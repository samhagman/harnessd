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
  RunState,
  RiskRegister,
  ProjectConfig,
  EvaluatorGuide,
} from "./schemas.js";
import { EvaluatorReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeEvaluatorHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { buildEvaluatorPrompt } from "./prompts/evaluator-prompt.js";
import { createValidationMcpServer } from "./validation-tool.js";

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

export interface EvaluatorRunnerConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  packetId: string;
  config: ProjectConfig;
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
  runnerConfig: EvaluatorRunnerConfig,
  riskRegister?: RiskRegister,
  evaluatorGuide?: EvaluatorGuide,
  completionSummaries?: string,
  gateResultsSummary?: string,
): Promise<EvaluatorRunResult> {
  const effectiveWorkspaceDir = runnerConfig.workspaceDir && runnerConfig.workspaceDir !== runnerConfig.repoRoot
    ? runnerConfig.workspaceDir
    : undefined;

  const prompt = buildEvaluatorPrompt(contract, builderReport, riskRegister, evaluatorGuide, effectiveWorkspaceDir, completionSummaries, gateResultsSummary);

  const workerResult = await runWorker(
    backend,
    {
      prompt,
      cwd: runnerConfig.workspaceDir ?? runnerConfig.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(runnerConfig.config.model ? { model: runnerConfig.config.model } : {}),
      allowedTools: READ_ONLY_ALLOWED_TOOLS,
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
      mcpServers: [createValidationMcpServer()],
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
      repoRoot: runnerConfig.repoRoot,
      runId: runnerConfig.runId,
      role: "evaluator",
      packetId: runnerConfig.packetId,
      artifactDir: `packets/${runnerConfig.packetId}/evaluator`,
      workspaceDir: runnerConfig.workspaceDir,
    },
    EvaluatorReportSchema,
  );

  // Validate verdict completeness if report was produced
  let verdictValidation: VerdictValidation | null = null;
  if (workerResult.payload) {
    verdictValidation = validateVerdictCompleteness(workerResult.payload, contract);

    if (!verdictValidation.complete) {
      console.log(
        `[${runnerConfig.runId}] Evaluator verdict map incomplete for ${runnerConfig.packetId}: ` +
        `${verdictValidation.coveredCount}/${verdictValidation.totalCount} criteria covered. ` +
        `Missing: ${verdictValidation.missingCriterionIds.join(", ")}`,
      );
    }

    if (verdictValidation.blockingSkipCount > 0) {
      console.log(
        `[${runnerConfig.runId}] Evaluator skipped ${verdictValidation.blockingSkipCount} blocking criteria ` +
        `for ${runnerConfig.packetId}`,
      );
    }

    // If the evaluation is so incomplete that a majority of criteria are missing,
    // override overall to "fail" to prevent rubber-stamped passes
    if (
      workerResult.payload.overall === "pass" &&
      isIncompleteEvaluation(verdictValidation)
    ) {
      console.log(
        `[${runnerConfig.runId}] Overriding evaluator pass → fail for ${runnerConfig.packetId}: ` +
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
  }

  return {
    report: workerResult.payload,
    workerResult,
    verdictValidation,
  };
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
