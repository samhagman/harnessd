/**
 * Test that the orchestrator's memvid encoding hooks actually work.
 *
 * Runs the happy-path scenario with FakeBackend, then checks:
 * 1. memory.mv2 file exists in the run directory
 * 2. It has searchable content from each phase (planning, contract, build, eval)
 * 3. The content matches what was produced by the agents
 *
 * Run: cd harness && npx tsx src/test/live/memvid-orchestrator.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { FakeBackend } from "../../backend/fake-backend.js";
import type { AgentMessage } from "../../backend/types.js";
import { runOrchestrator } from "../../orchestrator.js";
import { getLatestRunId } from "../../state-store.js";
import { readEvents } from "../../event-log.js";
import { openRunMemory, getMemoryPath } from "../../memvid.js";
import { RESULT_START_SENTINEL, RESULT_END_SENTINEL } from "../../schemas.js";

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function envelope(payload: unknown): string {
  return `${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}`;
}

// These envelopes match the exact schema format used in happy-path.test.ts

function plannerEnvelope(): string {
  return `Here is the plan:\n\n${envelope({
    spec: "# Auth Spec\n\nGoal: Add Clerk authentication middleware with Redis sessions.\n",
    packets: [
      {
        id: "PKT-001",
        title: "Auth middleware",
        type: "tooling",
        objective: "Implement Clerk auth middleware with Redis session store",
        whyNow: "Foundation for all protected routes",
        dependencies: [],
        status: "pending",
        priority: 1,
        estimatedSize: "M",
        risks: [],
        notes: [],
      },
    ],
    riskRegister: {
      risks: [{ id: "RISK-001", description: "Test risk", severity: "low", mitigation: "Test it", watchpoints: [] }],
    },
    evaluatorGuide: {
      domain: "backend",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Tests pass" }],
      antiPatterns: ["hardcoded secrets"],
      referenceStandard: "Secure auth middleware",
      edgeCases: ["expired tokens"],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All tests pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "Single packet: auth middleware with Redis sessions.\n",
  })}`;
}

function planReviewEnvelope(): string {
  return `Review complete:\n\n${envelope({
    packetId: "review",
    round: 1,
    decision: "approve",
    summary: "Plan approved.",
    issues: [],
    missingIntegrationScenarios: [],
  })}`;
}

function contractBuilderEnvelope(packetId: string): string {
  return `Contract:\n\n${envelope({
    packetId,
    round: 1,
    status: "proposed",
    title: "Auth middleware",
    packetType: "tooling",
    objective: "Implement Clerk auth middleware with Redis sessions",
    inScope: ["Auth middleware", "Redis session store"],
    outOfScope: ["Frontend"],
    assumptions: ["Node.js available"],
    risks: [{ id: "R1", description: "Might be slow", mitigation: "Profile it" }],
    likelyFiles: ["src/middleware/auth.ts", "src/config/redis.ts"],
    implementationPlan: ["Create auth middleware", "Configure Redis"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "Auth middleware rejects invalid tokens",
        blocking: true,
        evidenceRequired: ["test output"],
      },
    ],
    reviewChecklist: ["Check token validation"],
    proposedCommitMessage: "feat: add auth middleware",
  })}`;
}

function contractEvalEnvelope(packetId: string): string {
  return `Review:\n\n${envelope({
    packetId,
    round: 1,
    decision: "accept",
    scores: { scopeFit: 5, testability: 5, riskCoverage: 4, clarity: 5, specAlignment: 5 },
    requiredChanges: [],
    suggestedCriteriaAdditions: [],
    missingRisks: [],
    rationale: "Contract accepted.",
  })}`;
}

function builderEnvelope(packetId: string): string {
  return `Done:\n\n${envelope({
    packetId,
    sessionId: "builder-sess",
    changedFiles: ["src/middleware/auth.ts", "src/config/redis.ts"],
    commandsRun: [{ command: "npm test", exitCode: 0, summary: "8 tests passed" }],
    backgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "Clerk middleware validates tokens. Redis session store configured." },
    ],
    remainingConcerns: [],
    claimsDone: true,
  })}`;
}

function evaluatorEnvelope(packetId: string): string {
  return `Eval:\n\n${envelope({
    packetId,
    sessionId: "eval-sess",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      { criterionId: "AC-001", verdict: "pass", evidence: "Verified token validation against Clerk test API" },
    ],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
    addedCriteria: [],
    additionalIssuesOmitted: false,
    advisoryEscalations: [],
  })}`;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-orch-memvid-"));

  try {
    // Build FakeBackend that responds to each role
    const messages: AgentMessage[] = [
      // Planner
      { type: "assistant", text: "I'll create the plan.\n" + plannerEnvelope() },
      // Plan reviewer
      { type: "assistant", text: "Plan approved.\n" + planReviewEnvelope() },
      // Contract builder for PKT-001
      { type: "assistant", text: "Here's the contract.\n" + contractBuilderEnvelope("PKT-001") },
      // Contract evaluator for PKT-001
      { type: "assistant", text: "Contract accepted.\n" + contractEvalEnvelope("PKT-001") },
      // Builder for PKT-001
      { type: "assistant", text: "Built the auth middleware.\n" + builderEnvelope("PKT-001") },
      // Evaluator for PKT-001
      { type: "assistant", text: "All criteria pass.\n" + evaluatorEnvelope("PKT-001") },
    ];

    const backend = FakeBackend.fromScript(messages);

    // Inject plan approval into inbox after orchestrator starts
    const approveAfterMs = 2000;
    setTimeout(() => {
      const runId = getLatestRunId(tmpDir);
      if (!runId) return;
      const inboxDir = path.join(tmpDir, ".harnessd", "runs", runId, "inbox");
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(
        path.join(inboxDir, `${Date.now()}-approve.json`),
        JSON.stringify({ type: "approve_plan", createdAt: new Date().toISOString(), message: "go" }),
      );
    }, approveAfterMs);

    console.log("=== Running orchestrator with memvid encoding ===");
    await runOrchestrator(backend, {
      repoRoot: tmpDir,
      objective: "Add Clerk auth middleware with Redis sessions",
      config: { skipQA: true, skipPlanReview: true },
    });

    // Get the run ID
    const runId = getLatestRunId(tmpDir);
    assert(!!runId, "Should have a run ID after orchestration");
    console.log(`Run completed: ${runId}`);

    // Check events for memory.encoded
    const events = readEvents(tmpDir, runId!);
    const memoryEvents = events.filter(e => e.event === "memory.encoded" || e.event === "memory.error");
    console.log(`\nMemory events: ${memoryEvents.length}`);
    for (const e of memoryEvents) {
      console.log(`  ${e.event}: ${e.detail}`);
    }

    const errorEvents = memoryEvents.filter(e => e.event === "memory.error");
    assert(errorEvents.length === 0, `Should have no memory errors, got ${errorEvents.length}: ${errorEvents.map(e => e.detail).join(", ")}`);

    const encodedEvents = memoryEvents.filter(e => e.event === "memory.encoded");
    assert(encodedEvents.length > 0, "Should have at least one memory.encoded event");
    console.log(`PASS: ${encodedEvents.length} memory.encoded events`);

    // Check .mv2 file exists
    const memoryPath = getMemoryPath(tmpDir, runId!);
    assert(fs.existsSync(memoryPath), `memory.mv2 should exist at ${memoryPath}`);
    const fileSize = fs.statSync(memoryPath).size;
    console.log(`\nmemory.mv2 size: ${(fileSize / 1024).toFixed(1)} KB`);
    assert(fileSize > 10000, `memory.mv2 should be >10KB, got ${fileSize}`);
    console.log("PASS: memory.mv2 exists and has substantial data");

    // Open and search
    const memory = await openRunMemory(memoryPath, tmpDir, runId!);
    assert(memory !== null, "Should be able to open the memory file");

    // Search for spec content
    console.log("\n=== Searching memory for run content ===");

    const specResults = await memory!.search("Clerk authentication middleware", { k: 3, mode: "auto" });
    console.log(`\nSearch "Clerk authentication middleware": ${specResults.length} hits`);
    for (const h of specResults) {
      console.log(`  [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 80)}`);
    }
    assert(specResults.length > 0, "Should find Clerk auth content");

    // Search for builder work
    const builderResults = await memory!.search("Redis session store configuration", { k: 3, mode: "auto" });
    console.log(`\nSearch "Redis session store configuration": ${builderResults.length} hits`);
    for (const h of builderResults) {
      console.log(`  [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 80)}`);
    }
    assert(builderResults.length > 0, "Should find Redis session content");

    // Search for evaluator verdict
    const evalResults = await memory!.search("evaluator verdict criteria pass", { k: 3, mode: "auto" });
    console.log(`\nSearch "evaluator verdict criteria pass": ${evalResults.length} hits`);
    for (const h of evalResults) {
      console.log(`  [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 80)}`);
    }
    assert(evalResults.length > 0, "Should find evaluator pass content");

    console.log("\n" + "=".repeat(50));
    console.log("ALL ORCHESTRATOR MEMORY TESTS PASSED");
    console.log("=".repeat(50));
  } finally {
    // Allow flush
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nFAIL:", e.message ?? e);
  process.exit(1);
});
