/**
 * Unit tests for Zod schemas and helper functions.
 */

import { describe, it, expect } from "vitest";

import {
  RunStateSchema,
  PacketSchema,
  BuilderReportSchema,
  AcceptanceCriterionSchema,
  EventEntrySchema,
  defaultRunState,
  defaultProjectConfig,
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
});
