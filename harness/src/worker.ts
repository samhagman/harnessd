/**
 * Generic worker runner — runs an agent session and extracts a structured result envelope.
 *
 * Used by packet-runner.ts and evaluator-runner.ts. Handles:
 * - Session lifecycle (start, messages, completion) via query()
 * - Transcript logging to organized transcripts/ directory
 * - Heartbeat writes
 * - Structured envelope extraction from sentinel markers
 * - Session info persistence
 *
 * Reference: TAD sections 8.7, 13, 14
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { AgentBackend, AgentMessage, AgentSessionOptions } from "./backend/types.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
  type WorkerRole,
  type WorkerSession,
  type Heartbeat,
} from "./schemas.js";
import { getRunDir, atomicWriteJson } from "./state-store.js";
import { appendEvent } from "./event-log.js";
import { writeSessionSummary, type SessionSummaryContext } from "./session-summary.js";
import type { MemvidBuffer } from "./memvid.js";
import { agentMessageToDocuments, promptToDocuments } from "./memvid.js";

/**
 * Threshold for emitting `worker.api_retry_storm`. The Anthropic SDK retries
 * up to 10 times with exponential backoff; observing 3+ in a row from the same
 * session is a strong signal of a sustained API outage and lets cron monitoring
 * surface it immediately instead of waiting for the terminal 10/10 exhaustion
 * (which can take 4+ hours).
 */
const API_RETRY_STORM_THRESHOLD = 3;

// ------------------------------------
// Types
// ------------------------------------

export interface WorkerConfig {
  repoRoot: string;
  runId: string;
  role: WorkerRole;
  packetId?: string;
  /** Directory within the run to write session artifacts (e.g. "packets/PKT-001/builder") */
  artifactDir: string;
  /** Heartbeat interval in seconds (0 to disable) */
  heartbeatIntervalSeconds?: number;
  /** Workspace directory — when set and different from repoRoot, a workspace preamble is prepended to the prompt */
  workspaceDir?: string;
  /** Optional MemvidBuffer for real-time per-turn encoding */
  memvidBuffer?: MemvidBuffer | null;
}

export interface WorkerResult<T = unknown> {
  /** Whether a valid envelope was found and parsed */
  envelopeFound: boolean;
  /**
   * Which discovery path produced the envelope:
   * - "staged" (preferred): the validate_envelope tool persisted it on `valid:true`
   * - "delimiters": extracted from `===HARNESSD_RESULT_*===` markers in assistant text
   * - "fence_fallback": last-ditch ```json``` block recovery (with telemetry event)
   * Null when no envelope was found.
   */
  envelopeSource: "staged" | "delimiters" | "fence_fallback" | null;
  /** Parsed payload from the envelope (null if not found or parse failed) */
  payload: T | null;
  /** Parse error if envelope was found but payload failed validation */
  parseError?: string;
  /** Full combined text from all assistant messages */
  fullText: string;
  /** Session ID captured from the backend */
  sessionId: string | null;
  /** Number of turns (from result message) */
  numTurns?: number;
  /** Whether the session ended with an error */
  hadError: boolean;
  /**
   * Set when the backend attempted `codex exec resume <id>` and the session
   * was rejected (not found / expired). Caller should retry with a fresh
   * session, optionally prepending transcript-summary recovery context.
   */
  resumeFailed?: boolean;
  /** Path to the transcript JSONL file */
  transcriptPath: string;
}

// ------------------------------------
// Envelope extraction
// ------------------------------------

/**
 * Extract JSON from between sentinel markers in text.
 * Returns the raw JSON string or null if not found.
 *
 * Handles multiple envelopes in one text block (e.g. a truncated first attempt
 * followed by a complete second attempt). Each START is paired with the nearest
 * END that follows it but precedes the next START. Among all valid pairs the
 * LAST one is returned — the most-recent attempt is most likely correct, and
 * agents that self-correct explicitly discard earlier partial envelopes.
 *
 * Fall-back: returns null when no START has a matching END after it.
 */
