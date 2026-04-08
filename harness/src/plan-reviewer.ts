/**
 * Plan reviewer runner — executes the plan review agent against planner output.
 *
 * The plan reviewer is strictly read-only. It critically evaluates the SPEC,
 * packets, risk register, and integration scenarios before the operator sees
 * the plan. This catches plan-level issues early — before any builder starts.
 *
 * Reference: Plan Phase 3 — Plan Review
 */

import type { AgentBackend } from "./backend/types.js";
import type { PlanReview, ProjectConfig } from "./schemas.js";
import { PlanReviewSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeReadOnlyHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { buildPlanReviewPrompt } from "./prompts/plan-review-prompt.js";
import { createValidationMcpServer } from "./validation-tool.js";

export interface PlanReviewRunnerConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
}

export interface PlanReviewResult {
  success: boolean;
  review: PlanReview | null;
  error?: string;
}

/**
 * Run the plan reviewer agent against planner output.
 *
 * Returns a PlanReview with verdict (approve/revise), issues, and suggestions.
 */
export async function runPlanReview(
  backend: AgentBackend,
  specContent: string,
  packetsContent: string,
  riskRegister: string | undefined,
  integrationScenarios: string | undefined,
  planningContext: string | undefined,
  objective: string,
  opts: PlanReviewRunnerConfig,
): Promise<PlanReviewResult> {
  const prompt = buildPlanReviewPrompt(
    specContent,
    packetsContent,
    objective,
    riskRegister,
    integrationScenarios,
    planningContext,
  );

  const workerResult: WorkerResult<PlanReview> = await runWorker(
    backend,
    {
      prompt,
      cwd: opts.workspaceDir ?? opts.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(opts.config.model ? { model: opts.config.model } : {}),
      allowedTools: READ_ONLY_ALLOWED_TOOLS,
      disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS, "Agent", "TaskCreate"],
      mcpServers: [createValidationMcpServer()],
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [makeReadOnlyHook()] },
          { matcher: "Write", hooks: [makeReadOnlyHook()] },
          { matcher: "Edit", hooks: [makeReadOnlyHook()] },
        ],
      },
    },
    {
      repoRoot: opts.repoRoot,
      runId: opts.runId,
      role: "plan_reviewer",
      artifactDir: "spec/plan-review",
      heartbeatIntervalSeconds: opts.config.heartbeatWriteSeconds,
      workspaceDir: opts.workspaceDir,
    },
    PlanReviewSchema,
  );

  if (workerResult.payload) {
    return {
      success: true,
      review: workerResult.payload,
    };
  }

  return {
    success: false,
    review: null,
    error: workerResult.parseError ?? "Plan reviewer did not produce a valid envelope",
  };
}
