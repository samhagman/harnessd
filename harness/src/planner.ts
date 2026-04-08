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
import type { Packet, RiskRegister, EvaluatorGuide, ProjectConfig, PlanningContext, PlanReview, IntegrationScenarioList, DevServerConfig } from "./schemas.js";
import { PacketSchema, RiskRegisterSchema, EvaluatorGuideSchema, IntegrationScenarioListSchema, DevServerConfigSchema } from "./schemas.js";
import { runWorker } from "./worker.js";
import { makePlannerHook, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_DISALLOWED_TOOLS } from "./permissions.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { buildPlannerPrompt } from "./prompts/planner-prompt.js";
import { CONTINUATION_PROMPT } from "./prompts/shared.js";
import { createValidationMcpServer } from "./validation-tool.js";

// Schema for the planner's structured output
const PlannerOutputSchema = z.object({
  spec: z.string(),
  packets: z.array(PacketSchema),
  riskRegister: RiskRegisterSchema,
  evaluatorGuide: EvaluatorGuideSchema,
  planSummary: z.string(),
  integrationScenarios: IntegrationScenarioListSchema.default({ scenarios: [] }),
  devServer: DevServerConfigSchema.optional(),
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
  integrationScenarios?: IntegrationScenarioList;
  devServer?: DevServerConfig;
  specPath: string;
  success: boolean;
  error?: string;
}

/**
 * Context for plan revision mode — includes the previous plan and reviewer feedback.
 */
export interface RevisionContext {
  /** The previous SPEC.md content */
  previousSpec: string;
  /** The previous packets.json (as formatted string) */
  previousPackets: string;
  /** The plan review from the reviewer */
  review: PlanReview;
  /** Which revision round this is (1-based) */
  round: number;
}

/**
 * Run the planner to decompose an objective into packets.
 *
 * When `revisionContext` is provided, the planner operates in revision mode:
 * it receives the previous plan and reviewer feedback, and is instructed to
 * revise the plan to address the identified issues.
 */

export async function runPlanner(
  backend: AgentBackend,
  objective: string,
  plannerConfig: PlannerConfig,
  repoContext?: string,
  priorRunContext?: string,
  planningContext?: PlanningContext,
  revisionContext?: RevisionContext,
  resumeSessionId?: string,
): Promise<PlannerResult> {
  const maxRetries = plannerConfig.maxRetries ?? 3;
  const runDir = getRunDir(plannerConfig.repoRoot, plannerConfig.runId);
  const specDir = path.join(runDir, "spec");
  fs.mkdirSync(specDir, { recursive: true });

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Resume is only valid on the first attempt — subsequent retries need fresh prompts
    // with error context so the agent can correct its output.
    const effectiveResumeId = attempt === 1 ? resumeSessionId : undefined;

    // Build prior run context, incorporating revision feedback if present
    let effectivePriorContext = attempt > 1
      ? `Previous attempt failed: ${lastError}. Please try again with a valid structured output.`
      : priorRunContext;

    if (revisionContext) {
      effectivePriorContext = buildRevisionPriorContext(revisionContext, effectivePriorContext);
    }

    let prompt: string;
    const resumeOptions: Record<string, unknown> = {};

    if (effectiveResumeId) {
      prompt = CONTINUATION_PROMPT;
      resumeOptions.resume = effectiveResumeId;
    } else {
      prompt = buildPlannerPrompt(
        objective,
        repoContext,
        effectivePriorContext,
        planningContext,
      );
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
        workspaceDir: plannerConfig.workspaceDir,
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

      // Write integration scenarios (may be empty for simple projects)
      if (output.integrationScenarios && output.integrationScenarios.scenarios.length > 0) {
        atomicWriteJson(
          path.join(specDir, "integration-scenarios.json"),
          output.integrationScenarios,
        );
      }

      return {
        packets: output.packets,
        riskRegister: output.riskRegister,
        evaluatorGuide: output.evaluatorGuide,
        integrationScenarios: output.integrationScenarios,
        devServer: output.devServer,
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

// ------------------------------------
// Revision context builder
// ------------------------------------

/**
 * Build the "prior run context" string that instructs the planner to revise
 * its previous plan based on reviewer feedback.
 */
function buildRevisionPriorContext(
  revision: RevisionContext,
  existingContext?: string,
): string {
  const issueList = revision.review.issues
    .map((issue, i) => {
      return `  ${i + 1}. [${issue.severity.toUpperCase()}] (${issue.area}) ${issue.description}\n     Suggestion: ${issue.suggestion}`;
    })
    .join("\n");

  const missingScenarios = revision.review.missingIntegrationScenarios.length > 0
    ? `\nMissing integration scenarios:\n${revision.review.missingIntegrationScenarios.map((s) => `  - ${s}`).join("\n")}`
    : "";

  const parts = [
    `REVISION MODE (round ${revision.round}): A technical reviewer has identified issues with your previous plan.`,
    `Please revise the plan to address these issues while keeping what works.`,
    ``,
    `## Reviewer Summary`,
    revision.review.summary,
    ``,
    `## Issues to Address`,
    issueList,
    missingScenarios,
    ``,
    `## Previous SPEC.md`,
    revision.previousSpec,
    ``,
    `## Previous Packets`,
    revision.previousPackets,
    ``,
    `## Instructions`,
    `- Address ALL critical and major issues identified above.`,
    `- Keep the parts of the plan that the reviewer did not flag.`,
    `- You may also address minor issues if the fix is straightforward.`,
    `- If the reviewer suggested missing integration scenarios, add them.`,
    `- Produce a COMPLETE revised plan (full SPEC, all packets, full risk register).`,
    `  Do not produce a diff — produce the entire revised output.`,
  ];

  if (existingContext) {
    parts.push(``, `## Additional Context`, existingContext);
  }

  return parts.join("\n");
}
