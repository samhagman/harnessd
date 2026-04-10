/**
 * Scenario test: happy path — plan, negotiate, build, evaluate, done.
 *
 * Uses FakeBackend to replay minimal agent responses through the orchestrator.
 * Verifies state transitions, packet lifecycle, and artifact generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

import { FakeBackend } from "../../backend/fake-backend.js";
import type { AgentMessage, AgentBackend, AgentSessionOptions } from "../../backend/types.js";
import { runOrchestrator } from "../../orchestrator.js";
import { getRunDir, getLatestRunId, HARNESSD_DIR } from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
  RunStateSchema,
  StatusSnapshotSchema,
} from "../../schemas.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-happy-"));
});

afterEach(async () => {
  // Allow transcript write streams from worker.ts to flush before deleting.
  // Use 500ms to give background encoding (native SDK) time to release file handles.
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
});

// ------------------------------------
// Fake response builders
// ------------------------------------

/** Build a text that contains a valid planner envelope */
function plannerEnvelope(): string {
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
      {
        id: "PKT-002",
        title: "Add integration test",
        type: "tooling",
        objective: "Create integration tests",
        whyNow: "Verify helper utility",
        dependencies: ["PKT-001"],
        status: "pending",
        priority: 2,
        estimatedSize: "S",
        risks: [],
        notes: [],
      },
    ],
    riskRegister: {
      risks: [
        {
          id: "RISK-001",
          description: "Might not work",
          severity: "low",
          mitigation: "Test it",
          watchpoints: ["Check exit codes"],
        },
      ],
    },
    evaluatorGuide: {
      domain: "tooling",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Tests pass" }],
      antiPatterns: ["hardcoded paths"],
      referenceStandard: "Clean, well-tested utility code",
      edgeCases: ["empty input"],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All tests pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "Two packets: helper utility then integration tests.\n",
  };
  return `Here is the plan:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

/** Build a text that contains a valid contract builder envelope */
function contractBuilderEnvelope(packetId: string, round: number = 1): string {
  const payload = {
    packetId,
    round,
    status: "proposed",
    title: `Implement ${packetId}`,
    packetType: "tooling",
    objective: `Implement the ${packetId} packet`,
    inScope: ["Create the utility script"],
    outOfScope: ["Deployment automation"],
    assumptions: ["Node.js available"],
    risks: [{ id: "R1", description: "Might be slow", mitigation: "Profile it" }],
    likelyFiles: ["src/helper.ts"],
    implementationPlan: ["Step 1: Read codebase", "Step 2: Implement"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "Script runs successfully",
        blocking: true,
        evidenceRequired: ["command output"],
      },
    ],
    reviewChecklist: ["Check exit codes"],
    proposedCommitMessage: `harnessd(${packetId}): implement utility`,
  };
  return `Here is the contract:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

