/**
 * Unit tests for state-store.ts — file-backed state management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

import {
  createRun,
  loadRun,
  updateRun,
  writeArtifact,
  readArtifact,
  getLatestRunId,
  ensurePacketDir,
  getRunDir,
  validateWorkspacePath,
  pushToRunArray,
  HARNESSD_DIR,
} from "../../state-store.js";
import { RunStateSchema } from "../../schemas.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// createRun
// ------------------------------------

describe("createRun", () => {
  it("creates proper directory structure", () => {
    const state = createRun(tmpDir, "test objective");

    const runDir = getRunDir(tmpDir, state.runId);
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "spec"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "packets"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "inbox"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "outbox"))).toBe(true);
  });

  it("writes run.json with valid RunState", () => {
    const state = createRun(tmpDir, "test objective");
    const runDir = getRunDir(tmpDir, state.runId);
    const runJson = JSON.parse(
      fs.readFileSync(path.join(runDir, "run.json"), "utf-8"),
    );
    expect(() => RunStateSchema.parse(runJson)).not.toThrow();
    expect(runJson.objective).toBe("test objective");
    expect(runJson.phase).toBe("planning");
  });

  it("writes status.json and status.md", () => {
    const state = createRun(tmpDir, "test");
    const runDir = getRunDir(tmpDir, state.runId);
    expect(fs.existsSync(path.join(runDir, "status.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "status.md"))).toBe(true);
  });

  it("writes empty events.jsonl", () => {
    const state = createRun(tmpDir, "test");
    const runDir = getRunDir(tmpDir, state.runId);
    const content = fs.readFileSync(
      path.join(runDir, "events.jsonl"),
      "utf-8",
    );
    expect(content).toBe("");
  });

  it("writes config.json", () => {
    const state = createRun(tmpDir, "test");
    const runDir = getRunDir(tmpDir, state.runId);
    expect(fs.existsSync(path.join(runDir, "config.json"))).toBe(true);
  });

  it("returns valid RunState", () => {
    const state = createRun(tmpDir, "build X");
    expect(state.runId).toMatch(/^run-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(state.objective).toBe("build X");
    expect(state.phase).toBe("planning");
  });
});

// ------------------------------------
// loadRun
// ------------------------------------

describe("loadRun", () => {
  it("reads back what was created", () => {
    const created = createRun(tmpDir, "load test");
    const loaded = loadRun(tmpDir, created.runId);

    expect(loaded.runId).toBe(created.runId);
    expect(loaded.objective).toBe("load test");
    expect(loaded.createdAt).toBe(created.createdAt);
    expect(loaded.phase).toBe("planning");
  });

  it("throws on non-existent run", () => {
    expect(() => loadRun(tmpDir, "run-nonexistent")).toThrow(
      /not found/i,
    );
  });
});

// ------------------------------------
// updateRun
// ------------------------------------

describe("updateRun", () => {
  it("atomically updates fields", () => {
    const created = createRun(tmpDir, "update test");
    const updated = updateRun(tmpDir, created.runId, {
      phase: "building_packet",
      currentPacketId: "PKT-001",
    });

    expect(updated.phase).toBe("building_packet");
    expect(updated.currentPacketId).toBe("PKT-001");
    // updatedAt should change
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    // Immutable fields should stay the same
    expect(updated.runId).toBe(created.runId);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.objective).toBe("update test");
  });

  it("persists changes to disk", () => {
    const created = createRun(tmpDir, "persist test");
    updateRun(tmpDir, created.runId, { phase: "completed" });

    const reloaded = loadRun(tmpDir, created.runId);
    expect(reloaded.phase).toBe("completed");
  });

  it("does not allow overwriting runId or createdAt", () => {
    const created = createRun(tmpDir, "immutable test");
    const updated = updateRun(tmpDir, created.runId, {
      runId: "run-hacked" as any,
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    expect(updated.runId).toBe(created.runId);
    expect(updated.createdAt).toBe(created.createdAt);
  });
});

// ------------------------------------
// readArtifact / writeArtifact
// ------------------------------------

describe("readArtifact / writeArtifact", () => {
  it("round-trips data with schema validation", () => {
    const state = createRun(tmpDir, "artifact test");
    const data = { name: "test", count: 42 };
    const schema = z.object({ name: z.string(), count: z.number() });

    writeArtifact(tmpDir, state.runId, "spec/test-artifact.json", data);
    const read = readArtifact(tmpDir, state.runId, "spec/test-artifact.json", schema);

    expect(read).toEqual(data);
  });

  it("throws on non-existent artifact", () => {
    const state = createRun(tmpDir, "missing artifact");
    const schema = z.object({ name: z.string() });
    expect(() =>
      readArtifact(tmpDir, state.runId, "spec/nope.json", schema),
    ).toThrow(/not found/i);
  });

  it("throws when artifact fails schema validation", () => {
    const state = createRun(tmpDir, "bad artifact");
    writeArtifact(tmpDir, state.runId, "spec/bad.json", { wrong: "shape" });
    const schema = z.object({ name: z.string() });
    expect(() =>
      readArtifact(tmpDir, state.runId, "spec/bad.json", schema),
    ).toThrow();
  });

  it("creates parent directories as needed", () => {
    const state = createRun(tmpDir, "deep artifact");
    writeArtifact(tmpDir, state.runId, "spec/deep/nested/file.json", { ok: true });
    const schema = z.object({ ok: z.boolean() });
    const read = readArtifact(tmpDir, state.runId, "spec/deep/nested/file.json", schema);
    expect(read.ok).toBe(true);
  });
});

// ------------------------------------
// getLatestRunId
// ------------------------------------

describe("getLatestRunId", () => {
  it("finds the most recent run", async () => {
    const first = createRun(tmpDir, "first");
    // Wait >1 second so the timestamp portion of the ID differs.
    // Run IDs are `run-YYYYMMDD-HHMMSS-XXXX`, so same-second runs
    // sort by the random hex suffix, which is non-deterministic.
    await new Promise((r) => setTimeout(r, 1100));
    const second = createRun(tmpDir, "second");

    const latest = getLatestRunId(tmpDir);
    // Both runs exist; latest should be the second one
    // (since IDs are timestamp-based and sorted lexicographically)
    expect(latest).toBe(second.runId);
  });

  it("returns null when no runs exist", () => {
    const result = getLatestRunId(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when .harnessd directory does not exist", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-empty-"));
    try {
      const result = getLatestRunId(emptyDir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------
// ensurePacketDir
// ------------------------------------

describe("ensurePacketDir", () => {
  it("creates packet subdirectories", () => {
    const state = createRun(tmpDir, "packet dir test");
    const packetDir = ensurePacketDir(tmpDir, state.runId, "PKT-001");

    expect(fs.existsSync(path.join(packetDir, "contract"))).toBe(true);
    expect(fs.existsSync(path.join(packetDir, "builder"))).toBe(true);
    expect(fs.existsSync(path.join(packetDir, "evaluator"))).toBe(true);
  });

  it("is idempotent", () => {
    const state = createRun(tmpDir, "idempotent test");
    const dir1 = ensurePacketDir(tmpDir, state.runId, "PKT-001");
    const dir2 = ensurePacketDir(tmpDir, state.runId, "PKT-001");
    expect(dir1).toBe(dir2);
  });
});

// ------------------------------------
// validateWorkspacePath
// ------------------------------------

describe("validateWorkspacePath", () => {
  it("throws for /tmp workspace", () => {
    expect(() => validateWorkspacePath("/tmp/workspace")).toThrow(/volatile/i);
  });

  it("throws for exact /tmp path", () => {
    expect(() => validateWorkspacePath("/tmp")).toThrow(/volatile/i);
  });

  it("throws for /private/tmp subdirectory", () => {
    expect(() => validateWorkspacePath("/private/tmp/myproject")).toThrow(/volatile/i);
  });

  it("throws for /var/tmp subdirectory", () => {
    expect(() => validateWorkspacePath("/var/tmp/work")).toThrow(/volatile/i);
  });

  it("does NOT throw for a home directory path", () => {
    expect(() => validateWorkspacePath("/Users/sam/projects/workspace")).not.toThrow();
  });

  it("does NOT throw for /home/user path", () => {
    expect(() => validateWorkspacePath("/home/user/workspace")).not.toThrow();
  });

  it("does NOT throw for /var/app (not /var/tmp)", () => {
    expect(() => validateWorkspacePath("/var/app/myproject")).not.toThrow();
  });

  it("does NOT throw for the tmpDir itself (non-/tmp prefix)", () => {
    // tmpDir is created by os.tmpdir() which on macOS is /var/folders/...
    // This test exercises non-volatile absolute paths
    const nonVolatilePath = path.join(tmpDir.replace(/^\/tmp/, "/not-tmp"), "workspace");
    if (!nonVolatilePath.startsWith("/tmp") &&
        !nonVolatilePath.startsWith("/private/tmp") &&
        !nonVolatilePath.startsWith("/var/tmp")) {
      expect(() => validateWorkspacePath(nonVolatilePath)).not.toThrow();
    }
  });
});

// ------------------------------------
// pushToRunArray
// ------------------------------------

describe("pushToRunArray", () => {
  it("pushes a value to an empty completedPacketIds array", () => {
    const state = createRun(tmpDir, "push test");
    expect(state.completedPacketIds).toEqual([]);

    const updated = pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-001");
    expect(updated.completedPacketIds).toEqual(["PKT-001"]);
  });

  it("appends to a non-empty array", () => {
    const state = createRun(tmpDir, "push append test");
    pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-001");
    const updated = pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-002");
    expect(updated.completedPacketIds).toEqual(["PKT-001", "PKT-002"]);
  });

  it("deduplicates: does not add duplicate value", () => {
    const state = createRun(tmpDir, "dedup test");
    pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-001");
    const updated = pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-001");
    // PKT-001 should appear exactly once
    expect(updated.completedPacketIds).toEqual(["PKT-001"]);
    expect(updated.completedPacketIds).toHaveLength(1);
  });

  it("merges additionalPatch fields alongside the array push", () => {
    const state = createRun(tmpDir, "patch merge test");
    const updated = pushToRunArray(
      tmpDir, state.runId, "completedPacketIds", "PKT-001",
      { phase: "selecting_packet", currentPacketId: null },
    );
    expect(updated.completedPacketIds).toContain("PKT-001");
    expect(updated.phase).toBe("selecting_packet");
    expect(updated.currentPacketId).toBeNull();
  });

  it("reads fresh from disk — not stale in-memory state", () => {
    const state = createRun(tmpDir, "fresh read test");

    // Simulate another writer independently adding PKT-001 directly on disk
    updateRun(tmpDir, state.runId, { completedPacketIds: ["PKT-001"] });

    // Now call pushToRunArray with PKT-002 — it should read fresh, see PKT-001, and add PKT-002
    const updated = pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-002");
    expect(updated.completedPacketIds).toContain("PKT-001");
    expect(updated.completedPacketIds).toContain("PKT-002");
    expect(updated.completedPacketIds).toHaveLength(2);
  });

  it("reads fresh from disk — stale in-memory snapshot does not lose disk writes", () => {
    const state = createRun(tmpDir, "stale snapshot test");

    // Stale in-memory snapshot has empty completedPacketIds
    // Another writer (simulated) adds PKT-001 on disk directly
    updateRun(tmpDir, state.runId, { completedPacketIds: ["PKT-001"] });

    // pushToRunArray should read from disk, so PKT-001 survives
    const updated = pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-002");
    expect(updated.completedPacketIds).toEqual(["PKT-001", "PKT-002"]);
  });

  it("persists changes to disk", () => {
    const state = createRun(tmpDir, "persist check");
    pushToRunArray(tmpDir, state.runId, "completedPacketIds", "PKT-001");

    const reloaded = loadRun(tmpDir, state.runId);
    expect(reloaded.completedPacketIds).toContain("PKT-001");
  });

  it("works for round2CompletedPacketIds field", () => {
    const state = createRun(tmpDir, "r2 push test");
    const updated = pushToRunArray(tmpDir, state.runId, "round2CompletedPacketIds", "PKT-R2-001");
    expect(updated.round2CompletedPacketIds).toEqual(["PKT-R2-001"]);
  });

  it("works for failedPacketIds field", () => {
    const state = createRun(tmpDir, "failed push test");
    const updated = pushToRunArray(tmpDir, state.runId, "failedPacketIds", "PKT-003");
    expect(updated.failedPacketIds).toEqual(["PKT-003"]);
  });
});
