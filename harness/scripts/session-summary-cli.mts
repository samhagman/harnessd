#!/usr/bin/env npx tsx
/**
 * Narrative session summary CLI — invoked via harness/session.sh.
 *
 * Prefers the harness-written session-summary.json artifact when present.
 * Falls back to live computation via summarizeTranscript() for older runs
 * or sessions that crashed before the harness wrote the final summary.
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";

import type { SessionSummary, WorkerRole } from "../src/schemas.js";
import {
  ALL_ROLES,
  SessionRef,
  discoverSessions,
  findLatestRun,
  findRunsDir,
  loadSessionSummary,
} from "./_shared.mjs";

// ------------------------------------
// Args
// ------------------------------------

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

interface LoadedSummary {
  summary: SessionSummary;
  source: "artifact" | "live";
  ref: SessionRef;
}

function loadWithSource(ref: SessionRef, runId: string): LoadedSummary {
  const summaryPath = path.join(ref.artifactDir, "session-summary.json");
  const isArtifact = fs.existsSync(summaryPath);
  const summary = loadSessionSummary(ref, runId);
  const source = isArtifact ? "artifact" : "live";
  return { summary, source, ref };
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
  const runId = args.runId ?? findLatestRun(runsDir) ?? "";
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
    process.stderr.write(
      `No sessions found for packet=${args.packetId}${args.role ? ` role=${args.role}` : ""} in run ${runId}\n`,
    );
    process.exit(1);
  }

  if (args.attempt !== undefined) {
    if (args.attempt < 1 || args.attempt > sessions.length) {
      process.stderr.write(`--attempt ${args.attempt} out of range (1..${sessions.length})\n`);
      process.exit(1);
    }
    process.stdout.write(render(loadWithSource(sessions[args.attempt - 1], runId), runId) + "\n");
    return;
  }

  if (args.all) {
    for (let i = 0; i < sessions.length; i++) {
      process.stdout.write(`\n${"=".repeat(78)}\n`);
      process.stdout.write(`Attempt ${i + 1} of ${sessions.length}\n`);
      process.stdout.write(`${"=".repeat(78)}\n\n`);
      process.stdout.write(render(loadWithSource(sessions[i], runId), runId) + "\n");
    }
    return;
  }

  process.stdout.write(render(loadWithSource(sessions[sessions.length - 1], runId), runId) + "\n");
}

main();
