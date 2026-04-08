/**
 * Session recovery: extract partial progress from crashed evaluator transcripts.
 *
 * When an evaluator session crashes (OOM, rate limit, context exhaustion) before
 * emitting its result envelope, this module parses the transcript JSONL to salvage
 * any criterion verdicts, hard failures, and investigation context the evaluator
 * produced before dying.
 *
 * The extracted PartialProgress is formatted as a markdown preamble and injected
 * into the retry evaluator's prompt so it can skip or spot-check already-verified
 * criteria instead of starting from scratch.
 *
 * Reference: TAD section 14 (evaluator), CLAUDE.md (session recovery)
 */

import fs from "node:fs";
import path from "node:path";

import { getRunDir } from "./state-store.js";

// ------------------------------------
// Types
// ------------------------------------

export interface PartialProgress {
  verifiedCriteria: Array<{
    criterionId: string;
    verdict: "pass" | "fail" | "skip";
    evidence: string;
  }>;
  hardFailuresFound: Array<{
    criterionId: string;
    description: string;
  }>;
  investigationSummary: string;
  turnCount: number;
  sessionDuration: string;
}

// ------------------------------------
// Transcript line shape (matches worker.ts logMessage)
// ------------------------------------

interface TranscriptLine {
  ts: string;
  role: string;
  msg: {
    type: string;
    text?: string;
    subtype?: string;
    isError?: boolean;
    [key: string]: unknown;
  };
}

// ------------------------------------
// Verdict extraction (fuzzy patterns)
// ------------------------------------

/**
 * Patterns that match criterion verdict mentions in evaluator prose.
 *
 * We look for AC-style IDs (ac-foo, AC-FOO, ac_foo) followed by a verdict word.
 * The patterns are intentionally loose — false positives are cheap; false negatives
 * lose valuable recovery data.
 */
const CRITERION_ID_PATTERN = /\b(ac[-_][\w-]+)/gi;

