/**
 * Planner mode — expands a user objective into structured planning artifacts.
 *
 * Produces:
 * - SPEC.md — high-level specification
 * - packets.json — ordered packet list
 * - risk-register.json — identified risks
 * - plan-summary.md — short human-readable summary
 *
 * Reference: TAD section 9
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { AgentBackend } from "./backend/types.js";
import type { Packet, RiskRegister, EvaluatorGuide, ProjectConfig, PlanningContext } from "./schemas.js";
import { PacketSchema, RiskRegisterSchema, EvaluatorGuideSchema } from "./schemas.js";
import { runWorker } from "./worker.js";
import { makePlannerHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { buildPlannerPrompt } from "./prompts/planner-prompt.js";
import { createValidationMcpServer } from "./validation-tool.js";

// Schema for the planner's structured output
const PlannerOutputSchema = z.object({
  spec: z.string(),
  packets: z.array(PacketSchema),
  riskRegister: RiskRegisterSchema,
  evaluatorGuide: EvaluatorGuideSchema,
  planSummary: z.string(),
});

type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export interface PlannerConfig {
  repoRoot: string;
  /** Where agents work. Agents are scoped to this dir. Defaults to repoRoot. */
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
  maxRetries?: number;
}

export interface PlannerResult {
  packets: Packet[];
  riskRegister: RiskRegister;
  evaluatorGuide?: EvaluatorGuide;
  specPath: string;
  success: boolean;
  error?: string;
}

/**
 * Run the planner to decompose an objective into packets.
 */
export async function runPlanner(
  backend: AgentBackend,
  objective: string,
  plannerConfig: PlannerConfig,
  repoContext?: string,
  priorRunContext?: string,
  planningContext?: PlanningContext,
): Promise<PlannerResult> {
  const maxRetries = plannerConfig.maxRetries ?? 3;
  const runDir = getRunDir(plannerConfig.repoRoot, plannerConfig.runId);
  const specDir = path.join(runDir, "spec");
  fs.mkdirSync(specDir, { recursive: true });

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const prompt = buildPlannerPrompt(
      objective,
      repoContext,
      attempt > 1 ? `Previous attempt failed: ${lastError}. Please try again with a valid structured output.` : priorRunContext,
      planningContext,
    );

    const workerResult = await runWorker(
      backend,
      {
        prompt,
        cwd: plannerConfig.workspaceDir ?? plannerConfig.repoRoot,
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        ...(plannerConfig.config.model ? { model: plannerConfig.config.model } : {}),
        allowedTools: READ_ONLY_ALLOWED_TOOLS,
        disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS, "Agent", "TaskCreate"],
        mcpServers: [createValidationMcpServer()],
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [makePlannerHook()] },
          ],
        },
      },
      {
        repoRoot: plannerConfig.repoRoot,
        runId: plannerConfig.runId,
        role: "planner",
        artifactDir: "spec",
        heartbeatIntervalSeconds: plannerConfig.config.heartbeatWriteSeconds,
      },
      PlannerOutputSchema,
    );

    if (workerResult.payload) {
      const output = workerResult.payload;

      // Write planning artifacts
      const specPath = path.join(specDir, "SPEC.md");
      fs.writeFileSync(specPath, output.spec);

      atomicWriteJson(
        path.join(specDir, "packets.json"),
        output.packets,
      );

      atomicWriteJson(
        path.join(specDir, "risk-register.json"),
        output.riskRegister,
      );

      atomicWriteJson(
        path.join(specDir, "evaluator-guide.json"),
        output.evaluatorGuide,
      );

      fs.writeFileSync(
        path.join(specDir, "plan-summary.md"),
        output.planSummary,
      );

      return {
        packets: output.packets,
        riskRegister: output.riskRegister,
        evaluatorGuide: output.evaluatorGuide,
        specPath,
        success: true,
      };
    }

    lastError = workerResult.parseError ?? "No structured output envelope found";
  }

  return {
    packets: [],
    riskRegister: { risks: [] },
    specPath: "",
    success: false,
    error: `Planner failed after ${maxRetries} attempts: ${lastError}`,
  };
}
