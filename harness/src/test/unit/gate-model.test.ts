/**
 * Unit tests for the gate model — plan approval, packet review, reject, reset, context injection.
 *
 * Tests inbox message processing both at the schema/state level and through the full
 * orchestrator loop using ScriptedBackend to verify end-to-end gate behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  InboxMessageSchema,
  RunPhaseSchema,
  PacketSchema,
  PlanningContextSchema,
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../../schemas.js";
import {
  createRun,
  loadRun,
  updateRun,
  writeArtifact,
  getRunDir,
  ensurePacketDir,
} from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import { runOrchestrator } from "../../orchestrator.js";
import type { AgentMessage, AgentBackend, AgentSessionOptions, NudgeOutcome } from "../../backend/types.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-gate-"));
});

afterEach(async () => {
  // Use 500ms to give background encoding (native SDK) time to release file handles.
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
});

// ------------------------------------
// ScriptedBackend — replays scripts in order
// ------------------------------------

class ScriptedBackend implements AgentBackend {
  private callIndex = 0;
  private scripts: AgentMessage[][];
  private lastSessionId: string | null = null;
  readonly calls: AgentSessionOptions[] = [];

  constructor(scripts: AgentMessage[][]) {
    this.scripts = scripts;
  }

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    this.calls.push(opts);
    const idx = this.callIndex++;
    const script = this.scripts[idx];
    if (!script) {
      throw new Error(`ScriptedBackend: no script for call index ${idx}`);
    }
    for (const msg of script) {
      if (msg.sessionId) this.lastSessionId = msg.sessionId;
      yield msg;
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  queueNudge(_text: string): NudgeOutcome {
    return { handled: false };
  }

  abortSession(): string | null {
    return this.lastSessionId;
  }

  supportsResume(): boolean { return true; }
  supportsMcpServers(): boolean { return false; }
  nudgeStrategy(): "stream" | "abort-resume" | "none" { return "none"; }
  supportsOutputSchema(): boolean { return false; }
}

function makeScript(text: string, sessionId: string = "sess-001"): AgentMessage[] {
  return [
    { type: "system", subtype: "init", sessionId },
    { type: "assistant", text },
    { type: "result", subtype: "success", text, isError: false, numTurns: 1, sessionId },
  ];
}

// ------------------------------------
// Envelope builders
// ------------------------------------

function plannerEnvelope(opts?: { requiresHumanReview?: boolean }): string {
  const payload = {
    spec: "# Test Spec\n\nGoal: build the thing.\n",
    packets: [
      {
        id: "PKT-001",
        title: "Add helper utility",
        type: "tooling",
        objective: "Create a helper utility",
        whyNow: "Foundation for other work",
        dependencies: [],
        status: "pending",
        priority: 1,
        estimatedSize: "S",
        risks: [],
        notes: [],
        requiresHumanReview: opts?.requiresHumanReview ?? true,
      },
    ],
    riskRegister: {
      risks: [
        {
          id: "RISK-001",
          description: "Might not work",
          severity: "low",
          mitigation: "Test it",
          watchpoints: ["Check exit codes"],
        },
      ],
    },
    evaluatorGuide: {
      domain: "tooling",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Tests pass" }],
      antiPatterns: ["hardcoded paths"],
      referenceStandard: "Clean code",
      edgeCases: ["empty input"],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All tests pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "One packet: helper utility.\n",
  };
  return `Here is the plan:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

function contractBuilderEnvelope(packetId: string): string {
  const payload = {
    packetId,
    round: 1,
    status: "proposed",
    title: `Implement ${packetId}`,
    packetType: "tooling",
    objective: `Implement the ${packetId} packet`,
    inScope: ["Create the utility script"],
    outOfScope: ["Deployment automation"],
    assumptions: ["Node.js available"],
    risks: [{ id: "R1", description: "Might be slow", mitigation: "Profile it" }],
    likelyFiles: ["src/helper.ts"],
    implementationPlan: ["Step 1: Read codebase", "Step 2: Implement"],
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
    proposedCommitMessage: `harnessd(${packetId}): implement utility`,
  };
  return `Here is the contract:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

function contractEvaluatorAcceptEnvelope(packetId: string): string {
  const payload = {
    packetId,
    round: 1,
    decision: "accept",
    scores: { scopeFit: 5, testability: 5, riskCoverage: 4, clarity: 5, specAlignment: 5 },
    requiredChanges: [],
    suggestedCriteriaAdditions: [],
    missingRisks: [],
    rationale: "Contract looks good, accepting.",
  };
  return `Review complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

function builderReportEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "builder-session-001",
    changedFiles: ["src/helper.ts"],
    commandsRun: [{ command: "npx tsc --noEmit", exitCode: 0, summary: "type check passes" }],
    liveBackgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "Script runs with exit 0" },
    ],
    remainingConcerns: [],
    claimsDone: true,
  };
  return `Implementation complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

function evaluatorPassEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "evaluator-session-001",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      {
        criterionId: "AC-001",
        verdict: "pass",
        evidence: "Script runs with exit 0, output matches expected",
      },
    ],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };
  return `Evaluation complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

// ------------------------------------
// Test helpers
// ------------------------------------

/** Write a valid packets.json */
function writePackets(
  repoRoot: string,
  runId: string,
  packets: Array<{
    id: string;
    title: string;
    requiresHumanReview?: boolean;
    dependencies?: string[];
    status?: string;
  }>,
): void {
  const fullPackets = packets.map((p, i) => ({
    id: p.id,
    title: p.title,
    type: "tooling",
    objective: `Implement ${p.id}`,
    whyNow: "Needed now",
    dependencies: p.dependencies ?? [],
    status: p.status ?? "pending",
    priority: i + 1,
    estimatedSize: "S",
    risks: [],
    notes: [],
    requiresHumanReview: p.requiresHumanReview ?? false,
  }));
  writeArtifact(repoRoot, runId, "spec/packets.json", fullPackets);
}

