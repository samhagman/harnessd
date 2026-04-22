/**
 * Unit tests for the advisory guard logic in evaluator-runner.ts.
 *
 * The advisory guard overrides an evaluator "fail" to "pass" when ALL blocking
 * criteria passed and only advisory (non-blocking) criteria failed — unless the
 * evaluator explicitly escalated an advisory criterion via advisoryEscalations.
 */

import { describe, it, expect } from "vitest";

import {
  applyAdvisoryGuard,
  validateVerdictCompleteness,
  isIncompleteEvaluation,
} from "../../evaluator-runner.js";

import type {
  EvaluatorReport,
  PacketContract,
  CriterionVerdict,
  AcceptanceCriterion,
} from "../../schemas.js";

// ------------------------------------
// Test fixtures
// ------------------------------------

function makeContract(criteria: AcceptanceCriterion[]): PacketContract {
  return {
    packetId: "PKT-001",
    round: 1,
    status: "accepted",
    title: "Test packet",
    packetType: "ui_feature",
    objective: "Test",
    inScope: [],
    outOfScope: [],
    assumptions: [],
    risks: [],
    likelyFiles: [],
    implementationPlan: [],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: criteria,
    goals: [],
    constraints: [],
    guidance: [],
    reviewChecklist: [],
    proposedCommitMessage: "test",
  };
}

function makeCriterion(
  id: string,
  blocking: boolean,
): AcceptanceCriterion {
  return {
    id,
    kind: "command",
    description: `Criterion ${id}`,
    blocking,
    evidenceRequired: ["output"],
  };
}

function makeVerdict(
  criterionId: string,
  verdict: "pass" | "fail" | "skip",
): CriterionVerdict {
  return {
    criterionId,
    verdict,
    evidence: `Evidence for ${criterionId}`,
  };
}

const baseReport: EvaluatorReport = {
  packetId: "PKT-001",
  sessionId: "test",
  overall: "fail",
  hardFailures: [],
  rubricScores: [],
  criterionVerdicts: [],
  missingEvidence: [],
  nextActions: [],
  contractGapDetected: false,
  addedCriteria: [],
  additionalIssuesOmitted: false,
  advisoryEscalations: [],
};

// ------------------------------------
// applyAdvisoryGuard
// ------------------------------------

describe("applyAdvisoryGuard", () => {
  it("overrides fail → pass when all blocking criteria pass and only advisory criteria fail", () => {
    const criteria = [
      makeCriterion("AC-001", true),  // blocking
      makeCriterion("AC-002", true),  // blocking
      makeCriterion("AC-003", false), // advisory
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
        makeVerdict("AC-002", "pass"),
        makeVerdict("AC-003", "fail"), // advisory fail — should not block
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    expect(result.overall).toBe("pass");
  });

  it("keeps fail when an advisory criterion is escalated", () => {
    const criteria = [
      makeCriterion("AC-001", true),  // blocking
      makeCriterion("AC-002", false), // advisory
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
        makeVerdict("AC-002", "fail"), // advisory fail, but escalated
      ],
      advisoryEscalations: [
        { criterionId: "AC-002", reason: "Security risk too severe to ignore" },
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    expect(result.overall).toBe("fail");
  });

  it("keeps fail when a blocking criterion fails", () => {
    const criteria = [
      makeCriterion("AC-001", true),  // blocking
      makeCriterion("AC-002", true),  // blocking
      makeCriterion("AC-003", false), // advisory
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
        makeVerdict("AC-002", "fail"), // blocking fail
        makeVerdict("AC-003", "fail"), // advisory fail
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    expect(result.overall).toBe("fail");
  });

  it("returns report unchanged when overall is already pass", () => {
    const criteria = [
      makeCriterion("AC-001", true),
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "pass",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    expect(result.overall).toBe("pass");
    // Should be the same object since no override needed
    expect(result).toBe(report);
  });

  it("does not override when evaluation is incomplete (caller's responsibility to check first)", () => {
    // This tests the pre-condition: applyAdvisoryGuard itself only checks
    // report.overall === "fail". The caller (runEvaluator) gates on
    // !isIncompleteEvaluation before calling. Here we verify that if
    // called with incomplete verdicts AND a fail, the guard still examines
    // only the verdicts present.
    const criteria = [
      makeCriterion("AC-001", true),  // blocking
      makeCriterion("AC-002", true),  // blocking
      makeCriterion("AC-003", true),  // blocking
      makeCriterion("AC-004", true),  // blocking
    ];
    const contract = makeContract(criteria);

    // Only 1 of 4 criteria has a verdict — this is incomplete
    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    // Confirm this IS incomplete
    expect(isIncompleteEvaluation(validation)).toBe(true);

    // The guard sees 1 blocking pass but 3 missing — blockingVerdicts only
    // includes AC-001 (pass). It would override, but in practice the caller
    // should not call applyAdvisoryGuard for incomplete evaluations.
    // This test documents the behavior: the guard looks at present verdicts only.
    const result = applyAdvisoryGuard(report, contract, validation);
    // AC-001 passes, no escalations → guard overrides (which is why the
    // caller must check isIncompleteEvaluation first)
    expect(result.overall).toBe("pass");
  });

  it("keeps fail when no blocking verdicts are present at all", () => {
    // Edge case: contract has only advisory criteria
    const criteria = [
      makeCriterion("AC-001", false), // advisory
      makeCriterion("AC-002", false), // advisory
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "fail"),
        makeVerdict("AC-002", "fail"),
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    // No blocking verdicts → allBlockingPass is false (length === 0)
    // Guard does NOT override — preserves fail
    expect(result.overall).toBe("fail");
  });

  it("does not mutate the original report", () => {
    const criteria = [
      makeCriterion("AC-001", true),
      makeCriterion("AC-002", false),
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
        makeVerdict("AC-002", "fail"),
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    // Result should be overridden
    expect(result.overall).toBe("pass");
    // Original should be unchanged
    expect(report.overall).toBe("fail");
  });

  it("treats escalated advisory criterion as effectively blocking", () => {
    // The escalated criterion should be included in the effective blocking set.
    // If the escalated criterion fails, the guard should NOT override.
    const criteria = [
      makeCriterion("AC-001", true),  // blocking
      makeCriterion("AC-002", false), // advisory (but escalated)
      makeCriterion("AC-003", false), // advisory (not escalated)
    ];
    const contract = makeContract(criteria);

    const report: EvaluatorReport = {
      ...baseReport,
      overall: "fail",
      criterionVerdicts: [
        makeVerdict("AC-001", "pass"),
        makeVerdict("AC-002", "fail"), // escalated advisory fails
        makeVerdict("AC-003", "fail"), // plain advisory fails
      ],
      advisoryEscalations: [
        { criterionId: "AC-002", reason: "Data loss risk" },
      ],
    };

    const validation = validateVerdictCompleteness(report, contract);
    const result = applyAdvisoryGuard(report, contract, validation);

    // Should stay fail because escalatedIds.size > 0
    expect(result.overall).toBe("fail");
  });
});
