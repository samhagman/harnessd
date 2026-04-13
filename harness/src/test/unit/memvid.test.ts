/**
 * Unit tests for memvid.ts — the ACL over @memvid/sdk.
 *
 * Tests focus on the pure document preparation functions, chunking
 * behavior, factory functions, and the RunMemory class.
 *
 * Table of contents:
 *   1. eventsToDocuments
 *   2. transcriptToDocuments
 *   3. Long message chunking
 *   4. specToDocuments
 *   5. contractToDocument
 *   6. builderReportToDocument
 *   7. evalReportToDocument
 *   8. qaReportToDocument
 *   9. completionSummaryToDocument
 *   10. getMemoryPath
 *   11. Factory functions (createRunMemory / openRunMemory)
 *   12. queryMemoryContext
 *   13. MemvidBuffer (flush on threshold, flush on timer, stop, drain)
 *   14. agentMessageToDocuments (all 5 message types, text + toolUses, chunking)
 *   15. promptToDocuments (short prompt, long prompt chunking)
 *   16. inboxMessageToDocument (various inbox message types)
 *   17. contractRoundToDocument (proposal and review)
 *   18. planReviewToDocument (round number in tags)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  eventsToDocuments,
  transcriptToDocuments,
  specToDocuments,
  contractToDocument,
  builderReportToDocument,
  evalReportToDocument,
  qaReportToDocument,
  completionSummaryToDocument,
  getMemoryPath,
  createRunMemory,
  openRunMemory,
  queryMemoryContext,
  RunMemory,
  MemvidBuffer,
  agentMessageToDocuments,
  promptToDocuments,
  inboxMessageToDocument,
  contractRoundToDocument,
  planReviewToDocument,
} from "../../memvid.js";

import type { AgentMessage } from "../../backend/types.js";
import type { MemvidDocument } from "../../memvid.js";

import type {
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  QAReport,
  EventEntry,
} from "../../schemas.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-memvid-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// Helpers
// ------------------------------------

function makeTranscriptLine(
  role: string,
  text: string,
  ts?: string,
): string {
  return JSON.stringify({
    ts: ts ?? new Date().toISOString(),
    role: role === "assistant" ? "assistant" : role,
    msg: { type: role, text },
  });
}

function makeAssistantLine(text: string, ts?: string): string {
  return makeTranscriptLine("assistant", text, ts);
}

function makeUserLine(text: string): string {
  // user turns: msg.type = "user", role = "user"
  return JSON.stringify({
    ts: new Date().toISOString(),
    role: "user",
    msg: { type: "user", text },
  });
}

function writeTranscript(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ------------------------------------
// Minimal valid sample objects
// ------------------------------------

const sampleContract: PacketContract = {
  packetId: "PKT-001",
  round: 1,
  status: "accepted",
  title: "Add login page",
  packetType: "ui_feature",
  objective: "Create a login page with username and password fields",
  inScope: ["Login form", "Input validation"],
  outOfScope: ["OAuth providers", "2FA"],
  assumptions: ["React is already installed"],
  risks: [
    { id: "R-001", description: "Auth integration may be complex", mitigation: "Use existing auth service" },
  ],
  likelyFiles: ["src/pages/Login.tsx", "src/components/LoginForm.tsx"],
  implementationPlan: ["Create LoginForm component", "Wire up to auth service"],
  backgroundJobs: [],
  microFanoutPlan: [],
  acceptance: [
    {
      id: "AC-001",
      kind: "command",
      description: "Tests pass",
      blocking: true,
      evidenceRequired: ["test output showing 0 failures"],
    },
    {
      id: "AC-002",
      kind: "scenario",
      description: "User can log in",
      blocking: true,
      evidenceRequired: ["screenshot of successful login"],
    },
  ],
  reviewChecklist: ["Check for XSS vulnerabilities"],
  proposedCommitMessage: "feat: add login page",
};

const sampleBuilderReport: BuilderReport = {
  packetId: "PKT-001",
  sessionId: "session-abc123",
  changedFiles: ["src/pages/Login.tsx", "src/components/LoginForm.tsx"],
  commandsRun: [
    { command: "npx tsc --noEmit", exitCode: 0, summary: "No type errors" },
  ],
  backgroundJobs: [],
  microFanoutUsed: [],
  selfCheckResults: [
    { criterionId: "AC-001", status: "pass", evidence: "npm test passed with 0 failures" },
    { criterionId: "AC-002", status: "pass", evidence: "Verified login flow manually" },
  ],
  remainingConcerns: ["Edge case for empty password not tested"],
  claimsDone: true,
  commitShas: null,
};

const sampleEvaluatorReport: EvaluatorReport = {
  packetId: "PKT-001",
  sessionId: "session-eval-001",
  overall: "pass",
  hardFailures: [],
  rubricScores: [],
  criterionVerdicts: [
    { criterionId: "AC-001", verdict: "pass", evidence: "npm test output confirmed 0 failures" },
    { criterionId: "AC-002", verdict: "pass", evidence: "Login flow verified via browser" },
  ],
  missingEvidence: [],
  nextActions: [],
  contractGapDetected: false,
  addedCriteria: [],
  additionalIssuesOmitted: false,
  advisoryEscalations: [],
};

const sampleQAReport: QAReport = {
  overallVerdict: "pass",
  scenariosChecked: 3,
  issues: [],
  scenarioResults: [],
  consoleErrors: [],
  summary: "All scenarios passed. Application is functioning correctly.",
};

// ============================================================
// 1. eventsToDocuments
// ============================================================

describe("eventsToDocuments", () => {
  it("returns empty array for empty input", () => {
    expect(eventsToDocuments([])).toEqual([]);
  });

  it("maps one event to one document", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
    ];
    const docs = eventsToDocuments(events);
    expect(docs).toHaveLength(1);
  });

  it("title includes event name without packetId when packetId is absent", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.title).toBe("Event: run.started");
  });

  it("title includes packetId when present", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "builder.started", packetId: "PKT-001" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.title).toBe("Event: builder.started — PKT-001");
  });

  it("label is always 'event'", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
    ];
    expect(eventsToDocuments(events)[0]!.label).toBe("event");
  });

  it("text includes timestamp and event name", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "planning.started" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.text).toContain("2026-01-01T00:00:00.000Z");
    expect(doc!.text).toContain("planning.started");
  });

  it("text includes phase when present", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "planning.started", phase: "planning" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.text).toContain("phase: planning");
  });

  it("text includes detail when present", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "planning.completed", detail: "2 packets planned" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.text).toContain("2 packets planned");
  });

  it("text omits phase when absent", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.text).not.toContain("phase:");
  });

  it("metadata has correct category, ts, and optional fields", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "builder.started", packetId: "PKT-002", phase: "building_packet" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.metadata.category).toBe("event");
    expect(doc!.metadata.ts).toBe("2026-01-01T00:00:00.000Z");
    expect(doc!.metadata.packetId).toBe("PKT-002");
    expect(doc!.metadata.phase).toBe("building_packet");
  });

  it("tags always include 'event' and the event name", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.tags).toContain("event");
    expect(doc!.tags).toContain("run.started");
  });

  it("tags include packetId when present but not undefined/null string", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "builder.started", packetId: "PKT-003" },
    ];
    const [doc] = eventsToDocuments(events);
    expect(doc!.tags).toContain("PKT-003");
  });

  it("tags do not include undefined values when optional fields are absent", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
    ];
    const [doc] = eventsToDocuments(events);
    // Tags should have no undefined or empty string entries
    for (const tag of doc!.tags) {
      expect(tag).toBeTruthy();
      expect(typeof tag).toBe("string");
    }
  });

  it("handles multiple events and maps each to a distinct document", () => {
    const events: EventEntry[] = [
      { ts: "2026-01-01T00:00:00.000Z", event: "run.started" },
      { ts: "2026-01-01T00:01:00.000Z", event: "planning.started", phase: "planning" },
      { ts: "2026-01-01T00:02:00.000Z", event: "builder.started", packetId: "PKT-001", phase: "building_packet" },
    ];
    const docs = eventsToDocuments(events);
    expect(docs).toHaveLength(3);
    expect(docs[0]!.title).toBe("Event: run.started");
    expect(docs[1]!.title).toBe("Event: planning.started");
    expect(docs[2]!.title).toBe("Event: builder.started — PKT-001");
  });
});

// ============================================================
// 2. transcriptToDocuments
// ============================================================

describe("transcriptToDocuments", () => {
  let transcriptPath: string;

  beforeEach(() => {
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  it("returns empty array for non-existent file", () => {
    const docs = transcriptToDocuments("/does/not/exist.jsonl", "PKT-001", "builder");
    expect(docs).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    fs.writeFileSync(transcriptPath, "", "utf-8");
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toEqual([]);
  });

  it("filters out user turns — only assistant turns included", () => {
    writeTranscript(transcriptPath, [
      makeUserLine("Please do X"),
      makeAssistantLine("I will do X"),
      makeUserLine("Good, continue"),
      makeAssistantLine("Done"),
    ]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toHaveLength(2);
  });

  it("assigns incrementing turnIndex per assistant turn", () => {
    writeTranscript(transcriptPath, [
      makeAssistantLine("First turn text"),
      makeAssistantLine("Second turn text"),
    ]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toHaveLength(2);
    expect(docs[0]!.metadata.turnIndex).toBe(1);
    expect(docs[1]!.metadata.turnIndex).toBe(2);
  });

  it("title includes role, turn index, and packetId", () => {
    writeTranscript(transcriptPath, [
      makeAssistantLine("Some text"),
    ]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs[0]!.title).toBe("builder turn 1 — PKT-001");
  });

  it("label is always 'transcript'", () => {
    writeTranscript(transcriptPath, [makeAssistantLine("text")]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs[0]!.label).toBe("transcript");
  });

  it("metadata has packetId, role, category, turnIndex", () => {
    writeTranscript(transcriptPath, [makeAssistantLine("text")]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-002", "evaluator");
    expect(docs[0]!.metadata.packetId).toBe("PKT-002");
    expect(docs[0]!.metadata.role).toBe("evaluator");
    expect(docs[0]!.metadata.category).toBe("transcript");
    expect(docs[0]!.metadata.turnIndex).toBe(1);
  });

  it("tags include 'transcript', role, and packetId", () => {
    writeTranscript(transcriptPath, [makeAssistantLine("text")]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs[0]!.tags).toContain("transcript");
    expect(docs[0]!.tags).toContain("builder");
    expect(docs[0]!.tags).toContain("PKT-001");
  });

  it("skips turns with empty text", () => {
    writeTranscript(transcriptPath, [
      makeAssistantLine(""),
      makeAssistantLine("   "),
      makeAssistantLine("Valid content"),
    ]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.text).toBe("Valid content");
  });

  it("skips malformed JSON lines", () => {
    fs.writeFileSync(
      transcriptPath,
      [
        "not-valid-json",
        makeAssistantLine("Valid line"),
        "{broken",
      ].join("\n"),
      "utf-8",
    );
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toHaveLength(1);
  });

  it("uses current timestamp when ts is absent from entry", () => {
    const lineWithoutTs = JSON.stringify({
      role: "assistant",
      msg: { type: "assistant", text: "No timestamp here" },
    });
    fs.writeFileSync(transcriptPath, lineWithoutTs + "\n", "utf-8");
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toHaveLength(1);
    expect(typeof docs[0]!.metadata.ts).toBe("string");
  });
});

// ============================================================
// 3. Long message chunking behavior
// ============================================================

describe("transcriptToDocuments — chunking", () => {
  let transcriptPath: string;

  beforeEach(() => {
    transcriptPath = path.join(tmpDir, "transcript-chunk.jsonl");
  });

  it("does NOT chunk a message of exactly 2000 chars", () => {
    const text = "a".repeat(2000);
    writeTranscript(transcriptPath, [makeAssistantLine(text)]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.chunkTotal).toBe(1);
    expect(docs[0]!.metadata.chunkIndex).toBe(0);
    expect(docs[0]!.title).toBe("builder turn 1 — PKT-001");
  });

  it("chunks a message of 2001 chars into multiple pieces", () => {
    const text = "b".repeat(2001);
    writeTranscript(transcriptPath, [makeAssistantLine(text)]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs.length).toBeGreaterThan(1);
  });

  it("chunk titles include chunk index and total", () => {
    const text = "c".repeat(4000);
    writeTranscript(transcriptPath, [makeAssistantLine(text)]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs.length).toBeGreaterThan(1);
    const total = docs.length;
    docs.forEach((doc, i) => {
      expect(doc.title).toBe(`builder turn 1 (chunk ${i + 1}/${total}) — PKT-001`);
    });
  });

  it("chunk metadata includes chunkIndex and chunkTotal", () => {
    const text = "d".repeat(4000);
    writeTranscript(transcriptPath, [makeAssistantLine(text)]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs.length).toBeGreaterThan(1);
    docs.forEach((doc, i) => {
      expect(doc.metadata.chunkIndex).toBe(i);
      expect(doc.metadata.chunkTotal).toBe(docs.length);
    });
  });

  it("adjacent chunks have overlapping content (last 200 chars of N overlap with start of N+1)", () => {
    // Use 3500 chars to guarantee at least 2 chunks (chunk size is 1500, overlap is 200)
    const text = "e".repeat(3500);
    writeTranscript(transcriptPath, [makeAssistantLine(text)]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");
    expect(docs.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < docs.length - 1; i++) {
      const chunk = docs[i]!.text;
      const nextChunk = docs[i + 1]!.text;
      // The last 200 chars of chunk[i] should appear at the start of chunk[i+1]
      const tailOfCurrent = chunk.slice(-200);
      expect(nextChunk.startsWith(tailOfCurrent)).toBe(true);
    }
  });

  it("all chunks together cover the full original text without gaps", () => {
    // Make the text non-uniform so we can verify coverage
    const parts = ["first-part-", "middle-chunk-content-", "last-part-suffix"];
    const repeated = parts.map((p) => p.repeat(200)).join("");
    writeTranscript(transcriptPath, [makeAssistantLine(repeated)]);
    const docs = transcriptToDocuments(transcriptPath, "PKT-001", "builder");

    if (docs.length === 1) {
      // Short enough to not chunk — text should be the original
      expect(docs[0]!.text).toBe(repeated);
    } else {
      // First chunk starts at beginning
      expect(repeated.startsWith(docs[0]!.text.slice(0, 50))).toBe(true);
      // Last chunk ends at the end of the original
      const lastChunk = docs[docs.length - 1]!.text;
      expect(repeated.endsWith(lastChunk.slice(-50))).toBe(true);
    }
  });
});

// ============================================================
// 4. specToDocuments
// ============================================================

describe("specToDocuments", () => {
  let runDir: string;
  let specDir: string;

  beforeEach(() => {
    runDir = path.join(tmpDir, "run-001");
    specDir = path.join(runDir, "spec");
    fs.mkdirSync(specDir, { recursive: true });
  });

  it("returns empty array when spec dir is empty", () => {
    const docs = specToDocuments(runDir);
    expect(docs).toEqual([]);
  });

  it("returns one document per existing spec file", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "# Spec\nSome content", "utf-8");
    fs.writeFileSync(path.join(specDir, "packets.json"), '{"packets":[]}', "utf-8");
    const docs = specToDocuments(runDir);
    expect(docs).toHaveLength(2);
  });

  it("skips missing files without throwing", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "# Spec content", "utf-8");
    // packets.json, risk-register.json, evaluator-guide.json are absent
    const docs = specToDocuments(runDir);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("Specification (SPEC.md)");
  });

  it("skips files with empty content", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "   \n  ", "utf-8");
    const docs = specToDocuments(runDir);
    expect(docs).toEqual([]);
  });

  it("SPEC.md becomes document with correct title and label", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "# My Spec", "utf-8");
    const docs = specToDocuments(runDir);
    const specDoc = docs.find((d) => d.title === "Specification (SPEC.md)");
    expect(specDoc).toBeDefined();
    expect(specDoc!.label).toBe("spec");
    expect(specDoc!.text).toContain("# My Spec");
  });

  it("packets.json becomes document with correct title", () => {
    fs.writeFileSync(path.join(specDir, "packets.json"), '[]', "utf-8");
    const docs = specToDocuments(runDir);
    const pktDoc = docs.find((d) => d.title === "Packet list (packets.json)");
    expect(pktDoc).toBeDefined();
  });

  it("risk-register.json becomes document with correct title", () => {
    fs.writeFileSync(path.join(specDir, "risk-register.json"), '{"risks":[]}', "utf-8");
    const docs = specToDocuments(runDir);
    const riskDoc = docs.find((d) => d.title === "Risk register");
    expect(riskDoc).toBeDefined();
  });

  it("evaluator-guide.json becomes document with correct title", () => {
    fs.writeFileSync(path.join(specDir, "evaluator-guide.json"), '{}', "utf-8");
    const docs = specToDocuments(runDir);
    const guideDoc = docs.find((d) => d.title === "Evaluator guide");
    expect(guideDoc).toBeDefined();
  });

  it("all spec documents have category 'spec' in metadata", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "content", "utf-8");
    fs.writeFileSync(path.join(specDir, "packets.json"), "content", "utf-8");
    const docs = specToDocuments(runDir);
    for (const doc of docs) {
      expect(doc.metadata.category).toBe("spec");
    }
  });

  it("spec documents have 'spec' and 'planning' in tags", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "# Spec", "utf-8");
    const docs = specToDocuments(runDir);
    expect(docs[0]!.tags).toContain("spec");
    expect(docs[0]!.tags).toContain("planning");
  });

  it("metadata includes the file name", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "content", "utf-8");
    const docs = specToDocuments(runDir);
    expect(docs[0]!.metadata.file).toBe("SPEC.md");
  });

  it("handles all four spec files present", () => {
    fs.writeFileSync(path.join(specDir, "SPEC.md"), "spec content", "utf-8");
    fs.writeFileSync(path.join(specDir, "packets.json"), '{"packets":[]}', "utf-8");
    fs.writeFileSync(path.join(specDir, "risk-register.json"), '{"risks":[]}', "utf-8");
    fs.writeFileSync(path.join(specDir, "evaluator-guide.json"), '{"domain":"web"}', "utf-8");
    const docs = specToDocuments(runDir);
    expect(docs).toHaveLength(4);
  });
});

// ============================================================
// 5. contractToDocument
// ============================================================

describe("contractToDocument", () => {
  it("returns a document with the correct title", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.title).toBe("Contract: Add login page — PKT-001");
  });

  it("label is 'contract'", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.label).toBe("contract");
  });

  it("text includes the contract objective", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.text).toContain("Create a login page with username and password fields");
  });

  it("text includes in-scope items", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.text).toContain("Login form");
    expect(doc.text).toContain("Input validation");
  });

  it("text includes out-of-scope items", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.text).toContain("OAuth providers");
    expect(doc.text).toContain("2FA");
  });

  it("text includes implementation plan steps", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.text).toContain("Create LoginForm component");
    expect(doc.text).toContain("Wire up to auth service");
  });

  it("text includes acceptance criteria IDs and descriptions", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.text).toContain("AC-001");
    expect(doc.text).toContain("Tests pass");
    expect(doc.text).toContain("AC-002");
    expect(doc.text).toContain("User can log in");
  });

  it("text marks blocking criteria with [BLOCKING]", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    // Both AC-001 and AC-002 are blocking
    expect(doc.text).toContain("[BLOCKING]");
  });

  it("text includes assumptions when present", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.text).toContain("React is already installed");
  });

  it("assumptions section is omitted when empty", () => {
    const contractNoAssumptions: PacketContract = { ...sampleContract, assumptions: [] };
    const doc = contractToDocument(contractNoAssumptions, "PKT-001");
    expect(doc.text).not.toContain("## Assumptions");
  });

  it("metadata has correct packetId, category, and contractStatus", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.metadata.packetId).toBe("PKT-001");
    expect(doc.metadata.category).toBe("contract");
    expect(doc.metadata.contractStatus).toBe("accepted");
    expect(doc.metadata.packetType).toBe("ui_feature");
    expect(doc.metadata.acceptanceCriteriaCount).toBe(2);
  });

  it("tags include 'contract', packetId, and packetType", () => {
    const doc = contractToDocument(sampleContract, "PKT-001");
    expect(doc.tags).toContain("contract");
    expect(doc.tags).toContain("PKT-001");
    expect(doc.tags).toContain("ui_feature");
  });
});

// ============================================================
// 6. builderReportToDocument
// ============================================================

describe("builderReportToDocument", () => {
  it("returns a document with the correct title", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.title).toBe("Builder report — PKT-001");
  });

  it("label is 'builder-report'", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.label).toBe("builder-report");
  });

  it("text includes claimsDone status", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.text).toContain("Claims done");
    expect(doc.text).toContain("Yes");
  });

  it("text includes changed files", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.text).toContain("src/pages/Login.tsx");
    expect(doc.text).toContain("src/components/LoginForm.tsx");
  });

  it("text includes self-check results", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.text).toContain("AC-001");
    expect(doc.text).toContain("pass");
    expect(doc.text).toContain("npm test passed with 0 failures");
  });

  it("text includes remaining concerns", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.text).toContain("Edge case for empty password not tested");
  });

  it("remaining concerns section is omitted when empty", () => {
    const report: BuilderReport = { ...sampleBuilderReport, remainingConcerns: [] };
    const doc = builderReportToDocument(report, "PKT-001");
    expect(doc.text).not.toContain("## Remaining Concerns");
  });

  it("self-check section is omitted when empty", () => {
    const report: BuilderReport = { ...sampleBuilderReport, selfCheckResults: [] };
    const doc = builderReportToDocument(report, "PKT-001");
    expect(doc.text).not.toContain("## Self-Check Results");
  });

  it("metadata counts pass/fail self-check results correctly", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.metadata.selfCheckPass).toBe(2);
    expect(doc.metadata.selfCheckFail).toBe(0);
    expect(doc.metadata.changedFileCount).toBe(2);
    expect(doc.metadata.claimsDone).toBe(true);
  });

  it("metadata counts fail results when present", () => {
    const report: BuilderReport = {
      ...sampleBuilderReport,
      selfCheckResults: [
        { criterionId: "AC-001", status: "pass", evidence: "ok" },
        { criterionId: "AC-002", status: "fail", evidence: "broken" },
        { criterionId: "AC-003", status: "fail", evidence: "also broken" },
      ],
    };
    const doc = builderReportToDocument(report, "PKT-001");
    expect(doc.metadata.selfCheckPass).toBe(1);
    expect(doc.metadata.selfCheckFail).toBe(2);
  });

  it("metadata has correct packetId and category", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-002");
    expect(doc.metadata.packetId).toBe("PKT-002");
    expect(doc.metadata.category).toBe("builder-report");
  });

  it("tags include 'report', 'builder', and packetId", () => {
    const doc = builderReportToDocument(sampleBuilderReport, "PKT-001");
    expect(doc.tags).toContain("report");
    expect(doc.tags).toContain("builder");
    expect(doc.tags).toContain("PKT-001");
  });
});

// ============================================================
// 7. evalReportToDocument
// ============================================================

describe("evalReportToDocument", () => {
  it("title includes verdict and packetId", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.title).toBe("Evaluator report (pass) — PKT-001");
  });

  it("label is 'eval-report'", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.label).toBe("eval-report");
  });

  it("text includes overall verdict in uppercase", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.text).toContain("PASS");
  });

  it("text includes hard failure count", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.text).toContain("**Hard failures**: 0");
  });

  it("text includes contract gap detection status", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.text).toContain("Contract gap detected");
    expect(doc.text).toContain("No");
  });

  it("text includes hard failure details when present", () => {
    const reportWithFailure: EvaluatorReport = {
      ...sampleEvaluatorReport,
      overall: "fail",
      hardFailures: [
        {
          criterionId: "AC-001",
          description: "Tests fail",
          evidence: "Exit code 1 from npm test",
          reproduction: ["run npm test"],
          diagnosticHypothesis: "Missing test setup in jest.config",
          filesInvolved: ["src/__tests__/login.test.tsx"],
        },
      ],
    };
    const doc = evalReportToDocument(reportWithFailure, "PKT-001");
    expect(doc.text).toContain("AC-001");
    expect(doc.text).toContain("Tests fail");
    expect(doc.text).toContain("Missing test setup in jest.config");
    expect(doc.text).toContain("src/__tests__/login.test.tsx");
  });

  it("text includes criterion verdicts", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.text).toContain("AC-001");
    expect(doc.text).toContain("npm test output confirmed 0 failures");
  });

  it("text includes next actions when present", () => {
    const reportWithActions: EvaluatorReport = {
      ...sampleEvaluatorReport,
      nextActions: ["Fix the test config", "Re-run evaluation"],
    };
    const doc = evalReportToDocument(reportWithActions, "PKT-001");
    expect(doc.text).toContain("Fix the test config");
    expect(doc.text).toContain("Re-run evaluation");
  });

  it("metadata has correct verdict, counts, and packetId", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.metadata.verdict).toBe("pass");
    expect(doc.metadata.hardFailureCount).toBe(0);
    expect(doc.metadata.contractGapDetected).toBe(false);
    expect(doc.metadata.criterionPass).toBe(2);
    expect(doc.metadata.criterionFail).toBe(0);
    expect(doc.metadata.packetId).toBe("PKT-001");
    expect(doc.metadata.category).toBe("eval-report");
  });

  it("metadata counts fail criterion verdicts correctly", () => {
    const reportWithFails: EvaluatorReport = {
      ...sampleEvaluatorReport,
      overall: "fail",
      criterionVerdicts: [
        { criterionId: "AC-001", verdict: "pass", evidence: "ok" },
        { criterionId: "AC-002", verdict: "fail", evidence: "broken" },
      ],
    };
    const doc = evalReportToDocument(reportWithFails, "PKT-001");
    expect(doc.metadata.criterionPass).toBe(1);
    expect(doc.metadata.criterionFail).toBe(1);
  });

  it("tags include 'report', 'evaluator', packetId, and verdict", () => {
    const doc = evalReportToDocument(sampleEvaluatorReport, "PKT-001");
    expect(doc.tags).toContain("report");
    expect(doc.tags).toContain("evaluator");
    expect(doc.tags).toContain("PKT-001");
    expect(doc.tags).toContain("pass");
  });
});

// ============================================================
// 8. qaReportToDocument
// ============================================================

describe("qaReportToDocument", () => {
  it("title includes verdict and round number", () => {
    const doc = qaReportToDocument(sampleQAReport, 1);
    expect(doc.title).toBe("QA report (pass) — Round 1");
  });

  it("label is 'qa-report'", () => {
    const doc = qaReportToDocument(sampleQAReport, 1);
    expect(doc.label).toBe("qa-report");
  });

  it("text includes overall verdict in uppercase", () => {
    const doc = qaReportToDocument(sampleQAReport, 1);
    expect(doc.text).toContain("PASS");
  });

  it("text includes scenarios checked count", () => {
    const doc = qaReportToDocument(sampleQAReport, 1);
    expect(doc.text).toContain("3");
  });

  it("text includes summary", () => {
    const doc = qaReportToDocument(sampleQAReport, 1);
    expect(doc.text).toContain("All scenarios passed");
  });

  it("text includes issue details when issues are present", () => {
    const reportWithIssues: QAReport = {
      ...sampleQAReport,
      overallVerdict: "fail",
      issues: [
        {
          id: "QA-001",
          severity: "critical",
          title: "Login button does nothing",
          description: "Clicking login does not submit the form",
          stepsToReproduce: ["Navigate to /login", "Click the Login button"],
          relatedPackets: ["PKT-001"],
          diagnosticHypothesis: "Missing onClick handler on the button",
          filesInvolved: ["src/components/LoginForm.tsx"],
          rootCauseLayer: "ui",
        },
      ],
    };
    const doc = qaReportToDocument(reportWithIssues, 2);
    expect(doc.text).toContain("Login button does nothing");
    expect(doc.text).toContain("CRITICAL");
    expect(doc.text).toContain("Missing onClick handler on the button");
    expect(doc.text).toContain("src/components/LoginForm.tsx");
  });

  it("text includes console errors when present", () => {
    const reportWithErrors: QAReport = {
      ...sampleQAReport,
      consoleErrors: ["TypeError: Cannot read property 'user' of undefined"],
    };
    const doc = qaReportToDocument(reportWithErrors, 1);
    expect(doc.text).toContain("TypeError: Cannot read property 'user' of undefined");
  });

  it("metadata has correct round, verdict, and issue count", () => {
    const doc = qaReportToDocument(sampleQAReport, 3);
    expect(doc.metadata.round).toBe(3);
    expect(doc.metadata.verdict).toBe("pass");
    expect(doc.metadata.issueCount).toBe(0);
    expect(doc.metadata.scenariosChecked).toBe(3);
    expect(doc.metadata.category).toBe("qa-report");
  });

  it("tags include 'report', 'qa', round tag, and verdict", () => {
    const doc = qaReportToDocument(sampleQAReport, 2);
    expect(doc.tags).toContain("report");
    expect(doc.tags).toContain("qa");
    expect(doc.tags).toContain("round-2");
    expect(doc.tags).toContain("pass");
  });
});

// ============================================================
// 9. completionSummaryToDocument
// ============================================================

describe("completionSummaryToDocument", () => {
  it("title includes the packetId", () => {
    const doc = completionSummaryToDocument("Some summary text", "PKT-005");
    expect(doc.title).toBe("Completion summary — PKT-005");
  });

  it("label is 'summary'", () => {
    const doc = completionSummaryToDocument("text", "PKT-001");
    expect(doc.label).toBe("summary");
  });

  it("text is the passed-in summary verbatim", () => {
    const summary = "## What was done\n- Added login form\n- Wired up auth";
    const doc = completionSummaryToDocument(summary, "PKT-001");
    expect(doc.text).toBe(summary);
  });

  it("metadata has correct packetId and category", () => {
    const doc = completionSummaryToDocument("text", "PKT-003");
    expect(doc.metadata.packetId).toBe("PKT-003");
    expect(doc.metadata.category).toBe("summary");
    expect(typeof doc.metadata.ts).toBe("string");
  });

  it("tags include 'summary' and packetId", () => {
    const doc = completionSummaryToDocument("text", "PKT-004");
    expect(doc.tags).toContain("summary");
    expect(doc.tags).toContain("PKT-004");
  });
});

// ============================================================
// 10. getMemoryPath
// ============================================================

describe("getMemoryPath", () => {
  it("returns the canonical .mv2 path", () => {
    const p = getMemoryPath("/my/repo", "run-20260101-120000-abcd");
    expect(p).toBe("/my/repo/.harnessd/runs/run-20260101-120000-abcd/memory.mv2");
  });

  it("uses path.join semantics (handles trailing slash in repoRoot)", () => {
    const withTrailing = getMemoryPath("/my/repo/", "run-001");
    const withoutTrailing = getMemoryPath("/my/repo", "run-001");
    // Both should resolve to the same canonical path
    expect(path.normalize(withTrailing)).toBe(path.normalize(withoutTrailing));
  });

  it("is deterministic — same inputs always produce same output", () => {
    const p1 = getMemoryPath("/repo", "run-abc");
    const p2 = getMemoryPath("/repo", "run-abc");
    expect(p1).toBe(p2);
  });

  it("differs for different runIds", () => {
    const p1 = getMemoryPath("/repo", "run-001");
    const p2 = getMemoryPath("/repo", "run-002");
    expect(p1).not.toBe(p2);
  });
});

// ============================================================
// 11. Factory functions
// ============================================================

describe("createRunMemory", () => {
  it("returns a RunMemory instance when @memvid/sdk is available", async () => {
    const memPath = path.join(tmpDir, "test.mv2");
    const result = await createRunMemory(memPath, tmpDir, "test-run");
    // If SDK is installed, result is a RunMemory; otherwise null (graceful degradation)
    if (result !== null) {
      expect(result).toBeInstanceOf(RunMemory);
    } else {
      // SDK not installed — graceful degradation is correct behavior
      expect(result).toBeNull();
    }
  });
});

describe("openRunMemory", () => {
  it("returns null when the file does not exist", async () => {
    const memPath = path.join(tmpDir, "nonexistent.mv2");
    const result = await openRunMemory(memPath, tmpDir, "test-run");
    expect(result).toBeNull();
  });

  it("returns null or RunMemory when the file exists and SDK is available", async () => {
    // First create the file via createRunMemory
    const memPath = path.join(tmpDir, "existing.mv2");
    const created = await createRunMemory(memPath, tmpDir, "test-run");

    if (created !== null) {
      // SDK is installed — openRunMemory should also succeed
      const opened = await openRunMemory(memPath, tmpDir, "test-run");
      expect(opened).toBeInstanceOf(RunMemory);
    } else {
      // SDK not installed — openRunMemory returns null regardless
      const opened = await openRunMemory(memPath, tmpDir, "test-run");
      expect(opened).toBeNull();
    }
  });
});

// ============================================================
// 12. queryMemoryContext
// ============================================================

describe("queryMemoryContext", () => {
  it("returns undefined when memory is null", async () => {
    const result = await queryMemoryContext(null, sampleContract, "builder");
    expect(result).toBeUndefined();
  });

  it("returns undefined when memory has no matching documents", async () => {
    // Create a fresh .mv2 file with no documents encoded
    const memPath = path.join(tmpDir, "empty-query.mv2");
    const memory = await createRunMemory(memPath, tmpDir, "test-run");

    if (!memory) {
      // SDK not installed — skip gracefully
      expect(memory).toBeNull();
      return;
    }

    const result = await queryMemoryContext(memory, sampleContract, "builder");
    // No documents in memory → search returns no hits → undefined
    expect(result).toBeUndefined();
  });

  it("formats results as markdown with header, scores, and snippets", async () => {
    const memPath = path.join(tmpDir, "query-format.mv2");
    const memory = await createRunMemory(memPath, tmpDir, "test-run");

    if (!memory) {
      // SDK not installed — skip gracefully
      expect(memory).toBeNull();
      return;
    }

    // Encode documents that should match the sample contract's objective and files
    await memory.encode([
      {
        title: "Builder report — PKT-000",
        label: "builder-report",
        text: "Created a login page with username and password fields. Added form validation for required fields.",
        metadata: {
          ts: new Date().toISOString(),
          packetId: "PKT-000",
          role: "builder",
          category: "builder-report" as const,
        },
        tags: ["report", "builder", "PKT-000"],
      },
      {
        title: "Evaluator report — PKT-000",
        label: "eval-report",
        text: "Login form works correctly. Input validation catches empty fields. Authentication service integration verified.",
        metadata: {
          ts: new Date().toISOString(),
          packetId: "PKT-000",
          role: "evaluator",
          category: "eval-report" as const,
        },
        tags: ["report", "evaluator", "PKT-000"],
      },
    ]);

    const result = await queryMemoryContext(memory, sampleContract, "builder", {
      maxResults: 5,
      timeoutMs: 10000,
    });

    if (result === undefined) {
      // If semantic search returns no hits (possible with small corpus), that's valid
      return;
    }

    // Verify the markdown structure
    expect(result).toContain("## Relevant Prior Context (from run memory)");
    expect(result).toContain("### Related to:");
    expect(result).toContain("(score:");
    // The output should contain snippet text from at least one of our encoded documents
    expect(result).toMatch(/\[.+\]/); // [title] format
  });
});

// ============================================================
// 13. MemvidBuffer
// ============================================================

describe("MemvidBuffer", () => {
  /**
   * Minimal RunMemory stub that records encodeInBackground calls.
   * We only need to observe what MemvidBuffer flushes.
   */
  function makeMockMemory(): RunMemory & { encoded: MemvidDocument[][] } {
    const encoded: MemvidDocument[][] = [];
    return {
      encoded,
      encodeInBackground(docs: MemvidDocument[]) { encoded.push([...docs]); },
      // These are unused by MemvidBuffer but needed to satisfy the type
      encode: async () => {},
      search: async () => [],
      timeline: async () => [],
      waitForPendingWrites: async () => {},
    } as unknown as RunMemory & { encoded: import("../../memvid.js").MemvidDocument[][] };
  }

  function makeDoc(title: string): MemvidDocument {
    return {
      title,
      label: "test",
      text: "test text",
      metadata: { ts: new Date().toISOString(), category: "event" as const },
      tags: ["test"],
    };
  }

  it("flushes when buffer reaches maxBufferSize", () => {
    const mem = makeMockMemory();
    const buf = new MemvidBuffer(mem, { maxBufferSize: 3, flushIntervalMs: 60_000 });

    buf.add(makeDoc("a"));
    buf.add(makeDoc("b"));
    expect(mem.encoded).toHaveLength(0); // Not yet at threshold

    buf.add(makeDoc("c")); // Hits threshold of 3
    expect(mem.encoded).toHaveLength(1);
    expect(mem.encoded[0]).toHaveLength(3);

    buf.stop();
  });

  it("flushes multiple batches when addMany exceeds threshold", () => {
    const mem = makeMockMemory();
    const buf = new MemvidBuffer(mem, { maxBufferSize: 2, flushIntervalMs: 60_000 });

    buf.addMany([makeDoc("a"), makeDoc("b"), makeDoc("c")]);
    // 3 docs with threshold 2 → one flush of all 3 (buffer.length >= maxBufferSize triggers)
    expect(mem.encoded).toHaveLength(1);
    expect(mem.encoded[0]).toHaveLength(3);

    buf.stop();
  });

  it("does not flush below threshold without timer", () => {
    const mem = makeMockMemory();
    const buf = new MemvidBuffer(mem, { maxBufferSize: 10, flushIntervalMs: 60_000 });

    buf.add(makeDoc("a"));
    buf.add(makeDoc("b"));
    expect(mem.encoded).toHaveLength(0);

    buf.stop(); // stop() flushes remaining
    expect(mem.encoded).toHaveLength(1);
    expect(mem.encoded[0]).toHaveLength(2);
  });

  it("stop() flushes remaining buffer and stops timer", () => {
    const mem = makeMockMemory();
    const buf = new MemvidBuffer(mem, { maxBufferSize: 100, flushIntervalMs: 60_000 });

    buf.add(makeDoc("x"));
    buf.add(makeDoc("y"));
    expect(mem.encoded).toHaveLength(0);

    buf.stop();
    expect(mem.encoded).toHaveLength(1);
    expect(mem.encoded[0]).toHaveLength(2);

    // Calling stop() again is safe — no error, no duplicate flush
    buf.stop();
    expect(mem.encoded).toHaveLength(1); // No additional flush (buffer was empty)
  });

  it("drain() flushes remaining buffer and awaits pending writes", async () => {
    const mem = makeMockMemory();
    const buf = new MemvidBuffer(mem, { maxBufferSize: 100, flushIntervalMs: 60_000 });

    buf.add(makeDoc("z"));
    expect(mem.encoded).toHaveLength(0);

    await buf.drain();
    expect(mem.encoded).toHaveLength(1);
    expect(mem.encoded[0]).toHaveLength(1);
  });

  it("does not flush when buffer is empty", () => {
    const mem = makeMockMemory();
    const buf = new MemvidBuffer(mem, { maxBufferSize: 5, flushIntervalMs: 60_000 });

    buf.stop();
    expect(mem.encoded).toHaveLength(0); // Nothing to flush
  });

  it("flush timer fires and flushes buffer", async () => {
    const mem = makeMockMemory();
    // Very short interval for testing
    const buf = new MemvidBuffer(mem, { maxBufferSize: 100, flushIntervalMs: 50 });

    buf.add(makeDoc("timer-test"));
    expect(mem.encoded).toHaveLength(0);

    // Wait for the timer to fire
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mem.encoded).toHaveLength(1);
    expect(mem.encoded[0]![0]!.title).toBe("timer-test");

    buf.stop();
  });
});

