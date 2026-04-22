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
  DevServerConfig,
} from "./schemas.js";
import { MemvidBuffer } from "./memvid.js";
import type { RunMemory } from "./memvid.js";
import { QAReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeReadOnlyHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { buildQAPrompt, type QAPromptContext } from "./prompts/qa-prompt.js";
import { CONTINUATION_PROMPT } from "./prompts/shared.js";
import { createValidationMcpServer } from "./validation-tool.js";
import { createMemorySearchMcpServer } from "./memory-tool.js";
import { createResearchMcpServerRecord } from "./research-tools.js";

// ------------------------------------
// Config and types
// ------------------------------------

export interface QARunnerConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
  memory?: RunMemory | null;
  /** When false, the fanout guidance section is omitted (Codex backend). */
  useClaudeBackend?: boolean;
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
  devServer?: DevServerConfig,
  resumeSessionId?: string,
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
    devServer,
    workspaceDir: effectiveWorkspaceDir,
    enableMemory: runnerConfig.config.enableMemory,
    useClaudeBackend: runnerConfig.useClaudeBackend,
  };

  const prompt = resumeSessionId ? CONTINUATION_PROMPT : buildQAPrompt(promptContext);

  const memvidBuffer = runnerConfig.memory ? new MemvidBuffer(runnerConfig.memory) : null;

  const workerResult = await runWorker(
    backend,
    {
      prompt,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      cwd: runnerConfig.workspaceDir ?? runnerConfig.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(runnerConfig.config.model ? { model: runnerConfig.config.model } : {}),
      ...(runnerConfig.config.effort ? { effort: runnerConfig.config.effort } : {}),
      allowedTools: READ_ONLY_ALLOWED_TOOLS,
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
      mcpServers: {
        "harnessd-validation": createValidationMcpServer(),
        ...(runnerConfig.memory ? { "harnessd-memory": createMemorySearchMcpServer(runnerConfig.memory) } : {}),
        ...createResearchMcpServerRecord(runnerConfig.config.researchTools),
      },
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
      memvidBuffer,
    },
    QAReportSchema,
  );

  return {
    report: workerResult.payload,
    workerResult,
  };
}
