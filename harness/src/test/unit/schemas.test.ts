/**
 * Unit tests for Zod schemas and helper functions.
 */

import { describe, it, expect } from "vitest";

import {
  RunStateSchema,
  PacketSchema,
  PacketContractSchema,
  BuilderReportSchema,
  AcceptanceCriterionSchema,
  ContractGoalSchema,
  ContractConstraintSchema,
  ContractGuidanceSchema,
  PacketCompletionContextSchema,
  EventEntrySchema,
  defaultRunState,
  defaultProjectConfig,
  ProjectConfigSchema,
} from "../../schemas.js";

// ------------------------------------
// RunState
// ------------------------------------

describe("RunStateSchema", () => {
  it("parses a valid RunState", () => {
    const state = defaultRunState("run-test-001", "Test objective");
    const parsed = RunStateSchema.parse(state);
    expect(parsed.runId).toBe("run-test-001");
    expect(parsed.objective).toBe("Test objective");
    expect(parsed.phase).toBe("planning");
    expect(parsed.currentPacketId).toBeNull();
    expect(parsed.packetOrder).toEqual([]);
    expect(parsed.rateLimitState.status).toBe("ok");
    expect(parsed.operatorFlags.pauseAfterCurrentPacket).toBe(false);
  });

  it("throws on missing required fields", () => {
    expect(() => RunStateSchema.parse({})).toThrow();
  });

  it("throws on invalid phase", () => {
    const state = defaultRunState("run-test-001", "Test");
    expect(() =>
      RunStateSchema.parse({ ...state, phase: "invalid_phase" }),
    ).toThrow();
  });

  it("throws when runId is missing", () => {
    const state = defaultRunState("run-test-001", "Test");
    const { runId, ...rest } = state;
    expect(() => RunStateSchema.parse(rest)).toThrow();
  });
});

// ------------------------------------
// defaultRunState
// ------------------------------------

describe("defaultRunState", () => {
  it("produces a valid state that passes schema validation", () => {
    const state = defaultRunState("run-default-test", "build a thing");
    expect(() => RunStateSchema.parse(state)).not.toThrow();
    expect(state.phase).toBe("planning");
    expect(state.completedPacketIds).toEqual([]);
    expect(state.failedPacketIds).toEqual([]);
    expect(state.blockedPacketIds).toEqual([]);
    expect(state.currentWorkerRole).toBeNull();
    expect(state.lastHeartbeatAt).toBeNull();
  });

  it("sets createdAt and updatedAt to the same value", () => {
    const state = defaultRunState("run-ts-test", "obj");
    expect(state.createdAt).toBe(state.updatedAt);
  });
});

// ------------------------------------
// defaultProjectConfig
// ------------------------------------

describe("defaultProjectConfig", () => {
  it("produces a valid config with correct defaults", () => {
    const config = defaultProjectConfig();
    expect(config.maxNegotiationRounds).toBe(10);
    expect(config.maxNegotiationRoundsRisky).toBe(10);
    expect(config.maxFixLoopsPerPacket).toBe(10);
    expect(config.staleWorkerMinutes).toBe(15);
    expect(config.heartbeatWriteSeconds).toBe(20);
    expect(config.resumeBackoffMinutes).toEqual([5, 15, 30, 60]);
    expect(config.allowBuilderMicroFanout).toBe(true);
    expect(config.maxBuilderMicroFanoutAgents).toBe(3);
    expect(config.allowDirectEditSubagents).toBe(false);
    expect(config.renderStatusOnEveryEvent).toBe(true);
    expect(config.maxConsecutiveResumeFailures).toBe(8);
    // effort is optional; default config leaves it undefined
    expect(config.effort).toBeUndefined();
  });
});

// ------------------------------------
// ProjectConfigSchema — effort field
// ------------------------------------