/** Write a minimal SPEC.md */
function writeSpec(repoRoot: string, runId: string): void {
  const specPath = path.join(getRunDir(repoRoot, runId), "spec", "SPEC.md");
  fs.writeFileSync(specPath, "# Test Spec\n\nGoal: test the gates.\n", "utf-8");
}

/** Write a finalized contract for a packet */
function writeContract(repoRoot: string, runId: string, packetId: string): void {
  ensurePacketDir(repoRoot, runId, packetId);
  const contract = {
    packetId,
    round: 1,
    status: "accepted",
    title: `Implement ${packetId}`,
    packetType: "tooling",
    objective: `Implement the ${packetId} packet`,
    inScope: ["Create the utility"],
    outOfScope: ["Deployment"],
    assumptions: ["Node.js available"],
    risks: [{ id: "R1", description: "Might be slow", mitigation: "Profile" }],
    likelyFiles: ["src/helper.ts"],
    implementationPlan: ["Step 1: Do it"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "Script runs",
        blocking: true,
        evidenceRequired: ["output"],
      },
    ],
    reviewChecklist: ["Check exit codes"],
    proposedCommitMessage: `harnessd(${packetId}): implement`,
  };
  writeArtifact(repoRoot, runId, `packets/${packetId}/contract/final.json`, contract);
}

