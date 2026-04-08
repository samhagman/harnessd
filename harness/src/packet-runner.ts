/**
 * Packet runner — executes the builder agent on a single packet.
 *
 * The builder is the only repo writer. It implements exactly what the
 * finalized contract specifies.
 *
 * Nudges: The builder prompt tells the agent to check a nudge file periodically.
 * The orchestrator writes nudges to this file via send_to_agent inbox messages.
 *
 * Reference: TAD sections 13, 15.4
 */

import path from "node:path";

import type { AgentBackend } from "./backend/types.js";
import type {
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  RiskRegister,
  ProjectConfig,
} from "./schemas.js";
import { BuilderReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeBuilderHook } from "./permissions.js";
import { buildBuilderPrompt } from "./prompts/builder-prompt.js";
import { CONTINUATION_PROMPT } from "./prompts/shared.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { createValidationMcpServer } from "./validation-tool.js";

export interface PacketRunnerConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  packetId: string;
  config: ProjectConfig;
}

export interface BuilderRunResult {
  report: BuilderReport | null;
  workerResult: WorkerResult<BuilderReport>;
}


/**
 * Run the builder agent on a single packet.
 */
export async function runBuilder(
  backend: AgentBackend,
  contract: PacketContract,
  runnerConfig: PacketRunnerConfig,
  spec: string,
  riskRegister?: RiskRegister,
  priorEvalReport?: EvaluatorReport,
  contextOverrides?: string,
  completionSummaries?: string,
  resumeSessionId?: string,
): Promise<BuilderRunResult> {
  // Build the nudge file path — the builder will check this periodically
  const runDir = getRunDir(runnerConfig.repoRoot, runnerConfig.runId);
  const nudgeFilePath = path.join(runDir, "packets", runnerConfig.packetId, "nudge.md");

  const effectiveWorkspaceDir = runnerConfig.workspaceDir && runnerConfig.workspaceDir !== runnerConfig.repoRoot
    ? runnerConfig.workspaceDir
    : undefined;

  const prompt = resumeSessionId
    ? CONTINUATION_PROMPT
    : buildBuilderPrompt(
        contract, spec, riskRegister, priorEvalReport, contextOverrides, nudgeFilePath, effectiveWorkspaceDir, completionSummaries, runnerConfig.config.devServer,
      );

  const workerResult = await runWorker(
    backend,
    {
      prompt,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      cwd: runnerConfig.workspaceDir ?? runnerConfig.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(runnerConfig.config.model ? { model: runnerConfig.config.model } : {}),
      mcpServers: [createValidationMcpServer()],
      sandboxMode: "workspace-write",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [makeBuilderHook()] },
        ],
      },
    },
    {
      repoRoot: runnerConfig.repoRoot,
      runId: runnerConfig.runId,
      role: "builder",
      packetId: runnerConfig.packetId,
      artifactDir: `packets/${runnerConfig.packetId}/builder`,
      heartbeatIntervalSeconds: runnerConfig.config.heartbeatWriteSeconds,
      workspaceDir: runnerConfig.workspaceDir,
    },
    BuilderReportSchema,
  );

  // Write builder report artifact
  if (workerResult.payload) {
    const reportPath = path.join(runDir, "packets", runnerConfig.packetId, "builder", "builder-report.json");
    atomicWriteJson(reportPath, workerResult.payload);
  }

  return {
    report: workerResult.payload,
    workerResult,
  };
}
