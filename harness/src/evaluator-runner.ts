/**
 * Evaluator runner — executes the evaluator agent against a completed packet.
 *
 * The evaluator is strictly read-only. It verifies the builder's work against
 * the packet contract and produces an EvaluatorReport.
 *
 * Reference: TAD sections 14, 15.5
 */

import type { AgentBackend } from "./backend/types.js";
import type {
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  RiskRegister,
  ProjectConfig,
  EvaluatorGuide,
  ProposedCriterion,
  AcceptanceCriterion,
  PacketCompletionContext,
} from "./schemas.js";
import { MemvidBuffer } from "./memvid.js";
import type { RunMemory } from "./memvid.js";
import { EvaluatorReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeEvaluatorHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { buildEvaluatorPrompt } from "./prompts/evaluator-prompt.js";
import { RESUME_WITH_FRESH_CONTEXT_PREFIX } from "./prompts/shared.js";
import { createValidationMcpServer } from "./validation-tool.js";
import { createMemorySearchMcpServer } from "./memory-tool.js";
import { createResearchMcpServerRecord } from "./research-tools.js";

// ------------------------------------
// Verdict validation
// ------------------------------------

export interface VerdictValidation {
  complete: boolean;
  missingCriterionIds: string[];
  coveredCount: number;
  totalCount: number;
  blockingSkipCount: number;
}

/**
 * Validate that the evaluator produced verdicts for all acceptance criteria
 * in the contract. Returns a validation result indicating completeness.
 */
export function validateVerdictCompleteness(
  report: EvaluatorReport,
  contract: PacketContract,
): VerdictValidation {
  const expectedIds = new Set(contract.acceptance.map((ac) => ac.id));
  const coveredIds = new Set(report.criterionVerdicts.map((v) => v.criterionId));

  const missingCriterionIds: string[] = [];
  for (const id of expectedIds) {
    if (!coveredIds.has(id)) {
      missingCriterionIds.push(id);
    }
  }

  // Count blocking criteria that were skipped
  const blockingIds = new Set(
    contract.acceptance.filter((ac) => ac.blocking).map((ac) => ac.id),
  );
  const blockingSkipCount = report.criterionVerdicts.filter(
    (v) => v.verdict === "skip" && blockingIds.has(v.criterionId),
  ).length;

  return {
    complete: missingCriterionIds.length === 0,
    missingCriterionIds,
    coveredCount: expectedIds.size - missingCriterionIds.length,
    totalCount: expectedIds.size,
    blockingSkipCount,
  };
}

/**
 * Determine whether the verdict map is so incomplete that the evaluation
 * should not be trusted. A majority of criteria missing means the evaluator
 * likely rubber-stamped or failed to follow instructions.
 */
export function isIncompleteEvaluation(validation: VerdictValidation): boolean {
  if (validation.totalCount === 0) return false;
  return validation.missingCriterionIds.length > validation.totalCount / 2;
}

/**
 * All configuration and optional context needed to run the evaluator.
 * Merges what was previously `EvaluatorRunnerConfig` with the optional
 * positional context params into a single options bag.
 *
 * Note: `devServer` is sourced from `ctx.config.devServer` — do not add it
 * here separately.
 */
export interface EvaluatorContext {
  // Core identity
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  packetId: string;
  config: ProjectConfig;

  // Rich context (optional)
  riskRegister?: RiskRegister;
  evaluatorGuide?: EvaluatorGuide;
  completionContexts?: PacketCompletionContext[];
  /** Memory context string from memvid query (evaluator audience). */
  memoryContext?: string;
  gateResultsSummary?: string;
  recoveryContext?: string;
  futurePacketsSummary?: string;
  builderTranscriptPath?: string;
  completedPacketIds?: string[];
  resumeSessionId?: string;
  memory?: RunMemory | null;
  /** Expected files from the planner — used for completeness smoke-test. */
  expectedFiles?: string[];
  /** Number of builder commits (for git diff range). */
  builderCommitCount?: number;
  /** When false, the fanout guidance section is omitted (Codex backend). */
  useClaudeBackend?: boolean;
}

export interface EvaluatorRunResult {
  report: EvaluatorReport | null;
  workerResult: WorkerResult<EvaluatorReport>;
  verdictValidation: VerdictValidation | null;
}

/**
 * Run the evaluator agent on a completed packet.
 *
 * Returns the evaluator report or null if the evaluator failed to produce one.
 */
export async function runEvaluator(
  backend: AgentBackend,
  contract: PacketContract,
  builderReport: BuilderReport,
  ctx: EvaluatorContext,
): Promise<EvaluatorRunResult> {
  const effectiveWorkspaceDir = ctx.workspaceDir && ctx.workspaceDir !== ctx.repoRoot
    ? ctx.workspaceDir
    : undefined;

  // Always build the full evaluator prompt so resume sessions still see the
  // current builder report + recovery context. On resume we prefix with
  // RESUME_WITH_FRESH_CONTEXT_PREFIX so the model doesn't re-yield its prior
  // verdict envelope. Plain CONTINUATION_PROMPT is reserved for crashes where
  // no fresh context exists.
  const fullPrompt = buildEvaluatorPrompt(contract, builderReport, {
    riskRegister: ctx.riskRegister,
    evaluatorGuide: ctx.evaluatorGuide,
    workspaceDir: effectiveWorkspaceDir,
    completionContexts: ctx.completionContexts,
    gateResultsSummary: ctx.gateResultsSummary,
    recoveryContext: ctx.recoveryContext,
    futurePacketsSummary: ctx.futurePacketsSummary,
    devServer: ctx.config.devServer ?? undefined,
    builderTranscriptPath: ctx.builderTranscriptPath,
    completedPacketIds: ctx.completedPacketIds,
    researchTools: ctx.config.researchTools,
    enableMemory: ctx.config.enableMemory,
    expectedFiles: ctx.expectedFiles,
    builderCommitCount: ctx.builderCommitCount,
    useClaudeBackend: ctx.useClaudeBackend,
  });
  const prompt = ctx.resumeSessionId
    ? `${RESUME_WITH_FRESH_CONTEXT_PREFIX}${fullPrompt}`
    : fullPrompt;

  const memvidBuffer = ctx.memory ? new MemvidBuffer(ctx.memory) : null;

  const workerResult = await runWorker(
    backend,
    {
      prompt,
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      cwd: ctx.workspaceDir ?? ctx.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(ctx.config.model ? { model: ctx.config.model } : {}),
      ...(ctx.config.effort ? { effort: ctx.config.effort } : {}),
      allowedTools: READ_ONLY_ALLOWED_TOOLS,
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
      mcpServers: {
        "harnessd-validation": createValidationMcpServer(contract.acceptance.map((ac) => ac.id)),
        ...(ctx.memory ? { "harnessd-memory": createMemorySearchMcpServer(ctx.memory) } : {}),
        ...createResearchMcpServerRecord(ctx.config.researchTools),
      },
      // "workspace-write" allows Codex evaluator to run commands (dev server, curl, etc.)
      // File-edit enforcement is handled by the prompt + hooks (Claude) or prompt-only (Codex)
      sandboxMode: "workspace-write",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [makeEvaluatorHook()] },
          { matcher: "Write", hooks: [makeEvaluatorHook()] },
          { matcher: "Edit", hooks: [makeEvaluatorHook()] },
        ],
      },
    },
    {
      repoRoot: ctx.repoRoot,
      runId: ctx.runId,
      role: "evaluator",
      packetId: ctx.packetId,
      artifactDir: `packets/${ctx.packetId}/evaluator`,
      workspaceDir: ctx.workspaceDir,
      memvidBuffer,
    },
    EvaluatorReportSchema,
  );

  // Validate verdict completeness if report was produced
  let verdictValidation: VerdictValidation | null = null;
  if (workerResult.payload) {
    verdictValidation = validateVerdictCompleteness(workerResult.payload, contract);

    if (!verdictValidation.complete) {
      console.log(
        `[${ctx.runId}] Evaluator verdict map incomplete for ${ctx.packetId}: ` +
        `${verdictValidation.coveredCount}/${verdictValidation.totalCount} criteria covered. ` +
        `Missing: ${verdictValidation.missingCriterionIds.join(", ")}`,
      );
    }

    if (verdictValidation.blockingSkipCount > 0) {
      console.log(
        `[${ctx.runId}] Evaluator skipped ${verdictValidation.blockingSkipCount} blocking criteria ` +
        `for ${ctx.packetId}`,
      );
    }

    // If the evaluation is so incomplete that a majority of criteria are missing,
    // override overall to "fail" to prevent rubber-stamped passes
    if (
      workerResult.payload.overall === "pass" &&
      isIncompleteEvaluation(verdictValidation)
    ) {
      console.log(
        `[${ctx.runId}] Overriding evaluator pass → fail for ${ctx.packetId}: ` +
        `majority of criteria missing from verdict map (${verdictValidation.missingCriterionIds.length}/${verdictValidation.totalCount})`,
      );
      workerResult.payload = {
        ...workerResult.payload,
        overall: "fail",
        missingEvidence: [
          ...workerResult.payload.missingEvidence,
          ...verdictValidation.missingCriterionIds,
        ],
        nextActions: [
          ...workerResult.payload.nextActions,
          `Evaluator must provide verdicts for all ${verdictValidation.totalCount} acceptance criteria`,
        ],
      };
    }

    // Advisory-only failure guard: if evaluator said "fail" but ALL blocking
    // criteria passed, override to "pass" unless the evaluator explicitly
    // escalated an advisory criterion.
    if (
      workerResult.payload.overall === "fail" &&
      verdictValidation &&
      !isIncompleteEvaluation(verdictValidation)
    ) {
      workerResult.payload = applyAdvisoryGuard(
        workerResult.payload,
        contract,
        verdictValidation,
        ctx.runId,
        ctx.packetId,
      );
    }
  }

  return {
    report: workerResult.payload,
    workerResult,
    verdictValidation,
  };
}