describe("ProjectConfigSchema effort field", () => {
  it("accepts all valid effort values", () => {
    for (const value of ["low", "medium", "high", "xhigh", "max"] as const) {
      const parsed = ProjectConfigSchema.parse({ effort: value });
      expect(parsed.effort).toBe(value);
    }
  });

  it("rejects invalid effort values", () => {
    expect(() => ProjectConfigSchema.parse({ effort: "ultra" })).toThrow();
    expect(() => ProjectConfigSchema.parse({ effort: "HIGH" })).toThrow();
    expect(() => ProjectConfigSchema.parse({ effort: "" })).toThrow();
  });

  it("allows effort to be omitted (optional)", () => {
    const parsed = ProjectConfigSchema.parse({});
    expect(parsed.effort).toBeUndefined();
  });
});

// ------------------------------------
// PacketSchema
// ------------------------------------

describe("PacketSchema", () => {
  const validPacket = {
    id: "PKT-001",
    title: "Add login page",
    type: "ui_feature",
    objective: "Create a login page with username/password",
    whyNow: "Needed before other user features",
    dependencies: [],
    status: "pending",
    priority: 1,
    estimatedSize: "M",
    risks: ["auth integration might be complex"],
    notes: [],
  };

  it("parses a valid packet", () => {
    const parsed = PacketSchema.parse(validPacket);
    expect(parsed.id).toBe("PKT-001");
    expect(parsed.type).toBe("ui_feature");
    expect(parsed.estimatedSize).toBe("M");
  });

  it("rejects packet with invalid type", () => {
    expect(() =>
      PacketSchema.parse({ ...validPacket, type: "invalid_type" }),
    ).toThrow();
  });

  it("rejects packet with invalid status", () => {
    expect(() =>
      PacketSchema.parse({ ...validPacket, status: "in_progress" }),
    ).toThrow();
  });

  it("rejects packet with missing required fields", () => {
    const { id, ...rest } = validPacket;
    expect(() => PacketSchema.parse(rest)).toThrow();
  });
});

// ------------------------------------
// AcceptanceCriterionSchema
// ------------------------------------

describe("AcceptanceCriterionSchema", () => {
  const validCriterion = {
    id: "AC-001",
    kind: "command",
    description: "Tests pass",
    blocking: true,
    evidenceRequired: ["test output"],
  };

  it("parses a valid criterion", () => {
    const parsed = AcceptanceCriterionSchema.parse(validCriterion);
    expect(parsed.id).toBe("AC-001");
    expect(parsed.kind).toBe("command");
    expect(parsed.blocking).toBe(true);
  });

  it("rejects criterion with invalid kind", () => {
    expect(() =>
      AcceptanceCriterionSchema.parse({ ...validCriterion, kind: "foobar" }),
    ).toThrow();
  });

  it("rejects criterion without evidenceRequired array", () => {
    const { evidenceRequired, ...rest } = validCriterion;
    expect(() => AcceptanceCriterionSchema.parse(rest)).toThrow();
  });

  it("allows optional fields (threshold, command, scenario)", () => {
    const extended = {
      ...validCriterion,
      threshold: 0.95,
      command: "npm test",
      expected: "0 failures",
    };
    const parsed = AcceptanceCriterionSchema.parse(extended);
    expect(parsed.threshold).toBe(0.95);
    expect(parsed.command).toBe("npm test");
  });
});

// ------------------------------------
// EventEntrySchema
// ------------------------------------

describe("EventEntrySchema", () => {
  it("parses a valid event entry", () => {
    const entry = {
      ts: new Date().toISOString(),
      event: "run.started",
    };
    const parsed = EventEntrySchema.parse(entry);
    expect(parsed.event).toBe("run.started");
  });

  it("parses event with optional fields", () => {
    const entry = {
      ts: new Date().toISOString(),
      event: "packet.selected",
      phase: "selecting_packet",
      packetId: "PKT-001",
      detail: "Add login page",
    };
    const parsed = EventEntrySchema.parse(entry);
    expect(parsed.packetId).toBe("PKT-001");
    expect(parsed.phase).toBe("selecting_packet");
  });

  it("rejects event with invalid event type", () => {
    expect(() =>
      EventEntrySchema.parse({
        ts: new Date().toISOString(),
        event: "invalid.event.type",
      }),
    ).toThrow();
  });

  it("rejects event without ts", () => {
    expect(() =>
      EventEntrySchema.parse({ event: "run.started" }),
    ).toThrow();
  });
});