const VERDICT_PATTERNS: Array<{
  regex: RegExp;
  verdict: "pass" | "fail" | "skip";
}> = [
  // "AC-1: pass" or "ac-1: PASS" or "**AC-1** (pass)"
  { regex: /\b(ac[-_][\w-]+)\b[*]*\s*[:(]\s*pass/gi, verdict: "pass" },
  { regex: /\b(ac[-_][\w-]+)\b[*]*\s*[:(]\s*fail/gi, verdict: "fail" },
  { regex: /\b(ac[-_][\w-]+)\b[*]*\s*[:(]\s*skip/gi, verdict: "skip" },

  // "criterion ac-1 passes" or "ac-1 passed"
  { regex: /\b(ac[-_][\w-]+)\b\s+pass(?:es|ed)?\b/gi, verdict: "pass" },
  { regex: /\b(ac[-_][\w-]+)\b\s+fail(?:s|ed)?\b/gi, verdict: "fail" },
  { regex: /\b(ac[-_][\w-]+)\b\s+skip(?:s|ped)?\b/gi, verdict: "skip" },

  // "verdict: pass" with nearby criterion ID — handled in extractVerdicts below
  { regex: /verdict[:\s]+pass/gi, verdict: "pass" },
  { regex: /verdict[:\s]+fail/gi, verdict: "fail" },
  { regex: /verdict[:\s]+skip/gi, verdict: "skip" },
];

/**
 * Hard-failure signal patterns. When these appear near a criterion ID,
 * we record a hard failure.
 */
const HARD_FAILURE_PATTERNS = [
  /\bhard\s+fail(?:ure)?\b/gi,
  /\bFAIL:/g,
  /\bBLOCKING\b/g,
  /\bblocking\s+fail(?:ure)?\b/gi,
  /\bcritical\s+fail(?:ure)?\b/gi,
];

interface ExtractedVerdict {
  criterionId: string;
  verdict: "pass" | "fail" | "skip";
  evidence: string;
}

/**
 * Extract criterion verdicts from a single text block.
 * Returns de-duped verdicts (last mention wins if contradictory).
 */
function extractVerdicts(text: string): ExtractedVerdict[] {
  const found = new Map<string, ExtractedVerdict>();

  for (const { regex, verdict } of VERDICT_PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      let criterionId = match[1];

      // If the pattern didn't capture a criterion ID directly (the "verdict: pass" patterns),
      // search backward for the nearest criterion ID
      if (!criterionId || !CRITERION_ID_PATTERN.test(criterionId)) {
        CRITERION_ID_PATTERN.lastIndex = 0;
        const before = text.slice(Math.max(0, match.index - 200), match.index);
        const ids = [...before.matchAll(new RegExp(CRITERION_ID_PATTERN.source, "gi"))];
        if (ids.length > 0) {
          criterionId = ids[ids.length - 1]![1]!;
        } else {
          continue; // No nearby criterion ID, skip
        }
      }

      const normalizedId = criterionId.toLowerCase().replace(/_/g, "-");

      // Extract evidence: the sentence or nearby context containing the verdict
      const evidenceStart = Math.max(0, match.index - 150);
      const evidenceEnd = Math.min(text.length, match.index + match[0].length + 200);
      const evidence = text.slice(evidenceStart, evidenceEnd).trim();

      found.set(normalizedId, { criterionId: normalizedId, verdict, evidence });
    }
  }

  return [...found.values()];
}

/**
 * Extract hard failures from a single text block.
 */
function extractHardFailures(
  text: string,
): Array<{ criterionId: string; description: string }> {
  const failures: Array<{ criterionId: string; description: string }> = [];
  const seen = new Set<string>();

  for (const pattern of HARD_FAILURE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // Search nearby for a criterion ID
      const searchStart = Math.max(0, match.index - 200);
      const searchEnd = Math.min(text.length, match.index + match[0].length + 200);
      const nearby = text.slice(searchStart, searchEnd);

      const idMatches = [...nearby.matchAll(new RegExp(CRITERION_ID_PATTERN.source, "gi"))];
      const criterionId = idMatches.length > 0
        ? idMatches[0]![1]!.toLowerCase().replace(/_/g, "-")
        : "unknown";

      if (seen.has(criterionId)) continue;
      seen.add(criterionId);

      // Extract a description from the surrounding context
      const descStart = Math.max(0, match.index - 100);
      const descEnd = Math.min(text.length, match.index + match[0].length + 300);
      const description = text.slice(descStart, descEnd).trim();

      failures.push({ criterionId, description });
    }
  }

  return failures;
}

// ------------------------------------
// Duration formatting
// ------------------------------------

function formatDuration(startIso: string, endIso: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const diffMs = Math.max(0, endMs - startMs);

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ------------------------------------
// Main extraction
// ------------------------------------

/**
 * Extract partial progress from a crashed evaluator transcript.
 *
 * Reads the JSONL file line by line, collects assistant-message text,
 * and applies fuzzy pattern matching to find criterion verdicts and
 * hard failures the evaluator mentioned before crashing.
 *
 * Returns null if no verdicts were found (nothing to recover).
 */
export function extractPartialProgress(
  transcriptPath: string,
): PartialProgress | null {
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const assistantTexts: string[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const line of lines) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // Skip malformed lines
    }

    // Track timestamps from all messages
    if (parsed.ts) {
      if (!firstTs) firstTs = parsed.ts;
      lastTs = parsed.ts;
    }

    // Only process assistant messages with text content
    if (parsed.msg?.type === "assistant" && parsed.msg.text) {
      assistantTexts.push(parsed.msg.text);
    }
  }

  if (assistantTexts.length === 0) return null;

  // Collect verdicts and hard failures across all assistant messages
  const allVerdicts = new Map<string, ExtractedVerdict>();
  const allHardFailures: Array<{ criterionId: string; description: string }> = [];
  const hardFailureSeen = new Set<string>();

  for (const text of assistantTexts) {
    // Extract verdicts — last mention wins per criterion
    for (const v of extractVerdicts(text)) {
      allVerdicts.set(v.criterionId, v);
    }

    // Extract hard failures — de-dupe by criterionId
    for (const hf of extractHardFailures(text)) {
      if (!hardFailureSeen.has(hf.criterionId)) {
        hardFailureSeen.add(hf.criterionId);
        allHardFailures.push(hf);
      }
    }
  }

  // If the evaluator barely started (< 3 assistant messages), not enough to recover
  if (assistantTexts.length < 3) {
    return null;
  }

  // Build investigation summary from the last 3 assistant messages
  const lastMessages = assistantTexts.slice(-3);
  const investigationSummary = lastMessages
    .map((t) => (t.length > 500 ? t.slice(0, 500) + "..." : t))
    .join("\n\n---\n\n");

  // Session duration
  const sessionDuration =
    firstTs && lastTs ? formatDuration(firstTs, lastTs) : "unknown";

  return {
    verifiedCriteria: [...allVerdicts.values()],
    hardFailuresFound: allHardFailures,
    investigationSummary,
    turnCount: assistantTexts.length,
    sessionDuration,
  };
}

