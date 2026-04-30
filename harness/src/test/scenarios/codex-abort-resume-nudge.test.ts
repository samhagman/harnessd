/**
 * Scenario test: Codex abort+resume nudge delivery.
 *
 * Verifies that when a send_to_agent inbox message arrives while a Codex-strategy
 * builder is running, the orchestrator:
 *   1. Calls queueNudge() on the active backend.
 *   2. Emits a `builder.aborted-for-nudge` event with the session ID and nudge text.
 *   3. On the next builder invocation, passes `resume: sessionId` and prepends
 *      "OPERATOR NUDGE:\n{text}\n\n" to the prompt.
 *
 * Uses MultiCallNudgeBackend — a backend that simulates the Codex abort+resume
 * behaviour without spawning a real child process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { AgentMessage, AgentBackend, AgentSessionOptions, NudgeOutcome } from "../../backend/types.js";
import { runOrchestrator } from "../../orchestrator.js";
import { getRunDir, getLatestRunId } from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import { RESULT_START_SENTINEL, RESULT_END_SENTINEL } from "../../schemas.js";
import {
  makeScript,
  plannerEnvelope,
  contractBuilderEnvelope,
  contractEvaluatorAcceptEnvelope,
  evaluatorPassEnvelope,
} from "../helpers/scripted-backend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-nudge-ar-"));
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function builderReportEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "builder-session-resumed",
    changedFiles: ["src/util.ts"],
    commandsRun: [],
    liveBackgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [{ criterionId: "AC-001", status: "pass", evidence: "Runs OK" }],
    remainingConcerns: [],
    claimsDone: true,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

/**
 * A multi-call backend that dispatches different scripts per call index.
 *
 * For "blocking" call indices, the runSession generator yields the initial messages
 * and then waits indefinitely (with small polling sleeps) until queueNudge() is called
 * to abort it — simulating a long-running Codex child process that can be SIGTERM-ed.
 *
 * For non-blocking calls, it yields all messages from the script immediately.
 */
class MultiCallNudgeBackend implements AgentBackend {
  private callIndex = 0;
  private scripts: AgentMessage[][];
  private lastSessionIdVal: string | null = null;
  private activeSession: { ac: AbortController; sessionId: string } | null = null;
  private blockingCallIndices: Set<number>;

  readonly calls: AgentSessionOptions[] = [];
  readonly nudgeOutcomes: NudgeOutcome[] = [];

  constructor(scripts: AgentMessage[][], blockingCallIndices: number[] = []) {
    this.scripts = scripts;
    this.blockingCallIndices = new Set(blockingCallIndices);
  }

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    this.calls.push(opts);
    const idx = this.callIndex++;
    const script = this.scripts[idx];
    if (!script) throw new Error(`MultiCallNudgeBackend: no script for call index ${idx} (${this.scripts.length} scripts available)`);

    const ac = new AbortController();
    const sessionId = `session-${idx}`;
    this.activeSession = { ac, sessionId };
    this.lastSessionIdVal = sessionId;

    try {
      for (const msg of script) {
        if (ac.signal.aborted) return;
        if (msg.sessionId) this.lastSessionIdVal = msg.sessionId;
        yield msg;
      }
      if (this.blockingCallIndices.has(idx)) {
        while (!ac.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return;
      }
    } finally {
      this.activeSession = null;
    }
  }

  getLastSessionId(): string | null { return this.lastSessionIdVal; }

  queueNudge(text: string): NudgeOutcome {
    if (!this.activeSession) return { handled: false };
    const { ac, sessionId } = this.activeSession;
    ac.abort();
    const outcome: NudgeOutcome = { handled: true, via: "abort-resume", sessionId, nudgeText: text };
    this.nudgeOutcomes.push(outcome);
    return outcome;
  }

  abortSession(): string | null {
    if (!this.activeSession) return null;
    const sid = this.activeSession.sessionId;
    this.activeSession.ac.abort();
    return sid;
  }

