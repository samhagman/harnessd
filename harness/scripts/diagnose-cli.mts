#!/usr/bin/env npx tsx
/**
 * Classify a harnessd worker session's current state with bounded evidence
 * and a recommended action. Built on top of session-summary.json (Fix 2);
 * falls back to live computation when the artifact is absent.
 *
 * Why this exists: operator misdiagnoses from sparse signals (heartbeat,
 * events.jsonl summaries, transcript file size) caused intervention on
 * sessions that were actually doing real work or recoverably stalled. The
 * sealed classification enum forces named hypotheses with evidence — if
 * none match, the answer is "unclassified" and the operator must
 * investigate further before acting.
 *
 * Output format:
 *   CLASSIFICATION: <name>
 *     Evidence: <one or more lines grounded in transcript/summary fields>
 *     Recommended action: <what to do; "WAIT" is a valid answer>
 *
 * Classifications are checked in priority order (terminal first, then
 * in-progress, then quality indicators). First match wins.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  SessionSummarySchema,
  type SessionSummary,
  type WorkerRole,
} from "../src/schemas.js";
import { summarizeTranscript } from "../src/session-summary.js";

// ------------------------------------
// Args
// ------------------------------------

const ALL_ROLES: WorkerRole[] = [
  "planner",
  "plan_reviewer",
  "contract_builder",
  "contract_evaluator",
  "builder",
  "evaluator",
  "qa_agent",
  "round2_planner",
];

interface Args {
  packetId: string;
  role?: WorkerRole;
  attempt?: number;
  runId?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      role: { type: "string" },
      attempt: { type: "string" },
      "run-id": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stderr.write([
      "Usage: diagnose.sh <packet-id> [--role <role>] [--attempt N] [--run-id <id>]",
      "",
      "Classifications (sealed): envelope_emitted_clean, envelope_format_drift,",
      "  api_outage_terminal, api_outage_in_progress, compaction_in_progress,",
      "  compaction_completed_recently, rate_limited_pending, awaiting_envelope_emit,",
      "  silent_extended_thinking, stuck_loop_definite, unclassified.",
      "",
    ].join("\n"));
    process.exit(values.help ? 0 : 1);
  }

  const packetId = positionals[0]!;
  const role = values.role as WorkerRole | undefined;
  if (role && !ALL_ROLES.includes(role)) {
    process.stderr.write(`Unknown role: ${role}\n`);
    process.exit(1);
  }
  return {
    packetId,
    role,
    attempt: values.attempt ? Number(values.attempt) : undefined,
    runId: values["run-id"] as string | undefined,
  };
}

// ------------------------------------
// Run-id discovery (mirrors session.sh)
// ------------------------------------

function findRunsDir(): string {
  const harnessDir = path.dirname(path.dirname(import.meta.url.replace("file://", "")));
  for (const c of [
    path.join(harnessDir, ".harnessd", "runs"),
    path.join(harnessDir, "..", ".harnessd", "runs"),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(harnessDir, ".harnessd", "runs");
}

function findLatestRun(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  let bestName: string | null = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runJson = path.join(runsDir, entry.name, "run.json");
    if (!fs.existsSync(runJson)) continue;
    const mtime = fs.statSync(runJson).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestName = entry.name;
    }
  }
  return bestName;
}

// ------------------------------------
// Session discovery (mirrors session.sh)
// ------------------------------------

interface SessionRef {
  role: WorkerRole;
  packetId: string;
  transcriptPath: string;
  startedAt: string;
  artifactDir: string;
}

function discoverSessions(runDir: string, packetId: string, roleFilter?: WorkerRole): SessionRef[] {
  const transcriptDir = path.join(runDir, "transcripts", packetId);
  if (!fs.existsSync(transcriptDir)) return [];
  const refs: SessionRef[] = [];
  for (const f of fs.readdirSync(transcriptDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const m = f.match(/^([a-z_]+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.jsonl$/);
    if (!m) continue;
    const role = m[1] as WorkerRole;
    if (!ALL_ROLES.includes(role)) continue;
    if (roleFilter && role !== roleFilter) continue;
    const isoLike = m[2].replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      "$1-$2-$3T$4:$5:$6.$7Z",
    );
    const artifactDir = role === "planner" || role === "plan_reviewer" || role === "round2_planner"
      ? path.join(runDir, "spec")
      : path.join(runDir, "packets", packetId, role);
    refs.push({ role, packetId, transcriptPath: path.join(transcriptDir, f), startedAt: isoLike, artifactDir });
  }
  refs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return refs;
}

// ------------------------------------
// Load summary (artifact-first, live fallback)
// ------------------------------------

function loadSummary(ref: SessionRef, runId: string): SessionSummary {
  const summaryPath = path.join(ref.artifactDir, "session-summary.json");
  if (fs.existsSync(summaryPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
      const parsed = SessionSummarySchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch { /* fall through */ }
  }
  // Live compute path
  let envelopeOutcome: { found: boolean; source: "staged" | "delimiters" | "fence_fallback" | null } | undefined;
  const resultPath = path.join(ref.artifactDir, "result.json");
  if (fs.existsSync(resultPath)) {
    try {
      const r = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      if (typeof r.envelopeFound === "boolean") {
        envelopeOutcome = { found: r.envelopeFound, source: r.envelopeSource ?? null };
      }
    } catch { /* ignore */ }
  }
  let sessionId: string | null = null;
  let endedAt: string | undefined;
  const sessionPath = path.join(ref.artifactDir, "session.json");
  if (fs.existsSync(sessionPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      sessionId = s.sessionId ?? null;
      endedAt = s.endedAt ?? undefined;
    } catch { /* ignore */ }
  }
  return summarizeTranscript(ref.transcriptPath, {
    sessionId,
    role: ref.role,
    packetId: ref.packetId,
    runId,
    startedAt: ref.startedAt,
    endedAt,
    envelopeOutcome,
  });
}

