/**
 * Test graceful degradation of memvid when SDK returns null.
 * Verifies all null-guard patterns work correctly.
 *
 * Run: cd harness && npx tsx src/test/live/memvid-degradation.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRunMemory, getMemoryPath, queryMemoryContext } from "../../memvid.js";
import type { RunMemory } from "../../memvid.js";
import type { PacketContract } from "../../schemas.js";

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-degrade-"));

  try {
    console.log("=== Test 1: Null memory guard pattern ===");
    // Use a function to prevent TypeScript from narrowing null to 'never'
    function getNullMemory(): RunMemory | null { return null; }
    const nullMemory = getNullMemory();

    // Simulate orchestrator pattern: memory?.encodeInBackground(docs)
    nullMemory?.encodeInBackground([]);
    console.log("PASS: null?.encodeInBackground() is no-op");

    // Simulate orchestrator pattern: memory?.waitForPendingWrites()
    if (nullMemory) {
      await nullMemory.waitForPendingWrites();
    }
    console.log("PASS: null guard on waitForPendingWrites works");

    // Simulate Phase 2 pattern: queryMemoryContext(null, ...)
    const dummyContract: PacketContract = {
      packetId: "PKT-001",
      round: 1,
      status: "accepted",
      title: "Test",
      packetType: "tooling",
      objective: "Test objective",
      acceptance: [],
      inScope: [],
      outOfScope: [],
      assumptions: [],
      risks: [],
      likelyFiles: [],
      implementationPlan: [],
      backgroundJobs: [],
      microFanoutPlan: [],
      goals: [],
      constraints: [],
      guidance: [],
      reviewChecklist: [],
      proposedCommitMessage: "test",
    };

    const context = await queryMemoryContext(null, dummyContract, "builder");
    assert(context === undefined, "queryMemoryContext(null, ...) should return undefined");
    console.log("PASS: queryMemoryContext returns undefined when memory is null");

    console.log("\n=== Test 2: Non-existent .mv2 file ===");
    const runDir = path.join(tmpDir, ".harnessd", "runs", "fake-run");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "events.jsonl"), "");

    const memPath = getMemoryPath(tmpDir, "fake-run");
    assert(!fs.existsSync(memPath), ".mv2 should not exist yet");

    // createRunMemory should create it (SDK is installed)
    const memory = await createRunMemory(memPath, tmpDir, "fake-run");
    if (memory) {
      console.log("SDK is installed — testing search on empty memory");
      const results = await memory.search("anything", { k: 5 });
      assert(results.length === 0, "Search on empty memory should return 0 results");
      console.log("PASS: Search on empty memory returns empty array");

      const ctx = await queryMemoryContext(memory, dummyContract, "builder");
      assert(ctx === undefined, "queryMemoryContext on empty memory should return undefined");
      console.log("PASS: queryMemoryContext on empty memory returns undefined");
    } else {
      console.log("SDK not installed — createRunMemory returned null (graceful)");
    }

    console.log("\n=== Test 3: Orchestrator-style encoding with null memory ===");
    // This simulates the orchestrator's pattern at each phase transition
    const mem = getNullMemory();
    if (mem) {
      // This block should never execute
      mem.encodeInBackground([{ title: "test", label: "test", text: "test", metadata: { ts: "", category: "event" as const }, tags: [] }]);
      throw new Error("Should not reach here");
    }
    console.log("PASS: Encoding block correctly skipped when memory is null");

    console.log("\n" + "=".repeat(50));
    console.log("ALL DEGRADATION TESTS PASSED");
    console.log("=".repeat(50));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nFAIL:", e.message ?? e);
  process.exit(1);
});