// ------------------------------------
// Advisory guard (extracted for testability)
// ------------------------------------

/**
 * Advisory-only failure guard: if evaluator said "fail" but ALL blocking
 * criteria passed, override to "pass" unless the evaluator explicitly
 * escalated an advisory criterion.
 *
 * Returns a (possibly modified) copy of the report. Does not mutate the input.
 */
export function applyAdvisoryGuard(
  report: EvaluatorReport,
  contract: PacketContract,
  _verdictValidation: VerdictValidation,
  runId?: string,
  packetId?: string,
): EvaluatorReport {
  if (report.overall !== "fail") return report;

  const blockingIds = new Set(
    contract.acceptance.filter((ac) => ac.blocking).map((ac) => ac.id),
  );
  const escalatedIds = new Set(
    (report.advisoryEscalations ?? []).map((e) => e.criterionId),
  );
  const effectiveBlockingIds = new Set([...blockingIds, ...escalatedIds]);

  const blockingVerdicts = report.criterionVerdicts.filter(
    (v) => effectiveBlockingIds.has(v.criterionId),
  );
  const allBlockingPass = blockingVerdicts.length > 0 &&
    blockingVerdicts.every((v) => v.verdict === "pass");

  if (allBlockingPass && escalatedIds.size === 0) {
    if (runId && packetId) {
      console.log(
        `[${runId}] Overriding evaluator fail → pass for ${packetId}: ` +
        `all ${blockingVerdicts.length} blocking criteria passed; only advisory criteria failed`,
      );
    }
    return {
      ...report,
      overall: "pass",
    };
  }

  return report;
}

