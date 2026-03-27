/**
 * Orchestrator — the main state machine that drives a harnessd run.
 *
 * Resilient loop: agent crashes, rate limits, and incomplete outputs are
 * caught and retried automatically. The orchestrator never dies just because
 * an agent session ended unexpectedly. Like the original wiggum loop, it
 * keeps going until the work is done or a hard limit is hit.
 *
 * Gate model: plan approval gate (mandatory) + per-packet human review gates.
 * Nudges: file-based — operator writes to nudge.md, builder agent checks it.
 *
 * Reference: TAD sections 6, 10, 16, 17; operator-experience-spec Phases 2, 3, 5
 */

import fs from "node:fs";
import path from "node:path";

import type { AgentBackend } from "./backend/types.js";
import type {
  RunState,
  Packet,
  RiskRegister,
  ProjectConfig,
  RunPhase,
  EvaluatorReport,
  EvaluatorGuide,
  PlanningContext,
} from "./schemas.js";
import {
  PacketSchema,
  RiskRegisterSchema,
  PacketContractSchema,
  BuilderReportSchema,
  EvaluatorReportSchema,
  EvaluatorGuideSchema,
  PlanningContextSchema,
  defaultProjectConfig,
} from "./schemas.js";
import {
  createRun,
  loadRun,
  updateRun,
  readArtifact,
  getRunDir,
  ensurePacketDir,
  atomicWriteJson,
} from "./state-store.js";
import { appendEvent, readEvents } from "./event-log.js";
import { renderStatus, renderStatusMarkdown } from "./status-renderer.js";
import { runPlanner } from "./planner.js";
import { negotiateContract } from "./contract-negotiator.js";
import { runBuilder, type BuilderRunResult } from "./packet-runner.js";
import { runEvaluator, hasContractGap } from "./evaluator-runner.js";

import { z } from "zod";

// ------------------------------------
// Constants
// ------------------------------------

function errorStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Seconds to wait before retrying a phase after an agent crash */
const RETRY_COOLDOWN_SECONDS = 10;

/** Max consecutive retries on the same phase before giving up */
const MAX_CONSECUTIVE_RETRIES = 5;

/** How often to poll inbox when waiting for operator action (ms) */
const GATE_POLL_INTERVAL_MS = 2000;

// ------------------------------------
// Orchestrator config
// ------------------------------------

export interface OrchestratorConfig {
  repoRoot: string;
  /** Directory where the agents do their work. Agents are scoped to this dir. Defaults to repoRoot. */
  workspaceDir?: string;
  objective: string;
  config?: Partial<ProjectConfig>;
  resumeRunId?: string;
}

// ------------------------------------
// Gate "printed once" tracking
// ------------------------------------

let gatePrintedForPhase: string | null = null;

// ------------------------------------
// Main orchestrator loop
// ------------------------------------

