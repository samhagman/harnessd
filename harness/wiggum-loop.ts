#!/usr/bin/env node
/**
 * Wiggum Loop — Autonomous Builder + Verifier Harness
 *
 * Core behavior:
 * - Run fresh BUILDER sessions repeatedly with the same base prompt.
 * - If builder prints ===WIGGUM_COMPLETE===, run a VERIFIER session.
 * - If verifier prints ===VERIFIER_COMPLETE===, exit success.
 * - Otherwise, verifier outputs a report (in <verifier-report> XML tags)
 *   which is appended to the next builder prompt.
 *
 * Verifier constraints (enforced by PreToolUse hook):
 * - CAN edit any code/docs/tests.
 * - CANNOT delete files via Bash (rm/rmdir/unlink, git clean).
 * - CANNOT run mutating or network git commands.
 *
 * Authentication: Uses Claude Max/Pro login via Claude Code CLI.
 *
 * Logs:
 * - JSONL per session under logs/ (tail-able)
 * - Master log with summaries
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { buildBuilderPrompt, verifierPrompt } from "./prompts.js";
import { makeVerifierPreToolUseHook } from "./hooks.js";
import {
  type RunKind,
  type RunResult,
  BUILDER_DONE,
  VERIFIER_DONE,
  nowStamp,
  safeJsonStringify,
  extractTextFromAssistantMessage,
  extractVerifierReport,
  prettyPrintMessage,
} from "./logger.js";

// ------------------------------------
// Config (env overrides)
// ------------------------------------
const REPO_ROOT = process.env.WIGGUM_REPO_ROOT ?? process.cwd();

// Project plans that the harness will execute
const PLAN_DIR = path.resolve(
  REPO_ROOT,
  process.env.WIGGUM_PLAN_DIR ?? "harness/projects/example-project",
);

// TBD: Configure your harness directory
const HARNESS_DIR = path.resolve(
  REPO_ROOT,
  process.env.WIGGUM_HARNESS_DIR ?? "harness",
);

const LOG_DIR = path.resolve(HARNESS_DIR, process.env.WIGGUM_LOG_DIR ?? "logs");

const SANITY_CHECK = process.argv.includes("--sanity-check");

const MAX_LOOPS = SANITY_CHECK
  ? 1
  : Number(process.env.WIGGUM_MAX_LOOPS ?? "15");
const COOLDOWN_SECONDS = SANITY_CHECK
  ? 0
  : Number(process.env.WIGGUM_COOLDOWN_SECONDS ?? "2");

// ------------------------------------
// Sanity-check prompts (trivial tasks to prove the loop works)
// ------------------------------------
const SANITY_BUILDER_PROMPT =
  `You are running a SANITY CHECK for the Wiggum Loop harness.

Your ONLY task:
1. Create a file at /tmp/wiggum-sanity-test.txt containing exactly: wiggum-ok
2. Read it back to confirm it exists and has the right content.

After confirming, output exactly on its own line:
${BUILDER_DONE}

Do this immediately. Do nothing else. No git, no project files, just create that one temp file and output the marker.`.trim();

const SANITY_VERIFIER_PROMPT =
  `You are running a SANITY CHECK verification for the Wiggum Loop harness.

Your ONLY task:
1. Read the file /tmp/wiggum-sanity-test.txt
2. Verify its contents are exactly: wiggum-ok

If the file exists and is correct, output exactly on its own line:
${VERIFIER_DONE}

If something is wrong, output:
<verifier-report>
Describe what is wrong.
</verifier-report>

Do this immediately. Do nothing else.`.trim();

// ------------------------------------
// Sanity checks
// ------------------------------------
function assertRepoLooksRight(): void {
  if (!SANITY_CHECK) {
    // Validate project plan exists
    const planFile = path.join(PLAN_DIR, "CLAUDE.md");
    if (!fs.existsSync(planFile)) {
      throw new Error(
        `Project plan not found at ${planFile}.\n` +
          `Create a project in harness/projects/ or set WIGGUM_PLAN_DIR.`,
      );
    }
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ------------------------------------
// Session runner
// ------------------------------------
async function runSession(
  kind: RunKind,
  prompt: string,
  iteration: number,
): Promise<RunResult> {
  const stamp = nowStamp();
  const logPath = path.join(
    LOG_DIR,
    `${kind}_${String(iteration).padStart(3, "0")}_${stamp}.jsonl`,
  );
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  let combinedText = "";
  let finalResultText = "";
  let sawBuilderDone = false;
  let sawVerifierDone = false;
  let extractedReport: string | null = null;
  let hadError = false;

  // Build hooks for verifier (builder gets none)
  const hooks =
    kind === "verifier"
      ? {
          PreToolUse: [
            { matcher: "Bash", hooks: [makeVerifierPreToolUseHook()] },
          ],
        }
      : undefined;

  // SDK options
  const options: any = {
    cwd: REPO_ROOT,

    // Load user-scope settings (MCP servers, skills) + project CLAUDE.md files
    settingSources: ["user", "project"],

    // Full autonomy — hook still blocks what we deny for verifier
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,

    // Only verifier has hooks
    ...(hooks ? { hooks } : {}),
  };

  console.log(
    `\n--- ${kind.toUpperCase()} session start (iter ${iteration}) ---`,
  );
  console.log(`log: ${path.relative(REPO_ROOT, logPath)}`);
  console.log(
    `tail: tail -f "${path.relative(REPO_ROOT, logPath)}" | jq -r 'select(.msg.type=="assistant") | (.msg.message.content[]? | select(.type=="text") | .text)'`,
  );
  console.log("------------------------------------------------------------");

  try {
    for await (const msg of query({ prompt, options })) {
      logStream.write(
        safeJsonStringify({
          ts: new Date().toISOString(),
          kind,
          iteration,
          msg,
        }) + "\n",
      );

      prettyPrintMessage(kind, msg);

      if (msg.type === "assistant") {
        const t = extractTextFromAssistantMessage(msg);
        if (t) combinedText += t;
      }

      if (msg.type === "result") {
        if (
          msg.subtype === "success" &&
          typeof (msg as any).result === "string"
        ) {
          finalResultText = (msg as any).result;
        } else {
          hadError = true;
        }
      }
    }
  } catch (err: any) {
    hadError = true;
    const line = `[${new Date().toISOString()}] ${kind} crashed: ${err?.stack ?? String(err)}\n`;
    logStream.write(line);
    console.error(line);
  } finally {
    logStream.end();
  }

  const allText = (finalResultText || combinedText || "").trim();
  if (allText.includes(BUILDER_DONE)) sawBuilderDone = true;
  if (allText.includes(VERIFIER_DONE)) sawVerifierDone = true;

  if (kind === "verifier" && !sawVerifierDone) {
    extractedReport = extractVerifierReport(allText) ?? allText;
  }

  return {
    kind,
    logPath,
    resultText: allText,
    sawBuilderDone,
    sawVerifierDone,
    extractedVerifierReport: extractedReport,
    hadError,
  };
}

// ------------------------------------
// Main loop
// ------------------------------------
async function main(): Promise<void> {
  assertRepoLooksRight();

  const masterLog = path.join(LOG_DIR, "wiggum_master.log");
  fs.appendFileSync(
    masterLog,
    `\n========== WIGGUM LOOP START ${new Date().toISOString()} ==========\n`,
  );

  console.log("============================================================");
  if (SANITY_CHECK) {
    console.log("  WIGGUM LOOP — SANITY CHECK MODE");
    console.log("  (trivial prompts to prove builder→verifier→exit works)");
  } else {
    // TBD: Update this title for your project
    console.log("  WIGGUM LOOP — Harnessd");
  }
  console.log("============================================================");
  if (!SANITY_CHECK) {
    console.log(`Plan dir:     ${path.relative(REPO_ROOT, PLAN_DIR)}`);
  }
  console.log(`Logs:         ${path.relative(REPO_ROOT, LOG_DIR)}`);
  console.log(`Master log:   ${path.relative(REPO_ROOT, masterLog)}`);
  console.log(`Max loops:    ${MAX_LOOPS}`);
  console.log(`Cooldown:     ${COOLDOWN_SECONDS}s`);
  console.log("============================================================\n");

  let latestVerifierReport: string | null = null;

  for (let i = 1; i <= MAX_LOOPS; i++) {
    fs.appendFileSync(
      masterLog,
      `\n--- loop ${i}/${MAX_LOOPS} @ ${new Date().toISOString()} ---\n`,
    );

    // 1) Builder
    const builderPrompt = SANITY_CHECK
      ? SANITY_BUILDER_PROMPT
      : buildBuilderPrompt(REPO_ROOT, PLAN_DIR, latestVerifierReport);
    const builder = await runSession("builder", builderPrompt, i);

    fs.appendFileSync(
      masterLog,
      `[builder] error=${builder.hadError} done=${builder.sawBuilderDone} log=${builder.logPath}\n`,
    );

    if (!builder.sawBuilderDone) {
      console.log(
        `\n[loop ${i}] Builder not complete; sleeping ${COOLDOWN_SECONDS}s before next iteration...\n`,
      );
      if (i < MAX_LOOPS) {
        await new Promise((r) => setTimeout(r, COOLDOWN_SECONDS * 1000));
      }
      continue;
    }

    // 2) Verifier (only when builder claims complete)
    const vPrompt = SANITY_CHECK
      ? SANITY_VERIFIER_PROMPT
      : verifierPrompt(REPO_ROOT, PLAN_DIR);
    const verifier = await runSession("verifier", vPrompt, i);

    fs.appendFileSync(
      masterLog,
      `[verifier] error=${verifier.hadError} verified=${verifier.sawVerifierDone} log=${verifier.logPath}\n`,
    );

    if (verifier.sawVerifierDone) {
      console.log(
        "\n============================================================",
      );
      console.log("  VERIFIED COMPLETE (builder + verifier agree)");
      console.log(
        "============================================================\n",
      );
      fs.appendFileSync(
        masterLog,
        `VERIFIED COMPLETE @ ${new Date().toISOString()}\n`,
      );
      process.exit(0);
    }

    // 3) Verifier says more work remains — capture report for next builder
    latestVerifierReport = verifier.extractedVerifierReport?.trim() || null;

    if (latestVerifierReport) {
      fs.appendFileSync(
        masterLog,
        `[verifier-report]\n${latestVerifierReport}\n`,
      );
      console.log(
        "\n[loop] Verifier requires more work; report captured for next builder.\n",
      );
    } else {
      console.log(
        "\n[loop] Verifier requires more work but no report extracted; continuing.\n",
      );
    }

    if (i < MAX_LOOPS) {
      await new Promise((r) => setTimeout(r, COOLDOWN_SECONDS * 1000));
    }
  }

  console.error(
    `\nHit maximum loops (${MAX_LOOPS}). Check master log: ${masterLog}\n`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
