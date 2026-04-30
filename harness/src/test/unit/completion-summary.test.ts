/**
 * Unit tests for completion-summary.ts — generateCompletionContext().
 *
 * Verifies the three context layers (intent, execution, outcome) and backward
 * compatibility defaults for old builder/evaluator report shapes.
 */

import { describe, it, expect } from "vitest";
import { generateCompletionContext } from "../../completion-summary.js";
import type { Packet, PacketContract, BuilderReport, EvaluatorReport } from "../../schemas.js";

function makePacket(overrides: Partial<Packet> = {}): Packet {
  return {
    id: "PKT-001",
    title: "Add auth middleware",
    type: "backend_feature",
    objective: "Zero-trust auth using Clerk SDK",
    whyNow: "Needed before all other features",
    dependencies: [],
    status: "done",
    priority: 1,
    estimatedSize: "M",
    risks: [],
    notes: [],
    expectedFiles: [],
    criticalConstraints: [],
    integrationInputs: [],
    requiresHumanReview: false,
    ...overrides,
  };
}

function makeContract(overrides: Partial<PacketContract> = {}): PacketContract {
  return {
    packetId: "PKT-001",
    round: 1,
    status: "accepted",
    title: "Add auth middleware",
    packetType: "backend_feature",
    objective: "Implement zero-trust auth using Clerk SDK",
    inScope: ["Auth middleware", "Session management", "Redis store config"],
    outOfScope: ["Frontend changes", "Rate limiting"],
    assumptions: [],
    risks: [],
    likelyFiles: ["src/middleware/auth.ts"],
    implementationPlan: ["Step 1"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "scenario",
        description: "All routes require valid session",
        blocking: true,
        evidenceRequired: ["curl to any endpoint"],
      },
    ],
    goals: [
      {
        id: "G-001",
        description: "All routes require valid Clerk session",
        acceptanceCriteriaIds: ["AC-001"],
      },
    ],
    constraints: [
      {
        id: "C-001",
        description: "Must use existing @clerk/express",
        kind: "tech-stack",
        rationale: "Already a project dependency",
      },
    ],
    guidance: [
      {
        id: "GD-001",
        description: "Use Express middleware pattern",
        source: "codebase-pattern",
      },
    ],
    reviewChecklist: [],
    proposedCommitMessage: "feat: add Clerk auth middleware",
    ...overrides,
  };
}

function makeBuilderReport(overrides: Partial<BuilderReport> = {}): BuilderReport {
  return {
    packetId: "PKT-001",
    sessionId: "session-builder-001",
    changedFiles: ["src/middleware/auth.ts", "src/config/clerk.ts"],
    commandsRun: [{ command: "npx tsc --noEmit", exitCode: 0, summary: "No type errors" }],
    liveBackgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "All routes return 401 without session" },
    ],
    keyDecisions: [
      {
        description: "Used Redis-backed sessions instead of stateless JWT",
        rationale: "Clerk token refresh aligns with Redis TTL",
      },
    ],
    remainingConcerns: ["WebSocket upgrade path not tested"],
    claimsDone: true,
    commitShas: null,
    ...overrides,
  };
}

function makeEvaluatorReport(overrides: Partial<EvaluatorReport> = {}): EvaluatorReport {
  return {
    packetId: "PKT-001",
    sessionId: "session-eval-001",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      { criterionId: "AC-001", verdict: "pass", evidence: "Confirmed: 401 on unauthenticated request" },
      { criterionId: "AC-002", verdict: "pass", evidence: "Session persists across requests" },
      { criterionId: "AC-003", verdict: "skip", evidence: "", skipReason: "WebSocket not in scope" },
    ],
    missingEvidence: [],
    nextActions: ["Consider rate limiting on auth endpoint"],
    contractGapDetected: false,
    addedCriteria: [],
    additionalIssuesOmitted: false,
    advisoryEscalations: [],
    ...overrides,
  };
}

