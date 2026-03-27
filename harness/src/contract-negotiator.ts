/**
 * Contract negotiator — multi-round negotiation before packet implementation.
 *
 * The contract builder proposes, the contract evaluator reviews, and they
 * iterate until agreement, escalation, or max rounds.
 *
 * Reference: TAD section 11
 */

import fs from "node:fs";
import path from "node:path";

import type { AgentBackend } from "./backend/types.js";
import type {
  Packet,
  PacketContract,
  ContractReview,
  RiskRegister,
  ProjectConfig,
} from "./schemas.js";
import {
  PacketContractSchema,
  ContractReviewSchema,
  RISKY_PACKET_TYPES,
} from "./schemas.js";
import { runWorker } from "./worker.js";
import { makePlannerHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { appendEvent } from "./event-log.js";
import { lintContract } from "./contract-linter.js";
import { getTemplate } from "./templates.js";
import { buildContractBuilderPrompt } from "./prompts/contract-builder-prompt.js";
import { buildContractEvaluatorPrompt } from "./prompts/contract-evaluator-prompt.js";
import { createValidationMcpServer } from "./validation-tool.js";

export interface NegotiationConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
  specExcerpt: string;
}

export type NegotiationOutcome =
  | { kind: "accepted"; contract: PacketContract }
  | { kind: "split"; suggestedSplit: string }
  | { kind: "escalated"; reason: string }
  | { kind: "failed"; error: string };

/**
 * Negotiate a packet contract through multi-round builder↔evaluator loop.
 */
