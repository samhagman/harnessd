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
import { appendEvent } from "./event-log.js";
import type {
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  RiskRegister,
  ProjectConfig,
  PacketType,
  PacketSummary,
} from "./schemas.js";
import type { BaselineGateFailure } from "./tool-gates.js";
import { MemvidBuffer } from "./memvid.js";
import type { RunMemory } from "./memvid.js";
import { BuilderReportSchema } from "./schemas.js";
import { runWorker, type WorkerResult } from "./worker.js";
import { makeBuilderHook } from "./permissions.js";
import { buildBuilderPrompt } from "./prompts/builder-prompt.js";
import { CONTINUATION_PROMPT } from "./prompts/shared.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { createValidationMcpServer } from "./validation-tool.js";
import { createMemorySearchMcpServer } from "./memory-tool.js";
import { createResearchMcpServerRecord } from "./research-tools.js";
import { createGateCheckMcpServer } from "./gate-check-tool.js";

/**
 * All configuration and optional context needed to run the builder.
 * Merges what was previously `PacketRunnerConfig` with the optional
 * positional context params into a single options bag.
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
  completionSummaries?: string;
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
  // Build the nudge file path — the builder will check this periodically
  const runDir = getRunDir(ctx.repoRoot, ctx.runId);
  const nudgeFilePath = path.join(runDir, "packets", ctx.packetId, "nudge.md");

  const effectiveWorkspaceDir = ctx.workspaceDir && ctx.workspaceDir !== ctx.repoRoot
    ? ctx.workspaceDir
    : undefined;

  const prompt = ctx.resumeSessionId
    ? CONTINUATION_PROMPT
    : buildBuilderPrompt(contract, {
        spec: ctx.spec,
        riskRegister: ctx.riskRegister,
        priorEvalReport: ctx.priorEvalReport,
        contextOverrides: ctx.contextOverrides,
        nudgeFilePath,
        workspaceDir: effectiveWorkspaceDir,
        completionSummaries: ctx.completionSummaries,
        devServer: ctx.config.devServer ?? undefined,
        completedPacketIds: ctx.completedPacketIds,
        researchTools: ctx.config.researchTools,
        enableMemory: ctx.config.enableMemory,
        allPackets: ctx.allPackets,
        runTimeline: ctx.runTimeline,
        packetNotes: ctx.packetNotes,
        expectedFiles: ctx.expectedFiles,
        criticalConstraints: ctx.criticalConstraints,
        baselineGateFailures: ctx.baselineGateFailures,
      });

  const memvidBuffer = ctx.memory ? new MemvidBuffer(ctx.memory) : null;

  const workerResult = await runWorker(
    backend,
    {
      prompt,
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      cwd: ctx.workspaceDir ?? ctx.repoRoot,
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
      ...(ctx.config.model ? { model: ctx.config.model } : {}),
      mcpServers: {
        "harnessd-validation": createValidationMcpServer(),
        "harnessd-gate-check": createGateCheckMcpServer(
          ctx.workspaceDir ?? ctx.repoRoot,
          ctx.packetType ?? "backend_feature",
          ctx.config,
        ),
        ...(ctx.memory ? { "harnessd-memory": createMemorySearchMcpServer(ctx.memory) } : {}),
        ...createResearchMcpServerRecord(ctx.config.researchTools),
      },
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

  // Write builder report artifact
  if (workerResult.payload) {
    const reportPath = path.join(runDir, "packets", ctx.packetId, "builder", "builder-report.json");
    atomicWriteJson(reportPath, workerResult.payload);

    // Advisory warning: builder changed files but made no git commits
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