export function extractEnvelope(text: string): string | null {
  // Collect all START positions
  const startPositions: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(RESULT_START_SENTINEL, searchFrom);
    if (idx === -1) break;
    startPositions.push(idx);
    searchFrom = idx + RESULT_START_SENTINEL.length;
  }

  if (startPositions.length === 0) return null;

  // For each START, find the nearest END that comes after it but before
  // the next START (so we don't accidentally swallow prose between envelopes).
  type Pair = { jsonStart: number; endIdx: number };
  const validPairs: Pair[] = [];

  for (let i = 0; i < startPositions.length; i++) {
    const jsonStart = startPositions[i] + RESULT_START_SENTINEL.length;
    // The search window for the END ends just before the next START (if any)
    const nextStart = startPositions[i + 1] ?? text.length;
    const endIdx = text.indexOf(RESULT_END_SENTINEL, jsonStart);
    if (endIdx === -1 || endIdx >= nextStart) continue;
    validPairs.push({ jsonStart, endIdx });
  }

  if (validPairs.length === 0) return null;

  // Prefer the LAST valid pair — the agent's most recent (and intentional) attempt
  const { jsonStart, endIdx } = validPairs[validPairs.length - 1];

  let slice = text.slice(jsonStart, endIdx).trim();
  // Agents occasionally wrap the envelope body in a ```json ... ``` fence
  // (especially after context compaction). Strip it so JSON.parse succeeds.
  const fenceStart = slice.match(/^```(?:json)?\s*\n/);
  if (fenceStart) slice = slice.slice(fenceStart[0].length);
  const fenceEnd = slice.match(/\n?```\s*$/);
  if (fenceEnd) slice = slice.slice(0, slice.length - fenceEnd[0].length);
  return slice.trim();
}

/**
 * Source from which `resolveEnvelope` recovered the envelope body.
 *
 * - `"staged"` — the model called `validate_envelope` with a body that returned
 *   `valid:true`, and the tool persisted the body to staged-envelope.json.
 *   This is the preferred path because it's independent of how the model
 *   formatted its final assistant text.
 * - `"delimiters"` — extracted from `===HARNESSD_RESULT_*===` delimiters in
 *   the combined assistant text (the historical contract).
 * - `"fence_fallback"` — last-ditch recovery: parsed from the first ```json
 *   fenced JSON block in the combined text. Triggers a
 *   `worker.envelope_format_drift` telemetry event so we can phase out
 *   delimiter dependence over time.
 */
export type EnvelopeSource = "staged" | "delimiters" | "fence_fallback";

/**
 * Layered envelope discovery: staged-envelope.json > delimiter regex > markdown-fence fallback.
 *
 * The staged-envelope.json file is written by the `validate_envelope` MCP
 * tool (or CLI binary) when the model calls it with a body that passes
 * schema validation. Reading from there first means the orchestrator
 * recovers the envelope regardless of how the model formats its final
 * assistant text — neutralizing the recurring markdown-fence regression
 * where Opus 4.7 wraps the JSON in ```json ... ``` instead of the
 * required `===HARNESSD_RESULT_*===` delimiters.
 *
 * Returns null if no envelope is recoverable from any of the three paths.
 */
export function resolveEnvelope(args: {
  stagedEnvelopePath: string;
  combinedText: string;
  sessionStartedAt: string;
}): { source: EnvelopeSource; body: string } | null {
  // Path 1: staged-envelope.json from a successful validate_envelope call
  if (fs.existsSync(args.stagedEnvelopePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(args.stagedEnvelopePath, "utf-8"));
      if (
        raw &&
        typeof raw === "object" &&
        typeof raw.validatedAt === "string" &&
        "validatedBody" in raw
      ) {
        const validatedAtMs = Date.parse(raw.validatedAt);
        const sessionStartMs = Date.parse(args.sessionStartedAt);
        if (Number.isFinite(validatedAtMs) && validatedAtMs >= sessionStartMs) {
          return { source: "staged", body: JSON.stringify(raw.validatedBody) };
        }
      }
    } catch {
      // Malformed staged file — fall through to delimiter parsing.
    }
  }

  // Path 2: existing delimiter-based extraction (handles inner-fence cases).
  const delimiterBody = extractEnvelope(args.combinedText);
  if (delimiterBody) return { source: "delimiters", body: delimiterBody };

  // Path 3: last-ditch markdown-fenced JSON recovery. Some models emit
  // ```json ... ``` with no `===HARNESSD_RESULT_*===` delimiters at all.
  // Look for the LAST ```json fenced block whose contents parse as JSON
  // (last-wins, mirroring delimiter behavior).
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  let lastValidJson: string | null = null;
  for (const match of args.combinedText.matchAll(fenceRe)) {
    const candidate = match[1].trim();
    try {
      JSON.parse(candidate);
      lastValidJson = candidate;
    } catch {
      // Skip un-parseable fences.
    }
  }
  if (lastValidJson) return { source: "fence_fallback", body: lastValidJson };

  return null;
}