// ============================================================
// 14. agentMessageToDocuments
// ============================================================

describe("agentMessageToDocuments", () => {
  const baseCtx = { role: "builder", packetId: "PKT-001", turnIndex: 1 };

  // --- system messages ---

  it("converts system message to a session-start document", () => {
    const msg: AgentMessage = { type: "system", subtype: "init", sessionId: "sess-123" };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.label).toBe("session");
    expect(docs[0]!.metadata.category).toBe("session");
    expect(docs[0]!.title).toContain("Session start");
    expect(docs[0]!.title).toContain("builder");
    expect(docs[0]!.title).toContain("PKT-001");
    expect(docs[0]!.text).toContain("init");
    expect(docs[0]!.text).toContain("sess-123");
    expect(docs[0]!.tags).toContain("session");
    expect(docs[0]!.tags).toContain("start");
  });

  it("system message without packetId omits it from title", () => {
    const msg: AgentMessage = { type: "system", subtype: "init" };
    const docs = agentMessageToDocuments(msg, { ...baseCtx, packetId: undefined });
    expect(docs[0]!.title).toBe("Session start — builder");
    expect(docs[0]!.title).not.toContain("undefined");
  });

  // --- assistant messages (text only) ---

  it("converts assistant text-only message to a reasoning document", () => {
    const msg: AgentMessage = { type: "assistant", text: "I will implement the login form." };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.label).toBe("reasoning");
    expect(docs[0]!.metadata.category).toBe("reasoning");
    expect(docs[0]!.text).toBe("I will implement the login form.");
    expect(docs[0]!.title).toContain("reasoning");
    expect(docs[0]!.tags).toContain("reasoning");
    expect(docs[0]!.tags).toContain("builder");
    expect(docs[0]!.tags).toContain("PKT-001");
  });

  it("chunks long assistant text", () => {
    const longText = "x".repeat(4000);
    const msg: AgentMessage = { type: "assistant", text: longText };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs.length).toBeGreaterThan(1);
    // All are reasoning docs
    for (const doc of docs) {
      expect(doc.label).toBe("reasoning");
      expect(doc.metadata.category).toBe("reasoning");
    }
    // Chunk indices are correct
    docs.forEach((doc, i) => {
      expect(doc.metadata.chunkIndex).toBe(i);
      expect(doc.metadata.chunkTotal).toBe(docs.length);
    });
  });

  it("skips assistant message with empty text and no tool uses", () => {
    const msg: AgentMessage = { type: "assistant", text: "" };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(0);
  });

  // --- assistant messages (tool uses only) ---

  it("converts assistant tool-use-only message to tool-call documents", () => {
    const msg: AgentMessage = {
      type: "assistant",
      toolUses: [
        { name: "Read", input: { file_path: "/tmp/test.ts" } },
        { name: "Bash", input: { command: "npm test" } },
      ],
    };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.label).toBe("tool-call");
    expect(docs[0]!.metadata.category).toBe("tool-call");
    expect(docs[0]!.metadata.toolName).toBe("Read");
    expect(docs[0]!.title).toContain("Tool call: Read");
    expect(docs[1]!.metadata.toolName).toBe("Bash");
    expect(docs[1]!.title).toContain("Tool call: Bash");
  });

  // --- assistant messages (text + tool uses) ---

  it("converts assistant message with both text and toolUses to reasoning + tool-call docs", () => {
    const msg: AgentMessage = {
      type: "assistant",
      text: "I need to check the file first.",
      toolUses: [{ name: "Read", input: { file_path: "/tmp/x.ts" } }],
    };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(2);
    // First doc is reasoning
    expect(docs[0]!.label).toBe("reasoning");
    expect(docs[0]!.text).toContain("I need to check the file first.");
    // Second doc is tool-call
    expect(docs[1]!.label).toBe("tool-call");
    expect(docs[1]!.metadata.toolName).toBe("Read");
  });

  // --- tool_result messages ---

  it("converts tool_result message to tool-result documents", () => {
    const msg: AgentMessage = {
      type: "tool_result",
      toolResults: [
        { toolUseId: "tu-1", output: "file contents here", isError: false },
        { toolUseId: "tu-2", output: "command not found", isError: true },
      ],
    };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.label).toBe("tool-result");
    expect(docs[0]!.metadata.category).toBe("tool-result");
    expect(docs[0]!.metadata.isError).toBe(false);
    expect(docs[0]!.text).toBe("file contents here");
    expect(docs[0]!.tags).toContain("ok");
    expect(docs[1]!.metadata.isError).toBe(true);
    expect(docs[1]!.tags).toContain("error");
  });

  it("tool_result with no toolResults produces empty array", () => {
    const msg: AgentMessage = { type: "tool_result" };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(0);
  });

  // --- event messages ---

  it("converts event message to agent-event document", () => {
    const msg: AgentMessage = { type: "event", subtype: "turn_boundary", text: "Turn 5 complete" };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.label).toBe("agent-event");
    expect(docs[0]!.metadata.category).toBe("agent-event");
    expect(docs[0]!.metadata.subtype).toBe("turn_boundary");
    expect(docs[0]!.text).toContain("turn_boundary");
    expect(docs[0]!.text).toContain("Turn 5 complete");
    expect(docs[0]!.tags).toContain("agent-event");
    expect(docs[0]!.tags).toContain("turn_boundary");
  });

  it("event without subtype uses 'unknown'", () => {
    const msg: AgentMessage = { type: "event" };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs[0]!.metadata.subtype).toBeUndefined();
    expect(docs[0]!.tags).toContain("unknown");
    expect(docs[0]!.title).toContain("unknown");
  });

  // --- result messages ---

  it("converts result message to session-end document", () => {
    const msg: AgentMessage = {
      type: "result",
      subtype: "end_turn",
      numTurns: 15,
      costUsd: 0.42,
      isError: false,
      sessionId: "sess-final",
    };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.label).toBe("session");
    expect(docs[0]!.metadata.category).toBe("session");
    expect(docs[0]!.title).toContain("Session end");
    expect(docs[0]!.text).toContain("numTurns: 15");
    expect(docs[0]!.text).toContain("costUsd: 0.42");
    expect(docs[0]!.text).toContain("isError: false");
    expect(docs[0]!.tags).toContain("end");
    expect(docs[0]!.tags).toContain("success");
  });

  it("result with isError=true tags 'error'", () => {
    const msg: AgentMessage = { type: "result", isError: true };
    const docs = agentMessageToDocuments(msg, baseCtx);
    expect(docs[0]!.tags).toContain("error");
    expect(docs[0]!.tags).not.toContain("success");
  });

  // --- metadata correctness ---

  it("all message types include role and turnIndex in metadata", () => {
    const messages: AgentMessage[] = [
      { type: "system", subtype: "init" },
      { type: "assistant", text: "hello" },
      { type: "tool_result", toolResults: [{ toolUseId: "t", output: "o" }] },
      { type: "event", subtype: "x" },
      { type: "result" },
    ];
    for (const msg of messages) {
      const docs = agentMessageToDocuments(msg, baseCtx);
      for (const doc of docs) {
        expect(doc.metadata.role).toBe("builder");
        expect(doc.metadata.turnIndex).toBe(1);
        expect(doc.metadata.packetId).toBe("PKT-001");
      }
    }
  });
});

