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
): Promise<EvaluatorRunResult> {
  const prompt = buildEvaluatorPrompt(contract, builderReport, riskRegister, evaluatorGuide);

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
    },
    EvaluatorReportSchema,
  );

  return {
    report: workerResult.payload,
    workerResult,
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
