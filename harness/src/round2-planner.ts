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
  /** Current round number (2, 3, 4...). Used for packet ID generation. */
  round?: number;
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
const CONTINUATION_PROMPT =
  "You were interrupted mid-session. Continue your work from where you left off. Complete your task and emit the result envelope when done.";

export async function runRound2Planner(
  backend: AgentBackend,
  qaReport: QAReport,
  originalSpec: string,
  originalPackets: Packet[],
  evaluatorGuide: EvaluatorGuide | undefined,
  plannerConfig: Round2PlannerConfig,
  resumeSessionId?: string,
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
    // Resume is only valid on the first attempt — subsequent retries need fresh prompts
    const effectiveResumeId = attempt === 1 ? resumeSessionId : undefined;

    const promptContext: Round2PlannerPromptContext = {
      originalSpec,
      qaReport,
      originalPackets,
      evaluatorGuide,
      workspaceDir: effectiveWorkspaceDir,
      round: plannerConfig.round,
    };

    let prompt: string;
    const resumeOptions: Record<string, unknown> = {};

    if (effectiveResumeId) {
      prompt = CONTINUATION_PROMPT;
      resumeOptions.resume = effectiveResumeId;
    } else {
      prompt = attempt > 1
        ? `Previous attempt failed: ${lastError}. Please try again with a valid structured output.\n\n${buildRound2PlannerPrompt(promptContext)}`
        : buildRound2PlannerPrompt(promptContext);
    }

    const workerResult = await runWorker(
      backend,
      {
        prompt,
        ...resumeOptions,
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

      // Write round-specific artifacts (each round gets its own file)
      const roundNum = plannerConfig.round ?? 2;
      atomicWriteJson(
        path.join(specDir, `packets-r${roundNum}.json`),
        output.packets,
      );

      fs.writeFileSync(
        path.join(specDir, `round${roundNum}-plan-summary.md`),
        output.planSummary,
      );

      // Write round-specific risk register
      if (output.riskRegister.risks.length > 0) {
        atomicWriteJson(
          path.join(specDir, `risk-register-r${roundNum}.json`),
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
