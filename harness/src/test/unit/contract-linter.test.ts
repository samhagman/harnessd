/**
 * Unit tests for contract-linter.ts.
 */

import { describe, it, expect } from "vitest";

import { lintContract } from "../../contract-linter.js";

// ------------------------------------
// Helpers
// ------------------------------------

/** Build a minimal valid contract for a given packet type */
function makeContract(
  overrides: Record<string, unknown> = {},
  packetType: string = "tooling",
) {
  // A tooling contract requires only "command" criterion kinds.
  // This gives us the simplest valid baseline.
  const base = {
    packetId: "PKT-001",
    round: 1,
    status: "proposed",
    title: "Add helper script",
    packetType: packetType,
    objective: "Create a utility script",
    inScope: ["script.sh"],
    outOfScope: ["deployment automation"],
    assumptions: ["Node.js available"],
    risks: [{ id: "R1", description: "Might be slow", mitigation: "Profile it" }],
    likelyFiles: ["script.sh", "README.md"],
    implementationPlan: ["Step 1", "Step 2"],
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
    proposedCommitMessage: "feat: add helper script",
    ...overrides,
  };
  return base;
}

// ------------------------------------
// Valid contract
// ------------------------------------

describe("lintContract", () => {
  it("valid contract passes", () => {
    const contract = makeContract();
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ------------------------------------
  // outOfScope
  // ------------------------------------

  it("empty outOfScope fails", () => {
    const contract = makeContract({ outOfScope: [] });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /outOfScope/i.test(e))).toBe(true);
  });

  // ------------------------------------
  // acceptance
  // ------------------------------------

  it("empty acceptance fails", () => {
    const contract = makeContract({ acceptance: [] });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /acceptance/i.test(e))).toBe(true);
  });

  // ------------------------------------
  // Required criterion kinds
  // ------------------------------------

  it("missing required criterion kind fails", () => {
    // bugfix requires "command" and "negative" kinds
    const contract = makeContract(
      {
        packetType: "bugfix",
        acceptance: [
          {
            id: "AC-001",
            kind: "command",
            description: "Bug fixed",
            blocking: true,
            evidenceRequired: ["output"],
          },
          // Missing "negative" kind
        ],
      },
      "bugfix",
    );
    const result = lintContract(contract, "bugfix");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /negative/i.test(e))).toBe(true);
  });

  // ------------------------------------
  // likelyFiles (no cap — informational only)
  // ------------------------------------

  it("large likelyFiles list is allowed (no cap)", () => {
    const manyFiles = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
    const contract = makeContract({ likelyFiles: manyFiles });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
  });

  // ------------------------------------
  // long_running_job without observability
  // ------------------------------------

  it("long_running_job without observability fails", () => {
    const contract = makeContract(
      {
        packetType: "long_running_job",
        acceptance: [
          {
            id: "AC-001",
            kind: "command",
            description: "Job starts",
            blocking: true,
            evidenceRequired: ["command output"],
          },
          {
            id: "AC-002",
            kind: "artifact",
            description: "Output exists",
            blocking: true,
            evidenceRequired: ["file path"],
          },
          {
            id: "AC-003",
            kind: "negative",
            description: "Failure logged",
            blocking: true,
            evidenceRequired: ["error log"],
          },
          // Missing observability criterion
        ],
      },
      "long_running_job",
    );
    const result = lintContract(contract, "long_running_job");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /observability/i.test(e))).toBe(true);
  });

  // ------------------------------------
  // User-visible without scenario
  // ------------------------------------

  it("user-visible packet without scenario fails", () => {
    const contract = makeContract(
      {
        packetType: "ui_feature",
        acceptance: [
          {
            id: "AC-001",
            kind: "command",
            description: "Build passes",
            blocking: true,
            evidenceRequired: ["output"],
          },
          {
            id: "AC-002",
            kind: "invariant",
            description: "No errors",
            blocking: true,
            evidenceRequired: ["console output"],
          },
          // Missing scenario or api criterion
        ],
      },
      "ui_feature",
    );
    const result = lintContract(contract, "ui_feature");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /scenario|api/i.test(e))).toBe(true);
  });

  // ------------------------------------
  // Risky packet without negative/invariant
  // ------------------------------------

  it("risky packet without negative/invariant fails", () => {
    const contract = makeContract(
      {
        packetType: "migration",
        acceptance: [
          {
            id: "AC-001",
            kind: "command",
            description: "Migration runs",
            blocking: true,
            evidenceRequired: ["output"],
          },
          {
            id: "AC-002",
            kind: "artifact",
            description: "Data intact",
            blocking: true,
            evidenceRequired: ["check"],
          },
          // Missing negative/invariant
        ],
      },
      "migration",
    );
    const result = lintContract(contract, "migration");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /negative|invariant/i.test(e))).toBe(true);
  });

  // ------------------------------------
  // Blocking criterion without evidence
  // ------------------------------------

  it("blocking criterion without evidence fails", () => {
    const contract = makeContract({
      acceptance: [
        {
          id: "AC-001",
          kind: "command",
          description: "Tests pass",
          blocking: true,
          evidenceRequired: [], // empty!
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /evidenceRequired/i.test(e))).toBe(true);
  });

  it("non-blocking criterion with empty evidence passes", () => {
    const contract = makeContract({
      acceptance: [
        {
          id: "AC-001",
          kind: "command",
          description: "Tests pass",
          blocking: true,
          evidenceRequired: ["output"],
        },
        {
          id: "AC-002",
          kind: "command",
          description: "Lint clean",
          blocking: false,
          evidenceRequired: [],
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
  });

  // Rule 12: Structural verification for scenario/api criteria
  // (No longer regex-matching prose — evidence QUALITY is the evaluator's job.
  //  The linter only checks structural completeness: has command, scenario, or evidenceRequired.)

  it("scenario criterion with no verification mechanism fails on user-visible packet", () => {
    const contract = makeContract(
      {
        packetType: "backend_feature",
        acceptance: [
          {
            id: "AC-001",
            kind: "scenario",
            description: "POST /api/items creates a record",
            blocking: true,
            evidenceRequired: [], // empty — no command, no scenario, no evidence
          },
        ],
      },
      "backend_feature",
    );
    const result = lintContract(contract, "backend_feature");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /no verification mechanism/i.test(e))).toBe(true);
  });

  it("scenario criterion with evidenceRequired passes (evaluator judges quality)", () => {
    const contract = makeContract(
      {
        packetType: "backend_feature",
        acceptance: [
          {
            id: "AC-001",
            kind: "scenario",
            description: "POST /api/items creates a record",
            blocking: true,
            evidenceRequired: ["vitest output showing test passes"],
          },
        ],
      },
      "backend_feature",
    );
    const result = lintContract(contract, "backend_feature");
    expect(result.errors.every((e) => !/verification mechanism/i.test(e))).toBe(true);
  });

  it("scenario criterion with command field passes", () => {
    const contract = makeContract(
      {
        packetType: "backend_feature",
        acceptance: [
          {
            id: "AC-001",
            kind: "scenario",
            description: "POST /api/items creates a record",
            blocking: true,
            command: "curl -X POST http://localhost:3000/api/items",
            evidenceRequired: [],
          },
        ],
      },
      "backend_feature",
    );
    const result = lintContract(contract, "backend_feature");
    expect(result.errors.every((e) => !/verification mechanism/i.test(e))).toBe(true);
  });

  it("scenario criterion on non-user-visible packet skips rule 12", () => {
    const contract = makeContract({
      acceptance: [
        {
          id: "AC-001",
          kind: "scenario",
          description: "Script runs",
          blocking: true,
          evidenceRequired: [],
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.errors.every((e) => !/verification mechanism/i.test(e))).toBe(true);
  });

  // Rule 13 (outOfScope/objective contradiction) moved to contract evaluator prompt —
  // semantic analysis belongs in the LLM, not in string-matching heuristics.
});

// ------------------------------------
// Goals / constraints / guidance (new-style contract rules)
// ------------------------------------

describe("lintContract — goals/constraints/guidance rules", () => {
  // Old contract without goals field → still passes (backward compat)
  it("old contract without goals field still passes", () => {
    const contract = makeContract();
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // New contract with goals where all blocking ACs are mapped → passes
  it("new-style contract with fully mapped blocking ACs passes", () => {
    const contract = makeContract({
      goals: [
        {
          id: "G-001",
          description: "Script executes without errors",
          acceptanceCriteriaIds: ["AC-001"],
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
  });

  // New contract with goals where blocking ACs are unmapped → fails
  it("new-style contract with unmapped blocking AC fails", () => {
    const contract = makeContract({
      acceptance: [
        {
          id: "AC-001",
          kind: "command",
          description: "Script runs successfully",
          blocking: true,
          evidenceRequired: ["command output"],
        },
        {
          id: "AC-002",
          kind: "command",
          description: "Exit code is 0",
          blocking: true,
          evidenceRequired: ["exit code"],
        },
      ],
      goals: [
        {
          id: "G-001",
          description: "Script executes without errors",
          acceptanceCriteriaIds: ["AC-001"], // AC-002 not mapped
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /AC-002/.test(e) && /not mapped/i.test(e))).toBe(true);
  });

  // New contract with goals referencing non-existent AC IDs → fails
  it("new-style contract with dangling goal AC reference fails", () => {
    const contract = makeContract({
      goals: [
        {
          id: "G-001",
          description: "Script executes without errors",
          acceptanceCriteriaIds: ["AC-001", "AC-999"], // AC-999 does not exist
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /AC-999/.test(e) && /non-existent/i.test(e))).toBe(true);
  });

  // New contract with constraints missing rationale → fails
  it("new-style contract with constraint missing rationale fails", () => {
    const contract = makeContract({
      goals: [
        {
          id: "G-001",
          description: "Script executes without errors",
          acceptanceCriteriaIds: ["AC-001"],
        },
      ],
      constraints: [
        {
          id: "C-001",
          description: "Only modify script.sh",
          kind: "scope",
          // rationale omitted
        },
        {
          id: "C-002",
          description: "Must not change auth logic",
          kind: "safety",
          rationale: "Auth changes need a dedicated packet",
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /C-001/.test(e) && /rationale/i.test(e))).toBe(true);
    // C-002 has rationale, should not appear in error
    expect(result.errors.every((e) => !/C-002/.test(e))).toBe(true);
  });

  // Full valid new-style contract with goals/constraints/guidance → passes
  it("full valid new-style contract with goals, constraints, and guidance passes", () => {
    const contract = makeContract({
      goals: [
        {
          id: "G-001",
          description: "Script executes without errors",
          acceptanceCriteriaIds: ["AC-001"],
        },
      ],
      constraints: [
        {
          id: "C-001",
          description: "Only modify script.sh",
          kind: "scope",
          rationale: "Other files are out of scope for this packet",
        },
      ],
      guidance: [
        {
          id: "GD-001",
          description: "Follow POSIX sh conventions",
          source: "codebase-pattern",
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // Constraints with all rationales and no goals → passes
  it("constraints with rationales but no goals array passes", () => {
    const contract = makeContract({
      constraints: [
        {
          id: "C-001",
          description: "Only modify script.sh",
          kind: "scope",
          rationale: "Keeps scope tight",
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.valid).toBe(true);
  });
});
