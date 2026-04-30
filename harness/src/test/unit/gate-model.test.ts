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
import {
  ScriptedBackend,
  makeScript,
  plannerEnvelope,
  contractBuilderEnvelope,
  contractEvaluatorAcceptEnvelope,
  builderReportEnvelope,
  evaluatorPassEnvelope,
} from "../helpers/scripted-backend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-gate-"));
});

afterEach(async () => {
  // Allow 500ms for background encoding (native SDK) to release file handles.
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

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

function writeSpec(repoRoot: string, runId: string): void {
  const specPath = path.join(getRunDir(repoRoot, runId), "spec", "SPEC.md");
  fs.writeFileSync(specPath, "# Test Spec\n\nGoal: test the gates.\n", "utf-8");
}

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
      { id: "AC-001", kind: "command", description: "Script runs", blocking: true, evidenceRequired: ["output"] },
    ],
    reviewChecklist: ["Check exit codes"],
    proposedCommitMessage: `harnessd(${packetId}): implement`,
  };
  writeArtifact(repoRoot, runId, `packets/${packetId}/contract/final.json`, contract);
}

function writeInboxMessage(
  repoRoot: string,
  runId: string,
  msg: Record<string, unknown>,
  filename?: string,
): void {
  const inboxDir = path.join(getRunDir(repoRoot, runId), "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, filename ?? `msg-${Date.now()}.json`), JSON.stringify(msg));
}

function findRunDir(repoRoot: string): string | null {
  const runsDir = path.join(repoRoot, ".harnessd", "runs");
  if (!fs.existsSync(runsDir)) return null;
  const entries = fs.readdirSync(runsDir).filter((d) => d.startsWith("run-")).sort();
  if (entries.length === 0) return null;
  return path.join(runsDir, entries[entries.length - 1]!);
}

function readAllEvents(runDir: string): Array<Record<string, unknown>> {
  const eventsFile = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8");
  return eventsFile.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("gate phases in RunPhaseSchema", () => {
  it("accepts awaiting_plan_approval", () => {
    expect(RunPhaseSchema.parse("awaiting_plan_approval")).toBe("awaiting_plan_approval");
  });

  it("accepts awaiting_human_review", () => {
    expect(RunPhaseSchema.parse("awaiting_human_review")).toBe("awaiting_human_review");
  });
});

describe("PacketSchema.requiresHumanReview", () => {
  const basePacket = {
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
  };

  it("defaults to false", () => {
    expect(PacketSchema.parse(basePacket).requiresHumanReview).toBe(false);
  });

  it("accepts true", () => {
    expect(PacketSchema.parse({ ...basePacket, requiresHumanReview: true }).requiresHumanReview).toBe(true);
  });
});

describe("InboxMessageSchema — all message types", () => {
  const now = new Date().toISOString();

  it("accepts approve_plan", () => {
    const msg = InboxMessageSchema.parse({ type: "approve_plan", createdAt: now, message: "Looks good" });
    expect(msg.type).toBe("approve_plan");
  });

  it("accepts approve_packet with packetId", () => {
    const msg = InboxMessageSchema.parse({ type: "approve_packet", createdAt: now, packetId: "PKT-003", message: "Ship it" });
    expect(msg.type).toBe("approve_packet");
    expect(msg.packetId).toBe("PKT-003");
  });

  it("accepts reject_packet", () => {
    const msg = InboxMessageSchema.parse({ type: "reject_packet", createdAt: now, packetId: "PKT-003", message: "Redo with grid" });
    expect(msg.type).toBe("reject_packet");
  });

  it("accepts send_to_agent", () => {
    const msg = InboxMessageSchema.parse({ type: "send_to_agent", createdAt: now, message: "Use CSS grid" });
    expect(msg.type).toBe("send_to_agent");
  });

  it("accepts inject_context", () => {
    const msg = InboxMessageSchema.parse({ type: "inject_context", createdAt: now, context: "Dark theme requested" });
    expect(msg.type).toBe("inject_context");
    expect(msg.context).toBe("Dark theme requested");
  });

  it("accepts reset_packet", () => {
    const msg = InboxMessageSchema.parse({ type: "reset_packet", createdAt: now, packetId: "PKT-002", message: "Wrong approach" });
    expect(msg.type).toBe("reset_packet");
  });

  it("accepts poke", () => {
    expect(InboxMessageSchema.parse({ type: "poke", createdAt: now, message: "status?" }).type).toBe("poke");
  });

  it("accepts pause", () => {
    expect(InboxMessageSchema.parse({ type: "pause", createdAt: now }).type).toBe("pause");
  });

  it("accepts resume", () => {
    expect(InboxMessageSchema.parse({ type: "resume", createdAt: now }).type).toBe("resume");
  });

  it("accepts stop_after_current", () => {
    expect(InboxMessageSchema.parse({ type: "stop_after_current", createdAt: now }).type).toBe("stop_after_current");
  });

  it("accepts summarize", () => {
    expect(InboxMessageSchema.parse({ type: "summarize", createdAt: now }).type).toBe("summarize");
  });

  it("rejects unknown message type", () => {
    expect(() => InboxMessageSchema.parse({ type: "unknown_type", createdAt: now })).toThrow();
  });
});

describe("PlanningContextSchema", () => {
  it("parses minimal context with empty arrays", () => {
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
    const updated = updateRun(tmpDir, run.runId, { phase: "awaiting_human_review", currentPacketId: "PKT-001" });
    expect(updated.phase).toBe("awaiting_human_review");
    expect(updated.currentPacketId).toBe("PKT-001");
  });

  it("awaiting_human_review -> selecting_packet (approve)", () => {
    const run = createRun(tmpDir, "approve test");
    updateRun(tmpDir, run.runId, { phase: "awaiting_human_review", currentPacketId: "PKT-001", packetOrder: ["PKT-001"] });
    const updated = updateRun(tmpDir, run.runId, { phase: "selecting_packet", currentPacketId: null, completedPacketIds: ["PKT-001"] });
    expect(updated.phase).toBe("selecting_packet");
    expect(updated.completedPacketIds).toContain("PKT-001");
    expect(updated.currentPacketId).toBeNull();
  });

  it("awaiting_human_review -> fixing_packet (reject)", () => {
    const run = createRun(tmpDir, "reject test");
    updateRun(tmpDir, run.runId, { phase: "awaiting_human_review", currentPacketId: "PKT-001", packetOrder: ["PKT-001"] });
    const updated = updateRun(tmpDir, run.runId, { phase: "fixing_packet" });
    expect(updated.phase).toBe("fixing_packet");
    expect(updated.currentPacketId).toBe("PKT-001");
  });

  it("context-overrides.md created on simulated inject_context", () => {
    const run = createRun(tmpDir, "Test");
    const runDir = getRunDir(tmpDir, run.runId);
    const specDir = path.join(runDir, "spec");
    fs.mkdirSync(specDir, { recursive: true });

    const overridePath = path.join(specDir, "context-overrides.md");
    fs.appendFileSync(overridePath, `\n---\n**[${new Date().toISOString()}]** Dark theme requested\n`);

    expect(fs.existsSync(overridePath)).toBe(true);
    expect(fs.readFileSync(overridePath, "utf-8")).toContain("Dark theme requested");
  });
});

describe("plan approval gate (orchestrator integration)", () => {
  it("transitions from awaiting_plan_approval to selecting_packet on approve_plan inbox", async () => {
    const scripts = [
      makeScript(plannerEnvelope({ requiresHumanReview: true }), "planner-sess"),
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-001"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-001"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-001"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-001"),
    ];

    const backend = new ScriptedBackend(scripts);

    const autoActions = setInterval(() => {
      try {
        const rd = findRunDir(tmpDir);
        if (!rd) return;
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));
        const inboxDir = path.join(rd, "inbox");
        fs.mkdirSync(inboxDir, { recursive: true });

        if (runJson.phase === "awaiting_plan_approval") {
          const f = path.join(inboxDir, "approve-plan.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({ type: "approve_plan", createdAt: new Date().toISOString(), message: "LGTM" }));
          }
        }
        if (runJson.phase === "awaiting_human_review") {
          const f = path.join(inboxDir, "approve-packet.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({ type: "approve_packet", createdAt: new Date().toISOString(), message: "Ship it" }));
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

    const rd = findRunDir(tmpDir)!;
    const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));
    expect(runJson.phase).toBe("completed");

    const events = readAllEvents(rd);
    const planApproved = events.find((e) => e.event === "plan.approved");
    expect(planApproved).toBeDefined();
    expect(planApproved!.phase).toBe("selecting_packet");
  });
});

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
        const inboxDir = path.join(rd, "inbox");
        fs.mkdirSync(inboxDir, { recursive: true });

        if (runJson.phase === "awaiting_plan_approval") {
          const f = path.join(inboxDir, "approve-plan.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({ type: "approve_plan", createdAt: new Date().toISOString() }));
          }
        }
        if (runJson.phase === "awaiting_human_review") {
          sawAwaitingReview = true;
          const f = path.join(inboxDir, "approve-packet.json");
          if (!fs.existsSync(f)) {
            fs.writeFileSync(f, JSON.stringify({ type: "approve_packet", createdAt: new Date().toISOString(), packetId: "PKT-001" }));
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

    const rd = findRunDir(tmpDir)!;
    const events = readAllEvents(rd);
    const awaitingEvent = events.find((e) => e.event === "packet.awaiting_review");
    expect(awaitingEvent).toBeDefined();
    expect(awaitingEvent!.packetId).toBe("PKT-001");
    expect(events.find((e) => e.event === "packet.approved")?.packetId).toBe("PKT-001");
    expect(events.find((e) => e.event === "packet.done")).toBeDefined();
  });
});

