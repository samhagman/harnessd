import { describe, it, expect } from "vitest";
import { buildBuilderPrompt } from "../../prompts/builder-prompt.js";
import { buildPlannerPrompt } from "../../prompts/planner-prompt.js";
import { buildContractBuilderPrompt } from "../../prompts/contract-builder-prompt.js";
import type { PacketContract, Packet, AcceptanceTemplate } from "../../schemas.js";

function makeMinimalContract(): PacketContract {
  return {
    packetId: "PKT-001",
    round: 1,
    status: "accepted",
    title: "Test Packet",
    packetType: "backend_feature",
    objective: "Test objective",
    inScope: ["scope item"],
    outOfScope: ["out item"],
    assumptions: ["assumption"],
    risks: [],
    likelyFiles: ["src/test.ts"],
    implementationPlan: ["step 1"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "tests pass",
        blocking: true,
        evidenceRequired: [],
      },
    ],
    goals: [],
    constraints: [],
    guidance: [],
    reviewChecklist: [],
    proposedCommitMessage: "harnessd(PKT-001): test",
  };
}

function makeMinimalPacket(): Packet {
  return {
    id: "PKT-001",
    title: "Test Packet",
    type: "backend_feature",
    objective: "Test objective",
    whyNow: "needed now",
    dependencies: [],
    status: "pending",
    priority: 1,
    estimatedSize: "S",
    risks: [],
    notes: [],
    expectedFiles: [],
    criticalConstraints: [],
    integrationInputs: [],
    requiresHumanReview: false,
  };
}

function makeMinimalTemplate(): AcceptanceTemplate {
  return {
    type: "backend_feature",
    requiredCriterionKinds: ["command"],
    defaultCriteria: [],
  };
}

describe("buildBuilderPrompt — backendCapabilities", () => {
  it("includes validate_envelope section by default (no capabilities specified)", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, { spec: "test spec" });
    expect(prompt).toContain("validate_envelope");
    expect(prompt).toContain("MANDATORY: Validate Before Emitting");
  });

  it("includes validate_envelope when supportsMcpServers is true", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: true,
        nudgeStrategy: "stream",
        supportsOutputSchema: false,
      },
    });
    expect(prompt).toContain("validate_envelope");
    expect(prompt).toContain("MANDATORY: Validate Before Emitting");
  });

  it("omits validate_envelope when supportsMcpServers is false", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: false,
        nudgeStrategy: "none",
        supportsOutputSchema: false,
      },
    });
    expect(prompt).not.toContain("MANDATORY: Validate Before Emitting");
    expect(prompt).not.toContain("validate_envelope");
  });

  it("uses envelope sentinels by default (no supportsOutputSchema)", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, { spec: "test spec" });
    expect(prompt).toContain("===HARNESSD_RESULT_START===");
    expect(prompt).toContain("===HARNESSD_RESULT_END===");
  });

  it("replaces envelope sentinels with output schema instructions when supportsOutputSchema is true", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: true,
        nudgeStrategy: "abort-resume",
        supportsOutputSchema: true,
      },
    });
    // Should NOT contain sentinel markers
    expect(prompt).not.toContain("===HARNESSD_RESULT_START===");
    expect(prompt).not.toContain("===HARNESSD_RESULT_END===");
    // Should instruct to emit structured JSON
    expect(prompt).toContain("output schema");
    expect(prompt).toContain("Do NOT use envelope sentinels");
  });

  it("adds abort-resume nudge paragraph when nudgeStrategy is abort-resume", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: true,
        nudgeStrategy: "abort-resume",
        supportsOutputSchema: true,
      },
    });
    expect(prompt).toContain("abort+resume");
    expect(prompt).toContain("write your progress to disk frequently");
  });

  it("does not add abort-resume nudge paragraph for stream strategy", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: true,
        nudgeStrategy: "stream",
        supportsOutputSchema: false,
      },
    });
    expect(prompt).not.toContain("abort+resume");
  });

  it("uses Claude Task-tool sub-agent guidance when supportsMcpServers is true", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: true,
        nudgeStrategy: "stream",
        supportsOutputSchema: false,
      },
    });
    // Claude-flavored prompt mentions sonnet Explore agent
    expect(prompt).toContain("sonnet Explore agent");
  });

  it("uses sequential exploration guidance when supportsMcpServers is false", () => {
    const contract = makeMinimalContract();
    const prompt = buildBuilderPrompt(contract, {
      spec: "test spec",
      backendCapabilities: {
        supportsMcpServers: false,
        nudgeStrategy: "abort-resume",
        supportsOutputSchema: true,
      },
    });
    // Codex-flavored prompt does NOT mention sonnet Explore agent
    expect(prompt).not.toContain("sonnet Explore agent");
    // But still has exploration section
    expect(prompt).toContain("Before You Start Implementing");
  });
});

