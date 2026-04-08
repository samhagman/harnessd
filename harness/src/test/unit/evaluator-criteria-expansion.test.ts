/**
 * Unit tests for evaluator criteria expansion functions:
 * processProposedCriteria, isInvalidDualReport, assignCriterionIds
 * and related schema validation.
 */

import { describe, it, expect } from "vitest";

import {
  processProposedCriteria,
  isInvalidDualReport,
  assignCriterionIds,
  MAX_EVALUATOR_CRITERIA_PER_PACKET,
} from "../../evaluator-runner.js";

import {
  ProposedCriterionSchema,
  AcceptanceCriterionSchema,
  EvaluatorReportSchema,
} from "../../schemas.js";

import type { EvaluatorReport, ProposedCriterion } from "../../schemas.js";

// ------------------------------------
// Test fixtures
// ------------------------------------

const baseReport: EvaluatorReport = {
  packetId: "PKT-TEST",
  sessionId: "test",
  overall: "fail" as const,
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

const validProposal: ProposedCriterion = {
  kind: "api" as const,
  description: "Test criterion",
  blocking: true,
  evidenceRequired: ["test evidence"],
  severity: "medium" as const,
  rationale: "Found during testing",
  evidence: "API returned 200 instead of 403",
};

// ------------------------------------
// processProposedCriteria
// ------------------------------------

describe("processProposedCriteria", () => {
  it("returns empty array when no addedCriteria", () => {
    const report: EvaluatorReport = { ...baseReport, addedCriteria: [] };
    const result = processProposedCriteria(report, 0);
    expect(result).toEqual([]);
  });

  it("filters out non-medium severity (high/critical/low should be excluded)", () => {
    const proposals: ProposedCriterion[] = [
      { ...validProposal, severity: "high" },
      { ...validProposal, severity: "critical" },
      { ...validProposal, severity: "low" },
      { ...validProposal, severity: "medium", description: "medium one" },
    ];
    const report: EvaluatorReport = { ...baseReport, addedCriteria: proposals };
    const result = processProposedCriteria(report, 0);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("medium one");
    expect(result[0].severity).toBe("medium");
  });

  it("enforces global cap of 20 (18 existing + 5 proposals = only 2 pass)", () => {
    const proposals: ProposedCriterion[] = Array.from({ length: 5 }, (_, i) => ({
      ...validProposal,
      description: `Proposal ${i + 1}`,
    }));
    const report: EvaluatorReport = { ...baseReport, addedCriteria: proposals };
    const result = processProposedCriteria(report, 18);
    expect(result).toHaveLength(2);
    expect(result[0].description).toBe("Proposal 1");
    expect(result[1].description).toBe("Proposal 2");
  });

  it("returns empty when cap is already reached (count >= 20)", () => {
    const proposals: ProposedCriterion[] = [validProposal];
    const report: EvaluatorReport = { ...baseReport, addedCriteria: proposals };
    expect(processProposedCriteria(report, 20)).toEqual([]);
    expect(processProposedCriteria(report, 25)).toEqual([]);
  });

  it("passes through valid medium proposals", () => {
    const proposals: ProposedCriterion[] = [
      { ...validProposal, description: "First medium" },
      { ...validProposal, description: "Second medium" },
    ];
    const report: EvaluatorReport = { ...baseReport, addedCriteria: proposals };
    const result = processProposedCriteria(report, 0);
    expect(result).toHaveLength(2);
    expect(result[0].description).toBe("First medium");
    expect(result[1].description).toBe("Second medium");
  });
});

// ------------------------------------
// isInvalidDualReport
// ------------------------------------

describe("isInvalidDualReport", () => {
  it("returns true when both contractGapDetected and addedCriteria present", () => {
    const report: EvaluatorReport = {
      ...baseReport,
      contractGapDetected: true,
      addedCriteria: [validProposal],
    };
    expect(isInvalidDualReport(report)).toBe(true);
  });

  it("returns false when only contractGapDetected", () => {
    const report: EvaluatorReport = {
      ...baseReport,
      contractGapDetected: true,
      addedCriteria: [],
    };
    expect(isInvalidDualReport(report)).toBe(false);
  });

  it("returns false when only addedCriteria", () => {
    const report: EvaluatorReport = {
      ...baseReport,
      contractGapDetected: false,
      addedCriteria: [validProposal],
    };
    expect(isInvalidDualReport(report)).toBe(false);
  });

  it("returns false when neither", () => {
    const report: EvaluatorReport = {
      ...baseReport,
      contractGapDetected: false,
      addedCriteria: [],
    };
    expect(isInvalidDualReport(report)).toBe(false);
  });
});

// ------------------------------------
// assignCriterionIds
// ------------------------------------

describe("assignCriterionIds", () => {
  it("assigns AC-E001, AC-E002, etc. starting from 0", () => {
    const proposals: ProposedCriterion[] = [
      { ...validProposal, description: "First" },
      { ...validProposal, description: "Second" },
      { ...validProposal, description: "Third" },
    ];
    const result = assignCriterionIds(proposals, 0);
    expect(result[0].id).toBe("AC-E001");
    expect(result[1].id).toBe("AC-E002");
    expect(result[2].id).toBe("AC-E003");
  });

  it("continues numbering from existingEvaluatorCriteriaCount (3 exist, starts at AC-E004)", () => {
    const proposals: ProposedCriterion[] = [
      { ...validProposal, description: "Fourth" },
      { ...validProposal, description: "Fifth" },
    ];
    const result = assignCriterionIds(proposals, 3);
    expect(result[0].id).toBe("AC-E004");
    expect(result[1].id).toBe("AC-E005");
  });

  it("sets source: 'evaluator' on all output criteria", () => {
    const proposals: ProposedCriterion[] = [
      validProposal,
      { ...validProposal, description: "Another" },
    ];
    const result = assignCriterionIds(proposals, 0);
    for (const criterion of result) {
      expect(criterion.source).toBe("evaluator");
    }
  });

  it("preserves kind, description, blocking, evidenceRequired from proposals", () => {
    const proposal: ProposedCriterion = {
      kind: "scenario",
      description: "Login flow must redirect to dashboard",
      blocking: false,
      evidenceRequired: ["screenshot of dashboard", "network trace"],
      severity: "medium",
      rationale: "Missing redirect found",
      evidence: "After login, user stays on /login",
    };
    const result = assignCriterionIds([proposal], 0);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("scenario");
    expect(result[0].description).toBe("Login flow must redirect to dashboard");
    expect(result[0].blocking).toBe(false);
    expect(result[0].evidenceRequired).toEqual(["screenshot of dashboard", "network trace"]);
  });
});

// ------------------------------------
// Schema tests
// ------------------------------------

describe("ProposedCriterionSchema", () => {
  it("validates a correct proposal", () => {
    const parsed = ProposedCriterionSchema.parse(validProposal);
    expect(parsed.kind).toBe("api");
    expect(parsed.severity).toBe("medium");
    expect(parsed.evidence).toBe("API returned 200 instead of 403");
    expect(parsed.rationale).toBe("Found during testing");
    expect(parsed.blocking).toBe(true);
  });

  it("rejects missing required fields", () => {
    // Missing severity
    const { severity, ...noSeverity } = validProposal;
    expect(() => ProposedCriterionSchema.parse(noSeverity)).toThrow();

    // Missing evidence
    const { evidence, ...noEvidence } = validProposal;
    expect(() => ProposedCriterionSchema.parse(noEvidence)).toThrow();

    // Missing rationale
    const { rationale, ...noRationale } = validProposal;
    expect(() => ProposedCriterionSchema.parse(noRationale)).toThrow();

    // Missing description
    const { description, ...noDescription } = validProposal;
    expect(() => ProposedCriterionSchema.parse(noDescription)).toThrow();
  });
});

describe("AcceptanceCriterionSchema", () => {
  const baseCriterion = {
    id: "AC-001",
    kind: "command" as const,
    description: "Tests pass",
    blocking: true,
    evidenceRequired: ["test output"],
  };

  it("accepts criteria without source (backwards compat)", () => {
    const parsed = AcceptanceCriterionSchema.parse(baseCriterion);
    expect(parsed.source).toBeUndefined();
  });

  it("accepts criteria with source: 'evaluator'", () => {
    const parsed = AcceptanceCriterionSchema.parse({
      ...baseCriterion,
      source: "evaluator",
    });
    expect(parsed.source).toBe("evaluator");
  });
});

describe("EvaluatorReportSchema", () => {
  const minimalReport = {
    packetId: "PKT-TEST",
    sessionId: "test",
    overall: "fail" as const,
    hardFailures: [],
    rubricScores: [],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };

  it("defaults addedCriteria to [] when absent", () => {
    const parsed = EvaluatorReportSchema.parse(minimalReport);
    expect(parsed.addedCriteria).toEqual([]);
  });

  it("defaults additionalIssuesOmitted to false when absent", () => {
    const parsed = EvaluatorReportSchema.parse(minimalReport);
    expect(parsed.additionalIssuesOmitted).toBe(false);
  });
});
