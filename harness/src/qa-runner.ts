/**
 * QA runner — executes the holistic QA agent after all round N packets complete.
 *
 * The QA agent is read-only (same permissions as evaluator) and tests the
 * complete feature end-to-end. It produces a QAReport with issues, severity,
 * and reproduction steps.
 *
 * Reference: research/harness-improvement-analysis/05-round2-planning-final-qa.md
 */

import type { AgentBackend } from "./backend/types.js";
import type {
  PacketContract,
  BuilderReport,
  EvaluatorGuide,
  QAReport,
  ProjectConfig,
  IntegrationScenario,
} from "./schemas.js";
import { QAReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeReadOnlyHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { buildQAPrompt, type QAPromptContext } from "./prompts/qa-prompt.js";
import { createValidationMcpServer } from "./validation-tool.js";

// ------------------------------------
// Config and types
// ------------------------------------

export interface QARunnerConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
}

export interface QARunResult {
  report: QAReport | null;
  workerResult: WorkerResult<QAReport>;
}

// ------------------------------------
// QA runner
// ------------------------------------

/**
 * Run the holistic QA agent on the complete feature.
 *
 * Gathers all contracts and builder reports, constructs the QA prompt,
 * and runs the agent session. Returns a QAReport or null if the agent
 * failed to produce one.
 */
export async function runQA(
  backend: AgentBackend,
  spec: string,
  contracts: PacketContract[],
  builderReports: BuilderReport[],
  evaluatorGuide: EvaluatorGuide | undefined,
  integrationScenarios: IntegrationScenario[],
  runnerConfig: QARunnerConfig,
  round: number = 1,
  devServerUrl?: string,
): Promise<QARunResult> {
  const effectiveWorkspaceDir =
    runnerConfig.workspaceDir && runnerConfig.workspaceDir !== runnerConfig.repoRoot
      ? runnerConfig.workspaceDir
      : undefined;

  const promptContext: QAPromptContext = {
    spec,
    contracts,
    builderReports,
    evaluatorGuide,
    integrationScenarios,
    round,
    devServerUrl,
    devServerCommand: runnerConfig.config.devServer?.command,
    workspaceDir: effectiveWorkspaceDir,
  };

  const prompt = buildQAPrompt(promptContext);

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
      // "workspace-write" allows Codex QA agent to run commands (dev server, tests, etc.)
      // File-edit enforcement is handled by the prompt + hooks (Claude) or prompt-only (Codex)
      sandboxMode: "workspace-write",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [makeReadOnlyHook()] },
          { matcher: "Write", hooks: [makeReadOnlyHook()] },
          { matcher: "Edit", hooks: [makeReadOnlyHook()] },
        ],
      },
    },
    {
      repoRoot: runnerConfig.repoRoot,
      runId: runnerConfig.runId,
      role: "qa_agent",
      artifactDir: `spec/qa-r${round}`,
      workspaceDir: runnerConfig.workspaceDir,
    },
    QAReportSchema,
  );

  return {
    report: workerResult.payload,
    workerResult,
  };
}
