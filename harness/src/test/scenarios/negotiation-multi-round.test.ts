/**
 * Scenario test: multi-round contract negotiation.
 *
 * Verifies that when the contract evaluator requests a revision, the
 * orchestrator loops back to the contract builder, and the negotiation
 * artifacts (proposal.r01, review.r01, proposal.r02, review.r02, final.json)
 * are all correctly persisted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { AgentMessage, AgentBackend, AgentSessionOptions } from "../../backend/types.js";
import { getRunDir, getLatestRunId } from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../../schemas.js";

// We import the orchestrator to drive the full flow
import { runOrchestrator } from "../../orchestrator.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-neg-multi-"));
});

afterEach(async () => {
  // Allow transcript write streams from worker.ts to flush before deleting.
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// Fake response builders
// ------------------------------------

function plannerEnvelope(): string {
  const payload = {
    spec: "# Spec\n\nBuild a thing.\n",
    packets: [
      {
        id: "PKT-001",
        title: "Add feature X",
        type: "tooling",
        objective: "Implement feature X",
        whyNow: "Foundation needed",
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
      domain: "backend-api",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Feature works" }],
      antiPatterns: [],
      referenceStandard: "Clean implementation",
      edgeCases: [],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "Works correctly" }],
      skepticismLevel: "normal",
    },
    planSummary: "One packet: feature X.\n",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

/** Round 1 proposal — will be revised */
function contractBuilderR1Envelope(): string {
  const payload = {
    packetId: "PKT-001",
    round: 1,
    status: "proposed",
    title: "Implement feature X",
    packetType: "tooling",
    objective: "Create feature X",
    inScope: ["Build X"],
    outOfScope: ["Deployment"],
    assumptions: ["Node.js"],
    risks: [{ id: "R1", description: "Risk", mitigation: "Mitigate" }],
    likelyFiles: ["src/x.ts"],
    implementationPlan: ["Step 1", "Step 2"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "X works",
        blocking: true,
        evidenceRequired: ["output"],
      },
    ],
    reviewChecklist: ["Check it"],
    proposedCommitMessage: "harnessd(PKT-001): add X",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

/** Round 1 review — revise */
function contractEvaluatorReviseEnvelope(): string {
  const payload = {
    packetId: "PKT-001",
    round: 1,
    decision: "revise",
    scores: { scopeFit: 3, testability: 2, riskCoverage: 3, clarity: 4, specAlignment: 4 },
    requiredChanges: ["Add a second acceptance criterion for error handling"],
    suggestedCriteriaAdditions: [
      {
        id: "AC-002",
        kind: "negative",
        description: "Error path handled",
        blocking: true,
        evidenceRequired: ["error output"],
      },
    ],
    missingRisks: ["Edge case with empty input"],
    rationale: "Need more thorough acceptance criteria.",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

/** Round 2 proposal — improved */
function contractBuilderR2Envelope(): string {
  const payload = {
    packetId: "PKT-001",
    round: 2,
    status: "proposed",
    title: "Implement feature X",
    packetType: "tooling",
    objective: "Create feature X with proper error handling",
    inScope: ["Build X", "Error handling"],
    outOfScope: ["Deployment"],
    assumptions: ["Node.js"],
    risks: [
      { id: "R1", description: "Risk", mitigation: "Mitigate" },
      { id: "R2", description: "Edge case with empty input", mitigation: "Validate input" },
    ],
    likelyFiles: ["src/x.ts"],
    implementationPlan: ["Step 1", "Step 2", "Step 3: Error handling"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "X works",
        blocking: true,
        evidenceRequired: ["output"],
      },
      {
        id: "AC-002",
        kind: "command",
        description: "Error path handled",
        blocking: true,
        evidenceRequired: ["error output"],
      },
    ],
    reviewChecklist: ["Check success path", "Check error path"],
    proposedCommitMessage: "harnessd(PKT-001): add X with error handling",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

/** Round 2 review — accept */
function contractEvaluatorAcceptEnvelope(): string {
  const payload = {
    packetId: "PKT-001",
    round: 2,
    decision: "accept",
    scores: { scopeFit: 5, testability: 5, riskCoverage: 5, clarity: 5, specAlignment: 5 },
    requiredChanges: [],
    suggestedCriteriaAdditions: [],
    missingRisks: [],
    rationale: "Contract is now comprehensive. Accepting.",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function builderDoneEnvelope(): string {
  const payload = {
    packetId: "PKT-001",
    sessionId: "builder-sess",
    changedFiles: ["src/x.ts"],
    commandsRun: [{ command: "npx tsc --noEmit", exitCode: 0, summary: "ok" }],
    backgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "Works" },
      { criterionId: "AC-002", status: "pass", evidence: "Error handled" },
    ],
    remainingConcerns: [],
    claimsDone: true,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function evaluatorPassEnvelope(): string {
  const payload = {
    packetId: "PKT-001",
    sessionId: "eval-sess",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      {
        criterionId: "AC-001",
        verdict: "pass",
        evidence: "Command runs successfully with expected output",
      },
      {
        criterionId: "AC-002",
        verdict: "pass",
        evidence: "Error path returns appropriate error message",
      },
    ],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

// ------------------------------------
// ScriptedBackend (same as happy-path)
// ------------------------------------

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

function makeScript(text: string, sessionId: string = "sess"): AgentMessage[] {
  return [
    { type: "system", subtype: "init", sessionId },
    { type: "assistant", text },
    { type: "result", subtype: "success", text, isError: false, numTurns: 1, sessionId },
  ];
}

// ------------------------------------
// Test
// ------------------------------------

describe("negotiation-multi-round scenario", () => {
  it("negotiates over 2 rounds and persists all artifacts", async () => {
    // Call sequence:
    // 1. Planner
    // 2. Contract builder (round 1)
    // 3. Contract evaluator (round 1 → revise)
    // 4. Contract builder (round 2)
    // 5. Contract evaluator (round 2 → accept)
    // 6. Builder
    // 7. Evaluator → pass
    const scripts = [
      makeScript(plannerEnvelope(), "planner-sess"),
      makeScript(contractBuilderR1Envelope(), "cb-r1-sess"),
      makeScript(contractEvaluatorReviseEnvelope(), "ce-r1-sess"),
      makeScript(contractBuilderR2Envelope(), "cb-r2-sess"),
      makeScript(contractEvaluatorAcceptEnvelope(), "ce-r2-sess"),
      makeScript(builderDoneEnvelope(), "builder-sess"),
      makeScript(evaluatorPassEnvelope(), "eval-sess"),
    ];

    const backend = new ScriptedBackend(scripts);

    // Auto-approve plan gate
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
      objective: "Build feature X",
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoApprove);

    const latestRunId = getLatestRunId(tmpDir)!;
    expect(latestRunId).toBeDefined();

    const runDir = getRunDir(tmpDir, latestRunId);
    const contractDir = path.join(runDir, "packets", "PKT-001", "contract");

    // Verify round 1 proposal exists
    const r1Proposal = path.join(contractDir, "proposal.r01.json");
    expect(fs.existsSync(r1Proposal)).toBe(true);
    const r1ProposalData = JSON.parse(fs.readFileSync(r1Proposal, "utf-8"));
    expect(r1ProposalData.round).toBe(1);

    // Verify round 1 review exists
    const r1Review = path.join(contractDir, "review.r01.json");
    expect(fs.existsSync(r1Review)).toBe(true);
    const r1ReviewData = JSON.parse(fs.readFileSync(r1Review, "utf-8"));
    expect(r1ReviewData.decision).toBe("revise");

    // Verify round 2 proposal exists
    const r2Proposal = path.join(contractDir, "proposal.r02.json");
    expect(fs.existsSync(r2Proposal)).toBe(true);
    const r2ProposalData = JSON.parse(fs.readFileSync(r2Proposal, "utf-8"));
    expect(r2ProposalData.round).toBe(2);
    // Round 2 should have 2 acceptance criteria (addressed feedback)
    expect(r2ProposalData.acceptance).toHaveLength(2);

    // Verify round 2 review exists
    const r2Review = path.join(contractDir, "review.r02.json");
    expect(fs.existsSync(r2Review)).toBe(true);
    const r2ReviewData = JSON.parse(fs.readFileSync(r2Review, "utf-8"));
    expect(r2ReviewData.decision).toBe("accept");

    // Verify final.json exists
    const finalContract = path.join(contractDir, "final.json");
    expect(fs.existsSync(finalContract)).toBe(true);
    const finalData = JSON.parse(fs.readFileSync(finalContract, "utf-8"));
    expect(finalData.status).toBe("accepted");

    // Verify events show 2 rounds of negotiation
    const events = readEvents(tmpDir, latestRunId);
    const contractRoundEvents = events.filter(
      (e) => e.event === "contract.round.started",
    );
    expect(contractRoundEvents).toHaveLength(2);

    // Verify we got the "contract.accepted" event
    const acceptedEvents = events.filter((e) => e.event === "contract.accepted");
    expect(acceptedEvents).toHaveLength(1);

    // Overall run should complete
    const runJson = JSON.parse(
      fs.readFileSync(path.join(runDir, "run.json"), "utf-8"),
    );
    expect(runJson.phase).toBe("completed");

    // Backend should have received 7 calls
    expect(backend.calls).toHaveLength(7);
  });
});
