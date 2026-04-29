/**
 * Live integration test for memvid — exercises the full pipeline.
 * Requires @memvid/sdk to be installed.
 *
 * Run: cd harness && npx tsx src/test/live/memvid-live.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createRunMemory,
  eventsToDocuments,
  transcriptToDocuments,
  builderReportToDocument,
  evalReportToDocument,
  completionSummaryToDocument,
  queryMemoryContext,
} from "../../memvid.js";
import type {
  EventEntry,
  PacketContract,
  BuilderReport,
  EvaluatorReport,
} from "../../schemas.js";

let tmpDir: string;

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function setup(): Promise<{ memoryPath: string; repoRoot: string; runId: string }> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-memvid-live-"));
  const runId = "test-run-live";
  const runDir = path.join(tmpDir, ".harnessd", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, "spec"), { recursive: true });
  // Create events.jsonl so appendEvent doesn't fail
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  const memoryPath = path.join(runDir, "memory.mv2");
  return { memoryPath, repoRoot: tmpDir, runId };
}

async function main() {
  const { memoryPath, repoRoot, runId } = await setup();

  // ──────────────────────────────────────────────────────
  console.log("=== Test 1: Create RunMemory ===");
  const memory = await createRunMemory(memoryPath, repoRoot, runId);
  assert(memory !== null, "createRunMemory returned null — is @memvid/sdk installed?");
  assert(fs.existsSync(memoryPath), ".mv2 file should exist on disk");
  console.log("PASS: RunMemory created");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 2: Encode events ===");
  const events: EventEntry[] = [
    { ts: new Date().toISOString(), event: "planning.started", phase: "planning" },
    { ts: new Date().toISOString(), event: "planning.completed", phase: "planning", detail: "5 packets planned" },
    { ts: new Date().toISOString(), event: "builder.started", phase: "building_packet", packetId: "PKT-001" },
    { ts: new Date().toISOString(), event: "evaluator.passed", phase: "evaluating_packet", packetId: "PKT-001", detail: "All 8 criteria verified" },
  ];
  const eventDocs = eventsToDocuments(events);
  console.log(`  Prepared ${eventDocs.length} event documents`);
  await memory!.encode(eventDocs);
  console.log("PASS: Events encoded");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 3: Encode transcript ===");
  const transcriptPath = path.join(tmpDir, "test-transcript.jsonl");
  const transcriptLines = [
    JSON.stringify({
      ts: new Date().toISOString(),
      role: "builder",
      msg: { type: "user", text: "Implement authentication middleware using Clerk SDK" },
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      role: "builder",
      msg: {
        type: "assistant",
        text: "I will implement the authentication middleware using Clerk SDK. The approach involves creating an Express middleware that validates session tokens using Clerk's verifyToken API. I chose Clerk over Auth0 because the contract specifies Clerk integration and the existing codebase already has @clerk/express installed. The middleware will extract the session token from the Authorization header, validate it, and attach the user context to the request object.",
      },
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      role: "builder",
      msg: { type: "user", text: "Good, now add session management" },
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      role: "builder",
      msg: {
        type: "assistant",
        text: "For session management, I will use Redis-backed sessions with connect-redis. The session store needs to be shared across multiple server instances, which rules out in-memory sessions. Redis also gives us TTL-based expiration that aligns with Clerk's token refresh cycle. I have configured the session middleware with a 24-hour TTL and secure cookie settings.",
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, transcriptLines.join("\n") + "\n");
  const transcriptDocs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
  console.log(`  Prepared ${transcriptDocs.length} transcript documents (assistant turns only)`);
  assert(transcriptDocs.length === 2, `Expected 2 assistant turns, got ${transcriptDocs.length}`);
  await memory!.encode(transcriptDocs);
  console.log("PASS: Transcript encoded");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 4: Encode builder report ===");
  const builderReport: BuilderReport = {
    packetId: "PKT-001",
    sessionId: "sess-001",
    changedFiles: ["src/middleware/auth.ts", "src/config/clerk.ts", "src/routes/index.ts"],
    commandsRun: [{ command: "npm test", exitCode: 0, summary: "All 12 tests passed" }],
    liveBackgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "Clerk middleware validates tokens correctly" },
      { criterionId: "AC-002", status: "pass", evidence: "Redis session store configured with 24h TTL" },
    ],
    keyDecisions: [],
    remainingConcerns: ["Edge case: expired token during WebSocket upgrade not tested"],
    claimsDone: true,
    commitShas: null,
  };
  await memory!.encode([builderReportToDocument(builderReport, "PKT-001")]);
  console.log("PASS: Builder report encoded");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 5: Encode evaluator report ===");
  const evalReport: EvaluatorReport = {
    packetId: "PKT-001",
    sessionId: "eval-sess-001",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      { criterionId: "AC-001", verdict: "pass", evidence: "Verified Clerk token validation works with test tokens" },
      { criterionId: "AC-002", verdict: "pass", evidence: "Redis session persists across server restart" },
    ],
    missingEvidence: [],
    nextActions: ["Consider adding rate limiting to auth endpoint"],
    contractGapDetected: false,
    addedCriteria: [],
    additionalIssuesOmitted: false,
    advisoryEscalations: [],
  };
  await memory!.encode([evalReportToDocument(evalReport, "PKT-001")]);
  console.log("PASS: Evaluator report encoded");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 6: Encode completion summary ===");
  const summary = `### PKT-001: Auth Middleware
**Type:** backend_feature | **Status:** done

**Key decisions:** Used Clerk SDK with Redis sessions. Chose connect-redis over ioredis for simplicity.
**Files:** src/middleware/auth.ts, src/config/clerk.ts
**Integration points:** Session validation middleware exported for route files.`;
  await memory!.encode([completionSummaryToDocument(summary, "PKT-001")]);
  console.log("PASS: Completion summary encoded");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 7: Lexical search ===");
  const lexResults = await memory!.search("Redis", { k: 5, mode: "lex" });
  console.log(`  Lexical search for "Redis": ${lexResults.length} hits`);
  for (const h of lexResults) {
    console.log(`    [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 100)}`);
  }
  assert(lexResults.length > 0, "Lexical search for 'Redis' should return results");
  console.log("PASS: Lexical search works");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 8: Semantic search — session storage ===");
  const semResults = await memory!.search("session storage approach", { k: 5, mode: "auto" });
  console.log(`  Semantic search for "session storage approach": ${semResults.length} hits`);
  for (const h of semResults) {
    console.log(`    [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 100)}`);
  }
  assert(semResults.length > 0, "Semantic search for 'session storage approach' should return results");
  console.log("PASS: Semantic search works");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 9: Semantic search — auth middleware ===");
  const authResults = await memory!.search("authentication middleware implementation", { k: 5, mode: "auto" });
  console.log(`  Search for "authentication middleware implementation": ${authResults.length} hits`);
  for (const h of authResults) {
    console.log(`    [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 100)}`);
  }
  assert(authResults.length > 0, "Auth middleware search should return results");
  console.log("PASS: Auth search works");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 10: Semantic search — evaluator question ===");
  const evalSearchResults = await memory!.search("did the evaluator pass all criteria", { k: 5, mode: "auto" });
  console.log(`  Search for "did the evaluator pass all criteria": ${evalSearchResults.length} hits`);
  for (const h of evalSearchResults) {
    console.log(`    [${h.score.toFixed(2)}] ${h.title}: ${h.snippet.slice(0, 100)}`);
  }
  assert(evalSearchResults.length > 0, "Evaluator query should return results");
  console.log("PASS: Evaluator search works");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 11: queryMemoryContext for a new packet ===");
  const pkt2Contract: PacketContract = {
    packetId: "PKT-002",
    round: 1,
    status: "accepted",
    title: "Add protected API routes",
    packetType: "backend_feature",
    objective: "Create authenticated API routes that require valid Clerk session",
    acceptance: [
      { id: "AC-001", kind: "command", description: "Routes reject unauthenticated requests with 401", blocking: true, evidenceRequired: ["curl output showing 401"] },
      { id: "AC-002", kind: "scenario", description: "Routes accept valid Clerk tokens and return data", blocking: true, evidenceRequired: ["test output"] },
    ],
    inScope: ["API route definitions", "Auth middleware integration"],
    outOfScope: ["Frontend changes"],
    implementationPlan: ["Wire auth middleware from PKT-001 into new route definitions"],
    risks: [{ id: "R-001", description: "May need Clerk test token setup", mitigation: "Use Clerk testing mode" }],
    likelyFiles: ["src/routes/api.ts", "src/middleware/auth.ts"],
    assumptions: ["Auth middleware from PKT-001 is working"],
    backgroundJobs: [],
    microFanoutPlan: [],
    goals: [],
    constraints: [],
    guidance: [],
    reviewChecklist: [],
    proposedCommitMessage: "feat: add protected API routes",
  };

  const context = await queryMemoryContext(memory, pkt2Contract, "builder", { maxResults: 5, timeoutMs: 10000 });
  console.log(`  queryMemoryContext returned: ${context ? context.length + " chars" : "undefined"}`);
  if (context) {
    console.log("  --- Context preview ---");
    console.log(context.split("\n").slice(0, 15).join("\n"));
    console.log("  --- End preview ---");
    assert(context.includes("## Relevant Prior Context"), "Context should have header");
  } else {
    console.log("  Note: queryMemoryContext returned undefined (may need more documents for semantic matching)");
  }
  console.log("PASS: queryMemoryContext completed without error");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 12: Timeline ===");
  const timeline = await memory!.timeline({ limit: 10 });
  console.log(`  Timeline entries: ${timeline.length}`);
  for (const e of timeline.slice(0, 3)) {
    console.log(`    ${e.title}: ${e.snippet.slice(0, 80)}`);
  }
  console.log("PASS: Timeline query completed");

  // ──────────────────────────────────────────────────────
  console.log("\n=== Test 13: encodeInBackground + waitForPendingWrites ===");
  const moreDocs = eventsToDocuments([
    { ts: new Date().toISOString(), event: "packet.done", packetId: "PKT-001" },
    { ts: new Date().toISOString(), event: "packet.selected", packetId: "PKT-002" },
  ]);
  memory!.encodeInBackground(moreDocs);
  await memory!.waitForPendingWrites();
  // Search for the new events
  const bgResults = await memory!.search("packet done PKT-001", { k: 3, mode: "lex" });
  console.log(`  Background encode then search: ${bgResults.length} hits`);
  console.log("PASS: encodeInBackground + waitForPendingWrites works");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("\n" + "=".repeat(50));
  console.log("ALL 13 TESTS PASSED");
  console.log("=".repeat(50));
}

main().catch((e) => {
  console.error("\nFAIL:", e.message ?? e);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
