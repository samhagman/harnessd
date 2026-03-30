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
}

export interface WorkerResult<T = unknown> {
  /** Whether a valid envelope was found and parsed */
  envelopeFound: boolean;
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
  /** Path to the transcript JSONL file */
  transcriptPath: string;
}

// ------------------------------------
// Envelope extraction
// ------------------------------------

/**
 * Extract JSON from between sentinel markers in text.
 * Returns the raw JSON string or null if not found.
 */
export function extractEnvelope(text: string): string | null {
  const startIdx = text.indexOf(RESULT_START_SENTINEL);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + RESULT_START_SENTINEL.length;
  const endIdx = text.indexOf(RESULT_END_SENTINEL, jsonStart);
  if (endIdx === -1) return null;

  return text.slice(jsonStart, endIdx).trim();
}

/**
 * Parse and validate the envelope payload against a Zod schema.
 */
export function parseEnvelopePayload<T>(
  envelopeJson: string,
  schema: z.ZodType<T>,
): { payload: T; error: null } | { payload: null; error: string } {
  try {
    const raw = JSON.parse(envelopeJson);
    const parsed = schema.parse(raw);
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

  const transcriptStream = fs.createWriteStream(transcriptPath, { flags: "a" });
  const legacyStream = fs.createWriteStream(legacyTranscriptPath, { flags: "a" });

  let combinedText = "";
  let sessionId: string | null = null;
  let numTurns: number | undefined;
  let hadError = false;
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

  // Heartbeat interval
  const heartbeatMs = (config.heartbeatIntervalSeconds ?? 20) * 1000;
  let lastHeartbeat = Date.now();

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
    lastHeartbeat = Date.now();
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

  try {
    for await (const msg of backend.runSession(sessionOptions)) {
      // Log to transcript
      logMessage(msg);

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

      // Capture result info — result is the terminal message, stop iterating
      if (msg.type === "result") {
        if (msg.sessionId) sessionId = msg.sessionId;
        numTurns = msg.numTurns;
        if (msg.isError) hadError = true;
        if (msg.text) combinedText += msg.text;
        break;
      }

      // Write heartbeat periodically
      if (heartbeatMs > 0 && Date.now() - lastHeartbeat >= heartbeatMs) {
        writeHeartbeat();
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
    transcriptStream.end();
    legacyStream.end();
  }

  // Final heartbeat
  writeHeartbeat();

  // Update session with end info
  session.sessionId = sessionId ?? backend.getLastSessionId();
  session.endedAt = new Date().toISOString();
  atomicWriteJson(sessionPath, session);

  // Extract envelope
  let envelopeFound = false;
  let payload: T | null = null;
  let parseError: string | undefined;

  const envelopeJson = extractEnvelope(combinedText);
  if (envelopeJson) {
    envelopeFound = true;
    if (payloadSchema) {
      const result = parseEnvelopePayload(envelopeJson, payloadSchema);
      payload = result.payload;
      if (result.error) parseError = result.error;
    } else {
      // No schema provided, try raw JSON parse
      try {
        payload = JSON.parse(envelopeJson) as T;
      } catch (err: unknown) {
        parseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Write result
  const workerResult: WorkerResult<T> = {
    envelopeFound,
    payload,
    parseError,
    fullText: combinedText,
    sessionId: session.sessionId,
    numTurns,
    hadError,
    transcriptPath,
  };

  atomicWriteJson(resultPath, workerResult);

  return workerResult;
}