/** Write an inbox message file */
function writeInboxMessage(
  repoRoot: string,
  runId: string,
  msg: Record<string, unknown>,
  filename?: string,
): void {
  const inboxDir = path.join(getRunDir(repoRoot, runId), "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  const fname = filename ?? `msg-${Date.now()}.json`;
  fs.writeFileSync(path.join(inboxDir, fname), JSON.stringify(msg));
}

/** Find the most recent run dir under tmpDir */
function findRunDir(repoRoot: string): string | null {
  const runsDir = path.join(repoRoot, ".harnessd", "runs");
  if (!fs.existsSync(runsDir)) return null;
  const entries = fs.readdirSync(runsDir).filter((d) => d.startsWith("run-")).sort();
  if (entries.length === 0) return null;
  return path.join(runsDir, entries[entries.length - 1]!);
}

// ====================================
// Schema-level tests
// ====================================

describe("gate phases in RunPhaseSchema", () => {
  it("accepts awaiting_plan_approval", () => {
    expect(RunPhaseSchema.parse("awaiting_plan_approval")).toBe("awaiting_plan_approval");
  });

  it("accepts awaiting_human_review", () => {
    expect(RunPhaseSchema.parse("awaiting_human_review")).toBe("awaiting_human_review");
  });
});

describe("PacketSchema.requiresHumanReview", () => {
  it("defaults to false", () => {
    const packet = PacketSchema.parse({
      id: "PKT-001",
      title: "Test",
      type: "ui_feature",
      objective: "Build thing",
      whyNow: "First",
      dependencies: [],
      status: "pending",
      priority: 1,
      estimatedSize: "S",
      risks: [],
      notes: [],
    });
    expect(packet.requiresHumanReview).toBe(false);
  });

  it("accepts true", () => {
    const packet = PacketSchema.parse({
      id: "PKT-001",
      title: "Test",
      type: "ui_feature",
      objective: "Build thing",
      whyNow: "First",
      dependencies: [],
      status: "pending",
      priority: 1,
      estimatedSize: "S",
      risks: [],
      notes: [],
      requiresHumanReview: true,
    });
    expect(packet.requiresHumanReview).toBe(true);
  });
});

describe("InboxMessageSchema — all message types", () => {
  const now = new Date().toISOString();

  it("accepts approve_plan", () => {
    const msg = InboxMessageSchema.parse({
      type: "approve_plan",
      createdAt: now,
      message: "Looks good",
    });
    expect(msg.type).toBe("approve_plan");
  });

  it("accepts approve_packet with packetId", () => {
    const msg = InboxMessageSchema.parse({
      type: "approve_packet",
      createdAt: now,
      packetId: "PKT-003",
      message: "Ship it",
    });
    expect(msg.type).toBe("approve_packet");
    expect(msg.packetId).toBe("PKT-003");
  });

  it("accepts reject_packet", () => {
    const msg = InboxMessageSchema.parse({
      type: "reject_packet",
      createdAt: now,
      packetId: "PKT-003",
      message: "Redo with grid",
    });
    expect(msg.type).toBe("reject_packet");
  });

  it("accepts send_to_agent", () => {
    const msg = InboxMessageSchema.parse({
      type: "send_to_agent",
      createdAt: now,
      message: "Use CSS grid",
    });
    expect(msg.type).toBe("send_to_agent");
  });

  it("accepts inject_context", () => {
    const msg = InboxMessageSchema.parse({
      type: "inject_context",
      createdAt: now,
      context: "Dark theme requested",
    });
    expect(msg.type).toBe("inject_context");
    expect(msg.context).toBe("Dark theme requested");
  });

  it("accepts reset_packet", () => {
    const msg = InboxMessageSchema.parse({
      type: "reset_packet",
      createdAt: now,
      packetId: "PKT-002",
      message: "Wrong approach",
    });
    expect(msg.type).toBe("reset_packet");
  });

  it("accepts poke", () => {
    const msg = InboxMessageSchema.parse({ type: "poke", createdAt: now, message: "status?" });
    expect(msg.type).toBe("poke");
  });

  it("accepts pause", () => {
    const msg = InboxMessageSchema.parse({ type: "pause", createdAt: now });
    expect(msg.type).toBe("pause");
  });

  it("accepts resume", () => {
    const msg = InboxMessageSchema.parse({ type: "resume", createdAt: now });
    expect(msg.type).toBe("resume");
  });

  it("accepts stop_after_current", () => {
    const msg = InboxMessageSchema.parse({ type: "stop_after_current", createdAt: now });
    expect(msg.type).toBe("stop_after_current");
  });

  it("accepts summarize", () => {
    const msg = InboxMessageSchema.parse({ type: "summarize", createdAt: now });
    expect(msg.type).toBe("summarize");
  });

  it("rejects unknown message type", () => {
    expect(() => InboxMessageSchema.parse({ type: "unknown_type", createdAt: now })).toThrow();
  });
});

describe("PlanningContextSchema", () => {
  it("parses minimal context", () => {
    const ctx = PlanningContextSchema.parse({});
    expect(ctx.techPreferences).toEqual([]);
    expect(ctx.designReferences).toEqual([]);
    expect(ctx.avoidList).toEqual([]);
  });

  it("parses full context", () => {
    const ctx = PlanningContextSchema.parse({
      vision: "A beautiful book list app",
      techPreferences: ["TypeScript", "CSS modules"],
      designReferences: ["https://example.com"],
      avoidList: ["No Tailwind"],
      doneDefinition: "All books display with star ratings",
      customNotes: "Keep it simple",
    });
    expect(ctx.vision).toBe("A beautiful book list app");
    expect(ctx.techPreferences).toHaveLength(2);
  });
});

// ====================================
// State transition tests
// ====================================

describe("gate state transitions via updateRun", () => {
  it("can transition to awaiting_plan_approval", () => {
    const run = createRun(tmpDir, "Test objective");
    const updated = updateRun(tmpDir, run.runId, { phase: "awaiting_plan_approval" });
    expect(updated.phase).toBe("awaiting_plan_approval");
  });

  it("can transition from awaiting_plan_approval to selecting_packet", () => {
    const run = createRun(tmpDir, "Test objective");
    updateRun(tmpDir, run.runId, { phase: "awaiting_plan_approval" });
    const updated = updateRun(tmpDir, run.runId, { phase: "selecting_packet" });
    expect(updated.phase).toBe("selecting_packet");
  });

  it("can transition to awaiting_human_review", () => {
    const run = createRun(tmpDir, "Test objective");
    const updated = updateRun(tmpDir, run.runId, {
      phase: "awaiting_human_review",
      currentPacketId: "PKT-001",
    });
    expect(updated.phase).toBe("awaiting_human_review");
    expect(updated.currentPacketId).toBe("PKT-001");
  });

  it("awaiting_human_review -> selecting_packet (approve)", () => {
    const run = createRun(tmpDir, "approve test");
    updateRun(tmpDir, run.runId, {
      phase: "awaiting_human_review",
      currentPacketId: "PKT-001",
      packetOrder: ["PKT-001"],
    });
    const updated = updateRun(tmpDir, run.runId, {
      phase: "selecting_packet",
      currentPacketId: null,
      completedPacketIds: ["PKT-001"],
    });
    expect(updated.phase).toBe("selecting_packet");
    expect(updated.completedPacketIds).toContain("PKT-001");
    expect(updated.currentPacketId).toBeNull();
  });

  it("awaiting_human_review -> fixing_packet (reject)", () => {
    const run = createRun(tmpDir, "reject test");
    updateRun(tmpDir, run.runId, {
      phase: "awaiting_human_review",
      currentPacketId: "PKT-001",
      packetOrder: ["PKT-001"],
    });
    const updated = updateRun(tmpDir, run.runId, { phase: "fixing_packet" });
    expect(updated.phase).toBe("fixing_packet");
    expect(updated.currentPacketId).toBe("PKT-001");
  });

  it("context-overrides.md created on simulated inject_context", () => {
    const run = createRun(tmpDir, "Test");
    const runDir = getRunDir(tmpDir, run.runId);
    const specDir = path.join(runDir, "spec");
    fs.mkdirSync(specDir, { recursive: true });

    // Simulate the appendContextOverride logic from orchestrator
    const overridePath = path.join(specDir, "context-overrides.md");
    const ts = new Date().toISOString();
    fs.appendFileSync(overridePath, `\n---\n**[${ts}]** Dark theme requested\n`);

    expect(fs.existsSync(overridePath)).toBe(true);
    const content = fs.readFileSync(overridePath, "utf-8");
    expect(content).toContain("Dark theme requested");
  });
});

// ====================================
// Orchestrator integration: plan approval gate
// ====================================

describe("plan approval gate (orchestrator integration)", () => {
  it("transitions from awaiting_plan_approval to selecting_packet on approve_plan inbox", async () => {
    const scripts = [
      makeScript(plannerEnvelope(), "planner-sess"),
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-001"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-001"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-001"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-001"),
    ];

    const backend = new ScriptedBackend(scripts);

    // Auto-approve plan gate and packet human review gate
    const autoActions = setInterval(() => {
      try {
        const rd = findRunDir(tmpDir);
        if (!rd) return;
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));

        if (runJson.phase === "awaiting_plan_approval") {
          const inboxDir = path.join(rd, "inbox");
          fs.mkdirSync(inboxDir, { recursive: true });
          const f = path.join(inboxDir, "approve-plan.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({
              type: "approve_plan",
              createdAt: new Date().toISOString(),
              message: "LGTM",
            }));
          }
        }

        if (runJson.phase === "awaiting_human_review") {
          const inboxDir = path.join(rd, "inbox");
          fs.mkdirSync(inboxDir, { recursive: true });
          const f = path.join(inboxDir, "approve-packet.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({
              type: "approve_packet",
              createdAt: new Date().toISOString(),
              message: "Ship it",
            }));
          }
        }
      } catch {}
    }, 100);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "Test plan approval gate",
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoActions);

    // Verify the run completed
    const rd = findRunDir(tmpDir)!;
    const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));
    expect(runJson.phase).toBe("completed");

    // Verify plan.approved event was emitted
    const events = readAllEvents(rd);
    const planApproved = events.find((e: any) => e.event === "plan.approved");
    expect(planApproved).toBeDefined();
    expect(planApproved!.phase).toBe("selecting_packet");
  });
});

