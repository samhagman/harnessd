/**
 * Session summary — reads a transcript JSONL and produces a structured
 * `SessionSummary` capturing the high-signal slices an operator needs to
 * decide whether to intervene: turn count, tool calls by name, api_retry
 * events, rate-limit events, compact_boundary events, envelope discovery
 * outcome, longest gap, last assistant text, last tool call, end reason.
 *
 * Why it exists: operator monitoring previously drew confident conclusions
 * from heartbeat + events.jsonl + transcript file size, missing the SDK
 * events that explained what was actually happening. This module produces
 * the report once and persists it to `session-summary.json` so all
 * downstream tools (session.sh CLI, diagnose.sh classifier, cron monitor
 * loop) read the same ground-truth slice instead of re-parsing transcripts
 * with their own filters.
 *
 * Use:
 *   - `summarizeTranscript(path, ctx)` is a pure function — given a
 *     transcript path and session context, returns a SessionSummary.
 *   - `writeSessionSummary(transcriptPath, ctx, outPath)` is the convenience
 *     wrapper that calls summarize + atomicWriteJson.
 *
 * Both handle a partial / live transcript: if the session is still running,
 * the summary's endReason is "still_running" or "compaction_pending".
 */

import fs from "node:fs";

import {
  type SessionSummary,
  type SessionSummaryEndReason,
  type WorkerRole,
} from "./schemas.js";
import { atomicWriteJson } from "./state-store.js";

// ------------------------------------
// Context
// ------------------------------------

export interface SessionSummaryContext {
  sessionId: string | null;
  role: WorkerRole;
  packetId?: string;
  runId: string;
  attempt?: string;
  startedAt: string;
  /** When set, this is the session's terminal time (loop exited). Else "still_running" path. */
  endedAt?: string;
  /**
   * Outcome from `resolveEnvelope` when the orchestrator has already run
   * envelope discovery. Optional because periodic-during-session writes
   * happen before the loop exits.
   */
  envelopeOutcome?: {
    found: boolean;
    source: "staged" | "delimiters" | "fence_fallback" | null;
  };
}

// ------------------------------------
// Internal: parse transcript line shape
// ------------------------------------

interface TranscriptLine {
  ts?: string;
  role?: string;
  msg?: {
    type?: string;
    subtype?: string;
    text?: string;
    isError?: boolean;
    numTurns?: number;
    costUsd?: number;
    raw?: unknown;
    toolUses?: Array<{ name: string; input: unknown }>;
    toolResults?: Array<{ toolUseId: string; output: string; isError?: boolean }>;
  };
}

function readJsonlLines(path: string): TranscriptLine[] {
  if (!fs.existsSync(path)) return [];
  const raw = fs.readFileSync(path, "utf-8");
  const lines: TranscriptLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // Skip malformed lines — common during writes-in-progress.
    }
  }
  return lines;
}

// ------------------------------------
// Public: pure summarizer
// ------------------------------------