// ------------------------------------
// Classifier — sealed enum, priority-ordered
// ------------------------------------

type Classification =
  | "envelope_emitted_clean"
  | "envelope_format_drift"
  | "api_outage_terminal"
  | "api_outage_in_progress"
  | "compaction_in_progress"
  | "compaction_completed_recently"
  | "rate_limited_pending"
  | "awaiting_envelope_emit"
  | "silent_extended_thinking"
  | "stuck_loop_definite"
  | "unclassified";

interface Diagnosis {
  classification: Classification;
  evidence: string[];
  recommendedAction: string;
}

function nowMs(): number { return Date.now(); }

function minutesAgo(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((nowMs() - t) / 60_000);
}

function classify(s: SessionSummary): Diagnosis {
  // ---- Terminal classifications first ----

  if (s.endReason === "envelope_emitted_via_staged_file" || s.endReason === "envelope_emitted") {
    return {
      classification: "envelope_emitted_clean",
      evidence: [
        `endReason=${s.endReason}; envelope.source=${s.envelope.source ?? "null"}`,
        `${s.turnCount} assistant turns, ${s.toolCallCount} tool calls`,
      ],
      recommendedAction: "No action — work was filed cleanly. Evaluator can proceed.",
    };
  }

  if (s.endReason === "envelope_emitted_via_fence_fallback") {
    return {
      classification: "envelope_format_drift",
      evidence: [
        `Envelope recovered via markdown-fence fallback (model omitted ===HARNESSD_RESULT_*=== delimiters)`,
        `envelope.formatIssue=${s.envelope.formatIssue ?? "unknown"}`,
        `Work was accepted; this is telemetry only.`,
      ],
      recommendedAction: "No action — work accepted via fallback. If this recurs frequently for the same role/model, audit prompt rendering for delimiter clarity.",
    };
  }

  if (s.endReason === "api_timeout_after_retries") {
    return {
      classification: "api_outage_terminal",
      evidence: [
        `${s.apiRetries.length} api_retry events; SDK exhausted retries and emitted synthetic timeout`,
        s.apiRetries.length > 0 ? `Last retry: attempt ${s.apiRetries[s.apiRetries.length - 1].attempt} at ${s.apiRetries[s.apiRetries.length - 1].ts} (error="${s.apiRetries[s.apiRetries.length - 1].error}")` : "",
      ].filter(Boolean),
      recommendedAction: "Restart the session. The harness's auto-resume should handle this; if it doesn't, kill and resume manually.",
    };
  }

  if (s.endReason === "session_crashed_no_envelope") {
    // Distinguish: did the model successfully validate but fail to emit?
    return {
      classification: "envelope_format_drift",
      evidence: [
        `Session ended without a parseable envelope (endReason=session_crashed_no_envelope)`,
        `${s.turnCount} assistant turns, ${s.toolCallCount} tool calls — work likely happened`,
        `envelope.found=${s.envelope.found}, source=${s.envelope.source ?? "null"}`,
      ],
      recommendedAction: "Check git log and gate_check to verify the work landed. If it did, manual envelope recovery: write builder-report.json from observed state and reset phase to evaluating_packet. With Fix 1 deployed, this case becomes rare.",
    };
  }

  if (s.endReason === "rate_limited") {
    return {
      classification: "rate_limited_pending",
      evidence: [
        `${s.rateLimitEvents.length} rate_limit_event observations`,
        s.rateLimitEvents.length > 0 ? `Latest: ${s.rateLimitEvents[s.rateLimitEvents.length - 1].rateLimitType}/${s.rateLimitEvents[s.rateLimitEvents.length - 1].status} at ${s.rateLimitEvents[s.rateLimitEvents.length - 1].ts}` : "",
      ].filter(Boolean),
      recommendedAction: "Wait for rate-limit window to clear. Check the resetsAt timestamp in events.jsonl. Do NOT restart — that consumes more quota.",
    };
  }

  // ---- In-progress classifications ----

  // API outage in progress: ≥3 retries AND the most recent retry is RECENT
  // (within the last 5 min). A historical retry storm that has since
  // recovered (work is flowing) should not classify as an active outage —
  // that bug fires when work is actually fine and the operator gets a
  // misleading "WAIT" recommendation. The 5-min window matches typical
  // SDK exponential backoff intervals at high retry counts.
  if (s.apiRetries.length >= 3) {
    const latest = s.apiRetries[s.apiRetries.length - 1];
    const minsAgo = minutesAgo(latest.ts);
    const RETRY_FRESHNESS_MIN = 5;
    if (minsAgo !== null && minsAgo <= RETRY_FRESHNESS_MIN) {
      return {
        classification: "api_outage_in_progress",
        evidence: [
          `${s.apiRetries.length}/10 api_retry events observed`,
          `Most recent: attempt ${latest.attempt} at ${latest.ts} (${minsAgo} min ago)`,
          `error="${latest.error}"`,
        ],
        recommendedAction: "WAIT. SDK budget allows up to 10 retries (~4h with backoff). Do NOT kill before attempt 10 exhausts — sessions often recover. Re-run diagnose.sh in 30 min.",
      };
    }
    // Retries are stale (>5 min old). The storm has recovered if work has
    // continued — fall through to other classifications. The retries
    // remain visible in session.sh's narrative for context.
  }

  // Compaction in progress
  if (s.endReason === "compaction_pending") {
    return {
      classification: "compaction_in_progress",
      evidence: [
        `status="compacting" event observed; no compact_boundary yet`,
        `Compactions on >100K tokens routinely take 60-180+ seconds; can take 30+ min for very large contexts`,
      ],
      recommendedAction: "WAIT. Compaction is SDK-internal and self-recovering. Re-run diagnose.sh in 5-10 min.",
    };
  }

  // Compaction completed recently (≤5 min ago)
  if (s.compactBoundaries.length > 0) {
    const latest = s.compactBoundaries[s.compactBoundaries.length - 1];
    const minsAgo = minutesAgo(latest.ts);
    if (minsAgo !== null && minsAgo <= 5) {
      return {
        classification: "compaction_completed_recently",
        evidence: [
          `Latest compact_boundary ${minsAgo} min ago: ${latest.preTokens} → ${latest.postTokens} tokens (${Math.round(latest.durationMs / 1000)}s)`,
          `Model just resumed post-compaction; first turn can be slow as it re-grounds`,
        ],
        recommendedAction: "WAIT. Give the model a few turns to resume work post-compaction.",
      };
    }
  }

  // Awaiting envelope emit — heuristic: assistant called validate_envelope tool recently
  // but no result message has arrived yet
  const validateCalls = s.toolCallsByName["mcp__harnessd-validation__validate_envelope"] ?? 0;
  if (
    s.endReason === "still_running" &&
    validateCalls > 0 &&
    s.envelope.found === false
  ) {
    return {
      classification: "awaiting_envelope_emit",
      evidence: [
        `validate_envelope called ${validateCalls} time(s); session still running`,
        `Model is likely emitting the final envelope text now`,
      ],
      recommendedAction: "WAIT briefly (≤1 min). Once the SDK loop sees the result message, the orchestrator will read staged-envelope.json and proceed.",
    };
  }

  // Stuck loop — look for repeated identical tool-call name dominating with no edits
  // Heuristic: if last 50% of tool calls are all the same name AND that name is a read-only
  // tool (Read/Grep/Bash) AND no Edit/Write since, treat as stuck.
  const totalTools = s.toolCallCount;
  if (totalTools >= 8) {
    const lastTool = s.lastToolCall ?? "";
    const lastIsReadOnly = ["Read", "Grep", "Bash", "Glob"].includes(lastTool);
    const editLikeCalls = (s.toolCallsByName["Edit"] ?? 0)
      + (s.toolCallsByName["Write"] ?? 0)
      + (s.toolCallsByName["NotebookEdit"] ?? 0);
    const dominantCount = s.toolCallsByName[lastTool] ?? 0;
    const dominantRatio = dominantCount / totalTools;
    if (lastIsReadOnly && editLikeCalls === 0 && dominantRatio >= 0.6 && totalTools >= 12) {
      return {
        classification: "stuck_loop_definite",
        evidence: [
          `${dominantCount} of ${totalTools} tool calls are ${lastTool} (${Math.round(dominantRatio * 100)}%)`,
          `Zero Edit/Write/NotebookEdit calls — model is reading without writing`,
          `Last tool: ${lastTool}`,
        ],
        recommendedAction: "Send a nudge identifying the loop. Reference exact files and an explicit next step. If it continues post-nudge, kill and reset the packet.",
      };
    }
  }

  // Silent extended thinking — last activity recent, low retry count, no errors
  if (s.endReason === "still_running" && s.apiRetries.length < 3) {
    const minsSinceStart = minutesAgo(s.startedAt);
    const longGapMin = Math.round(s.longestGapMs / 60_000);
    if (longGapMin < 10 || (minsSinceStart !== null && minsSinceStart < 30)) {
      return {
        classification: "silent_extended_thinking",
        evidence: [
          `Session live; ${s.turnCount} turns so far; longest gap ${longGapMin}m${s.longestGapPriorEvent ? ` (after ${s.longestGapPriorEvent})` : ""}`,
          `No api_retry storm; no compaction pending`,
        ],
        recommendedAction: "WAIT per Don't-Kill-on-Silence rule. Opus 4.7 high-effort can think silently for 5-10+ min. Re-run diagnose.sh in 10 min.",
      };
    }
  }

  // Default catch-all
  return {
    classification: "unclassified",
    evidence: [
      `endReason=${s.endReason}; ${s.turnCount} turns; ${s.toolCallCount} tool calls; ${s.apiRetries.length} api_retry; ${s.compactBoundaries.length} compactions`,
      `longest gap: ${Math.round(s.longestGapMs / 1000)}s${s.longestGapPriorEvent ? ` after ${s.longestGapPriorEvent}` : ""}`,
      `envelope.found=${s.envelope.found}, source=${s.envelope.source ?? "null"}`,
    ],
    recommendedAction: "No clean classification matches. Read the transcript directly via session.sh --all and the underlying transcripts/<packet>/*.jsonl files before any intervention.",
  };
}