/**
 * Parse and validate the envelope payload against a Zod schema.
 */
/**
 * Recursively strip null-valued keys from an object. OpenAI structured-outputs
 * strict mode requires every schema property to be present — optional fields
 * are emulated by a nullable union, so the model emits `null` where Zod
 * expects the key to be absent (undefined). We drop explicit nulls before
 * Zod parsing so `.optional()` / `.nullish()` fields pass validation.
 */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

export function parseEnvelopePayload<T>(
  envelopeJson: string,
  schema: z.ZodType<T>,
): { payload: T; error: null } | { payload: null; error: string } {
  try {
    const raw = JSON.parse(envelopeJson);
    const cleaned = stripNulls(raw);
    const parsed = schema.parse(cleaned);
    return { payload: parsed, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { payload: null, error: message };
  }
}

// ------------------------------------
// Transcript path helpers
// ------------------------------------

/**
 * Build the transcript path under the organized directory structure.
 * Format: transcripts/<packetId|planner>/<role>-<timestamp>.jsonl
 */
function buildTranscriptPath(
  runDir: string,
  role: WorkerRole,
  packetId?: string,
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const groupDir = packetId ?? "planner";
  const transcriptDir = path.join(runDir, "transcripts", groupDir);
  fs.mkdirSync(transcriptDir, { recursive: true });
  return path.join(transcriptDir, `${role}-${ts}.jsonl`);
}

function finishStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    stream.once("error", finish);
    stream.end(finish);
  });
}

// ------------------------------------
// Worker runner
// ------------------------------------

/**
 * Run an agent session and extract a structured result.
 *
 * @param backend - The agent backend (real SDK or fake)
 * @param sessionOptions - Options passed to the backend
 * @param config - Worker configuration (run ID, role, artifact paths)
 * @param payloadSchema - Optional Zod schema to validate the envelope payload
 */