export function summarizeTranscript(
  transcriptPath: string,
  ctx: SessionSummaryContext,
): SessionSummary {
  const lines = readJsonlLines(transcriptPath);

  let turnCount = 0;
  let toolCallCount = 0;
  const toolCallsByName: Record<string, number> = {};

  const apiRetries: SessionSummary["apiRetries"] = [];
  const rateLimitEvents: SessionSummary["rateLimitEvents"] = [];
  const compactBoundaries: SessionSummary["compactBoundaries"] = [];

  let costUsd: number | undefined;
  let numTurnsReportedBySdk: number | undefined;
  let resultSubtype: string | undefined;
  let resultIsError = false;

  let lastAssistantText: string | undefined;
  let lastToolCallName: string | null = null;

  // For longest-gap calculation we walk timestamps in arrival order.
  let prevTs: number | null = null;
  let prevSubtype: string | null = null;
  let longestGapMs = 0;
  let longestGapPriorEvent: string | null = null;

  // For "still compacting" detection: last seen status:"compacting" with
  // no compact_boundary after it.
  let pendingCompactingSeen = false;

  // For api-timeout-after-retries detection: count consecutive retries that
  // ended at session terminus without a successful result.
  let prevWasRetry = false;
  let trailingRetryCount = 0;

  for (const line of lines) {
    const msg = line.msg ?? {};
    const ts = line.ts;

    if (ts) {
      const tsMs = Date.parse(ts);
      if (Number.isFinite(tsMs)) {
        if (prevTs !== null) {
          const gap = tsMs - prevTs;
          if (gap > longestGapMs) {
            longestGapMs = gap;
            longestGapPriorEvent = prevSubtype ?? msg.type ?? null;
          }
        }
        prevTs = tsMs;
        prevSubtype = msg.subtype ?? msg.type ?? null;
      }
    }

    if (msg.type === "assistant") {
      turnCount++;

      if (msg.text && msg.text.trim()) {
        lastAssistantText = msg.text.slice(0, 200);
      }

      // Tool-call counting via raw content blocks
      const raw = msg.raw as { message?: { content?: Array<{ type?: string; name?: string }> } } | undefined;
      const content = raw?.message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          toolCallCount++;
          toolCallsByName[block.name] = (toolCallsByName[block.name] ?? 0) + 1;
          lastToolCallName = block.name;
        }
      }
      // Also support normalized `toolUses` shape (some backends pass it pre-extracted).
      if (Array.isArray(msg.toolUses)) {
        for (const tu of msg.toolUses) {
          if (typeof tu.name === "string") {
            toolCallCount++;
            toolCallsByName[tu.name] = (toolCallsByName[tu.name] ?? 0) + 1;
            lastToolCallName = tu.name;
          }
        }
      }

      prevWasRetry = false;
      trailingRetryCount = 0;
    } else if (msg.type === "event" && msg.subtype === "api_retry") {
      const raw = msg.raw as { attempt?: number; error?: string } | undefined;
      apiRetries.push({
        attempt: raw?.attempt ?? apiRetries.length + 1,
        error: raw?.error ?? "unknown",
        ts: ts ?? "",
      });
      trailingRetryCount = prevWasRetry ? trailingRetryCount + 1 : 1;
      prevWasRetry = true;
    } else if (msg.type === "event" && msg.subtype === "rate_limit_event") {
      const raw = msg.raw as {
        rate_limit_info?: { rateLimitType?: string; status?: string };
      } | undefined;
      rateLimitEvents.push({
        ts: ts ?? "",
        rateLimitType: raw?.rate_limit_info?.rateLimitType ?? "unknown",
        status: raw?.rate_limit_info?.status ?? "unknown",
      });
      // rate_limit_event is a peer signal — does not break a retry storm.
    } else if (msg.type === "event" && msg.subtype === "compact_boundary") {
      const raw = msg.raw as {
        compact_metadata?: {
          trigger?: string;
          pre_tokens?: number;
          post_tokens?: number;
          duration_ms?: number;
        };
      } | undefined;
      compactBoundaries.push({
        ts: ts ?? "",
        trigger: raw?.compact_metadata?.trigger ?? "unknown",
        preTokens: raw?.compact_metadata?.pre_tokens ?? 0,
        postTokens: raw?.compact_metadata?.post_tokens ?? 0,
        durationMs: raw?.compact_metadata?.duration_ms ?? 0,
      });
      pendingCompactingSeen = false;
      prevWasRetry = false;
      trailingRetryCount = 0;
    } else if (msg.type === "event" && msg.subtype === "status") {
      // SDK emits status:"compacting" before the boundary. We treat it as
      // a flag that's cleared when the boundary arrives.
      const raw = msg.raw as { status?: string } | undefined;
      if (raw?.status === "compacting") {
        pendingCompactingSeen = true;
      }
      prevWasRetry = false;
      trailingRetryCount = 0;
    } else if (msg.type === "result") {
      resultSubtype = msg.subtype;
      if (typeof msg.numTurns === "number") numTurnsReportedBySdk = msg.numTurns;
      if (typeof msg.costUsd === "number") costUsd = msg.costUsd;
      if (msg.isError) resultIsError = true;
      prevWasRetry = false;
      trailingRetryCount = 0;
    } else {
      // Any other message type — still resets the retry chain (matches worker.ts behavior).
      if (msg.type !== undefined) {
        prevWasRetry = false;
        trailingRetryCount = 0;
      }
    }
  }

  const endReason = computeEndReason({
    sessionEnded: ctx.endedAt !== undefined,
    resultSubtype,
    resultIsError,
    pendingCompactingSeen,
    trailingRetryCount,
    apiRetryCount: apiRetries.length,
    activeRateLimitCount: rateLimitEvents.filter((e) => e.status === "limited").length,
    envelopeOutcome: ctx.envelopeOutcome,
  });

  const startedMs = Date.parse(ctx.startedAt);
  const endedMs = ctx.endedAt ? Date.parse(ctx.endedAt) : null;
  const durationMs = endedMs !== null && Number.isFinite(startedMs) && Number.isFinite(endedMs)
    ? endedMs - startedMs
    : undefined;

  const envelope: SessionSummary["envelope"] = ctx.envelopeOutcome
    ? {
        found: ctx.envelopeOutcome.found,
        source: ctx.envelopeOutcome.source,
        formatIssue: ctx.envelopeOutcome.source === "fence_fallback"
          ? "wrapped_in_markdown_fences_outer"
          : null,
      }
    : { found: false, source: null, formatIssue: null };

  return {
    sessionId: ctx.sessionId,
    role: ctx.role,
    packetId: ctx.packetId,
    runId: ctx.runId,
    attempt: ctx.attempt,
    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    durationMs,
    endReason,
    turnCount,
    toolCallCount,
    toolCallsByName,
    apiRetries,
    rateLimitEvents,
    compactBoundaries,
    envelope,
    longestGapMs,
    longestGapPriorEvent,
    costUsd,
    numTurnsReportedBySdk,
    lastAssistantTextSnippet: lastAssistantText,
    lastToolCall: lastToolCallName,
  };
}

