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
 * Uses a ScriptedNudgeBackend — a backend that simulates the Codex abort+resume
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
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../../schemas.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-nudge-ar-"));
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
});

// ------------------------------------
// Fake response builders
// ------------------------------------

function plannerEnvelope(): string {
  const payload = {
    spec: "# Spec\n\nBuild a simple utility.\n",
    packets: [
      {
        id: "PKT-001",
        title: "Build utility",
        type: "tooling",
        objective: "Create a helper utility",
        whyNow: "Needed now",
        dependencies: [],
        status: "pending",
        priority: 1,
        estimatedSize: "S",
        risks: [],
        notes: [],
      },
    ],
    riskRegister: { risks: [] },
    evaluatorGuide: {
      domain: "tooling",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Works" }],
      antiPatterns: [],
      referenceStandard: "Clean code",
      edgeCases: [],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "One packet: utility.\n",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function contractBuilderEnvelope(packetId: string): string {
  const payload = {
    packetId,
    round: 1,
    status: "proposed",
    title: `Implement ${packetId}`,
    packetType: "tooling",
    objective: `Implement ${packetId}`,
    inScope: ["Create utility"],
    outOfScope: ["Deployment automation", "CI/CD setup"],
    assumptions: [],
    risks: [],
    likelyFiles: ["src/util.ts"],
    implementationPlan: ["Step 1: Implement"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      { id: "AC-001", kind: "command", description: "Runs OK", blocking: true, evidenceRequired: ["output"] },
    ],
    reviewChecklist: [],
    proposedCommitMessage: `feat: implement ${packetId}`,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function contractEvaluatorAcceptEnvelope(packetId: string): string {
  const payload = {
    packetId,
    round: 1,
    decision: "accept",
    scores: { scopeFit: 5, testability: 5, riskCoverage: 4, clarity: 5, specAlignment: 5 },
    requiredChanges: [],
    suggestedCriteriaAdditions: [],
    missingRisks: [],
    rationale: "Looks good.",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function builderReportEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "builder-session-resumed",
    changedFiles: ["src/util.ts"],
    commandsRun: [],
    backgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [{ criterionId: "AC-001", status: "pass", evidence: "Runs OK" }],
    remainingConcerns: [],
    claimsDone: true,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function evaluatorPassEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "evaluator-session-001",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [{ criterionId: "AC-001", verdict: "pass", evidence: "Works" }],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function makeScript(text: string, sessionId: string): AgentMessage[] {
  return [
    { type: "system", subtype: "init", sessionId },
    { type: "assistant", text },
    { type: "result", subtype: "success", text, isError: false, numTurns: 1, sessionId },
  ];
}

// ------------------------------------
// ScriptedNudgeBackend
// ------------------------------------

/**
 * A backend that simulates the Codex abort+resume nudge flow:
 *
 * - Call 0 (builder first attempt): yields a slow infinite loop that can be
 *   interrupted by queueNudge(). When killed (queueNudge called), the generator
 *   stops without yielding a result envelope — simulating SIGTERM abort.
 *
 * - Call 1+ (subsequent calls): yield the scripted messages normally.
 *
 * queueNudge() returns { handled: true, via: "abort-resume", sessionId, nudgeText }
 * when a session is active (simulating CodexCliBackend Phase 3 behaviour).
 */
class ScriptedNudgeBackend implements AgentBackend {
  private callIndex = 0;
  private scripts: AgentMessage[][];
  private lastSessionIdVal: string | null = null;
  private abortController: AbortController | null = null;

  readonly calls: AgentSessionOptions[] = [];

  // For nudge tracking
  private activeSessionId: string | null = null;
  nudgeOutcomes: NudgeOutcome[] = [];

  constructor(scripts: AgentMessage[][]) {
    this.scripts = scripts;
  }

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    this.calls.push(opts);
    const idx = this.callIndex++;
    const script = this.scripts[idx];
    if (!script) throw new Error(`ScriptedNudgeBackend: no script for call index ${idx}`);

    const ac = new AbortController();
    this.abortController = ac;
    this.activeSessionId = `session-${idx}`;
    this.lastSessionIdVal = this.activeSessionId;

    try {
      for (const msg of script) {
        if (ac.signal.aborted) break;
        if (msg.sessionId) this.lastSessionIdVal = msg.sessionId;
        yield msg;
      }
      // If aborted mid-script, don't yield the result message
      if (!ac.signal.aborted) {
        // Already yielded via script — nothing more to do
      }
    } finally {
      this.abortController = null;
      this.activeSessionId = null;
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionIdVal;
  }

  queueNudge(text: string): NudgeOutcome {
    if (!this.abortController || !this.activeSessionId) {
      return { handled: false };
    }
    const sessionId = this.activeSessionId;
    this.abortController.abort(); // Simulate SIGTERM abort
    const outcome: NudgeOutcome = {
      handled: true,
      via: "abort-resume",
      sessionId,
      nudgeText: text,
    };
    this.nudgeOutcomes.push(outcome);
    return outcome;
  }

  abortSession(): string | null {
    const sid = this.activeSessionId;
    this.abortController?.abort();
    return sid;
  }

  supportsResume(): boolean { return true; }
  supportsMcpServers(): boolean { return false; }
  nudgeStrategy(): "stream" | "abort-resume" | "none" { return "abort-resume"; }
  supportsOutputSchema(): boolean { return false; }
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

  readonly calls: AgentSessionOptions[] = [];
  readonly nudgeOutcomes: NudgeOutcome[] = [];

  // Which call indices should block until aborted (simulating running Codex child)
  private blockingCallIndices: Set<number>;

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
      // Yield the initial messages from the script
      for (const msg of script) {
        if (ac.signal.aborted) return; // Stopped by queueNudge — no result envelope
        if (msg.sessionId) this.lastSessionIdVal = msg.sessionId;
        yield msg;
      }

      // If this is a blocking call: wait until aborted (simulates a long-running session)
      if (this.blockingCallIndices.has(idx)) {
        while (!ac.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // Aborted — return without yielding a result envelope (simulates SIGTERM)
        return;
      }

      // Non-blocking: script finished normally, return (result envelope already in script)
    } finally {
      this.activeSession = null;
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionIdVal;
  }

  queueNudge(text: string): NudgeOutcome {
    if (!this.activeSession) {
      return { handled: false };
    }
    const { ac, sessionId } = this.activeSession;
    ac.abort(); // Abort the running session (simulates SIGTERM to child process)
    const outcome: NudgeOutcome = {
      handled: true,
      via: "abort-resume",
      sessionId,
      nudgeText: text,
    };
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

// ------------------------------------
// Scenario test
// ------------------------------------

describe("codex abort+resume nudge scenario", () => {
  // This test has a 10s RETRY_COOLDOWN after the first builder attempt is aborted,
  // plus ~3s for the nudge poller to fire (3000ms interval). Allow 45s total.
  it("emits builder.aborted-for-nudge and resumes with nudge in prompt", async () => {

    // Script order:
    // 0: planner
    // 1: contract builder
    // 2: contract evaluator (accept)
    // 3: builder (first attempt — will be interrupted by nudge)
    // 4: builder (second attempt — resumes with nudge in prompt, claims done)
    // 5: evaluator (pass)

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
      // 3: builder first attempt — only yields the system init, then stops
      //    (no result envelope — simulates being aborted mid-run)
      [
        { type: "system", subtype: "init", sessionId: "builder-sess-001" },
        { type: "assistant", text: "I am analyzing the codebase..." },
        // No result envelope — session will be interrupted
      ],
      // 4: builder second attempt (resumed with nudge)
      makeScript(builderReportEnvelope("PKT-001"), "builder-sess-002"),
      // 5: evaluator pass
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-sess"),
    ];

    const backend = new MultiCallNudgeBackend(scripts, [3]);

    // Auto-approve plan and inject nudge
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

        // Send nudge once builder is active (building_packet phase).
        // The MultiCallNudgeBackend will block on the first builder call (index 3)
        // until queueNudge() is called, so writing the inbox file here ensures
        // the nudge poller picks it up and calls queueNudge() to abort the session.
        if (!nudgeSent && runJson.phase === "building_packet") {
          nudgeSent = true;
          try {
            fs.writeFileSync(
              path.join(inboxDir, "nudge.json"),
              JSON.stringify({
                type: "send_to_agent",
                createdAt: new Date().toISOString(),
                message: NUDGE_TEXT,
              }),
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

    // Verify run completed
    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8"));
    expect(runJson.phase).toBe("completed");

    // Verify events.jsonl contains builder.aborted-for-nudge
    const events = readEvents(tmpDir, latestRunId!);
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("builder.aborted-for-nudge");
    expect(eventTypes).toContain("nudge.sent");

    // Find the aborted-for-nudge event and verify its detail
    const abortEvent = events.find((e) => e.event === "builder.aborted-for-nudge");
    expect(abortEvent).toBeDefined();
    expect(abortEvent?.detail).toContain("aborted for nudge");

    // Verify the nudge was delivered (queueNudge was called and returned abort-resume)
    expect(backend.nudgeOutcomes.length).toBeGreaterThan(0);
    const nudgeOutcome = backend.nudgeOutcomes[0];
    expect(nudgeOutcome.handled).toBe(true);
    if (nudgeOutcome.handled) {
      expect(nudgeOutcome.via).toBe("abort-resume");
      expect((nudgeOutcome as { via: "abort-resume"; nudgeText: string }).nudgeText).toBe(NUDGE_TEXT);
    }

    // Verify the resumed builder call has the nudge in the prompt
    // The nudge-resume builder invocation should be call index 4
    // and its prompt should start with "OPERATOR NUDGE:"
    const builderResumeCall = backend.calls.find(
      (call) => typeof call.prompt === "string" && call.prompt.startsWith("OPERATOR NUDGE:"),
    );
    expect(builderResumeCall).toBeDefined();
    expect(builderResumeCall?.prompt).toContain(NUDGE_TEXT);
    // The resumed call should have a resume session ID
    expect(builderResumeCall?.resume).toBeDefined();
  }, 45_000);
});
