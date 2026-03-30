/**
 * Round 2 planner — targeted re-planner based on QA findings.
 *
 * Similar to planner.ts but receives QA report + all R1 context and
 * generates smaller fix packets (PKT-R2-001, etc.) that address
 * specific QA issues.
 *
 * Reference: research/harness-improvement-analysis/05-round2-planning-final-qa.md
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { AgentBackend } from "./backend/types.js";
import type {
  Packet,
  RiskRegister,
  EvaluatorGuide,
  QAReport,
  ProjectConfig,
} from "./schemas.js";
import { PacketSchema, RiskRegisterSchema, EvaluatorGuideSchema } from "./schemas.js";
import { runWorker } from "./worker.js";
import { makeReadOnlyHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { buildRound2PlannerPrompt, type Round2PlannerPromptContext } from "./prompts/round2-planner-prompt.js";
import { createValidationMcpServer } from "./validation-tool.js";

// Schema for the round 2 planner's structured output
const Round2PlannerOutputSchema = z.object({
  spec: z.string(),
  packets: z.array(PacketSchema),
  riskRegister: RiskRegisterSchema,
  evaluatorGuide: EvaluatorGuideSchema,
  planSummary: z.string(),
});

export interface Round2PlannerConfig {
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  config: ProjectConfig;
  maxRetries?: number;
}

export interface Round2PlannerResult {
  packets: Packet[];
  riskRegister: RiskRegister;
  evaluatorGuide?: EvaluatorGuide;
  success: boolean;
  error?: string;
}

/**
 * Run the round 2 planner to create targeted fix packets from QA findings.
 */
export async function runRound2Planner(
  backend: AgentBackend,
  qaReport: QAReport,
  originalSpec: string,
  originalPackets: Packet[],
  evaluatorGuide: EvaluatorGuide | undefined,
  plannerConfig: Round2PlannerConfig,
): Promise<Round2PlannerResult> {
  const maxRetries = plannerConfig.maxRetries ?? 3;
  const runDir = getRunDir(plannerConfig.repoRoot, plannerConfig.runId);
  const specDir = path.join(runDir, "spec");
  fs.mkdirSync(specDir, { recursive: true });

  const effectiveWorkspaceDir =
    plannerConfig.workspaceDir && plannerConfig.workspaceDir !== plannerConfig.repoRoot
      ? plannerConfig.workspaceDir
      : undefined;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const promptContext: Round2PlannerPromptContext = {
      originalSpec,
      qaReport,
      originalPackets,
      evaluatorGuide,
      workspaceDir: effectiveWorkspaceDir,
    };

    const prompt = attempt > 1
      ? `Previous attempt failed: ${lastError}. Please try again with a valid structured output.\n\n${buildRound2PlannerPrompt(promptContext)}`
      : buildRound2PlannerPrompt(promptContext);

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
            { matcher: "Bash", hooks: [makeReadOnlyHook()] },
          ],
        },
      },
      {
        repoRoot: plannerConfig.repoRoot,
        runId: plannerConfig.runId,
        role: "round2_planner",
        artifactDir: "spec",
        heartbeatIntervalSeconds: plannerConfig.config.heartbeatWriteSeconds,
        workspaceDir: plannerConfig.workspaceDir,
      },
      Round2PlannerOutputSchema,
    );

    if (workerResult.payload) {
      const output = workerResult.payload;

      // Write R2-specific artifacts (separate from R1)
      atomicWriteJson(
        path.join(specDir, "packets-r2.json"),
        output.packets,
      );

      fs.writeFileSync(
        path.join(specDir, "round2-plan-summary.md"),
        output.planSummary,
      );

      // Append R2 risks to the existing register if there is one
      if (output.riskRegister.risks.length > 0) {
        atomicWriteJson(
          path.join(specDir, "risk-register-r2.json"),
          output.riskRegister,
        );
      }

      return {
        packets: output.packets,
        riskRegister: output.riskRegister,
        evaluatorGuide: output.evaluatorGuide,
        success: true,
      };
    }

    lastError = workerResult.parseError ?? "No structured output envelope found";
  }

  return {
    packets: [],
    riskRegister: { risks: [] },
    success: false,
    error: `Round 2 planner failed after ${maxRetries} attempts: ${lastError}`,
  };
}