// ------------------------------------
// End-reason classifier
// ------------------------------------

interface EndReasonInputs {
  sessionEnded: boolean;
  resultSubtype: string | undefined;
  resultIsError: boolean;
  pendingCompactingSeen: boolean;
  trailingRetryCount: number;
  apiRetryCount: number;
  /**
   * Count of rate_limit_event entries with status === "limited" only.
   * The SDK emits rate_limit_event regularly even when status is "allowed"
   * as an informational ping about the rate-limit window — those do NOT
   * indicate actual rate limiting and must not classify as `rate_limited`.
   */
  activeRateLimitCount: number;
  envelopeOutcome?: { found: boolean; source: "staged" | "delimiters" | "fence_fallback" | null };
}

function computeEndReason(i: EndReasonInputs): SessionSummaryEndReason {
  // Session is still running.
  if (!i.sessionEnded) {
    if (i.pendingCompactingSeen) return "compaction_pending";
    return "still_running";
  }

  // Session ended.
  if (i.envelopeOutcome?.found) {
    switch (i.envelopeOutcome.source) {
      case "staged": return "envelope_emitted_via_staged_file";
      case "fence_fallback": return "envelope_emitted_via_fence_fallback";
      case "delimiters": return "envelope_emitted";
      default: return "envelope_emitted";
    }
  }

  // No envelope. Try to classify the failure mode.
  if (i.resultSubtype === "error_during_execution" && i.trailingRetryCount >= 3) {
    return "api_timeout_after_retries";
  }
  if (i.resultIsError && i.apiRetryCount >= 3) {
    return "api_timeout_after_retries";
  }
  if (i.activeRateLimitCount > 0 && !i.envelopeOutcome?.found) {
    // ACTIVE rate limit observed and no recovery. status="allowed" events
    // are informational pings and do not count.
    return "rate_limited";
  }
  if (i.resultSubtype === "success" && !i.envelopeOutcome?.found) {
    // SDK said "success" but the orchestrator's envelope resolver came up empty.
    // Most common cause: model emitted in a format the resolver couldn't parse.
    return "session_crashed_no_envelope";
  }
  return "session_crashed_no_envelope";
}

// ------------------------------------
// Public: write convenience wrapper
// ------------------------------------

export function writeSessionSummary(
  transcriptPath: string,
  ctx: SessionSummaryContext,
  outPath: string,
): SessionSummary {
  const summary = summarizeTranscript(transcriptPath, ctx);
  atomicWriteJson(outPath, summary);
  return summary;
}