  supportsResume(): boolean { return true; }
  supportsMcpServers(): boolean { return false; }
  nudgeStrategy(): "stream" | "abort-resume" | "none" { return "abort-resume"; }
  supportsOutputSchema(): boolean { return false; }
}

describe("codex abort+resume nudge scenario", () => {
  // First builder attempt gets aborted (blocked until SIGTERM). After the nudge,
  // the orchestrator resumes with the nudge text prepended to the prompt.
  // Allow 45s: includes the ~10s RETRY_COOLDOWN + ~3s nudge poller interval.
  it("emits builder.aborted-for-nudge and resumes with nudge in prompt", async () => {
    const NUDGE_TEXT = "also handle the edge case where input is empty";

    const scripts: AgentMessage[][] = [
      // 0: planner
      [
        { type: "system", subtype: "init", sessionId: "planner-sess" },
        { type: "assistant", text: plannerEnvelope() },
        { type: "result", subtype: "success", text: plannerEnvelope(), isError: false, numTurns: 1, sessionId: "planner-sess" },
      ],
      // 1: contract builder
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-sess"),
      // 2: contract evaluator (accept)
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-sess"),
      // 3: builder first attempt — yields init then blocks (no result envelope — simulates SIGTERM abort)
      [
        { type: "system", subtype: "init", sessionId: "builder-sess-001" },
        { type: "assistant", text: "I am analyzing the codebase..." },
      ],
      // 4: builder second attempt (resumed with nudge)
      makeScript(builderReportEnvelope("PKT-001"), "builder-sess-002"),
      // 5: evaluator pass
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-sess"),
    ];

    const backend = new MultiCallNudgeBackend(scripts, [3]);

    let nudgeSent = false;
    const autoApprove = setInterval(() => {
      try {
        const rid = getLatestRunId(tmpDir);
        if (!rid) return;
        const rd = getRunDir(tmpDir, rid);
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));
        const inboxDir = path.join(rd, "inbox");
        fs.mkdirSync(inboxDir, { recursive: true });

        if (runJson.phase === "awaiting_plan_approval") {
          fs.writeFileSync(
            path.join(inboxDir, "auto-approve.json"),
            JSON.stringify({ type: "approve_plan", createdAt: new Date().toISOString(), message: "auto" }),
          );
        }

        if (!nudgeSent && runJson.phase === "building_packet") {
          nudgeSent = true;
          try {
            fs.writeFileSync(
              path.join(inboxDir, "nudge.json"),
              JSON.stringify({ type: "send_to_agent", createdAt: new Date().toISOString(), message: NUDGE_TEXT }),
            );
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }, 50);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "Build a helper utility",
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoApprove);

    const latestRunId = getLatestRunId(tmpDir);
    expect(latestRunId).not.toBeNull();
    const runDir = getRunDir(tmpDir, latestRunId!);

    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8"));
    expect(runJson.phase).toBe("completed");

    const events = readEvents(tmpDir, latestRunId!);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("builder.aborted-for-nudge");
    expect(eventTypes).toContain("nudge.sent");

    const abortEvent = events.find((e) => e.event === "builder.aborted-for-nudge");
    expect(abortEvent).toBeDefined();
    expect(abortEvent?.detail).toContain("aborted for nudge");

    expect(backend.nudgeOutcomes.length).toBeGreaterThan(0);
    const nudgeOutcome = backend.nudgeOutcomes[0]!;
    expect(nudgeOutcome.handled).toBe(true);
    if (nudgeOutcome.handled) {
      expect(nudgeOutcome.via).toBe("abort-resume");
      expect((nudgeOutcome as { via: "abort-resume"; nudgeText: string }).nudgeText).toBe(NUDGE_TEXT);
    }

    const builderResumeCall = backend.calls.find(
      (call) => typeof call.prompt === "string" && call.prompt.startsWith("OPERATOR NUDGE:"),
    );
    expect(builderResumeCall).toBeDefined();
    expect(builderResumeCall?.prompt).toContain(NUDGE_TEXT);
    expect(builderResumeCall?.resume).toBeDefined();
  }, 45_000);
});
