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
import { BackendFactory } from "./backend/backend-factory.js";
import type {
  RunState,
  Packet,
  PacketContract,
  RiskRegister,
  ProjectConfig,
  RunPhase,
  BuilderReport,
  EvaluatorReport,
  EvaluatorGuide,
  PlanningContext,
  QAReport,
  IntegrationScenario,
  EventEntry,
} from "./schemas.js";
import {
  PacketSchema,
  RiskRegisterSchema,
  PacketContractSchema,
  BuilderReportSchema,
  EvaluatorReportSchema,
  EvaluatorGuideSchema,
  PlanningContextSchema,
  QAReportSchema,
  IntegrationScenarioSchema,
  qaPassesThreshold,
  defaultProjectConfig,
} from "./schemas.js";
import {
  createRun,
  loadRun,
  updateRun,
  pushToRunArray,
  readArtifact,
  getRunDir,
  ensurePacketDir,
  atomicWriteJson,
  appendEvaluatorAdditions,
  validateWorkspacePath,
} from "./state-store.js";
import { appendEvent, readEvents } from "./event-log.js";
import { renderStatus, renderStatusMarkdown } from "./status-renderer.js";
import { runPlanner, type RevisionContext } from "./planner.js";
import { runPlanReview } from "./plan-reviewer.js";
import { negotiateContract } from "./contract-negotiator.js";
import { runBuilder, type BuilderRunResult, type BuilderContext } from "./packet-runner.js";
import {
  runEvaluator,
  hasContractGap,
  processProposedCriteria,
  isInvalidDualReport,
  assignCriterionIds,
  type EvaluatorContext,
} from "./evaluator-runner.js";
import { findLatestTranscript, readPriorSessionId } from "./session-recovery.js";
import { recoverFromCrashedSession } from "./recovery-agent.js";
import { runQA } from "./qa-runner.js";
import { runRound2Planner } from "./round2-planner.js";
import { generateCompletionContext } from "./completion-summary.js";
import type { PacketCompletionContext } from "./schemas.js";
import { PacketCompletionContextSchema } from "./schemas.js";
import {
  runToolGates,
  synthesizeEvalReportFromGates,
  formatGateResultsForPrompt,
  type GateRunResult,
  type BaselineGateFailure,
} from "./tool-gates.js";

import type { RunMemory, MemvidDocument } from "./memvid.js";
import {
  createRunMemory,
  openRunMemory,
  getMemoryPath,
  eventsToDocuments,
  transcriptToDocuments,
  specToDocuments,
  contractToDocument,
  builderReportToDocument,
  evalReportToDocument,
  qaReportToDocument,
  completionSummaryToDocument,
  queryMemoryContext,
  planReviewToDocument,
  inboxMessageToDocument,
} from "./memvid.js";

import { z } from "zod";
import { resolveResearchToolAvailability } from "./research-tools.js";

// ------------------------------------
// Constants
// ------------------------------------

function errorStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Seconds to wait before retrying a phase after an agent crash */
const RETRY_COOLDOWN_SECONDS = 10;

/** Max consecutive retries on the same phase before giving up */
const MAX_CONSECUTIVE_RETRIES = 10;

/** How often to poll inbox when waiting for operator action (ms) */
const GATE_POLL_INTERVAL_MS = 2000;

// ------------------------------------
// Round helpers
// ------------------------------------

/** Returns true when the run is executing a round-2+ fix-pass with packets queued. */
function isRound2Active(runState: RunState): boolean {
  return runState.round >= 2 && runState.round2PacketOrder.length > 0;
}

// ------------------------------------
// Session resume helpers
// ------------------------------------

/**
 * Get the session ID to resume for a crashed worker, if the backend supports it.
 * Returns a session ID if: (a) the role uses Claude SDK, (b) a valid prior session exists.
 * Returns null otherwise (caller should use recovery-agent fallback or fresh start).
 */
function getResumeSessionId(
  factory: BackendFactory,
  role: string,
  repoRoot: string,
  runId: string,
  artifactDir: string,
): string | null {
  if (!factory.isClaudeBackend(role)) return null;
  return readPriorSessionId(repoRoot, runId, artifactDir);
}

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
  backendOrFactory: AgentBackend | BackendFactory,
  orchConfig: OrchestratorConfig,
): Promise<void> {
  // Backward compatibility: wrap plain AgentBackend in a factory that returns it for all roles
  const factory = backendOrFactory instanceof BackendFactory
    ? backendOrFactory
    : BackendFactory.fromSingleBackend(backendOrFactory);

  const config = { ...defaultProjectConfig(), ...orchConfig.config };
  const repoRoot = orchConfig.repoRoot;
  const workspaceDir = orchConfig.workspaceDir ?? repoRoot;

  // Resolve research tool availability (check env vars, log summary)
  const researchAvailability = resolveResearchToolAvailability(config);
  config.researchTools = researchAvailability;

  // Validate workspace is not in a volatile location (/tmp gets cleared by OS)
  if (workspaceDir !== repoRoot) {
    validateWorkspacePath(workspaceDir);
  }

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
    runState = createRun(repoRoot, orchConfig.objective, undefined, undefined, workspaceDir);
    console.log(`Created run ${runState.runId}`);
    appendEvent(repoRoot, runState.runId, {
      event: "run.started",
      phase: "planning",
      detail: orchConfig.objective,
    });
  }

  // Initialize run memory (skip if disabled via config, or if @memvid/sdk not installed)
  let memory: RunMemory | null = null;
  if (config.enableMemory) {
    try {
      const memoryPath = getMemoryPath(repoRoot, runState.runId);
      console.log(`[memvid] Initializing memory at ${memoryPath}`);
      // Try to open existing memory on resume; fall back to creating fresh
      memory = orchConfig.resumeRunId
        ? (await openRunMemory(memoryPath, repoRoot, runState.runId)
           ?? await createRunMemory(memoryPath, repoRoot, runState.runId))
        : await createRunMemory(memoryPath, repoRoot, runState.runId);
      console.log(`[memvid] Memory initialized: ${memory ? 'active' : 'disabled (SDK not found)'}`);
    } catch (err) {
      console.log(`[memvid] Warning: could not initialize memory: ${(err as Error).message}`);
    }
  }

  // Retry tracking — resets whenever the phase advances
  let lastPhase: RunPhase = runState.phase;
  let consecutiveRetries = 0;

  // Start global background inbox poller for nudges — runs during all phases
  // Uses the Claude backend directly since only Claude supports live nudges via streamInput
  const globalNudgePoller = startGlobalNudgePoller(repoRoot, runState.runId, factory.claudeBackend, memory);

  // Main phase loop — resilient, never dies from agent crashes
  while (runState.phase !== "completed" && runState.phase !== "failed") {
    // Check operator flags
    if (runState.operatorFlags.stopRequested) {
      runState = await transition(repoRoot, runState, "paused", "Operator requested stop");
      break;
    }

    // Process inbox (may mutate runState phase for gate approvals)
    runState = await processInbox(repoRoot, runState, memory);

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

    const sessionStart = Date.now();
    try {
      const nextState = await executePhase(factory, repoRoot, workspaceDir, runState, config, memory);

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
      const sessionDurationMs = Date.now() - sessionStart;
      consecutiveRetries++;

      if (isQuotaExhaustionError(errMsg)) {
        console.error(`[${runState.runId}] Quota exhaustion during ${runState.phase}: ${errMsg.slice(0, 200)}`);
        appendEvent(repoRoot, runState.runId, {
          event: "worker.rate_limited",
          phase: runState.phase,
          packetId: runState.currentPacketId ?? undefined,
          detail: `Quota exhaustion detected. Pausing for human intervention: ${errMsg.slice(0, 200)}`,
        });
        runState = updateRun(repoRoot, runState.runId, { phase: "needs_human" });
        break;
      } else if (isRateLimitError(errMsg)) {
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
          `Retry ${consecutiveRetries}/${MAX_CONSECUTIVE_RETRIES}...`,
        );
        appendEvent(repoRoot, runState.runId, {
          event: "worker.resumed",
          phase: runState.phase,
          packetId: runState.currentPacketId ?? undefined,
          detail: `Error: ${errMsg.slice(0, 200)}. Auto-retry ${consecutiveRetries}`,
        });
        if (sessionDurationMs < 30_000) {
          const backoffMs = computeBackoffMs(consecutiveRetries, config);
          console.error(
            `[${runState.runId}] Rapid crash in ${runState.phase} (${Math.round(sessionDurationMs / 1000)}s). Backoff ${Math.ceil(backoffMs / 1000)}s`,
          );
          await sleep(backoffMs);
        } else {
          await sleep(RETRY_COOLDOWN_SECONDS * 1000);
        }
      }
    }
  }


  // Stop the global nudge poller
  globalNudgePoller.stop();

  // Wait for any pending memory encoding to complete (up to 10s — non-fatal)
  const MEMORY_FLUSH_TIMEOUT_MS = 10_000;
  if (memory) {
    try {
      await Promise.race([
        memory.waitForPendingWrites(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), MEMORY_FLUSH_TIMEOUT_MS),
        ),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "timeout") {
        console.log("[memvid] Warning: pending writes did not flush in 10s — some memory may be lost");
      }
      // non-fatal either way
    }
  }

  // Final status write
  lastStatusPhase = null; // force write
  await writeStatusFiles(repoRoot, runState);
  console.log(`Run ${runState.runId} ended in phase: ${runState.phase}`);

  if (runState.phase === "completed" || runState.phase === "failed") {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Ready for deferred work report!`);
    console.log(`${"=".repeat(60)}\n`);
  }
}

// ------------------------------------
// Phase dispatcher
// Returns RunState on success, null if agent didn't finish (retry same phase)
// ------------------------------------

async function executePhase(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  switch (runState.phase) {
    case "planning":
      return handlePlanning(factory, repoRoot, workspaceDir, runState, config, memory);

    case "plan_review":
      return handlePlanReview(factory, repoRoot, workspaceDir, runState, config, memory);

    case "awaiting_plan_approval":
      return handleAwaitingPlanApproval(repoRoot, runState);

    case "selecting_packet":
      return handlePacketSelection(repoRoot, runState, config);

    case "negotiating_contract":
      return handleContractNegotiation(factory, repoRoot, workspaceDir, runState, config, memory);

    case "building_packet":
      return handleBuilding(factory, repoRoot, workspaceDir, runState, config, memory);

    case "evaluating_packet":
      return handleEvaluation(factory, repoRoot, workspaceDir, runState, config, memory);

    case "fixing_packet":
      return handleFixing(factory, repoRoot, workspaceDir, runState, config, memory);

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

    case "qa_review":
      return handleQAReview(factory, repoRoot, workspaceDir, runState, config, memory);

    case "round2_planning":
      return handleRound2Planning(factory, repoRoot, workspaceDir, runState, config, memory);

    case "awaiting_round2_approval":
      return handleAwaitingRound2Approval(repoRoot, runState);

    default:
      throw new Error(`Unknown phase: ${runState.phase}`);
  }
}

// ------------------------------------
// Phase handlers
// Return RunState to advance, or null to retry the same phase
// ------------------------------------

async function handlePlanning(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  appendEvent(repoRoot, runState.runId, { event: "planning.started", phase: "planning" });

  // Load planning context if it exists (from --context or operator skill)
  const planningContext = readPlanningContext(repoRoot, runState.runId);

  // Attempt SDK resume if the planner crashed on a prior attempt
  const resumeSessionId = getResumeSessionId(
    factory, "planner", repoRoot, runState.runId, "spec",
  );

  const result = await runPlanner(factory.forRole("planner"), runState.objective, {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    config,
    memory,
  }, undefined, undefined, planningContext, undefined, resumeSessionId ?? undefined);

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

  // Persist devServer config discovered by the planner into config.json
  if (result.devServer) {
    config.devServer = result.devServer;
    const configPath = path.join(getRunDir(repoRoot, runState.runId), "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[${runState.runId}] Dev server config saved: ${result.devServer.command} (port ${result.devServer.port})`);
  }

  appendEvent(repoRoot, runState.runId, {
    event: "planning.completed",
    phase: "planning",
    detail: `${result.packets.length} packets planned`,
  });

  // Encode spec artifacts and planning.completed event into run memory
  if (memory) {
    const runDir = getRunDir(repoRoot, runState.runId);
    memory.encodeInBackground([
      ...specToDocuments(runDir),
      ...eventsToDocuments([{
        ts: new Date().toISOString(),
        event: "planning.completed",
        phase: "planning",
        detail: `${result.packets.length} packets planned`,
      }]),
    ]);
  }

  const packetOrder = result.packets.map((p) => p.id);

  // Route to plan review or directly to approval based on config
  if (!config.skipPlanReview) {
    return updateRun(repoRoot, runState.runId, {
      phase: "plan_review",
      packetOrder,
    });
  }

  // Skip plan review — go directly to plan approval gate
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
 * Plan review loop: have the reviewer evaluate the plan, and if issues are found,
 * send the planner back to revise. Repeats up to maxPlanReviewRounds.
 */
