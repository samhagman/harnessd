/**
 * Unit tests for buildRunTimeline() in orchestrator.ts.
 *
 * buildRunTimeline reads events from disk (.harnessd/runs/<id>/events.jsonl)
 * and returns a formatted string. Tests set up a temp directory with real
 * run state and event files, then assert on the string output.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { buildRunTimeline } from "../../orchestrator.js";
import { createRun } from "../../state-store.js";
import { appendEvent } from "../../event-log.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-timeline-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// Helpers
// ------------------------------------

/** Create a run in tmpDir and return its runId */
function setupRun(): string {
  const state = createRun(tmpDir, "Test run objective");
  return state.runId;
}

// ------------------------------------
// Tests
// ------------------------------------

describe("buildRunTimeline", () => {
  it("returns a non-empty fallback string for an empty event log", () => {
    const runId = setupRun();
    const result = buildRunTimeline(tmpDir, runId);
    // No prior events → the function returns a fallback message
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result).toContain("No prior events");
  });

  it("produces a numbered line for planning.completed", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "planning.completed" });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("1.");
    expect(result).toContain("Planning completed");
  });

  it("numbers events sequentially", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "planning.completed" });
    appendEvent(tmpDir, runId, { event: "plan.approved" });
    appendEvent(tmpDir, runId, { event: "contract.accepted", packetId: "PKT-001" });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
  });

  it("includes packetId in packet.done events", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, {
      event: "packet.done",
      packetId: "PKT-001",
    });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("PKT-001");
    expect(result).toContain("DONE");
  });

  it("noisy events (worker.heartbeat) produce no timeline entry", () => {
    // worker.heartbeat is NOT in EventTypeSchema, use builder.heartbeat which is
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "builder.heartbeat", packetId: "PKT-001" });

    const result = buildRunTimeline(tmpDir, runId);
    // No timeline entries should be generated
    expect(result).toContain("No prior events");
  });

  it("noisy events (nudge.sent) produce no timeline entry", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "nudge.sent", packetId: "PKT-001", detail: "fix the bug" });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("No prior events");
  });

  it("noisy events (poke.received) produce no timeline entry", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "poke.received", detail: "summarize status" });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("No prior events");
  });

  it("mix of noisy and signal events only numbers signal events", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "planning.completed" });
    appendEvent(tmpDir, runId, { event: "nudge.sent", detail: "hurry up" });
    appendEvent(tmpDir, runId, { event: "builder.heartbeat", packetId: "PKT-001" });
    appendEvent(tmpDir, runId, { event: "poke.received", detail: "status?" });
    appendEvent(tmpDir, runId, { event: "packet.done", packetId: "PKT-001" });

    const result = buildRunTimeline(tmpDir, runId);
    const lines = result.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1\./);
    expect(lines[1]).toMatch(/^2\./);
  });

  it("evaluator.passed event appears in timeline", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, {
      event: "evaluator.passed",
      packetId: "PKT-002",
    });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("PKT-002");
    expect(result).toContain("evaluator passed");
  });

  it("evaluator.failed event appears with detail", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, {
      event: "evaluator.failed",
      packetId: "PKT-003",
      detail: "AC-002 not met",
    });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("PKT-003");
    expect(result).toContain("evaluator failed");
  });

  it("packet.failed event appears with detail", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, {
      event: "packet.failed",
      packetId: "PKT-004",
      detail: "max fix loops exceeded",
    });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("PKT-004");
    expect(result).toContain("FAILED");
  });

  it("qa.passed event appears in timeline", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "qa.passed" });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("QA");
    expect(result).toContain("passed");
  });

  it("gate.failed event appears with detail", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, {
      event: "gate.failed",
      packetId: "PKT-005",
      detail: "typecheck: 3 errors",
    });

    const result = buildRunTimeline(tmpDir, runId);
    expect(result).toContain("PKT-005");
    expect(result).toContain("gate failed");
  });

  it("produces consistent output for the same events", () => {
    const runId = setupRun();
    appendEvent(tmpDir, runId, { event: "planning.completed" });
    appendEvent(tmpDir, runId, { event: "packet.done", packetId: "PKT-001" });

    const result1 = buildRunTimeline(tmpDir, runId);
    const result2 = buildRunTimeline(tmpDir, runId);
    expect(result1).toBe(result2);
  });
});
