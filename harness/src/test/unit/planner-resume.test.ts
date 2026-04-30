/**
 * Unit tests for planner.ts retry / session-resume logic.
 *
 * Verifies that:
 * 1. When attempt 1 fails with a parse error but captures a sessionId,
 *    attempt 2 resumes that session and sends the envelope-retry prompt.
 * 2. When attempt 1 crashes (no sessionId captured), attempt 2 starts
 *    a fresh session (current fallback behavior).
 * 3. A first-attempt success returns the result without any retry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runPlanner } from "../../planner.js";
import type { AgentBackend, AgentMessage, AgentSessionOptions, NudgeOutcome } from "../../backend/types.js";
import { RESULT_START_SENTINEL, RESULT_END_SENTINEL, defaultProjectConfig } from "../../schemas.js";
import { makeScript } from "../helpers/scripted-backend.js";

/**
 * ScriptedBackend variant that supports a different script per call index.
 * Unlike the shared ScriptedBackend, this one also tracks lastSessionId from
 * the yielded messages (not just the opts), which planner resume logic depends on.
 */
class ScriptedBackend implements AgentBackend {
  private callIndex = 0;
  private scripts: AgentMessage[][];
  private lastSessionId: string | null = null;
  readonly calls: AgentSessionOptions[] = [];

  constructor(scripts: AgentMessage[][]) {
    this.scripts = scripts;
  }

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    this.calls.push(opts);
    const idx = this.callIndex++;
    const script = this.scripts[idx];
    if (!script) {
      throw new Error(`ScriptedBackend: no script for call index ${idx}`);
    }
    for (const msg of script) {
      if (msg.sessionId) this.lastSessionId = msg.sessionId;
      yield msg;
    }
  }

  getLastSessionId(): string | null { return this.lastSessionId; }
  queueNudge(_text: string): NudgeOutcome { return { handled: false }; }
  abortSession(): string | null { return this.lastSessionId; }
  supportsResume(): boolean { return true; }
  supportsMcpServers(): boolean { return false; }
  nudgeStrategy(): "stream" | "abort-resume" | "none" { return "none"; }
  supportsOutputSchema(): boolean { return false; }
}

function makePlannerEnvelope(): string {
  const payload = {
    spec: "# Test Spec\n\nGoal: build the thing.\n",
    packets: [
      {
        id: "PKT-001",
        title: "Add helper utility",
        type: "tooling",
        objective: "Create a helper utility",
        whyNow: "Foundation for other work",
        dependencies: [],
        status: "pending",
        priority: 1,
        estimatedSize: "S",
        risks: [],
        notes: [],
      },
    ],
    riskRegister: {
      risks: [{ id: "RISK-001", description: "Might not work", severity: "low", mitigation: "Test it", watchpoints: ["Check exit codes"] }],
    },
    evaluatorGuide: {
      domain: "tooling",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Tests pass" }],
      antiPatterns: ["hardcoded paths"],
      referenceStandard: "Clean code",
      edgeCases: ["empty input"],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All tests pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "One packet: helper utility.\n",
  };
  return `Here is the plan:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-planner-resume-"));
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("runPlanner retry / session-resume logic", () => {
  const plannerConfig = () => ({
    repoRoot: tmpDir,
    runId: "test-run-001",
    config: defaultProjectConfig(),
    maxRetries: 3,
  });

  it("succeeds on first attempt without triggering any retry", async () => {
    const backend = new ScriptedBackend([
      makeScript(makePlannerEnvelope(), "sess-first"),
    ]);

    const result = await runPlanner(backend, "test objective", plannerConfig());

    expect(result.success).toBe(true);
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]!.id).toBe("PKT-001");
    expect(backend.calls).toHaveLength(1);
  });

  it("resumes prior session on attempt 2 when attempt 1 fails with parse error but captures sessionId", async () => {
    const attempt1Text = "I started thinking but ran out of space...";
    const attempt2Text = makePlannerEnvelope();

    const backend = new ScriptedBackend([
      makeScript(attempt1Text, "sess-attempt-1"),
      makeScript(attempt2Text, "sess-attempt-1"),
    ]);

    const result = await runPlanner(backend, "test objective", plannerConfig());

    expect(result.success).toBe(true);
    expect(result.packets).toHaveLength(1);
    expect(backend.calls).toHaveLength(2);

    const attempt2Call = backend.calls[1]!;
    expect(attempt2Call.resume).toBe("sess-attempt-1");
    expect(attempt2Call.prompt).toContain("previous envelope attempt did not parse");
    expect(attempt2Call.prompt).toContain("Do NOT re-read docs");
  });

  it("falls back to fresh prompt when attempt 1 crashes without capturing a sessionId", async () => {
    const attempt1Script: AgentMessage[] = [
      {
        type: "result",
        subtype: "error_during_execution",
        text: "connection reset",
        isError: true,
        numTurns: 0,
        sessionId: undefined,
      },
    ];
    const attempt2Text = makePlannerEnvelope();

    const backend = new ScriptedBackend([
      attempt1Script,
      makeScript(attempt2Text, "sess-attempt-2"),
    ]);

    const result = await runPlanner(backend, "test objective", plannerConfig());

    expect(result.success).toBe(true);
    expect(backend.calls).toHaveLength(2);

    const attempt2Call = backend.calls[1]!;
    expect(attempt2Call.resume).toBeUndefined();
    expect(attempt2Call.prompt).toContain("test objective");
  });

  it("propagates resumeSessionId on the first attempt for crash-recovery resume", async () => {
    const backend = new ScriptedBackend([
      makeScript(makePlannerEnvelope(), "sess-crash-recovery"),
    ]);

    const result = await runPlanner(
      backend,
      "test objective",
      plannerConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      "sess-prior-crash",
    );

    expect(result.success).toBe(true);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.resume).toBe("sess-prior-crash");
  });
});