async function handlePlanReview(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  const maxRounds = config.maxPlanReviewRounds;

  // Count how many review rounds have already happened (from event stream)
  const events = readEvents(repoRoot, runState.runId);
  const reviewRound = events.filter((e) => e.event === "plan_review.started").length + 1;

  appendEvent(repoRoot, runState.runId, {
    event: "plan_review.started",
    phase: "plan_review",
    detail: `Plan review round ${reviewRound}/${maxRounds}`,
  });

  // Read the plan artifacts to pass to the reviewer
  const specContent = readSpec(repoRoot, runState.runId);
  const runDir = getRunDir(repoRoot, runState.runId);
  const specDir = path.join(runDir, "spec");

  let packetsContent: string;
  try {
    packetsContent = fs.readFileSync(path.join(specDir, "packets.json"), "utf-8");
  } catch {
    console.log(`[${runState.runId}] Cannot read packets.json for plan review`);
    return null;
  }

  let riskRegisterContent: string | undefined;
  try {
    riskRegisterContent = fs.readFileSync(path.join(specDir, "risk-register.json"), "utf-8");
  } catch { /* optional */ }

  let integrationScenariosContent: string | undefined;
  try {
    integrationScenariosContent = fs.readFileSync(path.join(specDir, "integration-scenarios.json"), "utf-8");
  } catch { /* optional */ }

  let planningContextContent: string | undefined;
  try {
    const ctx = readPlanningContext(repoRoot, runState.runId);
    if (ctx) {
      planningContextContent = JSON.stringify(ctx, null, 2);
    }
  } catch { /* optional */ }

  // Run the plan reviewer
  const reviewResult = await runPlanReview(
    factory.forRole("plan_reviewer"),
    specContent,
    packetsContent,
    riskRegisterContent,
    integrationScenariosContent,
    planningContextContent,
    runState.objective,
    { repoRoot, workspaceDir, runId: runState.runId, config, memory, useClaudeBackend: factory.isClaudeBackend("plan_reviewer") },
  );

  if (!reviewResult.success || !reviewResult.review) {
    // Reviewer crashed — retry
    console.log(`[${runState.runId}] Plan reviewer did not produce output: ${reviewResult.error}`);
    return null;
  }

  const review = reviewResult.review;

  // Write the review artifact
  atomicWriteJson(
    path.join(specDir, `plan-review-r${reviewRound}.json`),
    review,
  );

  // Encode plan review into run memory
  if (memory && review) {
    memory.encodeInBackground([planReviewToDocument(review, reviewRound)]);
  }

  if (review.verdict === "approve") {
    appendEvent(repoRoot, runState.runId, {
      event: "plan_review.completed",
      phase: "plan_review",
      detail: `Plan approved by reviewer (${review.issues.length} issues noted)`,
    });

    // Transition to operator approval
    appendEvent(repoRoot, runState.runId, {
      event: "plan.awaiting_approval",
      phase: "awaiting_plan_approval",
      detail: `${runState.packetOrder.length} packets ready for review (reviewer approved)`,
    });

    return updateRun(repoRoot, runState.runId, {
      phase: "awaiting_plan_approval",
    });
  }

  // Verdict is "revise"
  appendEvent(repoRoot, runState.runId, {
    event: "plan_review.revision_requested",
    phase: "plan_review",
    detail: `Revision requested: ${review.issues.filter((i) => i.severity === "critical").length} critical, ` +
      `${review.issues.filter((i) => i.severity === "major").length} major issues`,
  });

  if (reviewRound >= maxRounds) {
    // Max rounds reached — proceed to approval with the review attached
    console.log(
      `[${runState.runId}] Plan review reached max rounds (${maxRounds}). ` +
      `Proceeding to operator approval with review attached.`,
    );

    appendEvent(repoRoot, runState.runId, {
      event: "plan_review.completed",
      phase: "plan_review",
      detail: `Max review rounds reached. Proceeding with ${review.issues.length} unresolved issues.`,
    });

    appendEvent(repoRoot, runState.runId, {
      event: "plan.awaiting_approval",
      phase: "awaiting_plan_approval",
      detail: `${runState.packetOrder.length} packets ready for review (reviewer had unresolved concerns)`,
    });

    return updateRun(repoRoot, runState.runId, {
      phase: "awaiting_plan_approval",
    });
  }

  // Call planner again with revision context
  console.log(
    `[${runState.runId}] Plan reviewer requested revision (round ${reviewRound}/${maxRounds}). ` +
    `${review.issues.length} issues to address.`,
  );

  const planningContext = readPlanningContext(repoRoot, runState.runId);

  const revisionContext: RevisionContext = {
    previousSpec: specContent,
    previousPackets: packetsContent,
    review,
    round: reviewRound,
  };

  const planResult = await runPlanner(
    factory.forRole("planner"),
    runState.objective,
    { repoRoot, workspaceDir, runId: runState.runId, config, memory },
    undefined,
    undefined,
    planningContext,
    revisionContext,
  );

  if (!planResult.success) {
    // Planner failed to produce revised plan — retry the review phase
    console.log(`[${runState.runId}] Planner revision failed: ${planResult.error}`);
    return null;
  }

  // Plan has been revised — update packet order and loop back to plan_review
  const newPacketOrder = planResult.packets.map((p) => p.id);
  return updateRun(repoRoot, runState.runId, {
    phase: "plan_review",
    packetOrder: newPacketOrder,
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
  config: ProjectConfig,
): Promise<RunState> {
  // Determine which packet list and completed list to use based on round
  const isRound2 = isRound2Active(runState);
  const activePacketOrder = isRound2 ? runState.round2PacketOrder : runState.packetOrder;
  const activeCompletedIds = isRound2 ? runState.round2CompletedPacketIds : runState.completedPacketIds;

  const packets = isRound2
    ? readRound2Packets(repoRoot, runState.runId)
    : readPackets(repoRoot, runState.runId);
  const nextPacket = selectNextPacket(packets, runState);

  if (!nextPacket) {
    // Check if all packets in the active round are done
    const allDone = activeCompletedIds.length >= activePacketOrder.length && activePacketOrder.length > 0;

    if (allDone) {
      // All packets for this round are complete — route to QA or finish
      if (config.skipQA) {
        appendEvent(repoRoot, runState.runId, { event: "run.completed", phase: "completed" });
        return transition(repoRoot, runState, "completed");
      }
      // Transition to QA review instead of completed
      return transition(repoRoot, runState, "qa_review");
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
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;
  const allPackets = readAllPackets(repoRoot, runState.runId);
  const packet = allPackets.find((p) => p.id === packetId);
  if (!packet) throw new Error(`Packet ${packetId} not found`);

  // Check if contract already exists
  let existingContract: PacketContract | undefined;
  try {
    existingContract = readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
  } catch { /* no final contract yet */ }

  if (existingContract) {
    // Determine if this is a renegotiation (contract gap) or a resume
    const events = readEvents(repoRoot, runState.runId);
    const hasContractGapEvent = events.some(
      (e) => e.event === "evaluator.failed" && e.packetId === packetId &&
        // Only count as renegotiation if there was an eval failure AFTER the contract was accepted
        events.some((a) => a.event === "contract.accepted" && a.packetId === packetId &&
          new Date(a.ts).getTime() < new Date(e.ts).getTime()),
    );

    if (!hasContractGapEvent) {
      // Resume case — contract was accepted in a prior session, skip to building
      return updateRun(repoRoot, runState.runId, { phase: "building_packet" });
    }

    // Renegotiation: fall through with existing contract as context
    console.log(`[${runState.runId}] Renegotiating contract for ${packetId} (additive renegotiation)`);
  }

  // Load evaluator report for renegotiation context (if available)
  let evalReport: EvaluatorReport | undefined;
  if (existingContract) {
    try {
      evalReport = readArtifact(repoRoot, runState.runId, `packets/${packetId}/evaluator/evaluator-report.json`, EvaluatorReportSchema);
    } catch { /* no eval report available */ }
  }

  const outcome = await negotiateContract(factory, packet, readRiskRegister(repoRoot, runState.runId), {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    config,
    specExcerpt: readSpec(repoRoot, runState.runId),
    memory,
  }, existingContract, evalReport);

  switch (outcome.kind) {
    case "accepted": {
      if (memory) {
        try {
          const acceptedContract = readArtifact(
            repoRoot, runState.runId,
            `packets/${packetId}/contract/final.json`,
            PacketContractSchema,
          );
          memory.encodeInBackground([contractToDocument(acceptedContract, packetId)]);
        } catch { /* contract file may not be written yet in edge cases */ }
      }
      return updateRun(repoRoot, runState.runId, { phase: "building_packet" });
    }

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
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  evalReport?: EvaluatorReport,
  resumeSessionId?: string | null,
  memory?: RunMemory | null,
  baselineGateFailures?: BaselineGateFailure[],
): Promise<BuilderRunResult> {
  const packetId = runState.currentPacketId!;
  const contract = readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
  const contextOverrides = readContextOverrides(repoRoot, runState.runId);
  const allCompletedIds = [...runState.completedPacketIds, ...runState.round2CompletedPacketIds];
  const completionContexts = readCompletionContexts(repoRoot, runState.runId, allCompletedIds);

  // Query memvid for semantically relevant context from prior packets
  let memoryContext: string | undefined;
  if (memory) {
    try {
      memoryContext = await queryMemoryContext(memory, contract, 'builder');
    } catch (err) {
      console.log(`[memvid] Warning: builder memory context query failed: ${(err as Error).message}`);
    }
  }

  // Build full plan context and timeline for builder
  // Read events once here; pass to buildRunTimeline to avoid a redundant file read.
  const allPackets = readAllPackets(repoRoot, runState.runId);
  const currentPacket = allPackets.find((p) => p.id === packetId);
  const currentEvents = readEvents(repoRoot, runState.runId);
  const runTimelineStr = buildRunTimeline(repoRoot, runState.runId, currentEvents);

  // Map packets to the shape the builder prompt expects
  const packetSummaries = allPackets.map((p) => ({
    id: p.id,
    title: p.title,
    objective: p.objective,
    status: p.status,
    expectedFiles: p.expectedFiles.length > 0 ? p.expectedFiles : undefined,
    criticalConstraints: p.criticalConstraints.length > 0 ? p.criticalConstraints : undefined,
    notes: p.notes.length > 0 ? p.notes : undefined,
  }));

  const builderCtx: BuilderContext = {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    packetId,
    config,
    spec: readSpec(repoRoot, runState.runId),
    riskRegister: readRiskRegister(repoRoot, runState.runId),
    priorEvalReport: evalReport,
    contextOverrides,
    completionContexts,
    memoryContext,
    completedPacketIds: allCompletedIds,
    resumeSessionId: resumeSessionId ?? undefined,
    memory,
    allPackets: packetSummaries,
    runTimeline: runTimelineStr,
    packetNotes: currentPacket?.notes && currentPacket.notes.length > 0 ? currentPacket.notes : undefined,
    expectedFiles: currentPacket?.expectedFiles && currentPacket.expectedFiles.length > 0 ? currentPacket.expectedFiles : undefined,
    criticalConstraints: currentPacket?.criticalConstraints && currentPacket.criticalConstraints.length > 0 ? currentPacket.criticalConstraints : undefined,
    packetType: contract.packetType,
    baselineGateFailures,
  };
  return runBuilder(factory.forRole("builder"), contract, builderCtx);
}

async function handleBuilding(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;

  appendEvent(repoRoot, runState.runId, {
    event: "builder.started",
    phase: "building_packet",
    packetId,
  });

  // Baseline gate check — run once before first build to catch pre-existing issues.
  const priorBaseline = readEvents(repoRoot, runState.runId).filter(
    (e) => (e.event === "gate.baseline_passed" || e.event === "gate.baseline_failed")
      && e.packetId === packetId,
  );
  let baselineGateFailures: BaselineGateFailure[] | undefined;
  if (priorBaseline.length === 0) {
    // Read packetType from the finalized contract (already written by this point) rather
    // than calling readAllPackets() just to get one field.
    let baselinePacketType: import("./schemas.js").PacketType = "backend_feature";
    try {
      const baselineContract = readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
      baselinePacketType = baselineContract.packetType;
    } catch { /* contract missing: use default */ }
    console.log(`[${runState.runId}] Running baseline gate check for ${packetId}...`);
    const baselineResults = await runToolGates(workspaceDir, baselinePacketType, config);
    const failures = baselineResults.filter((g) => !g.passed && !g.skipped);
    if (failures.length > 0) {
      console.log(`[${runState.runId}] WARNING: Baseline gates failed — pre-existing issues detected`);
      appendEvent(repoRoot, runState.runId, {
        event: "gate.baseline_failed", phase: "building_packet", packetId,
        detail: JSON.stringify(failures.map((f) => ({ gate: f.gate, summary: f.summary }))),
      });
      baselineGateFailures = failures.map((f) => ({
        gate: f.gate, summary: f.summary, errors: f.errors,
      }));
    } else {
      appendEvent(repoRoot, runState.runId, {
        event: "gate.baseline_passed", phase: "building_packet", packetId,
        detail: `${baselineResults.filter((r) => !r.skipped).length} gates passed`,
      });
    }
  } else if (priorBaseline.some((e) => e.event === "gate.baseline_failed")) {
    // Re-read baseline failures from event detail for crash-retry path
    const failEvent = priorBaseline.find((e) => e.event === "gate.baseline_failed");
    if (failEvent?.detail) {
      baselineGateFailures = parseBaselineGateFailures(failEvent.detail);
    }
  }

  // Attempt SDK resume if the backend is Claude and a prior session crashed
  const resumeSessionId = getResumeSessionId(
    factory, "builder", repoRoot, runState.runId,
    `packets/${packetId}/builder`,
  );

  const result = await executeBuilder(factory, repoRoot, workspaceDir, runState, config, undefined, resumeSessionId, memory, baselineGateFailures);

  if (result.report?.claimsDone) {
    appendEvent(repoRoot, runState.runId, {
      event: "builder.completed",
      phase: "building_packet",
      packetId,
    });

    // Encode builder artifacts into run memory
    if (memory && result.report) {
      const docs: MemvidDocument[] = [builderReportToDocument(result.report, packetId)];
      const latestTranscript = findLatestTranscript(repoRoot, runState.runId, packetId, "builder");
      if (latestTranscript) {
        docs.push(...transcriptToDocuments(latestTranscript, packetId, "builder"));
      }
      memory.encodeInBackground(docs);
    }

    // Run tool gates before proceeding to evaluator
    const gateTransition = await runGatesBetweenBuilderAndEvaluator(
      repoRoot, workspaceDir, runState, config, packetId,
    );
    if (gateTransition) return gateTransition;

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
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
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

  // Find the builder's transcript so the evaluator can investigate the builder's reasoning
  const builderTranscriptPath = findLatestTranscript(repoRoot, runState.runId, packetId, "builder");

  const allCompletedIds = [...runState.completedPacketIds, ...runState.round2CompletedPacketIds];
  const completionContexts = readCompletionContexts(repoRoot, runState.runId, allCompletedIds);

  // Query memvid for semantically relevant context from prior packets
  let evalMemoryContext: string | undefined;
  if (memory) {
    try {
      evalMemoryContext = await queryMemoryContext(memory, contract, 'evaluator');
    } catch (err) {
      console.log(`[memvid] Warning: evaluator memory context query failed: ${(err as Error).message}`);
    }
  }

  // Load gate results to inject into evaluator context
  const gateResultsSummary = readGateResultsSummary(repoRoot, runState.runId, packetId);

  // Check for prior crashed evaluator session and attempt resume or recovery
  let recoveryContext: string | null = null;
  let resumeSessionId: string | null = null;
  const events = readEvents(repoRoot, runState.runId);
  const lastEvalEvent = [...events].reverse().find(
    (e) => e.packetId === packetId && e.event === "evaluator.failed",
  );
  if (lastEvalEvent?.detail?.includes("without report")) {
    // Tier 1: SDK resume (Claude backend only)
    resumeSessionId = getResumeSessionId(
      factory, "evaluator", repoRoot, runState.runId,
      `packets/${packetId}/evaluator`,
    );
    if (resumeSessionId) {
      console.log(
        `[${runState.runId}] Resuming evaluator session for ${packetId} (session: ${resumeSessionId.slice(0, 8)}...)`,
      );
    } else {
      // Tier 2: Recovery-agent fallback (Codex backend or no prior session)
      const priorTranscript = findLatestTranscript(repoRoot, runState.runId, packetId, "evaluator");
      if (priorTranscript) {
        console.log(
          `[${runState.runId}] Recovering context from crashed evaluator session for ${packetId}...`,
        );
        recoveryContext = await recoverFromCrashedSession(
          factory.claudeBackend,
          priorTranscript,
          contract,
          memory,
        );
        if (recoveryContext) {
          console.log(
            `[${runState.runId}] Recovery context produced for ${packetId} (${recoveryContext.length} chars)`,
          );
        }
      }
    }
  }

  // Use the active round's packet order for future-packet context
  const activeOrder = isRound2Active(runState)
    ? runState.round2PacketOrder : runState.packetOrder;
  const futurePacketsSummary = buildFuturePacketsSummary(
    repoRoot, runState.runId, packetId, activeOrder,
  );

  // Resolve current packet for evaluator — for expectedFiles smoke-test
  const allPacketsForEval = readAllPackets(repoRoot, runState.runId);
  const currentPacketForEval = allPacketsForEval.find((p) => p.id === packetId);

  const evaluatorCtx: EvaluatorContext = {
    repoRoot,
    workspaceDir,
    runId: runState.runId,
    packetId,
    config,
    riskRegister: readRiskRegister(repoRoot, runState.runId),
    evaluatorGuide,
    completionContexts,
    memoryContext: evalMemoryContext,
    gateResultsSummary,
    recoveryContext: recoveryContext ?? undefined,
    futurePacketsSummary,
    builderTranscriptPath: builderTranscriptPath ?? undefined,
    completedPacketIds: allCompletedIds,
    resumeSessionId: resumeSessionId ?? undefined,
    memory,
    expectedFiles: currentPacketForEval?.expectedFiles && currentPacketForEval.expectedFiles.length > 0
      ? currentPacketForEval.expectedFiles
      : undefined,
    builderCommitCount: builderReport.commitShas?.length ?? 0,
    useClaudeBackend: factory.isClaudeBackend("evaluator"),
  };
  const result = await runEvaluator(factory.forRole("evaluator"), contract, builderReport, evaluatorCtx);

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

  // Persist evaluator report so the fix loop can read it
  const evalReportDir = path.join(
    getRunDir(repoRoot, runState.runId),
    "packets", packetId, "evaluator",
  );
  fs.mkdirSync(evalReportDir, { recursive: true });
  atomicWriteJson(
    path.join(evalReportDir, "evaluator-report.json"),
    result.report,
  );

  // --- Criterion expansion: process evaluator-proposed criteria ---

  // Reject invalid dual reports (addedCriteria + contractGapDetected)
  if (isInvalidDualReport(result.report)) {
    console.log(
      `[${runState.runId}] Invalid evaluator report for ${packetId}: ` +
      `both addedCriteria and contractGapDetected set. Retrying evaluator.`,
    );
    appendEvent(repoRoot, runState.runId, {
      event: "evaluator.failed",
      phase: "evaluating_packet",
      packetId,
      detail: "Invalid report: addedCriteria + contractGapDetected are mutually exclusive — will retry",
    });
    return null; // retry
  }

  // Process medium-severity criterion expansion
  if (result.report.addedCriteria.length > 0) {
    const existingEvalCount = contract.acceptance.filter(
      (c) => c.source === "evaluator",
    ).length;
    const validated = processProposedCriteria(result.report, existingEvalCount);

    if (validated.length > 0) {
      // Count eval rounds from events for this packet
      const events = readEvents(repoRoot, runState.runId);
      const evalRound = events.filter(
        (e) => e.event === "evaluator.started" && e.packetId === packetId,
      ).length;

      const newCriteria = assignCriterionIds(validated, existingEvalCount);
      // Set the eval round on each criterion
      for (const c of newCriteria) {
        c.addedInEvalRound = evalRound;
      }

      // Append to final.json (single source of truth)
      const updatedAcceptance = [...contract.acceptance, ...newCriteria];
      const updatedContract = { ...contract, acceptance: updatedAcceptance };
      const contractPath = path.join(
        getRunDir(repoRoot, runState.runId), "packets", packetId, "contract", "final.json",
      );
      atomicWriteJson(contractPath, updatedContract);

      // Audit log
      appendEvaluatorAdditions(repoRoot, runState.runId, packetId, newCriteria, evalRound);

      const ids = newCriteria.map((c) => c.id).join(", ");
      console.log(
        `[${runState.runId}] Criterion expansion for ${packetId}: added ${newCriteria.length} criteria (${ids}). ` +
        `Total evaluator-added: ${existingEvalCount + newCriteria.length}`,
      );
      appendEvent(repoRoot, runState.runId, {
        event: "evaluator.criteria_expanded",
        phase: "evaluating_packet",
        packetId,
        detail: `Added ${newCriteria.length} criteria: ${ids}`,
      });
    }
  }

  // Log verdict completeness warnings
  if (result.verdictValidation && !result.verdictValidation.complete) {
    const vv = result.verdictValidation;
    console.log(
      `[${runState.runId}] Verdict map for ${packetId}: ${vv.coveredCount}/${vv.totalCount} criteria covered. ` +
      `Missing: ${vv.missingCriterionIds.join(", ")}`,
    );
  }

  if (result.report.overall === "pass") {
    const verdictDetail = result.verdictValidation && !result.verdictValidation.complete
      ? ` (verdict map incomplete: ${result.verdictValidation.coveredCount}/${result.verdictValidation.totalCount} criteria)`
      : result.verdictValidation
        ? ` (all ${result.verdictValidation.totalCount} criteria verified)`
        : "";
    appendEvent(repoRoot, runState.runId, {
      event: "evaluator.passed",
      phase: "evaluating_packet",
      packetId,
      detail: `Evaluator passed${verdictDetail}`,
    });

    // Generate and store completion summary for cross-packet context
    writeCompletionSummary(repoRoot, runState.runId, packetId, contract, builderReport, result.report);

    // Encode evaluator artifacts into run memory (completion summary is now written)
    if (memory) {
      const docs: MemvidDocument[] = [evalReportToDocument(result.report, packetId)];
      const latestTranscript = findLatestTranscript(repoRoot, runState.runId, packetId, "evaluator");
      if (latestTranscript) {
        docs.push(...transcriptToDocuments(latestTranscript, packetId, "evaluator"));
      }
      const summaryPath = path.join(
        getRunDir(repoRoot, runState.runId), "packets", packetId, "completion-summary.md",
      );
      try {
        const summary = fs.readFileSync(summaryPath, "utf-8");
        docs.push(completionSummaryToDocument(summary, packetId));
      } catch { /* summary not available */ }
      memory.encodeInBackground(docs);
    }

    // Check if this packet requires human review
    const allPkts = readAllPackets(repoRoot, runState.runId);
    const packet = allPkts.find((p) => p.id === packetId);

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

    // Track completion in the appropriate round's list
    const isR2Packet = runState.round >= 2 && runState.round2PacketOrder.includes(packetId);
    const field = isR2Packet ? 'round2CompletedPacketIds' as const : 'completedPacketIds' as const;

    if (runState.operatorFlags.pauseAfterCurrentPacket) {
      return pushToRunArray(repoRoot, runState.runId, field, packetId, {
        phase: "paused",
        currentPacketId: null,
        operatorFlags: { ...runState.operatorFlags, pauseAfterCurrentPacket: false },
      });
    }

    return pushToRunArray(repoRoot, runState.runId, field, packetId, {
      phase: "selecting_packet",
      currentPacketId: null,
    });
  }

  // Evaluator found issues
  const verdictSummary = result.verdictValidation
    ? ` | verdicts: ${result.verdictValidation.coveredCount}/${result.verdictValidation.totalCount}`
    : "";
  appendEvent(repoRoot, runState.runId, {
    event: "evaluator.failed",
    phase: "evaluating_packet",
    packetId,
    detail: `${result.report.hardFailures.length} hard failures${verdictSummary}`,
  });

  // Encode evaluator artifacts into run memory (fail path — no completion summary)
  if (memory) {
    const docs: MemvidDocument[] = [evalReportToDocument(result.report, packetId)];
    const latestTranscript = findLatestTranscript(repoRoot, runState.runId, packetId, "evaluator");
    if (latestTranscript) {
      docs.push(...transcriptToDocuments(latestTranscript, packetId, "evaluator"));
    }
    memory.encodeInBackground(docs);
  }

  if (hasContractGap(result.report)) {
    return updateRun(repoRoot, runState.runId, { phase: "negotiating_contract" });
  }

  return updateRun(repoRoot, runState.runId, { phase: "fixing_packet" });
}

async function handleFixing(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  const packetId = runState.currentPacketId!;

  // Count fix attempts from events
  const events = readEvents(repoRoot, runState.runId);

  // Find the most recent fix counter reset for this packet (watermark)
  const lastReset = [...events].reverse().find(
    (e) => e.event === "packet.fix_counter_reset" && e.packetId === packetId,
  );
  const lastResetTime = lastReset ? new Date(lastReset.ts).getTime() : 0;

  // Count fix-phase builder starts after the last reset, EXCLUDING session-crash
  // retries (where the previous attempt produced no result envelope). Session
  // crashes shouldn't burn fix-loop budget; they're transparent retries of the
  // same logical attempt. Without this guard, PKT-005 lost 9 of 10 fix slots
  // in 4 minutes when the builder was emitting plain-text "still polling"
  // updates while a background job ran (each "no envelope" outcome counted as
  // a failed fix attempt).
  const builderStartsInFix = events.filter(
    (e) =>
      e.event === "builder.started" &&
      e.packetId === packetId &&
      e.phase === "fixing_packet" &&
      new Date(e.ts).getTime() > lastResetTime,
  ).length;
  const sessionCrashesInFix = events.filter(
    (e) =>
      e.event === "worker.session_crashed" &&
      e.packetId === packetId &&
      new Date(e.ts).getTime() > lastResetTime,
  ).length;
  const fixAttempts = Math.max(0, builderStartsInFix - sessionCrashesInFix);

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

  // Resume only when retrying a crashed fix attempt (not starting a new fix iteration).
  // Detect: if the last builder.started in fixing_packet was NOT followed by evaluator.started,
  // the builder crashed and we should resume. If evaluator ran, it's a new iteration — fresh start.
  // Only look at events after the last fix counter reset (watermark) to avoid resuming stale sessions.
  //
  // ALSO: if this is the FIRST fix attempt (no fixing_packet builder.started yet) AND we have
  // a fresh evalReport, do NOT resume — the prior session's last assistant turn was the
  // result envelope, and resuming with CONTINUATION_PROMPT alone would just yield it again.
  // Start a fresh session that gets the full builder prompt with the eval failure report.
  const lastBuilderFixStart = [...events].reverse().find(
    (e) =>
      e.event === "builder.started" &&
      e.packetId === packetId &&
      e.phase === "fixing_packet" &&
      new Date(e.ts).getTime() > lastResetTime,
  );
  const evalFollowed = lastBuilderFixStart && events.some(
    (e) => e.event === "evaluator.started" && e.packetId === packetId &&
      new Date(e.ts).getTime() > new Date(lastBuilderFixStart.ts).getTime(),
  );
  const isFirstFixAttempt = !lastBuilderFixStart && !!evalReport;
  const resumeSessionId = (!evalFollowed && !isFirstFixAttempt)
    ? getResumeSessionId(factory, "builder", repoRoot, runState.runId, `packets/${packetId}/builder`)
    : null;

  appendEvent(repoRoot, runState.runId, {
    event: "builder.started",
    phase: "fixing_packet",
    packetId,
    detail: `Fix attempt ${fixAttempts + 1}/${config.maxFixLoopsPerPacket}${resumeSessionId ? " (resuming)" : ""}`,
  });

  // Re-read baseline gate failures (persisted as events in handleBuilding) so fix-loop
  // builders also see the PRE-EXISTING GATE FAILURES section when session resume fails.
  let baselineGateFailures: BaselineGateFailure[] | undefined;
  const baselineEvent = events.find(
    (e) => e.event === "gate.baseline_failed" && e.packetId === packetId,
  );
  if (baselineEvent?.detail) {
    baselineGateFailures = parseBaselineGateFailures(baselineEvent.detail);
  }

  const result = await executeBuilder(factory, repoRoot, workspaceDir, runState, config, evalReport, resumeSessionId, memory, baselineGateFailures);

  if (result.report?.claimsDone) {
    // Encode builder artifacts into run memory (fix phase)
    if (memory && result.report) {
      const docs: MemvidDocument[] = [builderReportToDocument(result.report, packetId)];
      const latestTranscript = findLatestTranscript(repoRoot, runState.runId, packetId, "builder");
      if (latestTranscript) {
        docs.push(...transcriptToDocuments(latestTranscript, packetId, "builder"));
      }
      memory.encodeInBackground(docs);
    }

    // Run tool gates before proceeding to evaluator
    const gateTransition = await runGatesBetweenBuilderAndEvaluator(
      repoRoot, workspaceDir, runState, config, packetId,
    );
    if (gateTransition) return gateTransition;

    return updateRun(repoRoot, runState.runId, { phase: "evaluating_packet" });
  }

  // Builder session ended without completing — emit worker.session_crashed
  // (NOT builder.failed) so the fix-loop counter doesn't penalize this transparent
  // retry. The next iteration of handleFixing will resume the same session.
  console.log(`[${runState.runId}] Builder fix session ended without completing ${packetId}. Will resume (not counted as fix attempt).`);
  appendEvent(repoRoot, runState.runId, {
    event: "worker.session_crashed",
    phase: "fixing_packet",
    packetId,
    detail: "Builder fix session ended without completion — will resume; not counted toward fix-loop budget",
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
// QA / Round 2 phase handlers (stubs -- full implementation pending)
// ------------------------------------

async function handleQAReview(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  const round = runState.round;
  appendEvent(repoRoot, runState.runId, {
    event: "qa.started",
    phase: "qa_review",
    detail: `QA review for round ${round}`,
  });

  // Gather all context for the QA agent
  const contracts = gatherAllContracts(repoRoot, runState.runId, runState);
  const builderReports = gatherAllBuilderReports(repoRoot, runState.runId, runState);
  const integrationScenarios = readIntegrationScenarios(repoRoot, runState.runId);
  const evaluatorGuide = readEvaluatorGuide(repoRoot, runState.runId);
  const spec = readSpec(repoRoot, runState.runId);

  // Gather completion contexts for all packets that ran in this round
  const completedPacketIds = isRound2Active(runState)
    ? [...runState.completedPacketIds, ...runState.round2CompletedPacketIds]
    : runState.completedPacketIds;
  const completionContexts = readCompletionContexts(repoRoot, runState.runId, completedPacketIds);

  // Attempt SDK resume if the QA agent crashed on a prior attempt
  const resumeSessionId = getResumeSessionId(
    factory, "qa_agent", repoRoot, runState.runId,
    `spec/qa-r${round}`,
  );

  const result = await runQA(
    factory.forRole("qa_agent"),
    spec,
    contracts,
    builderReports,
    evaluatorGuide,
    integrationScenarios,
    completionContexts,
    { repoRoot, workspaceDir, runId: runState.runId, config, memory, useClaudeBackend: factory.isClaudeBackend("qa_agent") },
    round,
    config.devServer ?? undefined,
    resumeSessionId ?? undefined,
  );

  if (!result.report) {
    // QA agent crashed without producing output — retry
    console.log(`[${runState.runId}] QA agent session ended without producing a report. Will retry.`);
    return null;
  }

  // Write QA report
  const reportPath = `spec/qa-report-r${round}.json`;
  atomicWriteJson(
    path.join(getRunDir(repoRoot, runState.runId), reportPath),
    result.report,
  );

  // Encode QA report into run memory
  if (memory) {
    memory.encodeInBackground([qaReportToDocument(result.report, round)]);
  }

  if (qaPassesThreshold(result.report, config.qaPassThreshold)) {
    appendEvent(repoRoot, runState.runId, {
      event: "qa.passed",
      phase: "qa_review",
      detail: `QA passed (${result.report.issues.length} issues, all within threshold)`,
    });
    appendEvent(repoRoot, runState.runId, { event: "run.completed", phase: "completed" });
    return updateRun(repoRoot, runState.runId, {
      phase: "completed",
      qaReportPath: reportPath,
    });
  }

  // QA failed
  appendEvent(repoRoot, runState.runId, {
    event: "qa.failed",
    phase: "qa_review",
    detail: `${result.report.issues.length} issues found (${
      result.report.issues.filter((i) => i.severity === "critical").length
    } critical, ${
      result.report.issues.filter((i) => i.severity === "major").length
    } major)`,
  });

  if (round >= (runState.maxRounds ?? config.maxRounds)) {
    // Max rounds reached — escalate to human
    console.log(`[${runState.runId}] QA failed after max rounds (${round}). Escalating to human.`);
    return updateRun(repoRoot, runState.runId, {
      phase: "needs_human",
      qaReportPath: reportPath,
    });
  }

  // Trigger next round of planning — increment round but keep history intact
  return updateRun(repoRoot, runState.runId, {
    phase: "round2_planning",
    qaReportPath: reportPath,
    round: round + 1,
  });
}

async function handleRound2Planning(
  factory: BackendFactory,
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  memory: RunMemory | null,
): Promise<RunState | null> {
  appendEvent(repoRoot, runState.runId, {
    event: "round2.planning.started",
    phase: "round2_planning",
  });

  // Load QA report from the qaReportPath stored in run state (set when QA fails)
  let qaReport: QAReport | undefined;
  if (runState.qaReportPath) {
    try {
      qaReport = readArtifact(repoRoot, runState.runId, runState.qaReportPath, QAReportSchema);
    } catch { /* fall through */ }
  }
  if (!qaReport) {
    console.error(`[${runState.runId}] Cannot start R${runState.round} planning: no QA report at ${runState.qaReportPath}`);
    return transition(repoRoot, runState, "needs_human", "No QA report available for planning");
  }

  console.log(
    `[${runState.runId}] Round ${runState.round} planner reading QA report: ${runState.qaReportPath}`,
  );

  const originalPackets = readPackets(repoRoot, runState.runId);
  const evaluatorGuide = readEvaluatorGuide(repoRoot, runState.runId);
  const spec = readSpec(repoRoot, runState.runId);

  // Attempt SDK resume if the round planner crashed on a prior attempt
  const resumeSessionId = getResumeSessionId(
    factory, "round2_planner", repoRoot, runState.runId, "spec",
  );

  const result = await runRound2Planner(
    factory.forRole("round2_planner"),
    qaReport,
    spec,
    originalPackets,
    evaluatorGuide,
    { repoRoot, workspaceDir, runId: runState.runId, config, round: runState.round, memory },
    resumeSessionId ?? undefined,
  );

  if (!result.success) {
    console.log(`[${runState.runId}] Round ${runState.round} planner failed: ${result.error}`);
    return null; // retry
  }

  // Enforce round-specific packet IDs — the planner may ignore the prompt instruction
  // and reuse IDs from prior rounds. Rewrite any PKT-R{N} prefix to PKT-R{currentRound}.
  const roundPrefix = `PKT-R${runState.round}`;
  for (const pkt of result.packets) {
    const oldId = pkt.id;
    // Replace any PKT-R{digit(s)}- prefix with the correct round prefix
    pkt.id = pkt.id.replace(/^PKT-R\d+-/, `${roundPrefix}-`);
    if (pkt.id !== oldId) {
      console.log(`[${runState.runId}] Renamed packet ${oldId} → ${pkt.id}`);
    }
  }
  // Re-write the round-specific packets file with corrected IDs
  const specDir = path.join(getRunDir(repoRoot, runState.runId), "spec");
  atomicWriteJson(path.join(specDir, `packets-r${runState.round}.json`), result.packets);

  appendEvent(repoRoot, runState.runId, {
    event: "round2.planning.completed",
    phase: "round2_planning",
    detail: `${result.packets.length} fix packets planned for round ${runState.round}`,
  });

  // Append new packet IDs to the existing order (don't replace — history is additive)
  // Dedupe: only add IDs that aren't already in the order (guards against planner reusing IDs)
  const existingIds = new Set(runState.round2PacketOrder);
  const newPacketIds = result.packets.map((p) => p.id).filter((id) => !existingIds.has(id));
  if (newPacketIds.length === 0) {
    console.log(`[${runState.runId}] Round ${runState.round} planner produced no new packet IDs (all duplicates of existing). Will retry planning.`);
    return null; // retry — planner needs to generate unique IDs
  }
  const round2PacketOrder = [...runState.round2PacketOrder, ...newPacketIds];

  // Auto-approve rounds 3+ (first fix round gets human review, subsequent rounds keep going)
  if (runState.round > 2) {
    appendEvent(repoRoot, runState.runId, {
      event: "round2.plan.approved",
      phase: "selecting_packet",
      detail: `Auto-approved round ${runState.round} fix packets (${result.packets.length} packets)`,
    });
    console.log(`[${runState.runId}] Auto-approved round ${runState.round} fix plan (${result.packets.length} packets)`);
    return updateRun(repoRoot, runState.runId, {
      phase: "selecting_packet",
      round2PacketOrder,
    });
  }

  // Round 2: require operator approval
  appendEvent(repoRoot, runState.runId, {
    event: "round2.plan.awaiting_approval",
    phase: "awaiting_round2_approval",
    detail: `${result.packets.length} fix packets ready for review`,
  });

  return updateRun(repoRoot, runState.runId, {
    phase: "awaiting_round2_approval",
    round2PacketOrder,
  });
}

/**
 * Gate: wait for operator to approve the round 2 plan.
 */
async function handleAwaitingRound2Approval(
  repoRoot: string,
  runState: RunState,
): Promise<RunState> {
  if (gatePrintedForPhase !== "awaiting_round2_approval") {
    gatePrintedForPhase = "awaiting_round2_approval";
    const runDir = getRunDir(repoRoot, runState.runId);
    console.log(`[${runState.runId}] Round 2 plan ready for review.`);
    console.log(`  QA report: ${runDir}/spec/qa-report-r${runState.round}.json`);
    console.log(`  R2 packets: ${runDir}/spec/packets-r2.json`);
    console.log(`  R2 summary: ${runDir}/spec/round2-plan-summary.md`);
    console.log(`  Approve: echo '{"type":"approve_round2","createdAt":"...","message":"go"}' > ${runDir}/inbox/approve-r2.json`);
  }
  await sleep(GATE_POLL_INTERVAL_MS);
  return runState;
}

// ------------------------------------
// Tool gates (between builder and evaluator)
// ------------------------------------

/**
 * Run tool gates after the builder claims done.
 *
 * If any blocking gate fails, synthesize an EvaluatorReport from the gate
 * failures and write it to the evaluator artifact dir. Then transition to
 * fixing_packet, saving the cost of a full evaluator session.
 *
 * Returns a RunState if gates blocked (caller should return it).
 * Returns null if all gates passed (caller should proceed to evaluator).
 */
async function runGatesBetweenBuilderAndEvaluator(
  repoRoot: string,
  workspaceDir: string,
  runState: RunState,
  config: ProjectConfig,
  packetId: string,
): Promise<RunState | null> {
  // Determine packet type for gate filtering
  const gatePkts = readAllPackets(repoRoot, runState.runId);
  const packet = gatePkts.find((p) => p.id === packetId);
  const packetType = packet?.type ?? "tooling";

  // Run all applicable gates
  const gateResults = await runToolGates(workspaceDir, packetType, config);

  // Log gate events
  for (const result of gateResults) {
    if (result.skipped) {
      appendEvent(repoRoot, runState.runId, {
        event: "gate.skipped",
        phase: runState.phase,
        packetId,
        detail: `${result.gate}: ${result.skipReason ?? "not applicable"}`,
      });
    } else if (result.passed) {
      appendEvent(repoRoot, runState.runId, {
        event: "gate.passed",
        phase: runState.phase,
        packetId,
        detail: `${result.gate} (${(result.durationMs / 1000).toFixed(1)}s)`,
      });
    } else {
      appendEvent(repoRoot, runState.runId, {
        event: "gate.failed",
        phase: runState.phase,
        packetId,
        detail: `${result.gate}: ${result.summary} (${(result.durationMs / 1000).toFixed(1)}s)`,
      });
    }
  }

  // Check for blocking failures
  const blockingFailures = gateResults.filter((g) => !g.passed && g.blocking && !g.skipped);

  if (blockingFailures.length > 0) {
    console.log(
      `[${runState.runId}] ${blockingFailures.length} blocking gate(s) failed for ${packetId}. ` +
      `Skipping evaluator, returning to builder fix loop.`,
    );

    appendEvent(repoRoot, runState.runId, {
      event: "gate.blocked",
      phase: runState.phase,
      packetId,
      detail: `Skipping evaluator: ${blockingFailures.map((f) => f.gate).join(", ")} failed`,
    });

    // Synthesize evaluator report from gate failures
    const syntheticReport = synthesizeEvalReportFromGates(packetId, gateResults);

    // Write the synthetic report so the fix loop can read it
    const evalDir = path.join(
      getRunDir(repoRoot, runState.runId),
      "packets",
      packetId,
      "evaluator",
    );
    fs.mkdirSync(evalDir, { recursive: true });
    atomicWriteJson(
      path.join(evalDir, "evaluator-report.json"),
      syntheticReport,
    );

    // Also store gate results for the evaluator prompt (when gates eventually pass)
    atomicWriteJson(
      path.join(
        getRunDir(repoRoot, runState.runId),
        "packets",
        packetId,
        "gate-results.json",
      ),
      gateResults,
    );

    return updateRun(repoRoot, runState.runId, { phase: "fixing_packet" });
  }

  // All blocking gates passed — store results for evaluator context
  if (gateResults.length > 0) {
    atomicWriteJson(
      path.join(
        getRunDir(repoRoot, runState.runId),
        "packets",
        packetId,
        "gate-results.json",
      ),
      gateResults,
    );
  }

  return null; // proceed to evaluator
}

// ------------------------------------
// Packet selection (TAD section 10)
// ------------------------------------

export function selectNextPacket(
  packets: Packet[],
  runState: RunState,
): Packet | null {
  // Use round 2+ packet order if in any fix round and round2PacketOrder is populated
  const isRound2 = isRound2Active(runState);
  const activeOrder = isRound2 ? runState.round2PacketOrder : runState.packetOrder;
  const activeDone = isRound2
    ? new Set([...runState.round2CompletedPacketIds])
    : new Set([...runState.completedPacketIds]);
  const blocked = new Set([...runState.blockedPacketIds]);
  const failed = new Set([...runState.failedPacketIds]);

  for (const id of activeOrder) {
    if (activeDone.has(id) || blocked.has(id) || failed.has(id)) continue;
    const packet = packets.find((p) => p.id === id);
    if (!packet) continue;
    // For R2 packets, R1 completed packets also satisfy dependencies
    const allDone = isRound2
      ? new Set([...activeDone, ...runState.completedPacketIds])
      : activeDone;
    if (packet.dependencies.every((dep) => allDone.has(dep))) return packet;
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

/** Read and merge all risk registers (R1 + all fix rounds). */
function readRiskRegister(repoRoot: string, runId: string): RiskRegister | undefined {
  const specDir = path.join(getRunDir(repoRoot, runId), "spec");
  const allRisks: RiskRegister["risks"] = [];
  try {
    // R1 risk register
    try {
      const r1 = readArtifact(repoRoot, runId, "spec/risk-register.json", RiskRegisterSchema);
      allRisks.push(...r1.risks);
    } catch { /* no R1 register */ }
    // Round-specific risk registers
    try {
      for (const file of fs.readdirSync(specDir)) {
        if (file.match(/^risk-register-r\d+\.json$/)) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(specDir, file), "utf-8"));
            const parsed = RiskRegisterSchema.parse(data);
            allRisks.push(...parsed.risks);
          } catch { /* skip corrupt */ }
        }
      }
    } catch { /* spec dir missing */ }
  } catch { /* fallthrough */ }
  return allRisks.length > 0 ? { risks: allRisks } : undefined;
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

/** Read all fix packets across all rounds (r2, r3, r4, ...). */
function readRound2Packets(repoRoot: string, runId: string): Packet[] {
  const specDir = path.join(getRunDir(repoRoot, runId), "spec");
  const allPackets: Packet[] = [];
  try {
    for (const file of fs.readdirSync(specDir)) {
      if (file.match(/^packets-r\d+\.json$/)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(specDir, file), "utf-8"));
          allPackets.push(...z.array(PacketSchema).parse(data));
        } catch { /* skip corrupt files */ }
      }
    }
  } catch { /* spec dir missing */ }
  return allPackets;
}

/** Read all packets (R1 + R2). Use when looking up a packet by ID regardless of round. */
function readAllPackets(repoRoot: string, runId: string): Packet[] {
  return [...readPackets(repoRoot, runId), ...readRound2Packets(repoRoot, runId)];
}

/**
 * Parse baseline gate failures from a serialized event detail string.
 * The detail is JSON-encoded as `Array<{ gate: string; summary: string }>`.
 * `errors` is always set to [] since errors are not persisted in the event log.
 */
function parseBaselineGateFailures(detail: string): BaselineGateFailure[] {
  const parsed = JSON.parse(detail) as Array<{ gate: string; summary: string }>;
  return parsed.map((f) => ({ gate: f.gate, summary: f.summary, errors: [] }));
}

/**
 * Build a human-readable run timeline from the event log.
 * This gives the builder context about what has happened in the run so far.
 * Pass `events` to avoid a redundant file read when the caller already has them.
 */
export function buildRunTimeline(repoRoot: string, runId: string, events?: EventEntry[]): string {
  const evts = events ?? readEvents(repoRoot, runId);
  const lines: string[] = [];
  let stepNum = 1;

  for (const event of evts) {
    switch (event.event) {
      case "planning.completed":
        lines.push(`${stepNum++}. Planning completed`);
        break;
      case "plan_review.completed":
        lines.push(`${stepNum++}. Plan review: ${event.detail ?? "completed"}`);
        break;
      case "plan.approved":
        lines.push(`${stepNum++}. Plan approved by operator`);
        break;
      case "contract.accepted":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: contract accepted`);
        break;
      case "builder.completed":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: builder completed`);
        break;
      case "evaluator.passed":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: ✓ evaluator passed`);
        break;
      case "evaluator.failed":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: ✗ evaluator failed — ${event.detail ?? "see report"}`);
        break;
      case "gate.passed":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: gate passed (${event.detail ?? ""})`);
        break;
      case "gate.failed":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: gate failed — ${event.detail ?? ""}`);
        break;
      case "packet.done":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: ✓ DONE`);
        break;
      case "packet.failed":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: ✗ FAILED — ${event.detail ?? ""}`);
        break;
      case "qa.started":
        lines.push(`${stepNum++}. QA review started (round ${event.detail ?? "?"})`);
        break;
      case "qa.passed":
        lines.push(`${stepNum++}. QA: ✓ passed`);
        break;
      case "qa.failed":
        lines.push(`${stepNum++}. QA: ✗ failed — ${event.detail ?? ""}`);
        break;
      case "round2.planning.completed":
        lines.push(`${stepNum++}. Round 2 planning completed — ${event.detail ?? ""}`);
        break;
      case "contract.escalated":
        lines.push(`${stepNum++}. ${event.packetId ?? "?"}: contract escalated — ${event.detail ?? ""}`);
        break;
      // Skip noisy events like heartbeats, pokes, nudges
      default:
        break;
    }
  }

  return lines.length > 0 ? lines.join("\n") : "No prior events — you are the first builder.";
}

function readIntegrationScenarios(repoRoot: string, runId: string): IntegrationScenario[] {
  try {
    const scenariosPath = path.join(getRunDir(repoRoot, runId), "spec", "integration-scenarios.json");
    const raw = JSON.parse(fs.readFileSync(scenariosPath, "utf-8"));
    return z.array(IntegrationScenarioSchema).parse(raw);
  } catch {
    return [];
  }
}


/**
 * Generic artifact gatherer — reads one artifact per completed packet.
 * Skips packets that don't have the artifact yet (e.g. in-progress or failed).
 */
function gatherArtifacts<T>(
  repoRoot: string,
  runId: string,
  runState: RunState,
  pathFn: (packetId: string) => string,
  schema: z.ZodType<T>,
): T[] {
  const results: T[] = [];
  const allIds = [...runState.completedPacketIds, ...runState.round2CompletedPacketIds];
  for (const packetId of allIds) {
    try {
      results.push(readArtifact(repoRoot, runId, pathFn(packetId), schema));
    } catch { /* skip packets without this artifact */ }
  }
  return results;
}

/**
 * Gather all finalized contracts for a run.
 */
function gatherAllContracts(repoRoot: string, runId: string, runState: RunState): PacketContract[] {
  return gatherArtifacts(
    repoRoot, runId, runState,
    (id) => `packets/${id}/contract/final.json`,
    PacketContractSchema,
  );
}

/**
 * Gather all builder reports for a run.
 */
function gatherAllBuilderReports(repoRoot: string, runId: string, runState: RunState): BuilderReport[] {
  return gatherArtifacts(
    repoRoot, runId, runState,
    (id) => `packets/${id}/builder/builder-report.json`,
    BuilderReportSchema,
  );
}

/**
 * Build a brief summary of future (upcoming) packets for the evaluator prompt.
 * Helps the evaluator understand what work remains so it can calibrate scope
 * expectations for the current packet.
 */
function buildFuturePacketsSummary(
  repoRoot: string,
  runId: string,
  currentPacketId: string,
  packetOrder: string[],
): string | undefined {
  const packets = readAllPackets(repoRoot, runId);
  const currentIndex = packetOrder.indexOf(currentPacketId);
  if (currentIndex < 0) return undefined;

  const futurePackets = packetOrder
    .slice(currentIndex + 1)
    .map((id) => packets.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null && p.status !== "done" && p.status !== "failed");

  if (futurePackets.length === 0) return undefined;

  return futurePackets
    .map((p) => `- **${p.id}**: ${p.title}\n  Objective: ${p.objective}`)
    .join("\n");
}

/**
 * Read gate results and format them as a summary string for the evaluator prompt.
 * Returns undefined if no gate results are available.
 */
function readGateResultsSummary(repoRoot: string, runId: string, packetId: string): string | undefined {
  try {
    const gateResultsPath = path.join(
      getRunDir(repoRoot, runId),
      "packets",
      packetId,
      "gate-results.json",
    );
    const raw = JSON.parse(fs.readFileSync(gateResultsPath, "utf-8")) as GateRunResult[];
    return formatGateResultsForPrompt(raw);
  } catch {
    return undefined;
  }
}

/**
 * Generate and write a completion context for a packet that passed evaluation.
 * The context is stored at packets/<packetId>/completion-context.json.
 */
function writeCompletionSummary(
  repoRoot: string,
  runId: string,
  packetId: string,
  contract: PacketContract,
  builderReport: BuilderReport,
  evaluatorReport: EvaluatorReport,
): void {
  try {
    const packets = readAllPackets(repoRoot, runId);
    const packet = packets.find((p) => p.id === packetId);
    if (!packet) return;

    const context = generateCompletionContext(packet, contract, builderReport, evaluatorReport, {
      cwd: repoRoot,
      commitShas: builderReport.commitShas ?? null,
    });
    const contextPath = path.join(
      getRunDir(repoRoot, runId),
      "packets",
      packetId,
      "completion-context.json",
    );
    atomicWriteJson(contextPath, context);
  } catch (err) {
    // Non-fatal: context generation should never break the orchestrator
    console.log(`[${runId}] Warning: failed to write completion context for ${packetId}: ${errorStr(err)}`);
  }
}

/**
 * Read all completion contexts for previously completed packets.
 * Returns a typed array of PacketCompletionContext objects.
 * Reads completion-context.json (new format); old completion-summary.md files
 * from prior runs are skipped — they lack the structured data.
 * Returns an empty array if no contexts are found.
 */
export function readCompletionContexts(
  repoRoot: string,
  runId: string,
  completedPacketIds: string[],
): PacketCompletionContext[] {
  if (completedPacketIds.length === 0) return [];

  const contexts: PacketCompletionContext[] = [];
  for (const packetId of completedPacketIds) {
    try {
      const contextPath = path.join(
        getRunDir(repoRoot, runId),
        "packets",
        packetId,
        "completion-context.json",
      );
      const raw = JSON.parse(fs.readFileSync(contextPath, "utf-8")) as unknown;
      const parsed = PacketCompletionContextSchema.safeParse(raw);
      if (parsed.success) {
        contexts.push(parsed.data);
      }
    } catch {
      // Context might not exist for packets from before this feature was added
      // (old runs with only completion-summary.md are gracefully skipped)
    }
  }

  return contexts;
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
    case "approve_round2": return "awaiting_round2_approval";
    case "skip_qa": return "qa_review";
    default: return null; // Always actionable
  }
}