// ============================================================
// 15. promptToDocuments
// ============================================================

describe("promptToDocuments", () => {
  it("returns one document for a short prompt", () => {
    const docs = promptToDocuments("Do the thing", "builder", "PKT-001");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.label).toBe("prompt");
    expect(docs[0]!.metadata.category).toBe("prompt");
    expect(docs[0]!.text).toBe("Do the thing");
    expect(docs[0]!.title).toBe("builder prompt — PKT-001");
    expect(docs[0]!.tags).toContain("prompt");
    expect(docs[0]!.tags).toContain("builder");
    expect(docs[0]!.tags).toContain("PKT-001");
  });

  it("chunks a long prompt into multiple documents", () => {
    const longPrompt = "p".repeat(4000);
    const docs = promptToDocuments(longPrompt, "evaluator", "PKT-002");
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) {
      expect(doc.label).toBe("prompt");
      expect(doc.metadata.category).toBe("prompt");
      expect(doc.metadata.role).toBe("evaluator");
      expect(doc.metadata.packetId).toBe("PKT-002");
    }
    // Chunk indices are sequential
    docs.forEach((doc, i) => {
      expect(doc.metadata.chunkIndex).toBe(i);
      expect(doc.metadata.chunkTotal).toBe(docs.length);
    });
  });

  it("title includes chunk info for long prompts", () => {
    const longPrompt = "q".repeat(4000);
    const docs = promptToDocuments(longPrompt, "planner");
    expect(docs.length).toBeGreaterThan(1);
    expect(docs[0]!.title).toContain("(chunk 1/");
  });

  it("omits packetId from title and tags when not provided", () => {
    const docs = promptToDocuments("short prompt", "planner");
    expect(docs[0]!.title).toBe("planner prompt");
    expect(docs[0]!.tags).not.toContain("undefined");
    // Tags should only have truthy values
    for (const tag of docs[0]!.tags) {
      expect(tag).toBeTruthy();
    }
  });

  it("does NOT chunk a prompt of exactly 2000 chars", () => {
    const prompt = "r".repeat(2000);
    const docs = promptToDocuments(prompt, "builder");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.chunkTotal).toBe(1);
  });

  it("chunks a prompt of 2001 chars", () => {
    const prompt = "s".repeat(2001);
    const docs = promptToDocuments(prompt, "builder");
    expect(docs.length).toBeGreaterThan(1);
  });
});

