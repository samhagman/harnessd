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
import { BackendFactory } from "./backend/backend-factory.js";
import type {
  Packet,
  PacketContract,
  ContractReview,
  RiskRegister,
  ProjectConfig,
  EvaluatorReport,
} from "./schemas.js";
import { MemvidBuffer, contractRoundToDocument } from "./memvid.js";
import type { RunMemory } from "./memvid.js";
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
import { createMemorySearchMcpServer } from "./memory-tool.js";
import { createResearchMcpServerRecord } from "./research-tools.js";

export interface NegotiationConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
  specExcerpt: string;
  memory?: RunMemory | null;
}

export type NegotiationOutcome =
  | { kind: "accepted"; contract: PacketContract }
  | { kind: "split"; suggestedSplit: string }
  | { kind: "escalated"; reason: string }
  | { kind: "failed"; error: string };

/**
 * Negotiate a packet contract through multi-round builder↔evaluator loop.
 *
 * Accepts a BackendFactory (or plain AgentBackend for backward compat) to select
 * separate backends for the contract_builder and contract_evaluator roles.
 */
export async function negotiateContract(
  backendOrFactory: AgentBackend | BackendFactory,
  packet: Packet,
  riskRegister: RiskRegister | undefined,
  negConfig: NegotiationConfig,
  existingContract?: PacketContract,
  evaluatorReport?: EvaluatorReport,
): Promise<NegotiationOutcome> {
  // Backward compatibility: wrap plain AgentBackend in a factory
  const factory = backendOrFactory instanceof BackendFactory
    ? backendOrFactory
    : BackendFactory.fromSingleBackend(backendOrFactory);
  const contractBuilderBackend = factory.forRole("contract_builder");
  const contractEvaluatorBackend = factory.forRole("contract_evaluator");
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
      existingContract,
      evaluatorReport,
      negConfig.config.enableMemory,
    );

    const contractBuilderBuffer = negConfig.memory ? new MemvidBuffer(negConfig.memory) : null;

    const builderResult = await runWorker(
      contractBuilderBackend,
      {
        prompt: builderPrompt,
        cwd: negConfig.workspaceDir ?? negConfig.repoRoot,
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        ...(negConfig.config.model ? { model: negConfig.config.model } : {}),
        ...(negConfig.config.effort ? { effort: negConfig.config.effort } : {}),
        allowedTools: READ_ONLY_ALLOWED_TOOLS,
        disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS, "Agent", "TaskCreate"],
        mcpServers: {
          "harnessd-validation": createValidationMcpServer(),
          ...(negConfig.memory ? { "harnessd-memory": createMemorySearchMcpServer(negConfig.memory) } : {}),
          ...createResearchMcpServerRecord(negConfig.config.researchTools),
        },
        sandboxMode: "read-only",
      },
      {
        repoRoot: negConfig.repoRoot,
        runId: negConfig.runId,
        role: "contract_builder",
        packetId: packet.id,
        artifactDir: `packets/${packet.id}/contract`,
        workspaceDir: negConfig.workspaceDir,
        memvidBuffer: contractBuilderBuffer,
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

    // Encode proposal into memory
    if (negConfig.memory) {
      negConfig.memory.encodeInBackground([contractRoundToDocument('proposal', round, packet.id, proposal)]);
    }

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
    const evaluatorPrompt = buildContractEvaluatorPrompt(proposal, riskRegister, negConfig.config.enableMemory, factory.isClaudeBackend("contract_evaluator"));

    const contractEvaluatorBuffer = negConfig.memory ? new MemvidBuffer(negConfig.memory) : null;

    const evaluatorResult = await runWorker(
      contractEvaluatorBackend,
      {
        prompt: evaluatorPrompt,
        cwd: negConfig.workspaceDir ?? negConfig.repoRoot,
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        ...(negConfig.config.model ? { model: negConfig.config.model } : {}),
        ...(negConfig.config.effort ? { effort: negConfig.config.effort } : {}),
        allowedTools: READ_ONLY_ALLOWED_TOOLS,
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
        mcpServers: {
          "harnessd-validation": createValidationMcpServer(),
          ...(negConfig.memory ? { "harnessd-memory": createMemorySearchMcpServer(negConfig.memory) } : {}),
          ...createResearchMcpServerRecord(negConfig.config.researchTools),
        },
        sandboxMode: "read-only",
      },
      {
        repoRoot: negConfig.repoRoot,
        runId: negConfig.runId,
        role: "contract_evaluator",
        packetId: packet.id,
        artifactDir: `packets/${packet.id}/contract`,
        workspaceDir: negConfig.workspaceDir,
        memvidBuffer: contractEvaluatorBuffer,
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

    // Encode review into memory
    if (negConfig.memory) {
      negConfig.memory.encodeInBackground([contractRoundToDocument('review', round, packet.id, review)]);
    }

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
