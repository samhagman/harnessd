/**
 * Recovery agent: spawns a short Claude session to summarize a crashed evaluator
 * transcript into a structured handoff for the retry session.
 *
 * When an evaluator crashes mid-session, the retry evaluator needs to know
 * which criteria were already verified so it can skip them (or spot-check)
 * instead of re-doing everything from scratch. This module asks Claude to
 * read the raw transcript and produce that summary.
 *
 * Falls back to extractPartialProgress() (static regex extraction) if the
 * recovery session itself fails or times out.
 *
 * Reference: TAD section 14 (evaluator crash recovery)
 */

import type { AgentBackend } from "./backend/types.js";
import type { PacketContract } from "./schemas.js";
import { extractPartialProgress, formatPriorProgress } from "./session-recovery.js";
import { MemvidBuffer, agentMessageToDocuments } from "./memvid.js";
import type { RunMemory } from "./memvid.js";
import fs from "node:fs";

// ------------------------------------
// Recovery session
// ------------------------------------

const RECOVERY_MAX_TURNS = 3;
const RECOVERY_MAX_BUDGET_USD = 0.10;

/**
 * Spawn a short Claude session to read a crashed evaluator transcript and
 * produce a structured handoff summary for the retry session.
 *
 * @param backend  The agent backend (Claude SDK). Should be the Claude backend —
 *                 not Codex — since this is a short analysis task, not a build.
 * @param transcriptPath  Absolute path to the crashed evaluator transcript (.jsonl).
 * @param contract  The packet contract (used to enumerate expected criteria).
 * @returns A markdown string summarising what the crashed session accomplished,
 *          ready to be injected into the retry evaluator's prompt.
 *          Returns null if the transcript doesn't exist or can't be read.
 */
export async function recoverFromCrashedSession(
  backend: AgentBackend,
  transcriptPath: string,
  contract: PacketContract,
  memory?: RunMemory | null,
): Promise<string | null> {
  // 1. Read the crashed transcript
  let transcriptContent: string;
  try {
    transcriptContent = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  if (!transcriptContent.trim()) {
    return null;
  }

  // Extract the text lines from the JSONL for readability in the prompt
  const assistantLines: string[] = [];
  for (const line of transcriptContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { role?: string; msg?: { type?: string; text?: string } };
      if (parsed.msg?.type === "assistant" && parsed.msg.text) {
        assistantLines.push(parsed.msg.text);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (assistantLines.length < 3) {
    // Not enough content for Claude to summarize — fall back to static extraction
    return staticFallback(transcriptPath);
  }

  // 2. Build the recovery prompt
  const criteriaList = contract.acceptance
    .map((ac) => `- ${ac.id} (${ac.blocking ? "BLOCKING" : "advisory"}): ${ac.description}`)
    .join("\n");

  const condensedTranscript = assistantLines.join("\n\n---\n\n");

  const prompt = `You are a recovery assistant. A previous evaluator session for packet "${contract.packetId}" crashed before finishing. Below is the text the evaluator produced (assistant messages only, extracted from the session transcript).

Your job: produce a concise handoff summary so the retry evaluator knows what was already done.

## Acceptance Criteria (from contract)
${criteriaList}

## Crashed Session Transcript
${condensedTranscript}

## Instructions
Produce a markdown summary with these sections:

### Criterion Status
For EACH criterion listed above, classify it as one of:
- **VERIFIED PASS** — the evaluator confirmed it passes with evidence
- **VERIFIED FAIL** — the evaluator found it fails with evidence
- **IN PROGRESS** — the evaluator was actively working on this when it crashed
- **NOT YET CHECKED** — the evaluator did not reach this criterion

Include a brief (1-2 sentence) evidence note for VERIFIED verdicts only.

### What Was In Progress
Describe what the evaluator was doing when the session died (last active task, any partial findings).

### Key Findings
Bullet list of any significant findings (hard failures, suspicious code, issues noted) regardless of whether they were fully verified.

### Remaining Work
What the retry evaluator needs to focus on (criteria not yet checked or only partially checked).

Be concise. The retry evaluator will receive this as context — do not be verbose.
Reply with ONLY the markdown summary. No preamble, no envelope.`;

  // 3. Run a short recovery session
  try {
    let summaryText = "";

    const memvidBuffer = memory ? new MemvidBuffer(memory) : null;
    let turnIndex = 0;

    const session = backend.runSession({
      prompt,
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      allowedTools: [],
      disallowedTools: [
        "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit",
        "TodoWrite", "TodoRead", "WebSearch", "WebFetch",
        "mcp__playwright__browser_navigate",
      ],
      maxTurns: RECOVERY_MAX_TURNS,
      maxBudgetUsd: RECOVERY_MAX_BUDGET_USD,
    });

    try {
      for await (const msg of session) {
        if (msg.type === "assistant" && msg.text) {
          summaryText += msg.text;
        }
        if (memvidBuffer) {
          if (msg.type === 'assistant' && msg.text) turnIndex++;
          const docs = agentMessageToDocuments(msg, { role: 'recovery_agent', packetId: contract.packetId, turnIndex });
          if (docs.length > 0) memvidBuffer.addMany(docs);
        }
      }
    } finally {
      if (memvidBuffer) memvidBuffer.stop();
    }

    const trimmed = summaryText.trim();
    if (trimmed.length > 100) {
      // Return the raw summary — evaluator-prompt.ts wraps it with the header/footer
      return trimmed;
    }

    // Short or empty response — fall through to static fallback
  } catch {
    // Recovery session itself failed — fall through to static fallback
  }

  // 4. Fall back to static extraction
  return staticFallback(transcriptPath);
}

// ------------------------------------
// Static fallback
// ------------------------------------

/**
 * Fall back to static regex-based extraction when the recovery session fails.
 * Returns a formatted markdown string or null if nothing could be extracted.
 */
function staticFallback(transcriptPath: string): string | null {
  const progress = extractPartialProgress(transcriptPath);
  if (!progress || progress.verifiedCriteria.length === 0) {
    return null;
  }
  // Return the raw formatted progress — evaluator-prompt.ts wraps it with the header/footer
  return formatPriorProgress(progress);
}