// ------------------------------------
// Format for prompt injection
// ------------------------------------

/**
 * Format extracted partial progress as a markdown section suitable for
 * injection into a retry evaluator's system prompt.
 *
 * The format gives the retry evaluator clear instructions per verdict:
 * - pass verdicts: quick spot-check only
 * - fail verdicts: re-verify fully with fresh evidence
 * - unlisted criteria: evaluate from scratch
 */
export function formatPriorProgress(progress: PartialProgress): string {
  const lines: string[] = [];

  lines.push("## Prior Evaluator Progress (recovered from crashed session)");
  lines.push("");
  lines.push(
    `The previous evaluator session ran for ${progress.sessionDuration} ` +
    `(${progress.turnCount} turns) before crashing. Below is what it verified.`,
  );
  lines.push("");

  // Criterion verdicts
  if (progress.verifiedCriteria.length > 0) {
    lines.push("### Criterion Verdicts from Prior Session");
    lines.push("");
    for (const v of progress.verifiedCriteria) {
      const icon =
        v.verdict === "pass" ? "[PASS]" :
        v.verdict === "fail" ? "[FAIL]" :
        "[SKIP]";
      lines.push(`- **${v.criterionId}** ${icon}`);
      lines.push(`  Evidence: ${v.evidence.slice(0, 300)}${v.evidence.length > 300 ? "..." : ""}`);
    }
    lines.push("");
  }

  // Hard failures
  if (progress.hardFailuresFound.length > 0) {
    lines.push("### Hard Failures Identified");
    lines.push("");
    for (const hf of progress.hardFailuresFound) {
      lines.push(`- **${hf.criterionId}**: ${hf.description.slice(0, 300)}${hf.description.length > 300 ? "..." : ""}`);
    }
    lines.push("");
  }

  // Investigation summary
  lines.push("### Investigation Summary (last 3 messages)");
  lines.push("");
  lines.push(progress.investigationSummary);
  lines.push("");

  // Instructions for the retry evaluator
  lines.push("### Instructions for This Session");
  lines.push("");
  lines.push("- **PASS verdicts above**: do a quick spot-check to confirm, then reuse the verdict.");
  lines.push("- **FAIL verdicts above**: re-verify fully with fresh evidence — the prior session may have been wrong.");
  lines.push("- **Criteria not listed above**: evaluate from scratch — the prior session did not reach them.");
  lines.push("");

  return lines.join("\n");
}

// ------------------------------------
// Session ID discovery
// ------------------------------------

/**
 * Read the SDK session ID from a prior worker's session.json artifact.
 *
 * Returns the sessionId string if the file exists and contains a valid
 * sessionId field; returns null otherwise (file missing, malformed, or
 * the field is absent — e.g. for Codex runs which don't write a sessionId).
 */
export function readPriorSessionId(
  repoRoot: string,
  runId: string,
  artifactDir: string,
): string | null {
  const runDir = getRunDir(repoRoot, runId);
  const sessionPath = path.join(runDir, artifactDir, "session.json");
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    return typeof raw?.sessionId === "string" ? raw.sessionId : null;
  } catch {
    return null;
  }
}

// ------------------------------------
// Transcript discovery
// ------------------------------------

/**
 * Find the most recent transcript for a given packet and role.
 *
 * Looks in `{runDir}/transcripts/{packetId}/` for files matching
 * `{role}-*.jsonl` and returns the one with the latest timestamp
 * in its filename (filenames are `{role}-{ISO-timestamp}.jsonl`).
 *
 * Returns null if no matching transcript is found.
 */
export function findLatestTranscript(
  repoRoot: string,
  runId: string,
  packetId: string,
  role: string,
): string | null {
  const runDir = getRunDir(repoRoot, runId);
  const transcriptDir = path.join(runDir, "transcripts", packetId);

  let entries: string[];
  try {
    entries = fs.readdirSync(transcriptDir);
  } catch {
    return null; // Directory doesn't exist
  }

  const prefix = `${role}-`;
  const matching = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .sort(); // Lexicographic sort = chronological (ISO timestamps)

  if (matching.length === 0) return null;

  return path.join(transcriptDir, matching[matching.length - 1]!);
}
