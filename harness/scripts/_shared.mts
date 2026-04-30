/**
 * Shared helpers for diagnose-cli.mts and session-summary-cli.mts.
 */

import fs from "node:fs";
import path from "node:path";

import {
  SessionSummarySchema,
  type SessionSummary,
  type WorkerRole,
} from "../src/schemas.js";
import { summarizeTranscript } from "../src/session-summary.js";

export const ALL_ROLES: WorkerRole[] = [
  "planner",
  "plan_reviewer",
  "contract_builder",
  "contract_evaluator",
  "builder",
  "evaluator",
  "qa_agent",
  "round2_planner",
];

export interface SessionRef {
  role: WorkerRole;
  packetId: string;
  transcriptPath: string;
  startedAt: string;
  artifactDir: string;
}

export function findRunsDir(): string {
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

export function findLatestRun(runsDir: string): string | null {
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

export function discoverSessions(
  runDir: string,
  packetId: string,
  roleFilter?: WorkerRole,
): SessionRef[] {
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
    const artifactDir =
      role === "planner" || role === "plan_reviewer" || role === "round2_planner"
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
  refs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return refs;
}

export function loadSessionSummary(ref: SessionRef, runId: string): SessionSummary {
  const summaryPath = path.join(ref.artifactDir, "session-summary.json");
  if (fs.existsSync(summaryPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
      const parsed = SessionSummarySchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch { /* fall through */ }
  }

  let envelopeOutcome:
    | { found: boolean; source: "staged" | "delimiters" | "fence_fallback" | null }
    | undefined;
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