export async function runOrchestrator(
  backend: AgentBackend,
  orchConfig: OrchestratorConfig,
): Promise<void> {
  const config = { ...defaultProjectConfig(), ...orchConfig.config };
  const repoRoot = orchConfig.repoRoot;
  const workspaceDir = orchConfig.workspaceDir ?? repoRoot;

  // Ensure workspace directory exists
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Create or resume run
  let runState: RunState;
  if (orchConfig.resumeRunId) {
    runState = loadRun(repoRoot, orchConfig.resumeRunId);
    console.log(`Resuming run ${runState.runId} from phase: ${runState.phase}`);
    appendEvent(repoRoot, runState.runId, {
      event: "run.resumed",
      phase: runState.phase,
    });
  } else {
    runState = createRun(repoRoot, orchConfig.objective);
    console.log(`Created run ${runState.runId}`);
    appendEvent(repoRoot, runState.runId, {
      event: "run.started",
      phase: "planning",
      detail: orchConfig.objective,
    });
  }

  // Retry tracking — resets whenever the phase advances
  let lastPhase: RunPhase = runState.phase;
  let consecutiveRetries = 0;

  // Start global background inbox poller for nudges — runs during all phases
  const globalNudgePoller = startGlobalNudgePoller(repoRoot, runState.runId, backend);

  // Main phase loop — resilient, never dies from agent crashes
  while (runState.phase !== "completed" && runState.phase !== "failed") {
    // Check operator flags
    if (runState.operatorFlags.stopRequested) {
      runState = await transition(repoRoot, runState, "paused", "Operator requested stop");
      break;
    }

    // Process inbox (may mutate runState phase for gate approvals)
    runState = await processInbox(repoRoot, runState);

    // Update status
    await writeStatusFiles(repoRoot, runState);

    // Track phase changes to reset retry counter and gate print flag
    if (runState.phase !== lastPhase) {
      lastPhase = runState.phase;
      consecutiveRetries = 0;
      gatePrintedForPhase = null;
    }

    // Hard limit: too many retries on the same phase
    if (consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) {
      console.error(`[${runState.runId}] Exhausted ${MAX_CONSECUTIVE_RETRIES} retries on phase ${runState.phase}`);
      appendEvent(repoRoot, runState.runId, {
        event: "run.failed",
        phase: runState.phase,
        detail: `Exhausted ${MAX_CONSECUTIVE_RETRIES} consecutive retries`,
      });
      runState = await transition(repoRoot, runState, "failed", `Exhausted retries on ${runState.phase}`);
      break;
    }

    try {
      const nextState = await executePhase(backend, repoRoot, workspaceDir, runState, config);

      if (nextState) {
        // Phase handler succeeded and returned a new state
        runState = nextState;
      } else {
        // Phase handler returned null → agent didn't finish, retry same phase
        consecutiveRetries++;
        console.log(
          `[${runState.runId}] Agent session ended without completing ${runState.phase}. ` +
          `Retry ${consecutiveRetries}/${MAX_CONSECUTIVE_RETRIES} in ${RETRY_COOLDOWN_SECONDS}s...`,
        );
        appendEvent(repoRoot, runState.runId, {
          event: "worker.resumed",
          phase: runState.phase,
          packetId: runState.currentPacketId ?? undefined,
          detail: `Auto-retry ${consecutiveRetries}/${MAX_CONSECUTIVE_RETRIES}`,
        });
        await sleep(RETRY_COOLDOWN_SECONDS * 1000);
      }
    } catch (err: unknown) {
      const errMsg = errorStr(err);
      consecutiveRetries++;

      if (isRateLimitError(errMsg)) {
        const backoffMs = computeBackoffMs(consecutiveRetries, config);
        console.log(
          `[${runState.runId}] Rate limited during ${runState.phase}. ` +
          `Waiting ${Math.ceil(backoffMs / 1000)}s before retry ${consecutiveRetries}/${MAX_CONSECUTIVE_RETRIES}...`,
        );
        appendEvent(repoRoot, runState.runId, {
          event: "worker.rate_limited",
          phase: runState.phase,
          packetId: runState.currentPacketId ?? undefined,
          detail: `Backoff ${Math.ceil(backoffMs / 1000)}s, retry ${consecutiveRetries}`,
        });
        await sleep(backoffMs);
      } else {
        console.error(
          `[${runState.runId}] Error in ${runState.phase}: ${errMsg}. ` +
          `Retry ${consecutiveRetries}/${MAX_CONSECUTIVE_RETRIES} in ${RETRY_COOLDOWN_SECONDS}s...`,
        );
        appendEvent(repoRoot, runState.runId, {
          event: "worker.resumed",
          phase: runState.phase,
          packetId: runState.currentPacketId ?? undefined,
          detail: `Error: ${errMsg.slice(0, 200)}. Auto-retry ${consecutiveRetries}`,
        });
        await sleep(RETRY_COOLDOWN_SECONDS * 1000);
      }
    }
  }


  // Stop the global nudge poller
  globalNudgePoller.stop();

  // Final status write
  lastStatusPhase = null; // force write
  await writeStatusFiles(repoRoot, runState);
  console.log(`Run ${runState.runId} ended in phase: ${runState.phase}`);
}

// ------------------------------------
// Phase dispatcher
// Returns RunState on success, null if agent didn't finish (retry same phase)
// ------------------------------------

async function executePhase(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
): Promise<RunState | null> {
  switch (runState.phase) {
    case "planning":
      return handlePlanning(backend, repoRoot, workspaceDir, runState, config);

    case "awaiting_plan_approval":
      return handleAwaitingPlanApproval(repoRoot, runState);

    case "selecting_packet":
      return handlePacketSelection(repoRoot, runState);

    case "negotiating_contract":
      return handleContractNegotiation(backend, repoRoot, workspaceDir, runState, config);

    case "building_packet":
      return handleBuilding(backend, repoRoot, workspaceDir, runState, config);

    case "evaluating_packet":
      return handleEvaluation(backend, repoRoot, workspaceDir, runState, config);

    case "fixing_packet":
      return handleFixing(backend, repoRoot, workspaceDir, runState, config);

    case "awaiting_human_review":
      return handleAwaitingHumanReview(runState);

    case "rate_limited":
      return handleRateLimit(repoRoot, runState);

    case "paused":
      console.log("Run is paused. Use resume.sh to continue.");
      await sleep(GATE_POLL_INTERVAL_MS);
      return runState;

    case "needs_human":
      console.log("Run needs human input. Check outbox/ for details.");
      await sleep(GATE_POLL_INTERVAL_MS);
      return runState;

    default:
      throw new Error(`Unknown phase: ${runState.phase}`);
  }
}