// ------------------------------------
// PacketSchema field defaults
// ------------------------------------

describe("PacketSchema field defaults", () => {
  /** Minimal valid packet — required fields only, no defaulted arrays */
  function minimalPacket(overrides: Record<string, unknown> = {}) {
    return {
      id: "PKT-001",
      title: "Test packet",
      type: "tooling",
      objective: "Write a helper script",
      whyNow: "Needed immediately",
      dependencies: [],
      status: "pending",
      priority: 1,
      estimatedSize: "S",
      risks: ["Risk of breakage"],
      ...overrides,
    };
  }

  it("expectedFiles defaults to [] when omitted", () => {
    const packet = PacketSchema.parse(minimalPacket());
    expect(packet.expectedFiles).toEqual([]);
  });

  it("criticalConstraints defaults to [] when omitted", () => {
    const packet = PacketSchema.parse(minimalPacket());
    expect(packet.criticalConstraints).toEqual([]);
  });

  it("integrationInputs defaults to [] when omitted", () => {
    const packet = PacketSchema.parse(minimalPacket());
    expect(packet.integrationInputs).toEqual([]);
  });

  it("notes defaults to [] when omitted", () => {
    const packet = PacketSchema.parse(minimalPacket());
    expect(packet.notes).toEqual([]);
  });

  it("requiresHumanReview defaults to false when omitted", () => {
    const packet = PacketSchema.parse(minimalPacket());
    expect(packet.requiresHumanReview).toBe(false);
  });

  it("explicitly provided expectedFiles are preserved", () => {
    const packet = PacketSchema.parse(
      minimalPacket({ expectedFiles: ["src/foo.ts", "src/bar.ts"] }),
    );
    expect(packet.expectedFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("explicitly provided criticalConstraints are preserved", () => {
    const packet = PacketSchema.parse(
      minimalPacket({ criticalConstraints: ["Must not break auth"] }),
    );
    expect(packet.criticalConstraints).toEqual(["Must not break auth"]);
  });

  it("explicitly provided integrationInputs are preserved", () => {
    const packet = PacketSchema.parse(
      minimalPacket({
        integrationInputs: [{ fromPacket: "PKT-002", provides: ["UserSchema"] }],
      }),
    );
    expect(packet.integrationInputs).toHaveLength(1);
    expect(packet.integrationInputs[0]!.fromPacket).toBe("PKT-002");
  });
});

// ------------------------------------
// BuilderReportSchema field defaults
// ------------------------------------

describe("BuilderReportSchema field defaults", () => {
  /** Minimal valid builder report — required fields only */
  function minimalBuilderReport(overrides: Record<string, unknown> = {}) {
    return {
      packetId: "PKT-001",
      sessionId: "session-abc-123",
      changedFiles: ["src/index.ts"],
      commandsRun: [],
      backgroundJobs: [],
      microFanoutUsed: [],
      selfCheckResults: [],
      remainingConcerns: [],
      claimsDone: true,
      ...overrides,
    };
  }

  it("commitShas defaults to null when omitted", () => {
    const report = BuilderReportSchema.parse(minimalBuilderReport());
    expect(report.commitShas).toBeNull();
  });

  it("explicitly provided commitShas array is preserved", () => {
    const report = BuilderReportSchema.parse(
      minimalBuilderReport({ commitShas: ["abc123", "def456"] }),
    );
    expect(report.commitShas).toEqual(["abc123", "def456"]);
  });

  it("null commitShas is accepted explicitly", () => {
    const report = BuilderReportSchema.parse(
      minimalBuilderReport({ commitShas: null }),
    );
    expect(report.commitShas).toBeNull();
  });

  it("empty commitShas array is accepted", () => {
    const report = BuilderReportSchema.parse(
      minimalBuilderReport({ commitShas: [] }),
    );
    expect(report.commitShas).toEqual([]);
  });

  it("keyDecisions defaults to [] when omitted", () => {
    const report = BuilderReportSchema.parse(minimalBuilderReport());
    expect(report.keyDecisions).toEqual([]);
  });

  it("keyDecisions parses when provided", () => {
    const report = BuilderReportSchema.parse(
      minimalBuilderReport({
        keyDecisions: [
          {
            description: "Used Redis-backed sessions instead of stateless JWT",
            rationale: "Clerk token refresh aligns with Redis TTL",
          },
        ],
      }),
    );
    expect(report.keyDecisions).toHaveLength(1);
    expect(report.keyDecisions[0]!.description).toBe("Used Redis-backed sessions instead of stateless JWT");
    expect(report.keyDecisions[0]!.rationale).toBe("Clerk token refresh aligns with Redis TTL");
  });

  it("keyDecisions rejects entries missing required fields", () => {
    expect(() =>
      BuilderReportSchema.parse(
        minimalBuilderReport({
          keyDecisions: [{ description: "No rationale" }], // missing rationale
        }),
      ),
    ).toThrow();
  });
});

// ------------------------------------
// ContractGoalSchema
// ------------------------------------

describe("ContractGoalSchema", () => {
  it("parses a valid goal", () => {
    const goal = ContractGoalSchema.parse({
      id: "G-001",
      description: "Zero ESLint boundary violations",
      acceptanceCriteriaIds: ["AC-001", "AC-002"],
    });
    expect(goal.id).toBe("G-001");
    expect(goal.description).toBe("Zero ESLint boundary violations");
    expect(goal.acceptanceCriteriaIds).toEqual(["AC-001", "AC-002"]);
  });

  it("parses a goal with an empty acceptanceCriteriaIds array", () => {
    const goal = ContractGoalSchema.parse({
      id: "G-002",
      description: "App loads without console errors",
      acceptanceCriteriaIds: [],
    });
    expect(goal.acceptanceCriteriaIds).toEqual([]);
  });

  it("rejects a goal missing description", () => {
    expect(() =>
      ContractGoalSchema.parse({ id: "G-001", acceptanceCriteriaIds: [] }),
    ).toThrow();
  });
});

// ------------------------------------
// ContractConstraintSchema
// ------------------------------------

describe("ContractConstraintSchema", () => {
  const allKinds = ["scope", "tech-stack", "behavior", "safety", "process"] as const;

  for (const kind of allKinds) {
    it(`parses a constraint with kind="${kind}"`, () => {
      const constraint = ContractConstraintSchema.parse({
        id: "C-001",
        description: "Only modify files within src/",
        kind,
        rationale: "Prevents accidental changes to build config",
      });
      expect(constraint.kind).toBe(kind);
    });
  }

  it("allows omitting rationale (optional field)", () => {
    const constraint = ContractConstraintSchema.parse({
      id: "C-001",
      description: "Only modify files within src/",
      kind: "scope",
    });
    expect(constraint.rationale).toBeUndefined();
  });

  it("rejects an invalid kind value", () => {
    expect(() =>
      ContractConstraintSchema.parse({
        id: "C-001",
        description: "Only modify files within src/",
        kind: "invalid-kind",
      }),
    ).toThrow();
  });
});

// ------------------------------------
// ContractGuidanceSchema
// ------------------------------------

describe("ContractGuidanceSchema", () => {
  const allSources = [
    "architectural-principles",
    "codebase-pattern",
    "operator-preference",
    "domain-convention",
  ] as const;

  for (const source of allSources) {
    it(`parses guidance with source="${source}"`, () => {
      const guidance = ContractGuidanceSchema.parse({
        id: "GD-001",
        description: "Follow dependency-direction principle",
        source,
      });
      expect(guidance.source).toBe(source);
    });
  }

  it("parses guidance with optional principle field", () => {
    const guidance = ContractGuidanceSchema.parse({
      id: "GD-001",
      description: "Follow dependency-direction principle",
      source: "architectural-principles",
      principle: "dependency-direction",
    });
    expect(guidance.principle).toBe("dependency-direction");
  });

  it("allows omitting principle (optional field)", () => {
    const guidance = ContractGuidanceSchema.parse({
      id: "GD-001",
      description: "Prefer fewer bridge files",
      source: "codebase-pattern",
    });
    expect(guidance.principle).toBeUndefined();
  });

  it("rejects an invalid source value", () => {
    expect(() =>
      ContractGuidanceSchema.parse({
        id: "GD-001",
        description: "Some guidance",
        source: "made-up-source",
      }),
    ).toThrow();
  });
});

// ------------------------------------
// PacketContractSchema — goals/constraints/guidance
// ------------------------------------

/** Minimal valid contract for PacketContractSchema tests */
function minimalContract(overrides: Record<string, unknown> = {}) {
  return {
    packetId: "PKT-001",
    round: 1,
    status: "proposed",
    title: "Add helper script",
    packetType: "tooling",
    objective: "Create a utility script",
    inScope: ["script.sh"],
    outOfScope: ["deployment automation"],
    assumptions: [],
    risks: [],
    likelyFiles: ["script.sh"],
    implementationPlan: ["Step 1"],
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
    reviewChecklist: [],
    proposedCommitMessage: "feat: add helper script",
    ...overrides,
  };
}

describe("PacketContractSchema — backward compat and new fields", () => {
  it("old contract without goals/constraints/guidance still parses (backward compat)", () => {
    const contract = PacketContractSchema.parse(minimalContract());
    expect(contract.goals).toEqual([]);
    expect(contract.constraints).toEqual([]);
    expect(contract.guidance).toEqual([]);
  });

  it("new contract with goals array parses", () => {
    const contract = PacketContractSchema.parse(
      minimalContract({
        goals: [
          {
            id: "G-001",
            description: "Script executes without errors",
            acceptanceCriteriaIds: ["AC-001"],
          },
        ],
      }),
    );
    expect(contract.goals).toHaveLength(1);
    expect(contract.goals[0]!.id).toBe("G-001");
  });

  it("new contract with constraints array parses", () => {
    const contract = PacketContractSchema.parse(
      minimalContract({
        constraints: [
          {
            id: "C-001",
            description: "Only modify script.sh",
            kind: "scope",
            rationale: "Other files are not in scope",
          },
        ],
      }),
    );
    expect(contract.constraints).toHaveLength(1);
    expect(contract.constraints[0]!.kind).toBe("scope");
  });

  it("new contract with guidance array parses", () => {
    const contract = PacketContractSchema.parse(
      minimalContract({
        guidance: [
          {
            id: "GD-001",
            description: "Follow POSIX sh conventions",
            source: "codebase-pattern",
          },
        ],
      }),
    );
    expect(contract.guidance).toHaveLength(1);
    expect(contract.guidance[0]!.source).toBe("codebase-pattern");
  });

  it("new contract with all three new fields parses", () => {
    const contract = PacketContractSchema.parse(
      minimalContract({
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
            rationale: "Other files are not in scope",
          },
        ],
        guidance: [
          {
            id: "GD-001",
            description: "Follow POSIX sh conventions",
            source: "codebase-pattern",
          },
        ],
      }),
    );
    expect(contract.goals).toHaveLength(1);
    expect(contract.constraints).toHaveLength(1);
    expect(contract.guidance).toHaveLength(1);
  });
});

// ------------------------------------
// PacketCompletionContextSchema
// ------------------------------------

/** Minimal valid completion context */
function minimalCompletionContext(overrides: Record<string, unknown> = {}) {
  return {
    packetId: "PKT-001",
    title: "Add auth middleware",
    packetType: "backend_feature",
    objective: "Zero-trust auth using Clerk SDK",
    changedFiles: ["src/middleware/auth.ts"],
    inScope: ["Auth middleware", "Session management"],
    outOfScope: ["Frontend changes"],
    commitMessages: ["feat: add Clerk auth middleware"],
    acceptanceResults: {
      passed: 4,
      failed: 0,
      skipped: 0,
      total: 4,
    },
    remainingConcerns: ["WebSocket upgrade path not tested"],
    evaluatorNotes: ["Consider rate limiting on auth endpoint"],
    ...overrides,
  };
}

describe("PacketCompletionContextSchema", () => {
  it("parses a minimal valid completion context", () => {
    const ctx = PacketCompletionContextSchema.parse(minimalCompletionContext());
    expect(ctx.packetId).toBe("PKT-001");
    expect(ctx.title).toBe("Add auth middleware");
    expect(ctx.packetType).toBe("backend_feature");
    expect(ctx.objective).toBe("Zero-trust auth using Clerk SDK");
    expect(ctx.changedFiles).toEqual(["src/middleware/auth.ts"]);
    expect(ctx.acceptanceResults.passed).toBe(4);
    expect(ctx.acceptanceResults.total).toBe(4);
  });

  it("goals defaults to [] when omitted", () => {
    const ctx = PacketCompletionContextSchema.parse(minimalCompletionContext());
    expect(ctx.goals).toEqual([]);
  });

  it("constraints defaults to [] when omitted", () => {
    const ctx = PacketCompletionContextSchema.parse(minimalCompletionContext());
    expect(ctx.constraints).toEqual([]);
  });

  it("guidance defaults to [] when omitted", () => {
    const ctx = PacketCompletionContextSchema.parse(minimalCompletionContext());
    expect(ctx.guidance).toEqual([]);
  });

  it("keyDecisions defaults to [] when omitted", () => {
    const ctx = PacketCompletionContextSchema.parse(minimalCompletionContext());
    expect(ctx.keyDecisions).toEqual([]);
  });

  it("evaluatorAddedCriteria defaults to [] when omitted", () => {
    const ctx = PacketCompletionContextSchema.parse(minimalCompletionContext());
    expect(ctx.evaluatorAddedCriteria).toEqual([]);
  });

  it("parses with goals, constraints, guidance populated", () => {
    const ctx = PacketCompletionContextSchema.parse(
      minimalCompletionContext({
        goals: [
          {
            id: "G-001",
            description: "All routes require valid session",
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
      }),
    );
    expect(ctx.goals).toHaveLength(1);
    expect(ctx.goals[0]!.id).toBe("G-001");
    expect(ctx.constraints).toHaveLength(1);
    expect(ctx.constraints[0]!.kind).toBe("tech-stack");
    expect(ctx.guidance).toHaveLength(1);
    expect(ctx.guidance[0]!.source).toBe("codebase-pattern");
  });

  it("parses with keyDecisions populated", () => {
    const ctx = PacketCompletionContextSchema.parse(
      minimalCompletionContext({
        keyDecisions: [
          {
            description: "Used Redis-backed sessions instead of stateless JWT",
            rationale: "Clerk token refresh aligns with Redis TTL",
          },
          {
            description: "Auth as middleware, not per-route guards",
            rationale: "Middleware ensures all routes are covered with no omissions",
          },
        ],
      }),
    );
    expect(ctx.keyDecisions).toHaveLength(2);
    expect(ctx.keyDecisions[0]!.description).toContain("Redis");
    expect(ctx.keyDecisions[1]!.description).toContain("middleware");
  });

  it("parses with evaluatorAddedCriteria populated", () => {
    const ctx = PacketCompletionContextSchema.parse(
      minimalCompletionContext({
        evaluatorAddedCriteria: [
          "scenario: session invalidation on logout",
        ],
      }),
    );
    expect(ctx.evaluatorAddedCriteria).toHaveLength(1);
    expect(ctx.evaluatorAddedCriteria[0]).toContain("session invalidation");
  });

  it("rejects context missing required fields", () => {
    expect(() =>
      PacketCompletionContextSchema.parse({ packetId: "PKT-001" }),
    ).toThrow();
  });

  it("rejects context with invalid acceptanceResults (missing fields)", () => {
    expect(() =>
      PacketCompletionContextSchema.parse(
        minimalCompletionContext({
          acceptanceResults: { passed: 4, failed: 0 }, // missing skipped and total
        }),
      ),
    ).toThrow();
  });
});