export async function runWorker<T = unknown>(
  backend: AgentBackend,
  sessionOptions: AgentSessionOptions,
  config: WorkerConfig,
  payloadSchema?: z.ZodType<T>,
): Promise<WorkerResult<T>> {
  // Prepend workspace preamble if workspaceDir differs from repoRoot
  if (config.workspaceDir && config.workspaceDir !== config.repoRoot) {
    sessionOptions = {
      ...sessionOptions,
      prompt: `WORKSPACE: All file operations must target ${config.workspaceDir}\n\n${sessionOptions.prompt}`,
    };
  }

  const runDir = getRunDir(config.repoRoot, config.runId);
  const artifactPath = path.join(runDir, config.artifactDir);
  fs.mkdirSync(artifactPath, { recursive: true });

  // Transcript goes in the organized transcripts/ directory
  const transcriptPath = buildTranscriptPath(runDir, config.role, config.packetId);
  // Also write to the artifact dir for backward compat
  const legacyTranscriptPath = path.join(artifactPath, "transcript.jsonl");
  const sessionPath = path.join(artifactPath, "session.json");
  const heartbeatPath = path.join(artifactPath, "heartbeat.json");
  const resultPath = path.join(artifactPath, "result.json");
  const stagedEnvelopePath = path.join(artifactPath, "staged-envelope.json");
  const sessionSummaryPath = path.join(artifactPath, "session-summary.json");

  // Clear any stale staged envelope from a prior session in this same artifact
  // dir. The validatedAt > sessionStartedAt check in resolveEnvelope already
  // protects against staleness, but deletion here is cheap belt-and-suspenders
  // and prevents accidental cross-session contamination if clocks are skewed.
  try { fs.rmSync(stagedEnvelopePath, { force: true }); } catch { /* noop */ }

  // Tell the validate_envelope tool (in-process MCP, Codex stdio MCP, or CLI
  // binary) where to persist the validated body on `valid:true`. Reading
  // this file is the orchestrator's primary envelope-recovery path —
  // making the model's final-text format irrelevant.
  const priorStagedEnvVar = process.env.HARNESSD_STAGED_ENVELOPE_PATH;
  process.env.HARNESSD_STAGED_ENVELOPE_PATH = stagedEnvelopePath;

  const transcriptStream = fs.createWriteStream(transcriptPath, { flags: "a" });
  const legacyStream = fs.createWriteStream(legacyTranscriptPath, { flags: "a" });
  const rawEventLogPath = path.join(artifactPath, "raw-events.jsonl");
  const rawEventStream = fs.createWriteStream(rawEventLogPath, { flags: "a" });

  let combinedText = "";
  let sessionId: string | null = null;
  let numTurns: number | undefined;
  let hadError = false;
  let resumeFailed = false;
  let turnCount = 0;

  // Write initial session info
  const session: WorkerSession = {
    sessionId: null,
    role: config.role,
    packetId: config.packetId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastHeartbeatAt: null,
    transcriptPath,
    resultPath,
  };
  atomicWriteJson(sessionPath, session);

  // Heartbeat interval — fires from a wall-clock timer (see setInterval below)
  // so it doesn't depend on SDK message arrival.
  const heartbeatMs = (config.heartbeatIntervalSeconds ?? 20) * 1000;

  const memvidBuffer = config.memvidBuffer ?? null;
  let memvidTurnIndex = 0;

  // Encode the initial prompt into memory
  if (memvidBuffer) {
    const promptDocs = promptToDocuments(sessionOptions.prompt, config.role, config.packetId);
    memvidBuffer.addMany(promptDocs);
  }

  const writeHeartbeat = () => {
    const hb: Heartbeat = {
      sessionId,
      role: config.role,
      packetId: config.packetId,
      ts: new Date().toISOString(),
      turnCount,
    };
    atomicWriteJson(heartbeatPath, hb);
    session.lastHeartbeatAt = hb.ts;
  };

  const logMessage = (msg: AgentMessage) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      role: config.role,
      msg,
    }) + "\n";
    transcriptStream.write(line);
    legacyStream.write(line);
  };

  const logRawEvent = (msg: AgentMessage) => {
    if (msg.raw) {
      rawEventStream.write(JSON.stringify({ ts: new Date().toISOString(), raw: msg.raw }) + "\n");
    }
  };

  // Heartbeat from a wall-clock timer so it fires even during long opus thinking
  // turns or api_retry backoff (when no SDK messages arrive). The inline-on-message
  // pattern starved during PKT-007's 3.5h evaluator session.
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(writeHeartbeat, heartbeatMs)
    : null;

  // Periodic session-summary write — gives operators a structured view of
  // what's happening mid-session (api_retry counts, compact_boundary, tool
  // call mix) without needing to re-parse the JSONL transcript. Slower
  // cadence than heartbeat to avoid IO churn on long sessions.
  const PERIODIC_SUMMARY_MS = 60_000;
  const writePeriodicSummary = () => {
    try {
      const ctx: SessionSummaryContext = {
        sessionId,
        role: config.role,
        packetId: config.packetId,
        runId: config.runId,
        startedAt: session.startedAt,
        // No endedAt → endReason becomes "still_running" or "compaction_pending"
      };
      writeSessionSummary(transcriptPath, ctx, sessionSummaryPath);
    } catch { /* periodic summary is best-effort */ }
  };
  const summaryTimer = heartbeatMs > 0
    ? setInterval(writePeriodicSummary, PERIODIC_SUMMARY_MS)
    : null;

  // Track consecutive `api_retry` events so we can emit `worker.api_retry_storm`
  // once on the threshold-th retry (not on every retry after that). Reset
  // whenever any non-api_retry message arrives.
  let consecutiveApiRetries = 0;
  let stormEventEmitted = false;

  try {
    for await (const msg of backend.runSession(sessionOptions)) {
      // Log to transcript and raw event log
      logMessage(msg);
      logRawEvent(msg);

      // Real-time memvid encoding
      if (memvidBuffer) {
        if (msg.type === 'assistant' && msg.text) memvidTurnIndex++;
        const docs = agentMessageToDocuments(msg, {
          role: config.role,
          packetId: config.packetId,
          turnIndex: memvidTurnIndex,
        });
        if (docs.length > 0) memvidBuffer.addMany(docs);
      }

      // Capture session ID
      if (msg.sessionId && !sessionId) {
        sessionId = msg.sessionId;
        session.sessionId = sessionId;
        atomicWriteJson(sessionPath, session);
      }

      // Collect text
      if (msg.type === "assistant" && msg.text) {
        combinedText += msg.text;
        turnCount++;
      }

      // API-retry storm detection. The SDK emits `event` messages with
      // subtype "api_retry" on every retry attempt. 3+ in a row from one
      // session is a strong outage signal worth surfacing to events.jsonl
      // immediately so cron monitoring catches it without waiting hours
      // for the 10/10 terminal exhaustion.
      if (msg.type === "event" && msg.subtype === "api_retry") {
        consecutiveApiRetries++;
        if (consecutiveApiRetries >= API_RETRY_STORM_THRESHOLD && !stormEventEmitted) {
          appendEvent(config.repoRoot, config.runId, {
            event: "worker.api_retry_storm",
            packetId: config.packetId,
            detail: `${consecutiveApiRetries} consecutive api_retry events from ${config.role} session ${sessionId ?? "?"} — possible API outage`,
          });
          stormEventEmitted = true;
        }
      } else if (msg.type !== "event" || msg.subtype !== "rate_limit_event") {
        // Reset on any non-retry message except rate_limit_event (which is
        // a peer signal that doesn't break a retry storm).
        consecutiveApiRetries = 0;
        stormEventEmitted = false;
      }

      // Capture result info — result is the terminal message, stop iterating
      if (msg.type === "result") {
        if (msg.sessionId) sessionId = msg.sessionId;
        numTurns = msg.numTurns;
        if (msg.isError) hadError = true;
        if (msg.subtype === "error_resume_failed") resumeFailed = true;
        if (msg.text) combinedText += msg.text;
        break;
      }
    }
  } catch (err: unknown) {
    hadError = true;
    const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
    logMessage({
      type: "result",
      subtype: "error_during_execution",
      text: errMsg,
      isError: true,
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (summaryTimer) clearInterval(summaryTimer);
    await Promise.all([
      finishStream(transcriptStream),
      finishStream(legacyStream),
      finishStream(rawEventStream),
    ]);
    if (memvidBuffer) memvidBuffer.stop();
  }

  // Final heartbeat
  writeHeartbeat();

  // Update session with end info
  session.sessionId = sessionId ?? backend.getLastSessionId();
  session.endedAt = new Date().toISOString();
  atomicWriteJson(sessionPath, session);

  // Restore prior env var value (if any) — make this function safe to call
  // recursively or in parallel without leaking the staged-envelope path
  // across sessions in the same Node process.
  if (priorStagedEnvVar === undefined) {
    delete process.env.HARNESSD_STAGED_ENVELOPE_PATH;
  } else {
    process.env.HARNESSD_STAGED_ENVELOPE_PATH = priorStagedEnvVar;
  }

  // Layered envelope discovery: staged file > delimiters > markdown-fence fallback.
  let envelopeFound = false;
  let envelopeSource: EnvelopeSource | null = null;
  let payload: T | null = null;
  let parseError: string | undefined;

  const resolved = resolveEnvelope({
    stagedEnvelopePath,
    combinedText,
    sessionStartedAt: session.startedAt,
  });
  if (resolved) {
    envelopeFound = true;
    envelopeSource = resolved.source;
    if (payloadSchema) {
      const result = parseEnvelopePayload(resolved.body, payloadSchema);
      payload = result.payload;
      if (result.error) parseError = result.error;
    } else {
      try {
        payload = JSON.parse(resolved.body) as T;
      } catch (err: unknown) {
        parseError = err instanceof Error ? err.message : String(err);
      }
    }

    // Telemetry: mark the markdown-fence recovery path so we can track how
    // often models drift from the delimiter contract over time.
    if (resolved.source === "fence_fallback") {
      try {
        appendEvent(config.repoRoot, config.runId, {
          event: "worker.envelope_format_drift",
          packetId: config.packetId,
          detail: `${config.role} session ${session.sessionId ?? "?"} omitted HARNESSD_RESULT delimiters; envelope recovered from markdown-fence fallback (work accepted)`,
        });
      } catch { /* event-log write failure should not block envelope return */ }
    }
  }

  // Write result
  const workerResult: WorkerResult<T> = {
    envelopeFound,
    envelopeSource,
    payload,
    parseError,
    fullText: combinedText,
    sessionId: session.sessionId,
    numTurns,
    hadError,
    ...(resumeFailed ? { resumeFailed: true } : {}),
    transcriptPath,
  };

  atomicWriteJson(resultPath, workerResult);

  // Final session-summary write — runs synchronously after envelope
  // resolution so endReason captures the actual outcome (envelope_emitted,
  // session_crashed_no_envelope, api_timeout_after_retries, etc.) rather
  // than the still_running placeholder.
  try {
    const finalCtx: SessionSummaryContext = {
      sessionId: session.sessionId,
      role: config.role,
      packetId: config.packetId,
      runId: config.runId,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? new Date().toISOString(),
      envelopeOutcome: { found: envelopeFound, source: envelopeSource },
    };
    writeSessionSummary(transcriptPath, finalCtx, sessionSummaryPath);
  } catch { /* summary write is best-effort; never block envelope return */ }

  return workerResult;
}