describe("reject packet (orchestrator integration)", () => {
  it("transitions from awaiting_human_review to fixing_packet and writes operator evaluator report", async () => {
    const run = createRun(tmpDir, "test reject packet");
    const runId = run.runId;

    writePackets(tmpDir, runId, [{ id: "PKT-001", title: "Helper", requiresHumanReview: true }]);
    writeSpec(tmpDir, runId);
    writeContract(tmpDir, runId, "PKT-001");

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

    updateRun(tmpDir, runId, { phase: "awaiting_human_review", currentPacketId: "PKT-001", packetOrder: ["PKT-001"] });

    writeInboxMessage(tmpDir, runId, {
      type: "reject_packet",
      createdAt: new Date().toISOString(),
      packetId: "PKT-001",
      message: "Colors are wrong, fix them",
    }, "001-reject.json");

    const scripts = [
      makeScript(builderReportEnvelope("PKT-001"), "fix-builder"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-002"),
    ];

    const backend = new ScriptedBackend(scripts);
    let approvedSecondReview = false;

    const autoActions = setInterval(() => {
      try {
        const rd = getRunDir(tmpDir, runId);
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));

        if (runJson.phase === "awaiting_human_review" && !approvedSecondReview) {
          const eventsFile = fs.readFileSync(path.join(rd, "events.jsonl"), "utf-8");
          if (eventsFile.includes("packet.rejected")) {
            approvedSecondReview = true;
            const inboxDir = path.join(rd, "inbox");
            fs.mkdirSync(inboxDir, { recursive: true });
            fs.writeFileSync(
              path.join(inboxDir, "002-approve-packet.json"),
              JSON.stringify({ type: "approve_packet", createdAt: new Date().toISOString(), packetId: "PKT-001" }),
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

    const events = readEvents(tmpDir, runId);
    const rejectEvent = events.find((e) => e.event === "packet.rejected");
    expect(rejectEvent).toBeDefined();
    expect(rejectEvent!.packetId).toBe("PKT-001");

    // After the fix cycle the evaluator passed, so the final report is "pass"
    const reportPath = path.join(getRunDir(tmpDir, runId), "packets", "PKT-001", "evaluator", "evaluator-report.json");
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    expect(report.overall).toBe("pass");
  });
});

describe("reset packet (orchestrator integration)", () => {
  it("clears packet artifacts and resets status, then rebuilds the packet", async () => {
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

    const contractPath = path.join(getRunDir(tmpDir, runId), "packets", "PKT-001", "contract", "final.json");
    expect(fs.existsSync(contractPath)).toBe(true);

    writeInboxMessage(tmpDir, runId, {
      type: "reset_packet",
      createdAt: new Date().toISOString(),
      packetId: "PKT-001",
      message: "Start this packet over",
    });

    const backend = new ScriptedBackend([
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-reset"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-reset"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-reset"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-reset"),
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

    const events = readEvents(tmpDir, runId);
    const resetEvent = events.find((e) => e.event === "packet.reset");
    expect(resetEvent).toBeDefined();
    expect(resetEvent!.packetId).toBe("PKT-001");
  });
});

describe("context injection (orchestrator integration)", () => {
  it("writes to context-overrides.md on inject_context inbox message", async () => {
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

    const overridePath = path.join(getRunDir(tmpDir, runId), "spec", "context-overrides.md");
    expect(fs.existsSync(overridePath)).toBe(true);
    expect(fs.readFileSync(overridePath, "utf-8")).toContain("Use Tailwind CSS for all styling, not inline styles.");

    const events = readEvents(tmpDir, runId);
    expect(events.find((e) => e.event === "context.injected")).toBeDefined();
  });
});