describe("buildPlannerPrompt — backendCapabilities", () => {
  it("includes validate_envelope by default", () => {
    const prompt = buildPlannerPrompt("test objective");
    expect(prompt).toContain("validate_envelope");
    expect(prompt).toContain("MANDATORY: Validate Before Emitting");
  });

  it("omits validate_envelope when supportsMcpServers is false", () => {
    const prompt = buildPlannerPrompt(
      "test objective",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { supportsMcpServers: false, nudgeStrategy: "abort-resume", supportsOutputSchema: true },
    );
    expect(prompt).not.toContain("MANDATORY: Validate Before Emitting");
    expect(prompt).not.toContain("validate_envelope");
  });

  it("uses envelope sentinels when supportsOutputSchema is false (default)", () => {
    const prompt = buildPlannerPrompt("test objective");
    expect(prompt).toContain("===HARNESSD_RESULT_START===");
  });

  it("uses output schema instructions when supportsOutputSchema is true", () => {
    const prompt = buildPlannerPrompt(
      "test objective",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { supportsMcpServers: true, nudgeStrategy: "abort-resume", supportsOutputSchema: true },
    );
    expect(prompt).not.toContain("===HARNESSD_RESULT_START===");
    expect(prompt).toContain("output schema");
    expect(prompt).toContain("Do NOT use envelope sentinels");
  });
});

describe("buildContractBuilderPrompt — backendCapabilities", () => {
  it("includes validate_envelope by default", () => {
    const packet = makeMinimalPacket();
    const template = makeMinimalTemplate();
    const prompt = buildContractBuilderPrompt(packet, template, "spec excerpt");
    expect(prompt).toContain("validate_envelope");
    expect(prompt).toContain("MANDATORY: Validate Before Emitting");
  });

  it("omits validate_envelope when supportsMcpServers is false", () => {
    const packet = makeMinimalPacket();
    const template = makeMinimalTemplate();
    const prompt = buildContractBuilderPrompt(
      packet,
      template,
      "spec excerpt",
      undefined,
      undefined,
      undefined,
      undefined,
      { supportsMcpServers: false, nudgeStrategy: "abort-resume", supportsOutputSchema: true },
    );
    expect(prompt).not.toContain("MANDATORY: Validate Before Emitting");
    expect(prompt).not.toContain("validate_envelope");
  });

  it("uses envelope sentinels when supportsOutputSchema is false", () => {
    const packet = makeMinimalPacket();
    const template = makeMinimalTemplate();
    const prompt = buildContractBuilderPrompt(packet, template, "spec excerpt");
    expect(prompt).toContain("===HARNESSD_RESULT_START===");
  });

  it("uses output schema instructions when supportsOutputSchema is true", () => {
    const packet = makeMinimalPacket();
    const template = makeMinimalTemplate();
    const prompt = buildContractBuilderPrompt(
      packet,
      template,
      "spec excerpt",
      undefined,
      undefined,
      undefined,
      undefined,
      { supportsMcpServers: true, nudgeStrategy: "abort-resume", supportsOutputSchema: true },
    );
    expect(prompt).not.toContain("===HARNESSD_RESULT_START===");
    expect(prompt).toContain("output schema");
  });
});
