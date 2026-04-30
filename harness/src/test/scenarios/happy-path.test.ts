/**
 * Scenario test: happy path — plan, negotiate, build, evaluate, done.
 *
 * Uses FakeBackend to replay minimal agent responses through the orchestrator.
 * Verifies state transitions, packet lifecycle, and artifact generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runOrchestrator } from "../../orchestrator.js";
import { getRunDir, getLatestRunId } from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import { RunStateSchema, RESULT_START_SENTINEL, RESULT_END_SENTINEL } from "../../schemas.js";
import {
  ScriptedBackend,
  makeScript,
  contractBuilderEnvelope,
  contractEvaluatorAcceptEnvelope,
  builderReportEnvelope,
  evaluatorPassEnvelope,
} from "../helpers/scripted-backend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-happy-"));
});

afterEach(async () => {
  // Allow transcript write streams from worker.ts to flush before deleting.
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function plannerEnvelopeTwoPackets(): string {
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
      },
      {
        id: "PKT-002",
        title: "Add integration test",
        type: "tooling",
        objective: "Create integration tests",
        whyNow: "Verify helper utility",
        dependencies: ["PKT-001"],
        status: "pending",
        priority: 2,
        estimatedSize: "S",
        risks: [],
        notes: [],
      },
    ],
    riskRegister: {
      risks: [{ id: "RISK-001", description: "Might not work", severity: "low", mitigation: "Test it", watchpoints: ["Check exit codes"] }],
    },
    evaluatorGuide: {
      domain: "tooling",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Tests pass" }],
      antiPatterns: ["hardcoded paths"],
      referenceStandard: "Clean, well-tested utility code",
      edgeCases: ["empty input"],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All tests pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "Two packets: helper utility then integration tests.\n",
  };
  return `Here is the plan:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

describe("happy-path scenario", () => {
  it("runs through plan → negotiate → build → evaluate → done for 2 packets", async () => {
    const scripts = [
      makeScript(plannerEnvelopeTwoPackets(), "planner-sess"),
      makeScript(contractBuilderEnvelope("PKT-001"), "cb-001-sess"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-001"), "ce-001-sess"),
      makeScript(builderReportEnvelope("PKT-001"), "builder-001-sess"),
      makeScript(evaluatorPassEnvelope("PKT-001"), "eval-001-sess"),
      makeScript(contractBuilderEnvelope("PKT-002"), "cb-002-sess"),
      makeScript(contractEvaluatorAcceptEnvelope("PKT-002"), "ce-002-sess"),
      makeScript(builderReportEnvelope("PKT-002"), "builder-002-sess"),
      makeScript(evaluatorPassEnvelope("PKT-002"), "eval-002-sess"),
    ];

    const backend = new ScriptedBackend(scripts);

    const autoApprove = setInterval(() => {
      try {
        const rid = getLatestRunId(tmpDir);
        if (!rid) return;
        const rd = getRunDir(tmpDir, rid);
        const runJson = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf-8"));
        if (runJson.phase === "awaiting_plan_approval") {
          const inboxDir = path.join(rd, "inbox");
          fs.mkdirSync(inboxDir, { recursive: true });
          fs.writeFileSync(
            path.join(inboxDir, "auto-approve.json"),
            JSON.stringify({ type: "approve_plan", createdAt: new Date().toISOString(), message: "auto" }),
          );
          clearInterval(autoApprove);
        }
      } catch {}
    }, 100);

    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "Build test utilities",
      config: { skipQA: true, skipPlanReview: true },
    });
    clearInterval(autoApprove);

    const latestRunId = getLatestRunId(tmpDir);
    expect(latestRunId).not.toBeNull();

    const runDir = getRunDir(tmpDir, latestRunId!);
    const runState = RunStateSchema.parse(JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8")));
    expect(runState.phase).toBe("completed");
    expect(runState.completedPacketIds).toEqual(expect.arrayContaining(["PKT-001", "PKT-002"]));
    expect(runState.completedPacketIds).toHaveLength(2);

    expect(fs.existsSync(path.join(runDir, "status.json"))).toBe(true);

    const events = readEvents(tmpDir, latestRunId!);
    const eventTypes = events.map((e) => e.event);
    for (const expected of [
      "run.started", "planning.started", "planning.completed",
      "packet.selected", "contract.round.started", "contract.accepted",
      "builder.started", "builder.completed", "evaluator.started",
      "evaluator.passed", "packet.done", "run.completed",
    ]) {
      expect(eventTypes).toContain(expected);
    }
    expect(events.filter((e) => e.event === "packet.done")).toHaveLength(2);

    expect(fs.existsSync(path.join(runDir, "spec", "SPEC.md"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "spec", "packets.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "spec", "risk-register.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "packets", "PKT-001", "contract", "final.json"))).toBe(true);
    expect(backend.calls).toHaveLength(9);
  });
});