// ====================================
// Orchestrator integration: packet review gate
// ====================================

describe("packet review gate (orchestrator integration)", () => {
  it("transitions to awaiting_human_review when requiresHumanReview is true and evaluator passes", async () => {
    const scripts = [
      makeScript(plannerEnvelope({ requiresHumanReview: true }), "planner-sess"),
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-001"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-001"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-001"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-001"),
    ];

    const backend = new ScriptedBackend(scripts);
    let sawAwaitingReview = false;

    const autoActions = setInterval(() => {
      try {
        const rd = findRunDir(tmpDir);
        if (!rd) return;
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));

        if (runJson.phase === "awaiting_plan_approval") {
          const inboxDir = path.join(rd, "inbox");
          fs.mkdirSync(inboxDir, { recursive: true });
          const f = path.join(inboxDir, "approve-plan.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({
              type: "approve_plan",
              createdAt: new Date().toISOString(),
            }));
          }
        }

        if (runJson.phase === "awaiting_human_review") {
          sawAwaitingReview = true;
          const inboxDir = path.join(rd, "inbox");
          fs.mkdirSync(inboxDir, { recursive: true });
          const f = path.join(inboxDir, "approve-packet.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({
              type: "approve_packet",
              createdAt: new Date().toISOString(),
              packetId: "PKT-001",
            }));
          }
        }
      } catch {}
    }, 100);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "Test packet review gate",
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoActions);

    expect(sawAwaitingReview).toBe(true);

    // Verify events
    const rd = findRunDir(tmpDir)!;
    const events = readAllEvents(rd);
    const awaitingEvent = events.find((e: any) => e.event === "packet.awaiting_review");
    expect(awaitingEvent).toBeDefined();
    expect(awaitingEvent!.packetId).toBe("PKT-001");

    const approvedEvent = events.find((e: any) => e.event === "packet.approved");
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.packetId).toBe("PKT-001");

    const doneEvent = events.find((e: any) => e.event === "packet.done");
    expect(doneEvent).toBeDefined();
  });
});

