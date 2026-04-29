/**
 * Unit tests for the buildVerificationFanoutSection helper and its integration
 * into the four verification role prompt builders (evaluator, qa_agent,
 * plan_reviewer, contract_evaluator).
 *
 * Covers:
 * - Helper returns "" when useClaudeBackend === false; non-empty otherwise.
 * - Role-specific "Good fanout shapes" block content is distinct per role.
 * - The maxAgents option surfaces into the rendered prompt (default: 4).
 * - The model="sonnet" rule is load-bearing and must appear in every rendered
 *   fanout block — opus/haiku must NOT appear.
 * - Each of the four prompt builders correctly injects the section when their
 *   `useClaudeBackend` option is true and suppresses it when false.
 */

import { describe, it, expect } from "vitest";

import {
  buildVerificationFanoutSection,
  type VerificationRole,
} from "../../prompts/shared.js";

// ---------------------------------------------------------------------------
// Prompt-builder imports — used by the integration-level describe blocks below
// ---------------------------------------------------------------------------

import { buildEvaluatorPrompt } from "../../prompts/evaluator-prompt.js";
import { buildQAPrompt } from "../../prompts/qa-prompt.js";
import { buildPlanReviewPrompt } from "../../prompts/plan-review-prompt.js";
import { buildContractEvaluatorPrompt } from "../../prompts/contract-evaluator-prompt.js";

import type {
  PacketContract,
  BuilderReport,
} from "../../schemas.js";

// ---------------------------------------------------------------------------
// Minimal fixtures (following advisory-guard.test.ts pattern)
// ---------------------------------------------------------------------------

function makeContract(): PacketContract {
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
    acceptance: [],
    goals: [],
    constraints: [],
    guidance: [],
    reviewChecklist: [],
    proposedCommitMessage: "test",
  };
}

function makeBuilderReport(): BuilderReport {
  return {
    packetId: "PKT-001",
    sessionId: "session-abc",
    changedFiles: [],
    commandsRun: [],
    liveBackgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [],
    keyDecisions: [],
    remainingConcerns: [],
    claimsDone: true,
    commitShas: null,
  };
}

// ---------------------------------------------------------------------------
// buildVerificationFanoutSection — helper-level tests (all run immediately)
// ---------------------------------------------------------------------------

describe("buildVerificationFanoutSection", () => {
  it("returns empty string when useClaudeBackend is false", () => {
    const result = buildVerificationFanoutSection("evaluator", { useClaudeBackend: false });
    expect(result).toBe("");
  });

  it("returns non-empty content when useClaudeBackend is true", () => {
    const result = buildVerificationFanoutSection("evaluator", { useClaudeBackend: true });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Parallel Verification Fanout");
  });

  it("returns non-empty content when useClaudeBackend is undefined (default to Claude behavior)", () => {
    const result = buildVerificationFanoutSection("evaluator", {});
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Parallel Verification Fanout");
  });

  it("returns non-empty content when opts is omitted entirely", () => {
    const result = buildVerificationFanoutSection("evaluator");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Parallel Verification Fanout");
  });

  it("uses role-specific good-fanout-shapes block for evaluator", () => {
    const result = buildVerificationFanoutSection("evaluator", { useClaudeBackend: true });
    expect(result).toContain("Good fanout shapes for the evaluator");
    expect(result).toContain("Structure/diff check");
    expect(result).toContain("gate_check replay");
  });

  it("uses role-specific good-fanout-shapes block for qa_agent", () => {
    const result = buildVerificationFanoutSection("qa_agent", { useClaudeBackend: true });
    expect(result).toContain("Good fanout shapes for the QA agent");
    expect(result).toContain("Integration-scenario sweep");
    expect(result).toContain("Cross-packet handoff verification");
  });

  it("uses role-specific good-fanout-shapes block for plan_reviewer", () => {
    const result = buildVerificationFanoutSection("plan_reviewer", { useClaudeBackend: true });
    expect(result).toContain("Good fanout shapes for the plan reviewer");
    expect(result).toContain("Acceptance-criterion specificity scan");
    expect(result).toContain("Risk register coverage check");
  });

  it("uses role-specific good-fanout-shapes block for contract_evaluator", () => {
    const result = buildVerificationFanoutSection("contract_evaluator", { useClaudeBackend: true });
    expect(result).toContain("Good fanout shapes for the contract evaluator");
    expect(result).toContain("Acceptance-criterion testability check");
    expect(result).toContain("Plan-consistency check against prior accepted contracts");
  });

  it("respects maxAgents option — surfaces the cap in the rendered prompt", () => {
    const result = buildVerificationFanoutSection("evaluator", {
      useClaudeBackend: true,
      maxAgents: 3,
    });
    expect(result).toContain("3 sub-agents");
  });

  it("defaults maxAgents to 4 when not provided", () => {
    const result = buildVerificationFanoutSection("evaluator", { useClaudeBackend: true });
    expect(result).toContain("4 sub-agents");
  });

  // Model constraint — the fanout guidance must tell verifiers to use sonnet, not opus/haiku.
  // This is load-bearing: evaluators must NOT be instructed to spawn heavy opus sub-agents.
  it("instructs sub-agents to use model=sonnet", () => {
    const s = buildVerificationFanoutSection("evaluator", { useClaudeBackend: true });
    expect(s).toContain('model="sonnet"');
    expect(s).not.toContain('model="opus"');
    expect(s).not.toContain('model="haiku"');
  });

  it("each role produces a distinct role-specific block (blocks differ from each other)", () => {
    const roles: VerificationRole[] = ["evaluator", "qa_agent", "plan_reviewer", "contract_evaluator"];
    const sections = roles.map((r) => buildVerificationFanoutSection(r, { useClaudeBackend: true }));

    // All four are non-empty
    sections.forEach((s) => expect(s.length).toBeGreaterThan(0));

    // Each pair of sections has a distinct role block — check at least the heading
    expect(sections[0]).toContain("for the evaluator");
    expect(sections[1]).toContain("for the QA agent");
    expect(sections[2]).toContain("for the plan reviewer");
    expect(sections[3]).toContain("for the contract evaluator");
  });
});