// ------------------------------------
// Phase handlers
// Return RunState to advance, or null to retry the same phase
// ------------------------------------

async function handlePlanning(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
): Promise<RunState | null> {
  appendEvent(repoRoot, runState.runId, { event: "planning.started", phase: "planning" });

  // Load planning context if it exists (from --interview or operator skill)
  const planningContext = readPlanningContext(repoRoot, runState.runId);

  const result = await runPlanner(backend, runState.objective, {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    config,
  }, undefined, undefined, planningContext);

  if (!result.success) {
    // Planner couldn't produce output — retry, don't fail
    console.log(`[${runState.runId}] Planner did not produce valid output: ${result.error}`);
    appendEvent(repoRoot, runState.runId, {
      event: "planning.failed",
      phase: "planning",
      detail: result.error,
    });
    return null;
  }

  appendEvent(repoRoot, runState.runId, {
    event: "planning.completed",
    phase: "planning",
    detail: `${result.packets.length} packets planned`,
  });

  const packetOrder = result.packets.map((p) => p.id);

  // Transition to plan approval gate (mandatory)
  appendEvent(repoRoot, runState.runId, {
    event: "plan.awaiting_approval",
    phase: "awaiting_plan_approval",
    detail: `${result.packets.length} packets ready for review`,
  });

  return updateRun(repoRoot, runState.runId, {
    phase: "awaiting_plan_approval",
    packetOrder,
  });
}

/**
 * Gate: wait for operator to approve the plan.
 * Prints once, then polls silently. processInbox handles the transition.
 */
async function handleAwaitingPlanApproval(
  repoRoot: string,
  runState: RunState,
): Promise<RunState> {
  if (gatePrintedForPhase !== "awaiting_plan_approval") {
    gatePrintedForPhase = "awaiting_plan_approval";
    const runDir = getRunDir(repoRoot, runState.runId);
    console.log(`[${runState.runId}] Plan ready for review.`);
    console.log(`  Review: ${runDir}/spec/SPEC.md, packets.json, evaluator-guide.json`);
    console.log(`  Approve: echo '{"type":"approve_plan","createdAt":"...","message":"go"}' > ${runDir}/inbox/approve.json`);
  }
  await sleep(GATE_POLL_INTERVAL_MS);
  return runState;
}

/**
 * Gate: wait for operator to approve or reject a packet after evaluation passes.
 * Prints once, then polls silently. processInbox handles the transition.
 */
async function handleAwaitingHumanReview(
  runState: RunState,
): Promise<RunState> {
  if (gatePrintedForPhase !== `awaiting_human_review:${runState.currentPacketId}`) {
    gatePrintedForPhase = `awaiting_human_review:${runState.currentPacketId}`;
    console.log(`[${runState.runId}] Packet ${runState.currentPacketId} passed evaluation — awaiting human review.`);
    console.log(`  Approve: {"type":"approve_packet","packetId":"${runState.currentPacketId}",...}`);
    console.log(`  Reject:  {"type":"reject_packet","packetId":"${runState.currentPacketId}","message":"...",...}`);
  }
  await sleep(GATE_POLL_INTERVAL_MS);
  return runState;
}

async function handlePacketSelection(
  repoRoot: string,
  runState: RunState,
): Promise<RunState> {
  const packets = readPackets(repoRoot, runState.runId);
  const nextPacket = selectNextPacket(packets, runState);

  if (!nextPacket) {
    if (runState.completedPacketIds.length === runState.packetOrder.length) {
      appendEvent(repoRoot, runState.runId, { event: "run.completed", phase: "completed" });
      return transition(repoRoot, runState, "completed");
    } else {
      appendEvent(repoRoot, runState.runId, {
        event: "run.needs_human",
        phase: "needs_human",
        detail: "No eligible packets (all blocked or failed)",
      });
      return transition(repoRoot, runState, "needs_human");
    }
  }

  ensurePacketDir(repoRoot, runState.runId, nextPacket.id);

  appendEvent(repoRoot, runState.runId, {
    event: "packet.selected",
    packetId: nextPacket.id,
    detail: nextPacket.title,
  });

  return updateRun(repoRoot, runState.runId, {
    phase: "negotiating_contract",
    currentPacketId: nextPacket.id,
  });
}