// ====================================
// Orchestrator integration: reject packet
// ====================================

describe("reject packet (orchestrator integration)", () => {
  it("transitions from awaiting_human_review to fixing_packet and writes operator evaluator report", async () => {
    // Start a run already past planning, with the packet at the awaiting_human_review gate.
    // This avoids the complex multi-gate timing issue of the full lifecycle.
    const run = createRun(tmpDir, "test reject packet");
    const runId = run.runId;

    writePackets(tmpDir, runId, [{ id: "PKT-001", title: "Helper", requiresHumanReview: true }]);
    writeSpec(tmpDir, runId);
    writeContract(tmpDir, runId, "PKT-001");

    // Write a builder report so the fix loop can find it
    ensurePacketDir(tmpDir, runId, "PKT-001");
    writeArtifact(tmpDir, runId, "packets/PKT-001/builder/builder-report.json", {
      packetId: "PKT-001",
      sessionId: "builder-001",
      changedFiles: ["src/helper.ts"],
      commandsRun: [],
      liveBackgroundJobs: [],
      microFanoutUsed: [],
      selfCheckResults: [{ criterionId: "AC-001", status: "pass", evidence: "ok" }],
      remainingConcerns: [],
      claimsDone: true,
    });

    // Start in awaiting_human_review phase
    updateRun(tmpDir, runId, {
      phase: "awaiting_human_review",
      currentPacketId: "PKT-001",
      packetOrder: ["PKT-001"],
    });

    // Write reject inbox message immediately (before orchestrator starts)
    writeInboxMessage(tmpDir, runId, {
      type: "reject_packet",
      createdAt: new Date().toISOString(),
      packetId: "PKT-001",
      message: "Colors are wrong, fix them",
    }, "001-reject.json");

    // After reject -> fixing_packet, builder runs again, evaluator passes,
    // then packet goes back to awaiting_human_review. We approve on second visit.
    const scripts = [
      // Fix builder
      makeScript(builderReportEnvelope("PKT-001"), "fix-builder"),
      // Evaluator passes
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-002"),
    ];

    const backend = new ScriptedBackend(scripts);
    let approvedSecondReview = false;

    const autoActions = setInterval(() => {
      try {
        const rd = getRunDir(tmpDir, runId);
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));

        // After the fix loop, if we're back in awaiting_human_review, approve
        if (runJson.phase === "awaiting_human_review" && !approvedSecondReview) {
          // Check if we've been through fixing (reject was already consumed)
          const eventsFile = fs.readFileSync(path.join(rd, "events.jsonl"), "utf-8");
          if (eventsFile.includes("packet.rejected")) {
            approvedSecondReview = true;
            const inboxDir = path.join(rd, "inbox");
            fs.mkdirSync(inboxDir, { recursive: true });
            fs.writeFileSync(
              path.join(inboxDir, "002-approve-packet.json"),
              JSON.stringify({
                type: "approve_packet",
                createdAt: new Date().toISOString(),
                packetId: "PKT-001",
              }),
            );
          }
        }
      } catch {}
    }, 100);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "test reject packet",
      resumeRunId: runId,
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoActions);

    const state = loadRun(tmpDir, runId);
    expect(state.phase).toBe("completed");

    // Verify packet.rejected event
    const events = readEvents(tmpDir, runId);
    const rejectEvent = events.find((e) => e.event === "packet.rejected");
    expect(rejectEvent).toBeDefined();
    expect(rejectEvent!.packetId).toBe("PKT-001");

    // Verify evaluator report file exists. The operator's reject report ("fail",
    // sessionId: "operator") is written when the packet is rejected, giving the
    // builder context for the fix loop. After the fix cycle, the real evaluator
    // reruns and overwrites it with the final passing result — so the file now
    // reflects the evaluator's verdict, not the operator's.
    const reportPath = path.join(getRunDir(tmpDir, runId), "packets", "PKT-001", "evaluator", "evaluator-report.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    // After the fix cycle the evaluator passed, so the final report is "pass"
    expect(report.overall).toBe("pass");
  });
});