describe("generateCompletionContext", () => {
  it("returns a typed object (not a string)", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(typeof ctx).toBe("object");
    expect(typeof ctx).not.toBe("string");
    expect(ctx.packetId).toBe("PKT-001");
    expect(ctx.title).toBe("Add auth middleware");
    expect(ctx.packetType).toBe("backend_feature");
  });

  it("populates packet identity fields correctly", () => {
    const ctx = generateCompletionContext(
      makePacket({ id: "PKT-002", title: "Configure Redis" }),
      makeContract({ packetId: "PKT-002", objective: "Set up Redis for sessions" }),
      makeBuilderReport({ packetId: "PKT-002" }),
      makeEvaluatorReport({ packetId: "PKT-002" }),
    );
    expect(ctx.packetId).toBe("PKT-002");
    expect(ctx.title).toBe("Configure Redis");
    expect(ctx.objective).toBe("Set up Redis for sessions");
  });

  it("goals flow through from contract", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.goals).toHaveLength(1);
    expect(ctx.goals[0]!.id).toBe("G-001");
    expect(ctx.goals[0]!.description).toBe("All routes require valid Clerk session");
  });

  it("constraints flow through from contract", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.constraints).toHaveLength(1);
    expect(ctx.constraints[0]!.id).toBe("C-001");
    expect(ctx.constraints[0]!.kind).toBe("tech-stack");
  });

  it("guidance flows through from contract", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.guidance).toHaveLength(1);
    expect(ctx.guidance[0]!.id).toBe("GD-001");
    expect(ctx.guidance[0]!.source).toBe("codebase-pattern");
  });

  it("inScope and outOfScope flow through from contract", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.inScope).toContain("Auth middleware");
    expect(ctx.outOfScope).toContain("Frontend changes");
  });

  it("changedFiles flow through from builder report", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.changedFiles).toContain("src/middleware/auth.ts");
    expect(ctx.changedFiles).toContain("src/config/clerk.ts");
  });

  it("keyDecisions flow through from builder report", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.keyDecisions).toHaveLength(1);
    expect(ctx.keyDecisions[0]!.description).toContain("Redis");
    expect(ctx.keyDecisions[0]!.rationale).toContain("TTL");
  });

  it("remainingConcerns flow through from builder report", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.remainingConcerns).toContain("WebSocket upgrade path not tested");
  });

  it("acceptanceResults are computed from criterionVerdicts", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    // 2 pass, 0 fail, 1 skip, 3 total
    expect(ctx.acceptanceResults.passed).toBe(2);
    expect(ctx.acceptanceResults.failed).toBe(0);
    expect(ctx.acceptanceResults.skipped).toBe(1);
    expect(ctx.acceptanceResults.total).toBe(3);
  });

  it("evaluatorNotes flow through from nextActions", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.evaluatorNotes).toContain("Consider rate limiting on auth endpoint");
  });

  it("evaluatorAddedCriteria flow through from addedCriteria", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport({
        addedCriteria: [
          {
            kind: "scenario",
            description: "Session invalidation on logout",
            blocking: true,
            evidenceRequired: ["logout curl", "subsequent request returns 401"],
            severity: "high",
            rationale: "Logout should invalidate session",
            evidence: "No logout test in contract",
          },
        ],
      }),
    );
    expect(ctx.evaluatorAddedCriteria).toHaveLength(1);
    expect(ctx.evaluatorAddedCriteria[0]).toContain("scenario");
    expect(ctx.evaluatorAddedCriteria[0]).toContain("Session invalidation on logout");
  });

  it("all-fail verdict produces correct acceptanceResults", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport({
        overall: "fail",
        criterionVerdicts: [
          { criterionId: "AC-001", verdict: "fail", evidence: "Returns 200 on unauthenticated" },
          { criterionId: "AC-002", verdict: "fail", evidence: "No session header" },
        ],
      }),
    );
    expect(ctx.acceptanceResults.passed).toBe(0);
    expect(ctx.acceptanceResults.failed).toBe(2);
    expect(ctx.acceptanceResults.total).toBe(2);
  });

  it("empty criterionVerdicts produces zero counts", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport(),
      makeEvaluatorReport({ criterionVerdicts: [] }),
    );
    expect(ctx.acceptanceResults.passed).toBe(0);
    expect(ctx.acceptanceResults.failed).toBe(0);
    expect(ctx.acceptanceResults.skipped).toBe(0);
    expect(ctx.acceptanceResults.total).toBe(0);
  });

  it("keyDecisions defaults to [] when not in builder report (old schema)", () => {
    const oldStyleReport = {
      ...makeBuilderReport(),
      keyDecisions: undefined,
    } as unknown as BuilderReport;

    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      oldStyleReport,
      makeEvaluatorReport(),
    );
    expect(ctx.keyDecisions).toEqual([]);
  });

  it("goals defaults to [] when contract has no goals (old contract)", () => {
    const oldStyleContract = {
      ...makeContract(),
      goals: undefined,
    } as unknown as PacketContract;

    const ctx = generateCompletionContext(
      makePacket(),
      oldStyleContract,
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.goals).toEqual([]);
  });

  it("constraints defaults to [] when contract has no constraints (old contract)", () => {
    const oldStyleContract = {
      ...makeContract(),
      constraints: undefined,
    } as unknown as PacketContract;

    const ctx = generateCompletionContext(
      makePacket(),
      oldStyleContract,
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.constraints).toEqual([]);
  });

  it("guidance defaults to [] when contract has no guidance (old contract)", () => {
    const oldStyleContract = {
      ...makeContract(),
      guidance: undefined,
    } as unknown as PacketContract;

    const ctx = generateCompletionContext(
      makePacket(),
      oldStyleContract,
      makeBuilderReport(),
      makeEvaluatorReport(),
    );
    expect(ctx.guidance).toEqual([]);
  });

  it("commitMessages is empty when no cwd and no commitShas", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport({ commitShas: null }),
      makeEvaluatorReport(),
    );
    expect(ctx.commitMessages).toEqual([]);
  });

  it("commitMessages is empty when commitShas is empty array", () => {
    const ctx = generateCompletionContext(
      makePacket(),
      makeContract(),
      makeBuilderReport({ commitShas: [] }),
      makeEvaluatorReport(),
    );
    expect(ctx.commitMessages).toEqual([]);
  });
});
