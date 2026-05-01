import { describe, it, expect } from "vitest";
import { buildBuilderPrompt } from "../../prompts/builder-prompt.js";
import { buildPlannerPrompt } from "../../prompts/planner-prompt.js";
import { buildContractBuilderPrompt } from "../../prompts/contract-builder-prompt.js";
import { buildPlanReviewPrompt } from "../../prompts/plan-review-prompt.js";
import { PlanReviewSchema } from "../../schemas.js";
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

describe("buildPlanReviewPrompt — SLC framework + vertical slicing", () => {
  function makeReview() {
    return buildPlanReviewPrompt(
      "spec content",
      "packets content",
      "Build a tiny utility",
    );
  }

  it("includes the vertical-slicing principle as a checklist criterion", () => {
    const prompt = makeReview();
    expect(prompt).toContain("Vertical Slices, Not Horizontal Layers");
    // Must call out the specific anti-pattern shape
    expect(prompt).toMatch(/data layer.*no consuming surface|API endpoints.*later UI/i);
    expect(prompt).toContain("vertical_slicing");
  });

  it("includes the four SLC pillars (SCOPE / SIMPLE / LOVABLE / COMPLETE)", () => {
    const prompt = makeReview();
    expect(prompt).toContain("SLC Framework");
    expect(prompt).toMatch(/SCOPE\s+—/);
    expect(prompt).toMatch(/SIMPLE\s+—/);
    expect(prompt).toMatch(/LOVABLE\s+—/);
    expect(prompt).toMatch(/COMPLETE\s+—/);
  });

  it("includes the Maslow cross-check with all five layers", () => {
    const prompt = makeReview();
    expect(prompt).toContain("Maslow Cross-Check");
    for (const layer of ["Useful", "Reliable", "Intuitive", "Delightful", "Meaningful"]) {
      expect(prompt).toContain(layer);
    }
  });

  it("documents all four new SLC area enum values in the JSON envelope template", () => {
    const prompt = makeReview();
    for (const area of ["slc_simple", "slc_lovable", "slc_complete", "vertical_slicing"]) {
      expect(prompt).toContain(area);
    }
  });

  it("documents maslowScores in the JSON envelope template", () => {
    const prompt = makeReview();
    expect(prompt).toContain("maslowScores");
    expect(prompt).toMatch(/"useful":\s*1-5/);
    expect(prompt).toMatch(/"meaningful":\s*1-5/);
  });

  it("PlanReviewSchema rejects envelopes without maslowScores", () => {
    const result = PlanReviewSchema.safeParse({
      verdict: "approve",
      issues: [],
      missingIntegrationScenarios: [],
      summary: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("PlanReviewSchema accepts the new SLC area enum values", () => {
    const result = PlanReviewSchema.safeParse({
      verdict: "revise",
      issues: [
        { severity: "critical", area: "vertical_slicing", description: "horizontal split", suggestion: "thread end-to-end" },
        { severity: "major", area: "slc_simple", description: "vocab mismatch", suggestion: "use domain words" },
        { severity: "major", area: "slc_lovable", description: "no delight", suggestion: "find one corner" },
        { severity: "major", area: "slc_complete", description: "missing recovery", suggestion: "add it" },
      ],
      missingIntegrationScenarios: [],
      maslowScores: { useful: 4, reliable: 3, intuitive: 4, delightful: 2, meaningful: 5, notes: "delight low intentionally — internal tool" },
      summary: "needs revision",
    });
    expect(result.success).toBe(true);
  });

  it("PlanReviewSchema rejects out-of-range maslow scores", () => {
    for (const bad of [0, 6, -1, 7]) {
      const result = PlanReviewSchema.safeParse({
        verdict: "approve",
        issues: [],
        missingIntegrationScenarios: [],
        maslowScores: { useful: bad, reliable: 3, intuitive: 3, delightful: 3, meaningful: 3, notes: "" },
        summary: "ok",
      });
      expect(result.success).toBe(false);
    }
  });
});