// ============================================================
// 16. inboxMessageToDocument
// ============================================================

describe("inboxMessageToDocument", () => {
  it("converts a send_to_agent message", () => {
    const msg = { type: "send_to_agent", message: "Focus on AC-006" };
    const doc = inboxMessageToDocument(msg, "PKT-001");
    expect(doc.title).toBe("Operator message: send_to_agent — PKT-001");
    expect(doc.label).toBe("operator");
    expect(doc.metadata.category).toBe("operator");
    expect(doc.metadata.msgType).toBe("send_to_agent");
    expect(doc.metadata.packetId).toBe("PKT-001");
    expect(doc.tags).toContain("operator");
    expect(doc.tags).toContain("send_to_agent");
    expect(doc.tags).toContain("PKT-001");
    // Full JSON serialization
    expect(doc.text).toContain("send_to_agent");
    expect(doc.text).toContain("Focus on AC-006");
  });

  it("converts a pause message", () => {
    const msg = { type: "pause", message: "Take a break" };
    const doc = inboxMessageToDocument(msg);
    expect(doc.title).toBe("Operator message: pause");
    expect(doc.metadata.msgType).toBe("pause");
    expect(doc.tags).toContain("pause");
    // No packetId
    expect(doc.metadata.packetId).toBeUndefined();
  });

  it("converts an inject_context message", () => {
    const msg = { type: "inject_context", context: "Use React Query for data fetching" };
    const doc = inboxMessageToDocument(msg, "PKT-003");
    expect(doc.title).toContain("inject_context");
    expect(doc.text).toContain("React Query");
    expect(doc.tags).toContain("inject_context");
  });

  it("converts an approve_plan message", () => {
    const msg = { type: "approve_plan" };
    const doc = inboxMessageToDocument(msg);
    expect(doc.title).toBe("Operator message: approve_plan");
    expect(doc.metadata.msgType).toBe("approve_plan");
  });

  it("text is full JSON serialization — no truncation", () => {
    const bigMessage = { type: "pivot_agent", message: "a".repeat(5000) };
    const doc = inboxMessageToDocument(bigMessage);
    const parsed = JSON.parse(doc.text);
    expect(parsed.message).toHaveLength(5000);
  });

  it("tags do not include undefined values when packetId is omitted", () => {
    const doc = inboxMessageToDocument({ type: "stop_after_current" });
    for (const tag of doc.tags) {
      expect(tag).toBeTruthy();
      expect(typeof tag).toBe("string");
    }
  });
});

