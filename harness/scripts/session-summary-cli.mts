#!/usr/bin/env npx tsx
/**
 * Narrative session summary CLI — invoked via harness/session.sh.
 *
 * Prefers the harness-written session-summary.json artifact (Fix 2) when
 * present. Falls back to live computation via summarizeTranscript() when
 * the artifact is absent (e.g. older runs that pre-date the artifact, or
 * a session that crashed before the harness wrote the final summary).
 *
 * Why a CLI: operators and sub-agents shouldn't need 8 jq incantations
 * to figure out what happened in a session. One command produces a
 * 30-line ground-truth report.
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
  all: boolean;
  runId?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      role: { type: "string" },
      attempt: { type: "string" },
      all: { type: "boolean", default: false },
      "run-id": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stderr.write([
      "Usage:",
      "  session.sh <packet-id-or-planner> [--role <role>] [--attempt N] [--all] [--run-id <id>]",
      "",
      "Roles: " + ALL_ROLES.join(", "),
      "",
      "Examples:",
      "  ./session.sh PKT-R2-001",
      "  ./session.sh PKT-R2-001 --role evaluator",
      "  ./session.sh PKT-R2-001 --all",
      "  ./session.sh planner --role planner",
      "",
    ].join("\n"));
    process.exit(values.help ? 0 : 1);
  }

  const packetId = positionals[0]!;
  const role = values.role as WorkerRole | undefined;
  if (role && !ALL_ROLES.includes(role)) {
    process.stderr.write(`Unknown role: ${role}. Valid: ${ALL_ROLES.join(", ")}\n`);
    process.exit(1);
  }

  return {
    packetId,
    role,
    attempt: values.attempt ? Number(values.attempt) : undefined,
    all: !!values.all,
    runId: values["run-id"] as string | undefined,
  };
}

// ------------------------------------
// Run-id discovery — same pattern as status.sh
// ------------------------------------

function findRunsDir(): string {
  const harnessDir = path.dirname(path.dirname(import.meta.url.replace("file://", "")));
  const candidates = [
    path.join(harnessDir, ".harnessd", "runs"),
    path.join(harnessDir, "..", ".harnessd", "runs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
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
// Session discovery — find transcript files for the packet/role
// ------------------------------------

interface SessionRef {
  role: WorkerRole;
  packetId: string;
  transcriptPath: string;
  startedAt: string;       // from filename or stat
  artifactDir: string;     // <runDir>/packets/<packet>/<role> or planner equivalent
}

function discoverSessions(runDir: string, packetId: string, roleFilter?: WorkerRole): SessionRef[] {
  const transcriptDir = path.join(runDir, "transcripts", packetId);
  if (!fs.existsSync(transcriptDir)) return [];

  const refs: SessionRef[] = [];
  for (const f of fs.readdirSync(transcriptDir)) {
    if (!f.endsWith(".jsonl")) continue;
    // Filename format: <role>-<isoTs>.jsonl  e.g. builder-2026-04-28T11-19-34-993Z.jsonl
    const match = f.match(/^([a-z_]+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.jsonl$/);
    if (!match) continue;
    const role = match[1] as WorkerRole;
    if (!ALL_ROLES.includes(role)) continue;
    if (roleFilter && role !== roleFilter) continue;

    const isoLike = match[2].replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      "$1-$2-$3T$4:$5:$6.$7Z",
    );

    // For builder/evaluator/qa_agent the artifact dir lives under packets/<packet>/<role>.
    // Planner roles live under spec/.
    const artifactDir = role === "planner" || role === "plan_reviewer" || role === "round2_planner"
      ? path.join(runDir, "spec")
      : path.join(runDir, "packets", packetId, role);

    refs.push({
      role,
      packetId,
      transcriptPath: path.join(transcriptDir, f),
      startedAt: isoLike,
      artifactDir,
    });
  }

  // Sort by startedAt ascending so attempt indices are stable
  refs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return refs;
}

// ------------------------------------
// Load summary — prefer session-summary.json, fall back to live compute
// ------------------------------------

interface LoadedSummary {
  summary: SessionSummary;
  source: "artifact" | "live";
  ref: SessionRef;
}

function loadSummary(ref: SessionRef, runId: string): LoadedSummary {
  const summaryPath = path.join(ref.artifactDir, "session-summary.json");

  if (fs.existsSync(summaryPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
      const parsed = SessionSummarySchema.safeParse(raw);
      if (parsed.success) {
        return { summary: parsed.data, source: "artifact", ref };
      }
    } catch {
      // Fall through to live
    }
  }

  // Live computation path. We don't know envelopeOutcome from outside the
  // worker; reconstruct it from result.json if present.
  let envelopeOutcome: { found: boolean; source: "staged" | "delimiters" | "fence_fallback" | null } | undefined;
  const resultPath = path.join(ref.artifactDir, "result.json");
  if (fs.existsSync(resultPath)) {
    try {
      const r = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      if (typeof r.envelopeFound === "boolean") {
        envelopeOutcome = {
          found: r.envelopeFound,
          source: r.envelopeSource ?? null,
        };
      }
    } catch { /* ignore */ }
  }

  // Best-effort sessionId / endedAt from session.json
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

  const summary = summarizeTranscript(ref.transcriptPath, {
    sessionId,
    role: ref.role,
    packetId: ref.packetId,
    runId,
    startedAt: ref.startedAt,
    endedAt,
    envelopeOutcome,
  });

  return { summary, source: "live", ref };
}

// ------------------------------------
// Render
// ------------------------------------

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "(running)";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function fmtToolCalls(by: Record<string, number>): string {
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "(none)";
  return entries.map(([name, count]) => `${name}=${count}`).join(", ");
}