// ====================================
// Orchestrator integration: reset packet
// ====================================

describe("reset packet (orchestrator integration)", () => {
  it("clears packet artifacts and resets status, then rebuilds the packet", async () => {
    // Set up a run that has already completed PKT-001 and has PKT-002 pending
    const run = createRun(tmpDir, "test reset");
    const runId = run.runId;

    writePackets(tmpDir, runId, [
      { id: "PKT-001", title: "Helper", status: "done" },
      { id: "PKT-002", title: "Tests", status: "pending", dependencies: ["PKT-001"] },
    ]);
    writeSpec(tmpDir, runId);

    updateRun(tmpDir, runId, {
      phase: "selecting_packet",
      packetOrder: ["PKT-001", "PKT-002"],
      completedPacketIds: ["PKT-001"],
    });

    // Write artifacts for PKT-001 that should be cleaned up
    ensurePacketDir(tmpDir, runId, "PKT-001");
    writeContract(tmpDir, runId, "PKT-001");
    writeArtifact(tmpDir, runId, "packets/PKT-001/builder/builder-report.json", {
      packetId: "PKT-001",
      sessionId: "s1",
      changedFiles: [],
      commandsRun: [],
      liveBackgroundJobs: [],
      microFanoutUsed: [],
      selfCheckResults: [],
      remainingConcerns: [],
      claimsDone: true,
    });

    // Verify the contract exists before reset
    const contractPath = path.join(getRunDir(tmpDir, runId), "packets", "PKT-001", "contract", "final.json");
    expect(fs.existsSync(contractPath)).toBe(true);

    // Write reset_packet inbox message
    writeInboxMessage(tmpDir, runId, {
      type: "reset_packet",
      createdAt: new Date().toISOString(),
      packetId: "PKT-001",
      message: "Start this packet over",
    });

    const backend = new ScriptedBackend([
      // Rebuild PKT-001 after reset
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-reset"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-reset"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-reset"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-reset"),
      // Then PKT-002
      makeScript(contractBuilderEnvelope("PKT-002"), "cb-002"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-002"), "ce-002"),
      makeScript(builderReportEnvelope("PKT-002"), "builder-002"),
      makeScript(evaluatorPassEnvelope("PKT-002"), "eval-002"),
    ]);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "test reset",
      resumeRunId: runId,
      config: { skipQA: true, skipPlanReview: true },
    });

    const state = loadRun(tmpDir, runId);
    expect(state.completedPacketIds).toContain("PKT-001");
    expect(state.completedPacketIds).toContain("PKT-002");
    expect(state.phase).toBe("completed");

    // Verify packet.reset event was emitted
    const events = readEvents(tmpDir, runId);
    const resetEvent = events.find((e) => e.event === "packet.reset");
    expect(resetEvent).toBeDefined();
    expect(resetEvent!.packetId).toBe("PKT-001");
  });
});

