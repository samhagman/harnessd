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
  // likelyFiles cap
  // ------------------------------------

  it("oversized likelyFiles for small packet fails", () => {
    // S allows max 8 files
    const manyFiles = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
    const contract = makeContract({ likelyFiles: manyFiles });
    const result = lintContract(contract, "tooling", "S");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /likelyFiles/i.test(e))).toBe(true);
  });

  it("likelyFiles within limit passes", () => {
    const fewFiles = ["a.ts", "b.ts", "c.ts"];
    const contract = makeContract({ likelyFiles: fewFiles });
    const result = lintContract(contract, "tooling", "S");
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

  // Rule 12: Runtime evidence for scenario/api criteria

  it("scenario criterion with only code-review evidence fails on user-visible packet", () => {
    const contract = makeContract(
      {
        packetType: "backend_feature",
        acceptance: [
          {
            id: "AC-001",
            kind: "scenario",
            description: "POST /api/items creates a record",
            blocking: true,
            evidenceRequired: ["code review"], // no runtime evidence
          },
          {
            id: "AC-002",
            kind: "negative",
            description: "Malformed request returns 400",
            blocking: true,
            evidenceRequired: ["code review"],
          },
        ],
      },
      "backend_feature",
    );
    const result = lintContract(contract, "backend_feature");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /runtime verification/i.test(e))).toBe(true);
  });

  it("scenario criterion with runtime evidence passes on user-visible packet", () => {
    const contract = makeContract(
      {
        packetType: "backend_feature",
        acceptance: [
          {
            id: "AC-001",
            kind: "scenario",
            description: "POST /api/items creates a record",
            blocking: true,
            evidenceRequired: ["curl output showing 201 status code"],
          },
          {
            id: "AC-002",
            kind: "negative",
            description: "Malformed request returns 400",
            blocking: true,
            evidenceRequired: ["curl response body"],
          },
        ],
      },
      "backend_feature",
    );
    const result = lintContract(contract, "backend_feature");
    // May still fail for other reasons (e.g. missing UX criteria for ui_feature)
    // but must NOT fail for the runtime evidence rule
    expect(result.errors.every((e) => !/runtime verification/i.test(e))).toBe(true);
  });

  it("scenario criterion with code-review evidence on non-user-visible packet passes rule 12", () => {
    // tooling packets are not user-visible — the runtime evidence rule should NOT fire
    const contract = makeContract({
      acceptance: [
        {
          id: "AC-001",
          kind: "command",
          description: "Script runs",
          blocking: true,
          evidenceRequired: ["code review"],
        },
      ],
    });
    const result = lintContract(contract, "tooling");
    expect(result.errors.every((e) => !/runtime verification/i.test(e))).toBe(true);
  });

  // Rule 13 (outOfScope/objective contradiction) moved to contract evaluator prompt —
  // semantic analysis belongs in the LLM, not in string-matching heuristics.
});