function render(loaded: LoadedSummary, runId: string): string {
  const s = loaded.summary;
  const lines: string[] = [];

  const attempt = s.attempt ? ` / ${s.attempt}` : "";
  const sidShort = s.sessionId ? s.sessionId.slice(0, 8) + "..." : "(unknown)";
  lines.push(`Session: ${s.role} / ${s.packetId ?? "(no-packet)"}${attempt} / sessionId ${sidShort}`);
  lines.push(`Started:  ${s.startedAt}   Ended: ${s.endedAt ?? "(running)"}   Duration: ${fmtDuration(s.durationMs)}`);
  lines.push(`End reason: ${s.endReason}`);
  if (loaded.source === "live") {
    lines.push(`(summary computed live; harness has not yet written session-summary.json for this session)`);
  }
  lines.push("");

  lines.push(`TURN ACCOUNTING`);
  lines.push(`  Assistant turns:    ${s.turnCount}${s.numTurnsReportedBySdk !== undefined ? ` (SDK reported ${s.numTurnsReportedBySdk})` : ""}`);
  lines.push(`  Tool calls:         ${s.toolCallCount}  (${fmtToolCalls(s.toolCallsByName)})`);
  if (s.costUsd !== undefined) lines.push(`  Cost:               $${s.costUsd.toFixed(2)}`);
  if (s.lastAssistantTextSnippet) {
    const text = s.lastAssistantTextSnippet.replace(/\s+/g, " ").slice(0, 100);
    lines.push(`  Last assistant text: "${text}${text.length === 100 ? "..." : ""}"`);
  }
  if (s.lastToolCall) lines.push(`  Last tool call:     ${s.lastToolCall}`);
  lines.push("");

  lines.push(`ENVELOPE`);
  lines.push(`  Found:              ${s.envelope.found}`);
  lines.push(`  Source:             ${s.envelope.source ?? "(none)"}`);
  if (s.envelope.formatIssue) lines.push(`  Format issue:       ${s.envelope.formatIssue}`);
  lines.push("");

  lines.push(`API / SDK EVENTS`);
  lines.push(`  api_retry:          ${s.apiRetries.length}${s.apiRetries.length >= 3 ? " (storm threshold)" : ""}`);
  if (s.apiRetries.length > 0) {
    const latest = s.apiRetries[s.apiRetries.length - 1];
    lines.push(`    most recent:      attempt ${latest.attempt} at ${latest.ts} (error="${latest.error}")`);
  }
  lines.push(`  rate_limit_event:   ${s.rateLimitEvents.length}`);
  if (s.rateLimitEvents.length > 0) {
    const latest = s.rateLimitEvents[s.rateLimitEvents.length - 1];
    lines.push(`    most recent:      ${latest.rateLimitType}/${latest.status} at ${latest.ts}`);
  }
  lines.push(`  compact_boundary:   ${s.compactBoundaries.length}`);
  if (s.compactBoundaries.length > 0) {
    const total = s.compactBoundaries.reduce((acc, c) => acc + c.durationMs, 0);
    const preTotal = s.compactBoundaries.reduce((acc, c) => acc + c.preTokens, 0);
    const postTotal = s.compactBoundaries.reduce((acc, c) => acc + c.postTokens, 0);
    lines.push(`    cumulative:       ${preTotal} → ${postTotal} tokens, ${fmtDuration(total)}`);
  }
  lines.push("");

  lines.push(`GAPS`);
  if (s.longestGapMs >= 60_000) {
    const priorPart = s.longestGapPriorEvent ? ` after ${s.longestGapPriorEvent}` : "";
    lines.push(`  Longest gap:        ${fmtDuration(s.longestGapMs)}${priorPart}`);
  } else {
    lines.push(`  Longest gap:        ${fmtDuration(s.longestGapMs)} (no significant stalls)`);
  }
  lines.push("");

  lines.push(`ARTIFACTS`);
  lines.push(`  Run:        ${runId}`);
  lines.push(`  Transcript: ${loaded.ref.transcriptPath}`);
  lines.push(`  Heartbeat:  ${path.join(loaded.ref.artifactDir, "heartbeat.json")}`);
  lines.push(`  Result:     ${path.join(loaded.ref.artifactDir, "result.json")}`);
  if (s.envelope.source === "staged") {
    lines.push(`  Staged env: ${path.join(loaded.ref.artifactDir, "staged-envelope.json")}`);
  }

  return lines.join("\n");
}

// ------------------------------------
// Main
// ------------------------------------

function main(): void {
  const args = parseCliArgs();
  const runsDir = findRunsDir();

  let runId = args.runId;
  if (!runId) {
    runId = findLatestRun(runsDir) ?? "";
  }
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
    process.stderr.write(`No sessions found for packet=${args.packetId}${args.role ? ` role=${args.role}` : ""} in run ${runId}\n`);
    process.exit(1);
  }

  if (args.attempt !== undefined) {
    if (args.attempt < 1 || args.attempt > sessions.length) {
      process.stderr.write(`--attempt ${args.attempt} out of range (1..${sessions.length})\n`);
      process.exit(1);
    }
    const ref = sessions[args.attempt - 1];
    process.stdout.write(render(loadSummary(ref, runId), runId) + "\n");
    return;
  }

  if (args.all) {
    for (let i = 0; i < sessions.length; i++) {
      const ref = sessions[i];
      process.stdout.write(`\n${"=".repeat(78)}\n`);
      process.stdout.write(`Attempt ${i + 1} of ${sessions.length}\n`);
      process.stdout.write(`${"=".repeat(78)}\n\n`);
      process.stdout.write(render(loadSummary(ref, runId), runId) + "\n");
    }
    return;
  }

  // Default: latest session
  const ref = sessions[sessions.length - 1];
  process.stdout.write(render(loadSummary(ref, runId), runId) + "\n");
}

main();