/** Build a text that contains a valid contract evaluator envelope (accept) */
function contractEvaluatorAcceptEnvelope(packetId: string, round: number = 1): string {
  const payload = {
    packetId,
    round,
    decision: "accept",
    scores: { scopeFit: 5, testability: 5, riskCoverage: 4, clarity: 5, specAlignment: 5 },
    requiredChanges: [],
    suggestedCriteriaAdditions: [],
    missingRisks: [],
    rationale: "Contract looks good, accepting.",
  };
  return `Review complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

/** Build a text that contains a valid builder report envelope (done) */
function builderReportEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "builder-session-001",
    changedFiles: ["src/helper.ts"],
    commandsRun: [{ command: "npx tsc --noEmit", exitCode: 0, summary: "type check passes" }],
    backgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "Script runs with exit 0" },
    ],
    remainingConcerns: [],
    claimsDone: true,
  };
  return `Implementation complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

/** Build a text that contains a valid evaluator report envelope (pass) */
function evaluatorPassEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "evaluator-session-001",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      {
        criterionId: "AC-001",
        verdict: "pass",
        evidence: "Script runs with exit 0, output matches expected",
      },
    ],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };
  return `Evaluation complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

// ------------------------------------
// Multi-call FakeBackend
// ------------------------------------

/**
 * A backend that dispatches different scripts based on the call index.
 * Each call to runSession() gets the next script in the sequence.
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

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  queueNudge(_text: string): boolean {
    return false;
  }

  abortSession(): string | null {
    return this.lastSessionId;
  }
}

function makeScript(text: string, sessionId: string = "sess-001"): AgentMessage[] {
  return [
    { type: "system", subtype: "init", sessionId },
    { type: "assistant", text },
    { type: "result", subtype: "success", text, isError: false, numTurns: 1, sessionId },
  ];
}

// ------------------------------------
// Happy path test
// ------------------------------------

describe("happy-path scenario", () => {
  it("runs through plan → negotiate → build → evaluate → done for 2 packets", async () => {
    // Build scripts for each agent call in order:
    // 1. Planner
    // 2. Contract builder (PKT-001)
    // 3. Contract evaluator (PKT-001) → accept
    // 4. Builder (PKT-001)
    // 5. Evaluator (PKT-001) → pass
    // 6. Contract builder (PKT-002)
    // 7. Contract evaluator (PKT-002) → accept
    // 8. Builder (PKT-002)
    // 9. Evaluator (PKT-002) → pass
    const scripts = [
      makeScript(plannerEnvelope(), "planner-sess"),
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-001-sess"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-001-sess"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-001-sess"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-001-sess"),
      makeScript(contractBuilderEnvelope("PKT-002"), "cb-002-sess"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-002"), "ce-002-sess"),
      makeScript(builderReportEnvelope("PKT-002"), "builder-002-sess"),
      makeScript(evaluatorPassEnvelope("PKT-002"), "eval-002-sess"),
    ];

    const backend = new ScriptedBackend(scripts);

    // Auto-approve plan gate: poll for the run dir and write approve_plan once it appears
    const autoApprove = setInterval(() => {
      try {
        const rid = getLatestRunId(tmpDir);
        if (!rid) return;
        const rd = getRunDir(tmpDir, rid);
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));
        if (runJson.phase === "awaiting_plan_approval") {
          const inboxDir = path.join(rd, "inbox");
          fs.mkdirSync(inboxDir, { recursive: true });
          fs.writeFileSync(
            path.join(inboxDir, "auto-approve.json"),
            JSON.stringify({ type: "approve_plan", createdAt: new Date().toISOString(), message: "auto" }),
          );
          clearInterval(autoApprove);
        }
      } catch {}
    }, 100);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "Build test utilities",
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoApprove);

    // Verify run state
    const latestRunId = getLatestRunId(tmpDir);
    expect(latestRunId).not.toBeNull();

    const runDir = getRunDir(tmpDir, latestRunId!);

    // Check run.json
    const runJson = JSON.parse(
      fs.readFileSync(path.join(runDir, "run.json"), "utf-8"),
    );
    const runState = RunStateSchema.parse(runJson);
    expect(runState.phase).toBe("completed");
    expect(runState.completedPacketIds).toContain("PKT-001");
    expect(runState.completedPacketIds).toContain("PKT-002");
    expect(runState.completedPacketIds).toHaveLength(2);

    // Check status.json exists
    expect(fs.existsSync(path.join(runDir, "status.json"))).toBe(true);

    // Check events.jsonl has expected events
    const events = readEvents(tmpDir, latestRunId!);
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("planning.started");
    expect(eventTypes).toContain("planning.completed");
    expect(eventTypes).toContain("packet.selected");
    expect(eventTypes).toContain("contract.round.started");
    expect(eventTypes).toContain("contract.accepted");
    expect(eventTypes).toContain("builder.started");
    expect(eventTypes).toContain("builder.completed");
    expect(eventTypes).toContain("evaluator.started");
    expect(eventTypes).toContain("evaluator.passed");
    expect(eventTypes).toContain("packet.done");
    expect(eventTypes).toContain("run.completed");

    // Both packets should have "packet.done" events
    const packetDoneEvents = events.filter((e) => e.event === "packet.done");
    expect(packetDoneEvents).toHaveLength(2);

    // Check spec artifacts
    expect(fs.existsSync(path.join(runDir, "spec", "SPEC.md"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "spec", "packets.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "spec", "risk-register.json"))).toBe(true);

    // Check PKT-001 contract final
    expect(
      fs.existsSync(path.join(runDir, "packets", "PKT-001", "contract", "final.json")),
    ).toBe(true);

    // Check backend received 9 calls
    expect(backend.calls).toHaveLength(9);
  });
});
