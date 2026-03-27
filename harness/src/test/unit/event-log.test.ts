/**
 * Unit tests for event-log.ts — append-only JSONL event stream.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { appendEvent, readEvents, tailEvents } from "../../event-log.js";
import { createRun } from "../../state-store.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;
let runId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-test-"));
  const state = createRun(tmpDir, "event-log test");
  runId = state.runId;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// appendEvent
// ------------------------------------

describe("appendEvent", () => {
  it("writes valid JSONL", () => {
    appendEvent(tmpDir, runId, {
      event: "run.started",
      phase: "planning",
      detail: "Starting test",
    });

    const eventsFile = path.join(
      tmpDir,
      ".harnessd",
      "runs",
      runId,
      "events.jsonl",
    );
    const content = fs.readFileSync(eventsFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe("run.started");
    expect(parsed.phase).toBe("planning");
    expect(parsed.ts).toBeDefined();
  });

  it("appends multiple events", () => {
    appendEvent(tmpDir, runId, { event: "run.started" });
    appendEvent(tmpDir, runId, { event: "planning.started", phase: "planning" });
    appendEvent(tmpDir, runId, {
      event: "planning.completed",
      phase: "planning",
      detail: "2 packets",
    });

    const events = readEvents(tmpDir, runId);
    expect(events).toHaveLength(3);
    expect(events[0]!.event).toBe("run.started");
    expect(events[1]!.event).toBe("planning.started");
    expect(events[2]!.event).toBe("planning.completed");
  });

  it("sets ts automatically", () => {
    const before = new Date().toISOString();
    const entry = appendEvent(tmpDir, runId, { event: "run.started" });
    const after = new Date().toISOString();

    expect(entry.ts >= before).toBe(true);
    expect(entry.ts <= after).toBe(true);
  });

  it("returns the written entry with ts", () => {
    const entry = appendEvent(tmpDir, runId, {
      event: "packet.selected",
      packetId: "PKT-001",
    });
    expect(entry.event).toBe("packet.selected");
    expect(entry.packetId).toBe("PKT-001");
    expect(entry.ts).toBeDefined();
  });
});

// ------------------------------------
// readEvents
// ------------------------------------

describe("readEvents", () => {
  it("reads back what was appended", () => {
    appendEvent(tmpDir, runId, { event: "run.started" });
    appendEvent(tmpDir, runId, { event: "builder.started", packetId: "PKT-001" });

    const events = readEvents(tmpDir, runId);
    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("run.started");
    expect(events[1]!.event).toBe("builder.started");
    expect(events[1]!.packetId).toBe("PKT-001");
  });

  it("returns empty array for empty events file", () => {
    const events = readEvents(tmpDir, runId);
    expect(events).toEqual([]);
  });

  it("validates each event entry", () => {
    // Write valid events via appendEvent
    appendEvent(tmpDir, runId, { event: "run.started" });

    const events = readEvents(tmpDir, runId);
    // Every event should have ts
    for (const event of events) {
      expect(event.ts).toBeDefined();
      expect(typeof event.ts).toBe("string");
    }
  });
});

// ------------------------------------
// tailEvents
// ------------------------------------

describe("tailEvents", () => {
  it("returns last N events", () => {
    appendEvent(tmpDir, runId, { event: "run.started" });
    appendEvent(tmpDir, runId, { event: "planning.started" });
    appendEvent(tmpDir, runId, { event: "planning.completed" });
    appendEvent(tmpDir, runId, { event: "packet.selected", packetId: "PKT-001" });
    appendEvent(tmpDir, runId, { event: "builder.started", packetId: "PKT-001" });

    const last2 = tailEvents(tmpDir, runId, 2);
    expect(last2).toHaveLength(2);
    expect(last2[0]!.event).toBe("packet.selected");
    expect(last2[1]!.event).toBe("builder.started");
  });

  it("returns all events when N >= total", () => {
    appendEvent(tmpDir, runId, { event: "run.started" });
    appendEvent(tmpDir, runId, { event: "run.completed" });

    const all = tailEvents(tmpDir, runId, 100);
    expect(all).toHaveLength(2);
  });

  it("returns empty array for empty log", () => {
    const result = tailEvents(tmpDir, runId, 5);
    expect(result).toEqual([]);
  });
});