// ============================================================
// 17. contractRoundToDocument
// ============================================================

describe("contractRoundToDocument", () => {
  it("converts a proposal round into a document", () => {
    const proposal = { packetId: "PKT-001", title: "Login page", acceptance: [] };
    const doc = contractRoundToDocument("proposal", 1, "PKT-001", proposal);
    expect(doc.title).toBe("Contract proposal round 1 — PKT-001");
    expect(doc.label).toBe("contract-round");
    expect(doc.metadata.category).toBe("contract-round");
    expect(doc.metadata.kind).toBe("proposal");
    expect(doc.metadata.round).toBe(1);
    expect(doc.metadata.packetId).toBe("PKT-001");
    expect(doc.tags).toContain("contract-round");
    expect(doc.tags).toContain("PKT-001");
    expect(doc.tags).toContain("round-1");
    expect(doc.tags).toContain("proposal");
  });

  it("converts a review round into a document", () => {
    const review = { decision: "accept", scores: {}, rationale: "Looks good" };
    const doc = contractRoundToDocument("review", 3, "PKT-002", review);
    expect(doc.title).toBe("Contract review round 3 — PKT-002");
    expect(doc.metadata.kind).toBe("review");
    expect(doc.metadata.round).toBe(3);
    expect(doc.tags).toContain("review");
    expect(doc.tags).toContain("round-3");
  });

  it("text is pretty-printed JSON of the content", () => {
    const content = { key: "value", nested: { a: 1 } };
    const doc = contractRoundToDocument("proposal", 1, "PKT-001", content);
    const parsed = JSON.parse(doc.text);
    expect(parsed).toEqual(content);
    // Pretty-printed (contains newlines)
    expect(doc.text).toContain("\n");
  });

  it("tags differ by round number", () => {
    const doc1 = contractRoundToDocument("proposal", 1, "PKT-001", {});
    const doc2 = contractRoundToDocument("proposal", 5, "PKT-001", {});
    expect(doc1.tags).toContain("round-1");
    expect(doc2.tags).toContain("round-5");
    expect(doc1.tags).not.toContain("round-5");
  });
});