// ------------------------------------
// Render
// ------------------------------------

function render(d: Diagnosis, ref: SessionRef, runId: string, summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`CLASSIFICATION: ${d.classification}`);
  lines.push(`  Session: ${ref.role} / ${ref.packetId} / sessionId ${(summary.sessionId ?? "(unknown)").slice(0, 8)}...`);
  lines.push(`  Started: ${ref.startedAt}   Run: ${runId}`);
  lines.push("");
  lines.push(`  Evidence:`);
  for (const e of d.evidence) lines.push(`    - ${e}`);
  lines.push("");
  lines.push(`  Recommended action: ${d.recommendedAction}`);
  lines.push("");
  lines.push(`  Full session summary: ./harness/session.sh ${ref.packetId} --role ${ref.role}`);
  return lines.join("\n");
}

// ------------------------------------
// Main
// ------------------------------------

function main(): void {
  const args = parseCliArgs();
  const runsDir = findRunsDir();
  let runId = args.runId ?? findLatestRun(runsDir) ?? "";
  if (!runId) {
    process.stderr.write(`No runs found in ${runsDir}\n`);
    process.exit(1);
  }
  const runDir = path.join(runsDir, runId);
  if (!fs.existsSync(runDir)) {
    process.stderr.write(`Run not found: ${runDir}\n`);
    process.exit(1);
  }
  const sessions = discoverSessions(runDir, args.packetId, args.role);
  if (sessions.length === 0) {
    process.stderr.write(`No sessions found for packet=${args.packetId}${args.role ? ` role=${args.role}` : ""}\n`);
    process.exit(1);
  }
  let ref: SessionRef;
  if (args.attempt !== undefined) {
    if (args.attempt < 1 || args.attempt > sessions.length) {
      process.stderr.write(`--attempt ${args.attempt} out of range (1..${sessions.length})\n`);
      process.exit(1);
    }
    ref = sessions[args.attempt - 1];
  } else {
    ref = sessions[sessions.length - 1];
  }
  const summary = loadSummary(ref, runId);
  const diag = classify(summary);
  process.stdout.write(render(diag, ref, runId, summary) + "\n");
}

main();