async function handleContractNegotiation(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;
  const packets = readPackets(repoRoot, runState.runId);
  const packet = packets.find((p) => p.id === packetId);
  if (!packet) throw new Error(`Packet ${packetId} not found`);

  // Check if contract already exists (resume case)
  try {
    readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
    // Contract already accepted from a prior session — skip to building
    return updateRun(repoRoot, runState.runId, { phase: "building_packet" });
  } catch { /* no final contract yet, proceed with negotiation */ }

  const outcome = await negotiateContract(backend, packet, readRiskRegister(repoRoot, runState.runId), {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    config,
    specExcerpt: readSpec(repoRoot, runState.runId),
  });

  switch (outcome.kind) {
    case "accepted":
      return updateRun(repoRoot, runState.runId, { phase: "building_packet" });

    case "split":
      appendEvent(repoRoot, runState.runId, {
        event: "contract.split",
        packetId,
        detail: outcome.suggestedSplit,
      });
      return transition(repoRoot, runState, "needs_human", `Packet ${packetId} needs splitting: ${outcome.suggestedSplit}`);

    case "escalated":
      await markPacketStatus(repoRoot, runState.runId, packetId, "blocked");
      return updateRun(repoRoot, runState.runId, {
        phase: "selecting_packet",
        currentPacketId: null,
        blockedPacketIds: [...runState.blockedPacketIds, packetId],
      });

    case "failed":
      // Negotiation agent crashed — retry, don't fail the whole run
      console.log(`[${runState.runId}] Contract negotiation failed for ${packetId}: ${outcome.error}`);
      return null;
  }
}

async function executeBuilder(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  evalReport?: EvaluatorReport,
): Promise<BuilderRunResult> {
  const packetId = runState.currentPacketId!;
  const contract = readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
  const contextOverrides = readContextOverrides(repoRoot, runState.runId);
  return runBuilder(backend, contract, {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    packetId,
    config,
  }, readSpec(repoRoot, runState.runId), readRiskRegister(repoRoot, runState.runId), evalReport, contextOverrides);
}

async function handleBuilding(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;

  appendEvent(repoRoot, runState.runId, {
    event: "builder.started",
    phase: "building_packet",
    packetId,
  });

  const result = await executeBuilder(backend, repoRoot, workspaceDir, runState, config);

  if (result.report?.claimsDone) {
    appendEvent(repoRoot, runState.runId, {
      event: "builder.completed",
      phase: "building_packet",
      packetId,
    });
    return updateRun(repoRoot, runState.runId, { phase: "evaluating_packet" });
  }

  // Builder session ended without claiming done — retry automatically
  console.log(`[${runState.runId}] Builder session ended without completing ${packetId}. Will retry.`);
  appendEvent(repoRoot, runState.runId, {
    event: "builder.failed",
    phase: "building_packet",
    packetId,
    detail: result.workerResult.hadError
      ? `Session error: ${result.workerResult.parseError ?? "unknown"}`
      : "Session ended without completion claim",
  });
  return null; // retry same phase
}

async function handleEvaluation(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;

  appendEvent(repoRoot, runState.runId, {
    event: "evaluator.started",
    phase: "evaluating_packet",
    packetId,
  });

  const contract = readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
  const builderReport = readArtifact(repoRoot, runState.runId, `packets/${packetId}/builder/builder-report.json`, BuilderReportSchema);
  const evaluatorGuide = readEvaluatorGuide(repoRoot, runState.runId);

  const result = await runEvaluator(backend, contract, builderReport, {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    packetId,
    config,
  }, readRiskRegister(repoRoot, runState.runId), evaluatorGuide);

  if (!result.report) {
    // Evaluator session crashed without producing output — retry
    console.log(`[${runState.runId}] Evaluator session ended without producing a report for ${packetId}. Will retry.`);
    appendEvent(repoRoot, runState.runId, {
      event: "evaluator.failed",
      phase: "evaluating_packet",
      packetId,
      detail: "Session ended without report — will retry",
    });
    return null; // retry same phase
  }

  if (result.report.overall === "pass") {
    appendEvent(repoRoot, runState.runId, { event: "evaluator.passed", phase: "evaluating_packet", packetId });

    // Check if this packet requires human review
    const packets = readPackets(repoRoot, runState.runId);
    const packet = packets.find((p) => p.id === packetId);

    if (packet?.requiresHumanReview) {
      appendEvent(repoRoot, runState.runId, {
        event: "packet.awaiting_review",
        packetId,
        detail: "Packet requires human review before completion",
      });
      return updateRun(repoRoot, runState.runId, {
        phase: "awaiting_human_review",
      });
    }

    // No human review needed — mark done
    appendEvent(repoRoot, runState.runId, { event: "packet.done", packetId });
    await markPacketStatus(repoRoot, runState.runId, packetId, "done");

    if (runState.operatorFlags.pauseAfterCurrentPacket) {
      return updateRun(repoRoot, runState.runId, {
        phase: "paused",
        currentPacketId: null,
        completedPacketIds: [...runState.completedPacketIds, packetId],
        operatorFlags: { ...runState.operatorFlags, pauseAfterCurrentPacket: false },
      });
    }

    return updateRun(repoRoot, runState.runId, {
      phase: "selecting_packet",
      currentPacketId: null,
      completedPacketIds: [...runState.completedPacketIds, packetId],
    });
  }

  // Evaluator found issues
  appendEvent(repoRoot, runState.runId, {
    event: "evaluator.failed",
    phase: "evaluating_packet",
    packetId,
    detail: `${result.report.hardFailures.length} hard failures`,
  });

  if (hasContractGap(result.report)) {
    return updateRun(repoRoot, runState.runId, { phase: "negotiating_contract" });
  }

  return updateRun(repoRoot, runState.runId, { phase: "fixing_packet" });
}