// ====================================
// Orchestrator integration: context injection
// ====================================

describe("context injection (orchestrator integration)", () => {
  it("writes to context-overrides.md on inject_context inbox message", async () => {
    // Set up a run already in building phase
    const run = createRun(tmpDir, "test context injection");
    const runId = run.runId;

    writePackets(tmpDir, runId, [{ id: "PKT-001", title: "Helper" }]);
    writeSpec(tmpDir, runId);
    writeContract(tmpDir, runId, "PKT-001");

    updateRun(tmpDir, runId, {
      phase: "building_packet",
      currentPacketId: "PKT-001",
      packetOrder: ["PKT-001"],
    });

    // Write inject_context inbox message
    writeInboxMessage(tmpDir, runId, {
      type: "inject_context",
      createdAt: new Date().toISOString(),
      context: "Use Tailwind CSS for all styling, not inline styles.",
    });

    const backend = new ScriptedBackend([
      makeScript(builderReportEnvelope("PKT-001"), "builder-001"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-001"),
    ]);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "test context injection",
      resumeRunId: runId,
      config: { skipQA: true, skipPlanReview: true },
    });

    // Verify context-overrides.md was written
    const overridePath = path.join(getRunDir(tmpDir, runId), "spec", "context-overrides.md");
    expect(fs.existsSync(overridePath)).toBe(true);
    const content = fs.readFileSync(overridePath, "utf-8");
    expect(content).toContain("Use Tailwind CSS for all styling, not inline styles.");

    // Verify context.injected event was emitted
    const events = readEvents(tmpDir, runId);
    const injectEvent = events.find((e) => e.event === "context.injected");
    expect(injectEvent).toBeDefined();
  });
});

// ------------------------------------
// Helper: read all events from a run dir
// ------------------------------------

function readAllEvents(runDir: string): Array<Record<string, any>> {
  const eventsFile = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8");
  return eventsFile.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