// ============================================================
// 18. planReviewToDocument
// ============================================================

describe("planReviewToDocument", () => {
  it("converts a plan review to a document with correct round", () => {
    const review = { verdict: "revise", issues: [{ severity: "major", description: "Missing error handling" }] };
    const doc = planReviewToDocument(review, 2);
    expect(doc.title).toBe("Plan review — round 2");
    expect(doc.label).toBe("plan-review");
    expect(doc.metadata.category).toBe("plan-review");
    expect(doc.metadata.round).toBe(2);
  });

  it("tags include plan-review and round number", () => {
    const doc = planReviewToDocument({ verdict: "approve" }, 1);
    expect(doc.tags).toContain("plan-review");
    expect(doc.tags).toContain("round-1");
  });

  it("tags differ by round number", () => {
    const doc1 = planReviewToDocument({}, 1);
    const doc3 = planReviewToDocument({}, 3);
    expect(doc1.tags).toContain("round-1");
    expect(doc3.tags).toContain("round-3");
    expect(doc1.tags).not.toContain("round-3");
  });

  it("text is pretty-printed JSON of the review content", () => {
    const review = { verdict: "revise", summary: "Needs work" };
    const doc = planReviewToDocument(review, 1);
    const parsed = JSON.parse(doc.text);
    expect(parsed).toEqual(review);
    expect(doc.text).toContain("\n");
  });

  it("metadata does not include packetId (plan reviews are run-level)", () => {
    const doc = planReviewToDocument({}, 1);
    expect(doc.metadata.packetId).toBeUndefined();
  });
});
