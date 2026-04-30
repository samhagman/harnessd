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

import { getRunDir, getLatestRunId } from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import { RESULT_START_SENTINEL, RESULT_END_SENTINEL } from "../../schemas.js";
import { runOrchestrator } from "../../orchestrator.js";
import { ScriptedBackend, makeScript, plannerEnvelope } from "../helpers/scripted-backend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-neg-multi-"));
});

afterEach(async () => {
  // Allow transcript write streams from worker.ts to flush before deleting.
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

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
      { id: "AC-001", kind: "command", description: "X works", blocking: true, evidenceRequired: ["output"] },
    ],
    reviewChecklist: ["Check it"],
    proposedCommitMessage: "harnessd(PKT-001): add X",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

function contractEvaluatorReviseEnvelope(): string {
  const payload = {
    packetId: "PKT-001",
    round: 1,
    decision: "revise",
    scores: { scopeFit: 3, testability: 2, riskCoverage: 3, clarity: 4, specAlignment: 4 },
    requiredChanges: ["Add a second acceptance criterion for error handling"],
    suggestedCriteriaAdditions: [
      { id: "AC-002", kind: "negative", description: "Error path handled", blocking: true, evidenceRequired: ["error output"] },
    ],
    missingRisks: ["Edge case with empty input"],
    rationale: "Need more thorough acceptance criteria.",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

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
      { id: "AC-001", kind: "command", description: "X works", blocking: true, evidenceRequired: ["output"] },
      { id: "AC-002", kind: "command", description: "Error path handled", blocking: true, evidenceRequired: ["error output"] },
    ],
    reviewChecklist: ["Check success path", "Check error path"],
    proposedCommitMessage: "harnessd(PKT-001): add X with error handling",
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

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
    liveBackgroundJobs: [],
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
      { criterionId: "AC-001", verdict: "pass", evidence: "Command runs successfully with expected output" },
      { criterionId: "AC-002", verdict: "pass", evidence: "Error path returns appropriate error message" },
    ],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

describe("negotiation-multi-round scenario", () => {
  it("negotiates over 2 rounds and persists all artifacts", async () => {
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

    const r1Proposal = JSON.parse(fs.readFileSync(path.join(contractDir, "proposal.r01.json"), "utf-8"));
    expect(r1Proposal.round).toBe(1);

    const r1Review = JSON.parse(fs.readFileSync(path.join(contractDir, "review.r01.json"), "utf-8"));
    expect(r1Review.decision).toBe("revise");

    const r2Proposal = JSON.parse(fs.readFileSync(path.join(contractDir, "proposal.r02.json"), "utf-8"));
    expect(r2Proposal.round).toBe(2);
    expect(r2Proposal.acceptance).toHaveLength(2);

    const r2Review = JSON.parse(fs.readFileSync(path.join(contractDir, "review.r02.json"), "utf-8"));
    expect(r2Review.decision).toBe("accept");

    const finalData = JSON.parse(fs.readFileSync(path.join(contractDir, "final.json"), "utf-8"));
    expect(finalData.status).toBe("accepted");

    const events = readEvents(tmpDir, latestRunId);
    expect(events.filter((e) => e.event === "contract.round.started")).toHaveLength(2);
    expect(events.filter((e) => e.event === "contract.accepted")).toHaveLength(1);

    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8"));
    expect(runJson.phase).toBe("completed");
    expect(backend.calls).toHaveLength(7);
  });
});
