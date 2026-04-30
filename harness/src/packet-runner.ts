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
import { buildRoleMcpServers, SCHEMAS_DIR } from "./backend/mcp-descriptors.js";
import { appendEvent } from "./event-log.js";
import type {
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  RiskRegister,
  ProjectConfig,
  PacketType,
  PacketSummary,
  PacketCompletionContext,
} from "./schemas.js";
import type { BaselineGateFailure } from "./tool-gates.js";
import { MemvidBuffer } from "./memvid.js";
import type { RunMemory } from "./memvid.js";
import { BuilderReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeBuilderHook } from "./permissions.js";
import { buildBuilderPrompt } from "./prompts/builder-prompt.js";
import { CONTINUATION_PROMPT, RESUME_WITH_FRESH_CONTEXT_PREFIX } from "./prompts/shared.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";

/**
 * All configuration and optional context needed to run the builder.
 *
 * Note: `devServer` is sourced from `ctx.config.devServer` — do not add it
 * here separately.
 */
export interface BuilderContext {
  // Core identity
  repoRoot: string;
  workspaceDir?: string;
  runId: string;
  packetId: string;
  config: ProjectConfig;

  // Build context (optional)
  spec: string;
  riskRegister?: RiskRegister;
  priorEvalReport?: EvaluatorReport;
  contextOverrides?: string;
  completionContexts?: PacketCompletionContext[];
  /** Memory context string from memvid query (builder audience). */
  memoryContext?: string;
  completedPacketIds?: string[];
  resumeSessionId?: string;
  memory?: RunMemory | null;

  /** All packets for full plan context in builder prompt. */
  allPackets?: PacketSummary[];
  /** Run timeline string built from events.jsonl. */
  runTimeline?: string;
  /** Planner's notes for this packet. */
  packetNotes?: string[];
  /** Expected files from planner for this packet. */
  expectedFiles?: string[];
  /** Critical constraints from planner for this packet. */
  criticalConstraints?: string[];
  /** Packet type — needed for gate_check MCP tool resolution. */
  packetType?: PacketType;
  /** Pre-existing gate failures from baseline check. */
  baselineGateFailures?: BaselineGateFailure[];
  /**
   * Operator nudge text to inject at the start of a resumed session (Codex abort+resume flow).
   * When set alongside `resumeSessionId`, the nudge is prepended to the prompt as
   * "OPERATOR NUDGE:\n{text}\n\n" so the agent sees it immediately on session resume.
   */
  pendingNudgeText?: string;
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
  ctx: BuilderContext,
): Promise<BuilderRunResult> {
  const runDir = getRunDir(ctx.repoRoot, ctx.runId);
  const nudgeFilePath = path.join(runDir, "packets", ctx.packetId, "nudge.md");

  const effectiveWorkspaceDir = ctx.workspaceDir && ctx.workspaceDir !== ctx.repoRoot
    ? ctx.workspaceDir
    : undefined;

  // Always build the full prompt so fix-loop context (evaluator report, baseline
  // gate failures, context overrides, completion summaries) reaches the model
  // even on session resume. On resume we prepend a stronger framing so the model
  // doesn't re-yield its prior result envelope. On a fresh start we use only
  // the body. The simple CONTINUATION_PROMPT (no body) is reserved for crash
  // recovery where no fix-loop context exists — see resumeSessionId calculation
  // in orchestrator.handleFixing for that branch.
  const fullPrompt = buildBuilderPrompt(contract, {
    spec: ctx.spec,
    riskRegister: ctx.riskRegister,
    priorEvalReport: ctx.priorEvalReport,
    contextOverrides: ctx.contextOverrides,
    nudgeFilePath,
    workspaceDir: effectiveWorkspaceDir,
    completionContexts: ctx.completionContexts,
    devServer: ctx.config.devServer ?? undefined,
    completedPacketIds: ctx.completedPacketIds,
    researchTools: ctx.config.researchTools,
    enableMemory: ctx.config.enableMemory,
    memoryContext: ctx.memoryContext,
    allPackets: ctx.allPackets,
    runTimeline: ctx.runTimeline,
    packetNotes: ctx.packetNotes,
    expectedFiles: ctx.expectedFiles,
    criticalConstraints: ctx.criticalConstraints,
    baselineGateFailures: ctx.baselineGateFailures,
  });
  // Build the final prompt, handling three cases:
  // 1. Abort+resume nudge: resume the session and prepend the operator's nudge text so the
  //    model sees it immediately. Nudge precedes the full context so it's prominent.
  // 2. Normal resume (crash recovery): use CONTINUATION_PROMPT or fresh-context prefix.
  // 3. Fresh start: use the full prompt as-is.
  let prompt: string;
  if (ctx.resumeSessionId && ctx.pendingNudgeText) {
    // Abort+resume nudge delivery: operator message + full context
    prompt = `OPERATOR NUDGE:\n${ctx.pendingNudgeText}\n\n${fullPrompt}`;
  } else if (ctx.resumeSessionId) {
    prompt = ctx.priorEvalReport
      ? `${RESUME_WITH_FRESH_CONTEXT_PREFIX}${fullPrompt}`
      : CONTINUATION_PROMPT;
  } else {
    prompt = fullPrompt;
  }

  const memvidBuffer = ctx.memory ? new MemvidBuffer(ctx.memory) : null;

  const mcpServers = buildRoleMcpServers(backend, {
    needsGateCheck: true,
    workspaceDir: ctx.workspaceDir ?? ctx.repoRoot,
    packetType: ctx.packetType ?? "backend_feature",
    config: ctx.config,
    memory: ctx.memory,
    researchTools: ctx.config.researchTools,
  });

  const workerResult = await runWorker(
    backend,
    {
      prompt,
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      cwd: ctx.workspaceDir ?? ctx.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(ctx.config.model ? { model: ctx.config.model } : {}),
      ...(ctx.config.effort ? { effort: ctx.config.effort } : {}),
      mcpServers,
      ...(backend.supportsOutputSchema() ? {
        outputSchemaPath: path.join(SCHEMAS_DIR, "builder-report.json"),
      } : {}),
      sandboxMode: "workspace-write",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [makeBuilderHook()] },
        ],
      },
    },
    {
      repoRoot: ctx.repoRoot,
      runId: ctx.runId,
      role: "builder",
      packetId: ctx.packetId,
      artifactDir: `packets/${ctx.packetId}/builder`,
      heartbeatIntervalSeconds: ctx.config.heartbeatWriteSeconds,
      workspaceDir: ctx.workspaceDir,
      memvidBuffer,
    },
    BuilderReportSchema,
  );

  if (workerResult.payload) {
    const reportPath = path.join(runDir, "packets", ctx.packetId, "builder", "builder-report.json");
    atomicWriteJson(reportPath, workerResult.payload);

    // Warn when the builder modified files but made no commits — common sign of a
    // partial implementation that will confuse the evaluator's git-diff analysis.
    if (
      workerResult.payload.changedFiles.length > 0 &&
      (!workerResult.payload.commitShas || workerResult.payload.commitShas.length === 0)
    ) {
      appendEvent(ctx.repoRoot, ctx.runId, {
        event: "builder.warning",
        phase: "building_packet",
        packetId: ctx.packetId,
        detail: "Builder changed files but made no git commits",
      });
    }
  }

  return {
    report: workerResult.payload,
    workerResult,
  };
}