export async function negotiateContract(
  backend: AgentBackend,
  packet: Packet,
  riskRegister: RiskRegister | undefined,
  negConfig: NegotiationConfig,
): Promise<NegotiationOutcome> {
  const isRisky = RISKY_PACKET_TYPES.includes(packet.type);
  const maxRounds = isRisky
    ? negConfig.config.maxNegotiationRoundsRisky
    : negConfig.config.maxNegotiationRounds;

  const template = getTemplate(packet.type);
  const runDir = getRunDir(negConfig.repoRoot, negConfig.runId);
  const contractDir = path.join(runDir, "packets", packet.id, "contract");
  fs.mkdirSync(contractDir, { recursive: true });

  let priorReview: ContractReview | undefined;
  let lastUnresolvedIssues: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    await appendEvent(negConfig.repoRoot, negConfig.runId, {
      event: "contract.round.started",
      phase: "negotiating_contract",
      packetId: packet.id,
      detail: `Round ${round}/${maxRounds}`,
    });

    // 1. Contract builder proposes
    const builderPrompt = buildContractBuilderPrompt(
      packet,
      template,
      negConfig.specExcerpt,
      priorReview,
    );

    const builderResult = await runWorker(
      backend,
      {
        prompt: builderPrompt,
        cwd: negConfig.workspaceDir ?? negConfig.repoRoot,
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        ...(negConfig.config.model ? { model: negConfig.config.model } : {}),
        allowedTools: READ_ONLY_ALLOWED_TOOLS,
        disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS, "Agent", "TaskCreate"],
        mcpServers: [createValidationMcpServer()],
      },
      {
        repoRoot: negConfig.repoRoot,
        runId: negConfig.runId,
        role: "contract_builder",
        packetId: packet.id,
        artifactDir: `packets/${packet.id}/contract`,
      },
      PacketContractSchema,
    );

    if (!builderResult.payload) {
      return {
        kind: "failed",
        error: `Contract builder failed to produce valid proposal in round ${round}: ${builderResult.parseError ?? "no envelope"}`,
      };
    }

    const proposal = builderResult.payload;

    // Persist proposal
    atomicWriteJson(
      path.join(contractDir, `proposal.r${String(round).padStart(2, "0")}.json`),
      proposal,
    );

    // 2. Lint pass (no model call needed)
    const lintResult = lintContract(proposal, packet.type, packet.estimatedSize);
    if (!lintResult.valid) {
      // Auto-return to builder with lint errors instead of spending evaluator call
      priorReview = {
        packetId: packet.id,
        round,
        decision: "revise",
        scores: { scopeFit: 0, testability: 0, riskCoverage: 0, clarity: 0, specAlignment: 0 },
        requiredChanges: lintResult.errors,
        suggestedCriteriaAdditions: [],
        missingRisks: [],
        rationale: `Contract failed automated lint checks: ${lintResult.errors.join("; ")}`,
      };

      atomicWriteJson(
        path.join(contractDir, `review.r${String(round).padStart(2, "0")}.json`),
        priorReview,
      );

      await appendEvent(negConfig.repoRoot, negConfig.runId, {
        event: "contract.round.reviewed",
        packetId: packet.id,
        detail: `Round ${round}: lint failed (${lintResult.errors.length} errors)`,
      });

      continue;
    }

    // 3. Contract evaluator reviews
    const evaluatorPrompt = buildContractEvaluatorPrompt(proposal, riskRegister);

    const evaluatorResult = await runWorker(
      backend,
      {
        prompt: evaluatorPrompt,
        cwd: negConfig.workspaceDir ?? negConfig.repoRoot,
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        ...(negConfig.config.model ? { model: negConfig.config.model } : {}),
        allowedTools: READ_ONLY_ALLOWED_TOOLS,
        disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS, "Agent", "TaskCreate"],
        mcpServers: [createValidationMcpServer()],
      },
      {
        repoRoot: negConfig.repoRoot,
        runId: negConfig.runId,
        role: "contract_evaluator",
        packetId: packet.id,
        artifactDir: `packets/${packet.id}/contract`,
      },
      ContractReviewSchema,
    );

    if (!evaluatorResult.payload) {
      return {
        kind: "failed",
        error: `Contract evaluator failed to produce valid review in round ${round}: ${evaluatorResult.parseError ?? "no envelope"}`,
      };
    }

    const review = evaluatorResult.payload;

    // Persist review
    atomicWriteJson(
      path.join(contractDir, `review.r${String(round).padStart(2, "0")}.json`),
      review,
    );

    await appendEvent(negConfig.repoRoot, negConfig.runId, {
      event: "contract.round.reviewed",
      packetId: packet.id,
      detail: `Round ${round}: ${review.decision}`,
    });

    // 4. Handle decision
    switch (review.decision) {
      case "accept": {
        // Copy proposal to final.json
        const finalContract = { ...proposal, status: "accepted" as const };
        atomicWriteJson(path.join(contractDir, "final.json"), finalContract);

        await appendEvent(negConfig.repoRoot, negConfig.runId, {
          event: "contract.accepted",
          packetId: packet.id,
          detail: `Accepted in round ${round}`,
        });

        return { kind: "accepted", contract: finalContract };
      }

      case "split":
        return {
          kind: "split",
          suggestedSplit: review.rationale,
        };

      case "escalate":
        await appendEvent(negConfig.repoRoot, negConfig.runId, {
          event: "contract.escalated",
          packetId: packet.id,
          detail: review.rationale,
        });
        return {
          kind: "escalated",
          reason: review.rationale,
        };

      case "revise": {
        // Check for stale issues (same issue appearing twice)
        const currentIssues = review.requiredChanges;
        const repeatedIssues = currentIssues.filter((issue) =>
          lastUnresolvedIssues.some((prev) =>
            // Simple similarity check — same issue if they share significant words
            prev.toLowerCase() === issue.toLowerCase(),
          ),
        );

        if (repeatedIssues.length > 0) {
          await appendEvent(negConfig.repoRoot, negConfig.runId, {
            event: "contract.escalated",
            packetId: packet.id,
            detail: `Auto-escalated: same issues unresolved across rounds: ${repeatedIssues.join("; ")}`,
          });
          return {
            kind: "escalated",
            reason: `Same issues unresolved across consecutive rounds: ${repeatedIssues.join("; ")}`,
          };
        }

        lastUnresolvedIssues = currentIssues;
        priorReview = review;
        break;
      }
    }
  }

  // Max rounds exceeded
  return {
    kind: "escalated",
    reason: `Contract negotiation exceeded max rounds (${maxRounds})`,
  };
}