/**
 * Determine whether an evaluator result indicates the builder should try again.
 */
export function shouldRetryBuild(report: EvaluatorReport): boolean {
  return report.overall === "fail" && !report.contractGapDetected;
}

/**
 * Determine whether an evaluator result indicates a contract gap.
 * This means the packet should return to contract negotiation, not just a fix loop.
 */
export function hasContractGap(report: EvaluatorReport): boolean {
  return report.contractGapDetected;
}

// ------------------------------------
// Criterion expansion processing
// ------------------------------------

/** Maximum evaluator-added criteria allowed per packet across all eval rounds. */
export const MAX_EVALUATOR_CRITERIA_PER_PACKET = 20;

/**
 * Validate and process evaluator-proposed criteria.
 * - Filters out proposals with severity != "medium" (shouldn't be here)
 * - Checks global cap (20 per packet)
 * - Returns validated proposals (without IDs — orchestrator assigns them)
 */
export function processProposedCriteria(
  report: EvaluatorReport,
  existingEvaluatorCriteriaCount: number,
): ProposedCriterion[] {
  if (!report.addedCriteria || report.addedCriteria.length === 0) return [];

  // Only medium severity allowed through criterion expansion
  const mediumOnly = report.addedCriteria.filter(c => c.severity === "medium");

  // Enforce global cap
  const remaining = MAX_EVALUATOR_CRITERIA_PER_PACKET - existingEvaluatorCriteriaCount;
  if (remaining <= 0) return [];

  return mediumOnly.slice(0, remaining);
}

/**
 * Validate mutual exclusivity: addedCriteria and contractGapDetected
 * cannot coexist in the same report.
 */
export function isInvalidDualReport(report: EvaluatorReport): boolean {
  return report.contractGapDetected && report.addedCriteria.length > 0;
}

/**
 * Assign canonical IDs to proposed criteria.
 * Format: AC-E001, AC-E002, ... (globally unique within the packet)
 * Continues numbering from existingEvaluatorCriteriaCount to avoid collisions.
 */
export function assignCriterionIds(
  proposals: ProposedCriterion[],
  existingEvaluatorCriteriaCount: number,
): AcceptanceCriterion[] {
  return proposals.map((p, i) => {
    const seqNum = existingEvaluatorCriteriaCount + i + 1;
    const id = `AC-E${String(seqNum).padStart(3, "0")}`;
    return {
      id,
      kind: p.kind,
      description: p.description,
      blocking: p.blocking,
      evidenceRequired: p.evidenceRequired,
      source: "evaluator" as const,
      severity: p.severity,
      rationale: p.rationale,
      addedInEvalRound: 0, // caller sets this
      ...(p.command ? { command: p.command } : {}),
      ...(p.expected ? { expected: p.expected } : {}),
      ...(p.scenario ? { scenario: p.scenario } : {}),
    };
  });
}