async function handleFixing(
  backend: AgentBackend,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;

  // Count fix attempts from events
  const events = readEvents(repoRoot, runState.runId);
  // Count only fix-phase builder starts, not the initial build
  const fixAttempts = events.filter(
    (e) => e.event === "builder.started" && e.packetId === packetId && e.phase === "fixing_packet",
  ).length;

  if (fixAttempts >= config.maxFixLoopsPerPacket) {
    appendEvent(repoRoot, runState.runId, {
      event: "packet.failed",
      packetId,
      detail: `Exceeded max fix loops (${config.maxFixLoopsPerPacket})`,
    });
    await markPacketStatus(repoRoot, runState.runId, packetId, "failed");
    return updateRun(repoRoot, runState.runId, {
      phase: "selecting_packet",
      currentPacketId: null,
      failedPacketIds: [...runState.failedPacketIds, packetId],
    });
  }

  let evalReport: EvaluatorReport | undefined;
  try {
    evalReport = readArtifact(repoRoot, runState.runId, `packets/${packetId}/evaluator/evaluator-report.json`, EvaluatorReportSchema);
  } catch {}

  appendEvent(repoRoot, runState.runId, {
    event: "builder.started",
    phase: "fixing_packet",
    packetId,
    detail: `Fix attempt ${fixAttempts + 1}/${config.maxFixLoopsPerPacket}`,
  });

  const result = await executeBuilder(backend, repoRoot, workspaceDir, runState, config, evalReport);

  if (result.report?.claimsDone) {
    return updateRun(repoRoot, runState.runId, { phase: "evaluating_packet" });
  }

  // Builder session ended without completing — retry
  console.log(`[${runState.runId}] Builder fix session ended without completing ${packetId}. Will retry.`);
  appendEvent(repoRoot, runState.runId, {
    event: "builder.failed",
    phase: "fixing_packet",
    packetId,
    detail: "Fix session ended without completion — will retry",
  });
  return null; // retry same phase
}

