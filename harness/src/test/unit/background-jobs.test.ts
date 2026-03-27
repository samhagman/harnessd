/**
 * Unit tests for background-jobs.ts — background job tracker.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { BackgroundJobTracker } from "../../background-jobs.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-bgjobs-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// register + get lifecycle
// ------------------------------------

describe("register + get lifecycle", () => {
  it("registers a job and retrieves it", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    const job = tracker.register("job-1", "npx build", { pid: 12345 });

    expect(job.id).toBe("job-1");
    expect(job.command).toBe("npx build");
    expect(job.pid).toBe(12345);
    expect(job.status).toBe("running");
    expect(job.exitCode).toBeNull();

    const retrieved = tracker.get("job-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("job-1");
  });

  it("returns undefined for non-existent job", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("persists job to disk on register", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("job-disk", "echo hello");

    const filePath = path.join(tmpDir, "job-disk.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(data.id).toBe("job-disk");
    expect(data.status).toBe("running");
  });
});

// ------------------------------------
// heartbeat
// ------------------------------------

describe("heartbeat", () => {
  it("updates lastHeartbeatAt timestamp", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("job-hb", "long-running-cmd");

    const before = tracker.get("job-hb")!.lastHeartbeatAt;
    expect(before).toBeNull();

    tracker.heartbeat("job-hb");

    const after = tracker.get("job-hb")!.lastHeartbeatAt;
    expect(after).not.toBeNull();
    expect(typeof after).toBe("string");
  });

  it("does nothing for non-existent job", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    // Should not throw
    tracker.heartbeat("nonexistent");
  });
});

// ------------------------------------
// complete / fail
// ------------------------------------

describe("complete / fail status", () => {
  it("marks job as completed with exit code 0", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("job-ok", "echo success");
    tracker.complete("job-ok", 0, "All good");

    const job = tracker.get("job-ok")!;
    expect(job.status).toBe("completed");
    expect(job.exitCode).toBe(0);
    expect(job.note).toBe("All good");
  });

  it("marks job as failed with non-zero exit code", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("job-fail", "bad-cmd");
    tracker.complete("job-fail", 1, "Command not found");

    const job = tracker.get("job-fail")!;
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(1);
  });

  it("fail() marks job as failed with note", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("job-f", "risky-cmd");
    tracker.fail("job-f", "Timeout exceeded");

    const job = tracker.get("job-f")!;
    expect(job.status).toBe("failed");
    expect(job.note).toBe("Timeout exceeded");
  });
});

// ------------------------------------
// isAllComplete
// ------------------------------------

describe("isAllComplete", () => {
  it("returns true when all jobs are done", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("j1", "cmd1");
    tracker.register("j2", "cmd2");
    tracker.complete("j1", 0);
    tracker.complete("j2", 0);

    expect(tracker.isAllComplete()).toBe(true);
  });

  it("returns false when a job is still running", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("j1", "cmd1");
    tracker.register("j2", "cmd2");
    tracker.complete("j1", 0);

    expect(tracker.isAllComplete()).toBe(false);
  });

  it("returns true when no jobs registered", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    expect(tracker.isAllComplete()).toBe(true);
  });

  it("returns true when all jobs are failed (non-running)", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("j1", "cmd1");
    tracker.fail("j1", "crashed");

    expect(tracker.isAllComplete()).toBe(true);
  });
});

// ------------------------------------
// hasFailures
// ------------------------------------

describe("hasFailures", () => {
  it("returns false when no failures", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("j1", "cmd1");
    tracker.complete("j1", 0);

    expect(tracker.hasFailures()).toBe(false);
  });

  it("returns true when there are failures", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    tracker.register("j1", "cmd1");
    tracker.register("j2", "cmd2");
    tracker.complete("j1", 0);
    tracker.fail("j2", "broke");

    expect(tracker.hasFailures()).toBe(true);
  });

  it("returns false when no jobs registered", () => {
    const tracker = new BackgroundJobTracker(tmpDir);
    expect(tracker.hasFailures()).toBe(false);
  });
});

// ------------------------------------
// load from disk
// ------------------------------------

describe("load from disk", () => {
  it("loads previously persisted jobs", () => {
    // First tracker writes jobs
    const tracker1 = new BackgroundJobTracker(tmpDir);
    tracker1.register("j1", "cmd1", { pid: 100 });
    tracker1.register("j2", "cmd2", { pid: 200 });
    tracker1.complete("j1", 0, "done");
    tracker1.heartbeat("j2");

    // Second tracker loads from same directory
    const tracker2 = BackgroundJobTracker.load(tmpDir);
    const j1 = tracker2.get("j1")!;
    expect(j1.status).toBe("completed");
    expect(j1.exitCode).toBe(0);
    expect(j1.pid).toBe(100);

    const j2 = tracker2.get("j2")!;
    expect(j2.status).toBe("running");
    expect(j2.lastHeartbeatAt).not.toBeNull();
  });

  it("handles non-existent directory gracefully", () => {
    const nonExistent = path.join(tmpDir, "does-not-exist");
    const tracker = BackgroundJobTracker.load(nonExistent);
    expect(tracker.getAll()).toEqual([]);
  });
});