// ---------------------------------------------------------------------------
// buildEvaluatorPrompt — fanout integration
// ---------------------------------------------------------------------------

describe("buildEvaluatorPrompt — fanout integration", () => {
  it("includes the fanout section when useClaudeBackend is true", () => {
    const prompt = buildEvaluatorPrompt(makeContract(), makeBuilderReport(), {
      useClaudeBackend: true,
    });
    expect(prompt).toContain("Parallel Verification Fanout");
  });

  it("omits the fanout section when useClaudeBackend is false", () => {
    const prompt = buildEvaluatorPrompt(makeContract(), makeBuilderReport(), {
      useClaudeBackend: false,
    });
    expect(prompt).not.toContain("Parallel Verification Fanout");
  });
});

// ---------------------------------------------------------------------------
// buildQAPrompt — fanout integration
// ---------------------------------------------------------------------------

describe("buildQAPrompt — fanout integration", () => {
  it("includes the fanout section when useClaudeBackend is true", () => {
    const prompt = buildQAPrompt({
      spec: "test spec",
      contracts: [makeContract()],
      builderReports: [makeBuilderReport()],
      integrationScenarios: [],
      round: 1,
      useClaudeBackend: true,
    });
    expect(prompt).toContain("Parallel Verification Fanout");
  });

  it("omits the fanout section when useClaudeBackend is false", () => {
    const prompt = buildQAPrompt({
      spec: "test spec",
      contracts: [makeContract()],
      builderReports: [makeBuilderReport()],
      integrationScenarios: [],
      round: 1,
      useClaudeBackend: false,
    });
    expect(prompt).not.toContain("Parallel Verification Fanout");
  });
});

// ---------------------------------------------------------------------------
// buildPlanReviewPrompt — fanout integration
// ---------------------------------------------------------------------------

describe("buildPlanReviewPrompt — fanout integration", () => {
  it("includes the fanout section when useClaudeBackend is true", () => {
    const prompt = buildPlanReviewPrompt(
      "spec content",
      "packets content",
      "test objective",
      undefined, // riskRegister
      undefined, // integrationScenarios
      undefined, // planningContext
      undefined, // enableMemory
      true, // useClaudeBackend — 8th arg added by Phase 2 Task 6
    );
    expect(prompt).toContain("Parallel Verification Fanout");
  });

  it("omits the fanout section when useClaudeBackend is false", () => {
    const prompt = buildPlanReviewPrompt(
      "spec content",
      "packets content",
      "test objective",
      undefined,
      undefined,
      undefined,
      undefined,
      false, // useClaudeBackend
    );
    expect(prompt).not.toContain("Parallel Verification Fanout");
  });
});

// ---------------------------------------------------------------------------
// buildContractEvaluatorPrompt — fanout integration
// ---------------------------------------------------------------------------

describe("buildContractEvaluatorPrompt — fanout integration", () => {
  it("includes the fanout section when useClaudeBackend is true", () => {
    const prompt = buildContractEvaluatorPrompt(
      makeContract(),
      undefined, // riskRegister
      undefined, // enableMemory
      true, // useClaudeBackend — 4th arg added by Phase 2 Task 8
    );
    expect(prompt).toContain("Parallel Verification Fanout");
  });

  it("omits the fanout section when useClaudeBackend is false", () => {
    const prompt = buildContractEvaluatorPrompt(
      makeContract(),
      undefined,
      undefined,
      false, // useClaudeBackend
    );
    expect(prompt).not.toContain("Parallel Verification Fanout");
  });
});