async function handleRateLimit(
  repoRoot: string,
  runState: RunState,
): Promise<RunState> {
  const nextRetry = runState.rateLimitState.nextRetryAt;
  if (!nextRetry) {
    return transition(repoRoot, runState, "failed", "Rate limited with no retry scheduled");
  }

  const waitMs = new Date(nextRetry).getTime() - Date.now();
  if (waitMs > 0) {
    console.log(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s until ${nextRetry}...`);
    await sleep(waitMs);
  }

  const priorPhase: RunPhase = runState.currentPacketId ? "building_packet" : "planning";
  return updateRun(repoRoot, runState.runId, {
    phase: priorPhase,
    rateLimitState: { ...runState.rateLimitState, status: "ok" },
  });
}

// ------------------------------------
// Packet selection (TAD section 10)
// ------------------------------------

export function selectNextPacket(
  packets: Packet[],
  runState: RunState,
): Packet | null {
  const done = new Set([...runState.completedPacketIds]);
  const blocked = new Set([...runState.blockedPacketIds]);
  const failed = new Set([...runState.failedPacketIds]);

  for (const id of runState.packetOrder) {
    if (done.has(id) || blocked.has(id) || failed.has(id)) continue;
    const packet = packets.find((p) => p.id === id);
    if (!packet) continue;
    if (packet.dependencies.every((dep) => done.has(dep))) return packet;
  }

  return null;
}

// ------------------------------------
// Shared artifact readers
// ------------------------------------

function readSpec(repoRoot: string, runId: string): string {
  try {
    return fs.readFileSync(path.join(getRunDir(repoRoot, runId), "spec", "SPEC.md"), "utf-8");
  } catch {
    return "";
  }
}

function readRiskRegister(repoRoot: string, runId: string): RiskRegister | undefined {
  try {
    return readArtifact(repoRoot, runId, "spec/risk-register.json", RiskRegisterSchema);
  } catch {
    return undefined;
  }
}

function readPackets(repoRoot: string, runId: string): Packet[] {
  return readArtifact(repoRoot, runId, "spec/packets.json", z.array(PacketSchema));
}

function readEvaluatorGuide(repoRoot: string, runId: string): EvaluatorGuide | undefined {
  try {
    return readArtifact(repoRoot, runId, "spec/evaluator-guide.json", EvaluatorGuideSchema);
  } catch {
    return undefined;
  }
}

function readPlanningContext(repoRoot: string, runId: string): PlanningContext | undefined {
  try {
    return readArtifact(repoRoot, runId, "spec/planning-context.json", PlanningContextSchema);
  } catch {
    return undefined;
  }
}

function readContextOverrides(repoRoot: string, runId: string): string | undefined {
  try {
    const p = path.join(getRunDir(repoRoot, runId), "spec", "context-overrides.md");
    return fs.readFileSync(p, "utf-8");
  } catch {
    return undefined;
  }
}

// ------------------------------------
// Helpers
// ------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function transition(
  repoRoot: string,
  runState: RunState,
  phase: RunPhase,
  detail?: string,
): Promise<RunState> {
  if (detail) {
    console.log(`[${runState.runId}] ${runState.phase} → ${phase}: ${detail}`);
  }
  return updateRun(repoRoot, runState.runId, { phase });
}

let lastStatusPhase: string | null = null;
let lastStatusPacketId: string | null = null;

async function writeStatusFiles(
  repoRoot: string,
  runState: RunState,
): Promise<void> {
  if (runState.phase === lastStatusPhase && runState.currentPacketId === lastStatusPacketId) {
    return;
  }
  lastStatusPhase = runState.phase;
  lastStatusPacketId = runState.currentPacketId;

  const events = readEvents(repoRoot, runState.runId);
  let packets: Packet[] = [];
  try { packets = readPackets(repoRoot, runState.runId); } catch {}

  const snapshot = renderStatus(runState, events, packets);
  const runDir = getRunDir(repoRoot, runState.runId);
  atomicWriteJson(path.join(runDir, "status.json"), snapshot);
  fs.writeFileSync(path.join(runDir, "status.md"), renderStatusMarkdown(snapshot));
}

/**
 * Process inbox messages. Handles all message types including gate approvals,
 * nudges (send_to_agent), context injection, and packet resets.
 *
 * Returns potentially updated runState (e.g. after gate approval transitions phase).
 */
/**
 * Check if a message type requires a specific phase to be actionable.
 * Returns the required phase, or null if the message is always actionable.
 */
function requiredPhaseForMessage(type: string): RunPhase | null {
  switch (type) {
    case "approve_plan": return "awaiting_plan_approval";
    case "approve_packet": return "awaiting_human_review";
    case "reject_packet": return "awaiting_human_review";
    default: return null; // Always actionable
  }
}

async function processInbox(
  repoRoot: string,
  runState: RunState,
): Promise<RunState> {
  const inboxDir = path.join(getRunDir(repoRoot, runState.runId), "inbox");
  const files = readInboxFiles(inboxDir);

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const msg = JSON.parse(fs.readFileSync(filePath, "utf-8"));

      // Check if this message requires a specific phase
      const requiredPhase = requiredPhaseForMessage(msg.type);
      if (requiredPhase && runState.phase !== requiredPhase) {
        continue;
      }

      // Skip messages handled exclusively by the global nudge poller
      if (msg.type === "send_to_agent" || msg.type === "pivot_agent") {
        continue;
      }

      appendEvent(repoRoot, runState.runId, {
        event: "poke.received",
        detail: msg.message ?? msg.type,
      });

      switch (msg.type) {
        case "pause":
          runState.operatorFlags.pauseAfterCurrentPacket = true;
          runState = updateRun(repoRoot, runState.runId, { operatorFlags: runState.operatorFlags });
          break;

        case "stop_after_current":
          runState.operatorFlags.stopRequested = true;
          runState = updateRun(repoRoot, runState.runId, { operatorFlags: runState.operatorFlags });
          break;

        case "approve_plan":
          if (runState.phase === "awaiting_plan_approval") {
            appendEvent(repoRoot, runState.runId, {
              event: "plan.approved",
              phase: "selecting_packet",
              detail: msg.message ?? "Plan approved",
            });
            runState = updateRun(repoRoot, runState.runId, { phase: "selecting_packet" });
          }
          break;

        case "approve_packet":
          if (runState.phase === "awaiting_human_review") {
            const pid = msg.packetId ?? runState.currentPacketId;
            appendEvent(repoRoot, runState.runId, {
              event: "packet.approved",
              packetId: pid,
              detail: msg.message ?? "Packet approved",
            });
            appendEvent(repoRoot, runState.runId, { event: "packet.done", packetId: pid });
            await markPacketStatus(repoRoot, runState.runId, pid, "done");
            runState = updateRun(repoRoot, runState.runId, {
              phase: "selecting_packet",
              currentPacketId: null,
              completedPacketIds: [...runState.completedPacketIds, pid],
            });
          }
          break;

        case "reject_packet":
          if (runState.phase === "awaiting_human_review") {
            const pid = msg.packetId ?? runState.currentPacketId;
            appendEvent(repoRoot, runState.runId, {
              event: "packet.rejected",
              packetId: pid,
              detail: msg.message ?? "Packet rejected — sending back to fix loop",
            });
            // Write operator feedback as an evaluator report substitute
            const feedbackReport = {
              packetId: pid,
              sessionId: "operator",
              overall: "fail" as const,
              hardFailures: [{
                criterionId: "operator-review",
                description: msg.message ?? "Operator rejected the packet",
                evidence: "Manual review",
                reproduction: [],
              }],
              rubricScores: [],
              missingEvidence: [],
              nextActions: [msg.message ?? "Address operator feedback"],
              contractGapDetected: false,
            };
            const reportPath = path.join(
              getRunDir(repoRoot, runState.runId),
              "packets", pid, "evaluator", "evaluator-report.json",
            );
            fs.mkdirSync(path.dirname(reportPath), { recursive: true });
            atomicWriteJson(reportPath, feedbackReport);
            runState = updateRun(repoRoot, runState.runId, { phase: "fixing_packet" });
          }
          break;

        case "inject_context":
          if (msg.context) {
            appendContextOverride(repoRoot, runState.runId, msg.context);
            appendEvent(repoRoot, runState.runId, {
              event: "context.injected",
              detail: msg.context.slice(0, 200),
            });
          }
          break;

        case "reset_packet":
          if (msg.packetId) {
            const pid = msg.packetId;
            appendEvent(repoRoot, runState.runId, {
              event: "packet.reset",
              packetId: pid,
              detail: msg.message ?? "Packet reset by operator",
            });
            // Reset packet status to pending
            await markPacketStatus(repoRoot, runState.runId, pid, "pending");
            // Clean up packet artifacts (contract, builder, evaluator dirs)
            const packetDir = path.join(getRunDir(repoRoot, runState.runId), "packets", pid);
            for (const subdir of ["contract", "builder", "evaluator"]) {
              const dir = path.join(packetDir, subdir);
              try { fs.rmSync(dir, { recursive: true }); } catch {}
            }
            // Remove from completed/failed/blocked lists
            runState = updateRun(repoRoot, runState.runId, {
              phase: "selecting_packet",
              currentPacketId: null,
              completedPacketIds: runState.completedPacketIds.filter((id) => id !== pid),
              failedPacketIds: runState.failedPacketIds.filter((id) => id !== pid),
              blockedPacketIds: runState.blockedPacketIds.filter((id) => id !== pid),
            });
          }
          break;

        case "resume":
          // If paused, transition back to a reasonable phase
          if (runState.phase === "paused") {
            const resumePhase: RunPhase = runState.currentPacketId ? "building_packet" : "selecting_packet";
            runState = updateRun(repoRoot, runState.runId, {
              phase: resumePhase,
              operatorFlags: { pauseAfterCurrentPacket: false, stopRequested: false },
            });
          }
          break;
      }

      // Rename to CONSUMED__ prefix instead of deleting — preserves history
      consumeInboxFile(inboxDir, file);
    } catch {
      // Skip corrupt inbox files
    }
  }

  return runState;
}

/**
 * Global background inbox poller — runs for the ENTIRE orchestrator lifecycle.
 * Handles send_to_agent (live nudge via streamInput) and inject_context continuously.
 * Phase-transition messages (approve/reject/reset/pause/stop) are left for synchronous processInbox.
 */
function startGlobalNudgePoller(
  repoRoot: string,
  runId: string,
  backend: AgentBackend,
): { stop: () => void } {
  const inboxDir = path.join(getRunDir(repoRoot, runId), "inbox");
  const intervalMs = 3000;
  let processing = false; // Prevent re-entrant processing

  const timer = setInterval(async () => {
    if (processing) return; // Skip if previous iteration still running
    processing = true;
    try {
    // Read current run state for context
    let currentPacketId: string | null = null;
    let currentPhase: string = "";
    try {
      const runJsonPath = path.join(getRunDir(repoRoot, runId), "run.json");
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf-8"));
      currentPacketId = runJson.currentPacketId;
      currentPhase = runJson.phase;
    } catch { return; }

    const files = readInboxFiles(inboxDir);
    if (files.length === 0) return;

    for (const file of files) {
      const filePath = path.join(inboxDir, file);
      try {
        const msg = JSON.parse(fs.readFileSync(filePath, "utf-8"));

        // Only handle nudge/pivot/inject here. Others are for processInbox.
        if (msg.type !== "send_to_agent" && msg.type !== "inject_context" && msg.type !== "pivot_agent") continue;

        if (msg.type === "send_to_agent" && msg.message) {
          // Queue for live injection via streamInput (drained inside for-await loop)
          const injectedLive = backend.queueNudge(msg.message);

          // Also write to nudge file + context-overrides as fallback/record
          try {
            if (currentPacketId) {
              writeNudgeFile(repoRoot, runId, currentPacketId, msg.message);
            }
            appendContextOverride(repoRoot, runId, msg.message);
          } catch (writeErr) {
          }

          appendEvent(repoRoot, runId, {
            event: "nudge.sent",
            phase: currentPhase as RunPhase,
            packetId: currentPacketId ?? undefined,
            detail: `${injectedLive ? "[LIVE] " : "[FILE] "}${msg.message.slice(0, 190)}`,
          });
        } else if (msg.type === "inject_context" && msg.context) {
          appendContextOverride(repoRoot, runId, msg.context);
          appendEvent(repoRoot, runId, {
            event: "context.injected",
            detail: msg.context.slice(0, 200),
          });
        } else if (msg.type === "pivot_agent" && msg.message) {
          // Kill the running agent — orchestrator retry loop will restart with new context
          const killedSessionId = backend.abortSession();
          appendContextOverride(repoRoot, runId, `PIVOT: ${msg.message}`);
          if (currentPacketId) {
            writeNudgeFile(repoRoot, runId, currentPacketId, `PIVOT: ${msg.message}`);
          }
          appendEvent(repoRoot, runId, {
            event: "nudge.sent",
            phase: currentPhase as RunPhase,
            packetId: currentPacketId ?? undefined,
            detail: `[PIVOT] ${msg.message.slice(0, 180)} (killed ${killedSessionId ?? "none"})`,
          });
        }

        // Consume the message
        consumeInboxFile(inboxDir, file);
      } catch (err) {
        console.error(`[nudge-poller] Error processing ${file}: ${errorStr(err)}`);
      }
    }
    } finally {
      processing = false;
    }
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}

function writeNudgeFile(repoRoot: string, runId: string, packetId: string, message: string): void {
  const nudgePath = path.join(getRunDir(repoRoot, runId), "packets", packetId, "nudge.md");
  fs.mkdirSync(path.dirname(nudgePath), { recursive: true });
  const ts = new Date().toISOString();
  // Append (multiple nudges can accumulate before builder checks)
  fs.appendFileSync(nudgePath, `\n---\n**[${ts}]** ${message}\n`);
}

function appendContextOverride(repoRoot: string, runId: string, content: string): void {
  const overridePath = path.join(getRunDir(repoRoot, runId), "spec", "context-overrides.md");
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  const ts = new Date().toISOString();
  fs.appendFileSync(overridePath, `\n---\n**[${ts}]** ${content}\n`);
}

async function markPacketStatus(
  repoRoot: string,
  runId: string,
  packetId: string,
  status: "done" | "failed" | "blocked" | "pending",
): Promise<void> {
  try {
    const packets = readArtifact(repoRoot, runId, "spec/packets.json", z.array(PacketSchema));
    const updated = packets.map((p) => p.id === packetId ? { ...p, status } : p);
    atomicWriteJson(path.join(getRunDir(repoRoot, runId), "spec", "packets.json"), updated);
  } catch {}
}

/** Read unconsumed inbox files (excludes CONSUMED__ prefix). */
function readInboxFiles(inboxDir: string): string[] {
  try {
    return fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json") && !f.startsWith("CONSUMED__")).sort();
  } catch { return []; }
}

/** Mark an inbox file as consumed by renaming with CONSUMED__ prefix. */
function consumeInboxFile(inboxDir: string, file: string): void {
  try {
    fs.renameSync(path.join(inboxDir, file), path.join(inboxDir, `CONSUMED__${file}`));
  } catch {}
}

function isRateLimitError(msg: string): boolean {
  return /rate.?limit|429|too many requests|overloaded/i.test(msg);
}

function computeBackoffMs(retryCount: number, config: ProjectConfig): number {
  const backoffs = config.resumeBackoffMinutes;
  const idx = Math.min(retryCount - 1, backoffs.length - 1);
  const minutes = backoffs[idx] ?? 5;
  return minutes * 60 * 1000;
}