async function processInbox(
  repoRoot: string,
  runState: RunState,
  memory: RunMemory | null,
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

      // Encode inbox message into run memory before consuming it
      if (memory) {
        memory.encodeInBackground([inboxMessageToDocument(msg, runState.currentPacketId ?? undefined)]);
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
            const isR2 = runState.round >= 2 && runState.round2PacketOrder.includes(pid);
            const approveField = isR2 ? 'round2CompletedPacketIds' as const : 'completedPacketIds' as const;
            runState = pushToRunArray(repoRoot, runState.runId, approveField, pid, {
              phase: "selecting_packet",
              currentPacketId: null,
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
                diagnosticHypothesis: msg.message ?? "Operator rejected the packet — see description for details",
                filesInvolved: [],
              }],
              rubricScores: [],
              criterionVerdicts: [],
              missingEvidence: [],
              nextActions: [msg.message ?? "Address operator feedback"],
              contractGapDetected: false,
              addedCriteria: [],
              additionalIssuesOmitted: false,
              advisoryEscalations: [],
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
              round2CompletedPacketIds: runState.round2CompletedPacketIds.filter((id) => id !== pid),
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

        case "approve_round2":
          if (runState.phase === "awaiting_round2_approval") {
            appendEvent(repoRoot, runState.runId, {
              event: "round2.plan.approved",
              phase: "selecting_packet",
              detail: msg.message ?? "Round 2 plan approved",
            });
            runState = updateRun(repoRoot, runState.runId, {
              phase: "selecting_packet",
              round: runState.round,
            });
          }
          break;

        case "skip_qa":
          if (runState.phase === "qa_review") {
            appendEvent(repoRoot, runState.runId, {
              event: "qa.passed",
              phase: "completed",
              detail: "QA skipped by operator",
            });
            appendEvent(repoRoot, runState.runId, { event: "run.completed", phase: "completed" });
            runState = await transition(repoRoot, runState, "completed");
          }
          break;

        case "force_approve": {
          const packetId = msg.packetId ?? runState.currentPacketId;
          if (!packetId) break;

          // Only valid during evaluating_packet or fixing_packet phases
          if (runState.phase !== "evaluating_packet" && runState.phase !== "fixing_packet") {
            appendEvent(repoRoot, runState.runId, {
              event: "poke.responded",
              detail: `force_approve ignored — only valid during evaluating_packet or fixing_packet (current: ${runState.phase})`,
            });
            break;
          }

          // Read evaluator result to report what's being overridden
          let forceApproveDetail = `Force-approved by operator: ${msg.message ?? "no reason given"}`;
          {
            let evalReport: EvaluatorReport | null = null;
            try {
              evalReport = readArtifact(repoRoot, runState.runId, `packets/${packetId}/evaluator/evaluator-report.json`, EvaluatorReportSchema);
            } catch {
              // No evaluator result available — force_approve without prior evaluation
            }

            if (evalReport) {
              const hardFailureCount = evalReport.hardFailures.length;
              const skipVerdicts = (evalReport.criterionVerdicts ?? []).filter(
                (v) => v.verdict === "skip",
              );

              // Cross-reference skipped criteria with the contract to find blocking ones
              const blockingSkipIds: string[] = [];
              try {
                const contract = readArtifact(repoRoot, runState.runId, `packets/${packetId}/contract/final.json`, PacketContractSchema);
                const blockingCriterionIds = new Set(
                  contract.acceptance.filter((ac) => ac.blocking).map((ac) => ac.id),
                );
                for (const v of skipVerdicts) {
                  if (blockingCriterionIds.has(v.criterionId)) {
                    blockingSkipIds.push(v.criterionId);
                  }
                }
              } catch {
                // Contract unavailable — count all skips as potentially blocking
                blockingSkipIds.push(...skipVerdicts.map((v) => v.criterionId));
              }

              const overrideParts: string[] = [];
              if (hardFailureCount > 0) overrideParts.push(`${hardFailureCount} hard failure(s)`);
              if (blockingSkipIds.length > 0) {
                overrideParts.push(`${blockingSkipIds.length} blocking skip(s) [${blockingSkipIds.join(", ")}]`);
              }

              const overrideStr = overrideParts.length > 0
                ? `overriding: ${overrideParts.join(", ")}`
                : "no hard failures or blocking skips";
              forceApproveDetail = `Force-approved by operator (${overrideStr}): ${msg.message ?? "no reason given"}`;

              if (blockingSkipIds.length > 0 && !msg.blockingSkipsAcknowledged) {
                appendEvent(repoRoot, runState.runId, {
                  event: "poke.responded",
                  packetId,
                  detail: `WARNING: force_approve overriding ${blockingSkipIds.length} blocking skip(s) [${blockingSkipIds.join(", ")}] without acknowledgment. Consider adding blockingSkipsAcknowledged: true to the force_approve message.`,
                });
              }
            }
          }

          appendEvent(repoRoot, runState.runId, {
            event: "evaluator.passed",
            packetId,
            detail: forceApproveDetail,
          });
          appendEvent(repoRoot, runState.runId, {
            event: "packet.done",
            packetId,
            detail: "",
          });

          await markPacketStatus(repoRoot, runState.runId, packetId, "done");

          const isR2ForceApprove = runState.round >= 2 && runState.round2PacketOrder.includes(packetId);
          const forceApproveField = isR2ForceApprove ? 'round2CompletedPacketIds' as const : 'completedPacketIds' as const;
          runState = pushToRunArray(repoRoot, runState.runId, forceApproveField, packetId, {
            phase: "selecting_packet",
            currentPacketId: null,
            failedPacketIds: runState.failedPacketIds.filter((id) => id !== packetId),
          });

          // Track cumulative force-approve rate
          {
            const allEvents = readEvents(repoRoot, runState.runId);
            let totalPasses = 0;
            let forceApproveCount = 0;
            for (const e of allEvents) {
              if (e.event === "evaluator.passed") {
                totalPasses++;
                if (e.detail?.startsWith("Force-approved by operator")) {
                  forceApproveCount++;
                }
              }
            }

            if (totalPasses > 0) {
              const rate = (forceApproveCount / totalPasses) * 100;
              if (rate > 50) {
                appendEvent(repoRoot, runState.runId, {
                  event: "poke.responded",
                  detail: `High force-approve rate: ${rate.toFixed(0)}% (${forceApproveCount}/${totalPasses}). Consider improving evaluation environment tooling.`,
                });
              }
            }
          }

          break;
        }

        case "reset_fix_counter": {
          const packetId = msg.packetId ?? runState.currentPacketId;
          if (!packetId) break;

          appendEvent(repoRoot, runState.runId, {
            event: "packet.fix_counter_reset",
            packetId,
            detail: msg.message ?? "Fix counter reset by operator",
          });

          // Unfail the packet if it was marked failed
          const unfailedList = runState.failedPacketIds.filter((id) => id !== packetId);

          // If we're in needs_human because this packet exhausted fix loops,
          // reset to fixing_packet so the builder can try again
          if (runState.phase === "needs_human") {
            runState = updateRun(repoRoot, runState.runId, {
              phase: "fixing_packet",
              currentPacketId: packetId,
              failedPacketIds: unfailedList,
            });
          } else {
            runState = updateRun(repoRoot, runState.runId, {
              failedPacketIds: unfailedList,
            });
          }
          break;
        }
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
  memory: RunMemory | null,
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

        // Encode operator message into run memory
        if (memory) {
          memory.encodeInBackground([inboxMessageToDocument(msg, currentPacketId ?? undefined)]);
        }

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
  // Transient rate limits only — quota exhaustion handled separately
  return /rate.?limit|429|too many requests|overloaded/i.test(msg);
}

function isQuotaExhaustionError(msg: string): boolean {
  return /insufficient.?quota|quota.?exceed|billing.?hard.?limit|daily.?token.?limit|monthly.?limit|you.?ve hit your limit/i.test(msg);
}

function computeBackoffMs(retryCount: number, config: ProjectConfig): number {
  const backoffs = config.resumeBackoffMinutes;
  const idx = Math.min(retryCount - 1, backoffs.length - 1);
  const minutes = backoffs[idx] ?? 5;
  return minutes * 60 * 1000;
}
