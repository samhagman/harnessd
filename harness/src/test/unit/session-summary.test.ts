import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { summarizeTranscript } from "../../session-summary.js";
import { SessionSummarySchema } from "../../schemas.js";

function writeTranscript(dir: string, lines: object[]): string {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function tsAt(seconds: number): string {
  return new Date(2026, 0, 1, 0, 0, seconds).toISOString();
}

describe("summarizeTranscript — basic counters", () => {
  it("counts assistant turns and tool calls by name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-"));
    const transcript = writeTranscript(tmp, [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
      {
        ts: tsAt(1),
        role: "builder",
        msg: {
          type: "assistant",
          text: "ok",
          raw: {
            message: {
              content: [
                { type: "tool_use", name: "Read", input: {} },
                { type: "tool_use", name: "Bash", input: {} },
                { type: "text", text: "ok" },
              ],
            },
          },
        },
      },
      {
        ts: tsAt(2),
        role: "builder",
        msg: {
          type: "assistant",
          text: "more",
          raw: {
            message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
          },
        },
      },
      { ts: tsAt(3), role: "builder", msg: { type: "result", subtype: "success", text: "" } },
    ]);

    const summary = summarizeTranscript(transcript, {
      sessionId: "s1",
      role: "builder",
      packetId: "PKT-1",
      runId: "test",
      startedAt: tsAt(0),
      endedAt: tsAt(3),
      envelopeOutcome: { found: true, source: "delimiters" },
    });

    expect(summary.turnCount).toBe(2);
    expect(summary.toolCallCount).toBe(3);
    expect(summary.toolCallsByName).toEqual({ Read: 2, Bash: 1 });
    expect(summary.lastToolCall).toBe("Read");
    expect(summary.lastAssistantTextSnippet).toBe("more");
    expect(summary.endReason).toBe("envelope_emitted");
  });
});

describe("summarizeTranscript — api_retry storm classification", () => {
  it("marks api_timeout_after_retries when 10 retries terminate without success", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-retry-"));
    const lines: object[] = [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
    ];
    for (let i = 1; i <= 10; i++) {
      lines.push({
        ts: tsAt(i * 60),
        role: "builder",
        msg: {
          type: "event",
          subtype: "api_retry",
          raw: { attempt: i, error: "unknown" },
        },
      });
    }
    lines.push({
      ts: tsAt(700),
      role: "builder",
      msg: {
        type: "result",
        subtype: "error_during_execution",
        text: "Request timed out",
        isError: true,
      },
    });
    const transcript = writeTranscript(tmp, lines);

    const summary = summarizeTranscript(transcript, {
      sessionId: "s1",
      role: "builder",
      packetId: "PKT-1",
      runId: "test",
      startedAt: tsAt(0),
      endedAt: tsAt(700),
      envelopeOutcome: { found: false, source: null },
    });

    expect(summary.apiRetries).toHaveLength(10);
    expect(summary.apiRetries[0].attempt).toBe(1);
    expect(summary.apiRetries[9].attempt).toBe(10);
    expect(summary.endReason).toBe("api_timeout_after_retries");
    expect(summary.envelope.found).toBe(false);
  });
});

describe("summarizeTranscript — compact_boundary capture", () => {
  it("captures pre/post tokens and duration from compact_boundary events", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-compact-"));
    const transcript = writeTranscript(tmp, [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
      {
        ts: tsAt(60),
        role: "builder",
        msg: {
          type: "event",
          subtype: "compact_boundary",
          raw: {
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 167906,
              post_tokens: 10500,
              duration_ms: 84313,
            },
          },
        },
      },
      { ts: tsAt(70), role: "builder", msg: { type: "result", subtype: "success" } },
    ]);

    const summary = summarizeTranscript(transcript, {
      sessionId: "s1",
      role: "builder",
      packetId: "PKT-1",
      runId: "test",
      startedAt: tsAt(0),
      endedAt: tsAt(70),
      envelopeOutcome: { found: true, source: "staged" },
    });

    expect(summary.compactBoundaries).toHaveLength(1);
    expect(summary.compactBoundaries[0].trigger).toBe("auto");
    expect(summary.compactBoundaries[0].preTokens).toBe(167906);
    expect(summary.compactBoundaries[0].postTokens).toBe(10500);
    expect(summary.compactBoundaries[0].durationMs).toBe(84313);
    expect(summary.endReason).toBe("envelope_emitted_via_staged_file");
  });

  it("marks compaction_pending when status:compacting has no following boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-compacting-"));
    const transcript = writeTranscript(tmp, [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
      {
        ts: tsAt(60),
        role: "builder",
        msg: { type: "event", subtype: "status", raw: { status: "compacting" } },
      },
    ]);

    const summary = summarizeTranscript(transcript, {
      sessionId: "s1",
      role: "builder",
      packetId: "PKT-1",
      runId: "test",
      startedAt: tsAt(0),
      // No endedAt → still alive
    });

    expect(summary.endReason).toBe("compaction_pending");
  });
});

describe("summarizeTranscript — envelope outcome routing", () => {
  it("routes endReason based on envelope source", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-env-"));
    const transcript = writeTranscript(tmp, [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
      { ts: tsAt(1), role: "builder", msg: { type: "result", subtype: "success" } },
    ]);

    const baseCtx = {
      sessionId: "s1",
      role: "builder" as const,
      packetId: "PKT-1",
      runId: "test",
      startedAt: tsAt(0),
      endedAt: tsAt(1),
    };

    const fromStaged = summarizeTranscript(transcript, {
      ...baseCtx,
      envelopeOutcome: { found: true, source: "staged" },
    });
    const fromDelim = summarizeTranscript(transcript, {
      ...baseCtx,
      envelopeOutcome: { found: true, source: "delimiters" },
    });
    const fromFence = summarizeTranscript(transcript, {
      ...baseCtx,
      envelopeOutcome: { found: true, source: "fence_fallback" },
    });
    const noEnv = summarizeTranscript(transcript, {
      ...baseCtx,
      envelopeOutcome: { found: false, source: null },
    });

    expect(fromStaged.endReason).toBe("envelope_emitted_via_staged_file");
    expect(fromDelim.endReason).toBe("envelope_emitted");
    expect(fromFence.endReason).toBe("envelope_emitted_via_fence_fallback");
    expect(fromFence.envelope.formatIssue).toBe("wrapped_in_markdown_fences_outer");
    expect(noEnv.endReason).toBe("session_crashed_no_envelope");
  });
});

describe("summarizeTranscript — gap analysis", () => {
  it("captures the longest gap between consecutive timestamps and the prior event", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-gap-"));
    const transcript = writeTranscript(tmp, [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
      { ts: tsAt(10), role: "builder", msg: { type: "assistant", text: "x" } },
      // Big gap (180s) after a tool_result
      { ts: tsAt(15), role: "builder", msg: { type: "tool_result" } },
      { ts: tsAt(195), role: "builder", msg: { type: "assistant", text: "back" } },
      { ts: tsAt(196), role: "builder", msg: { type: "result", subtype: "success" } },
    ]);

    const summary = summarizeTranscript(transcript, {
      sessionId: "s1",
      role: "builder",
      packetId: "PKT-1",
      runId: "test",
      startedAt: tsAt(0),
      endedAt: tsAt(196),
      envelopeOutcome: { found: true, source: "delimiters" },
    });

    expect(summary.longestGapMs).toBe(180_000);
    expect(summary.longestGapPriorEvent).toBe("tool_result");
  });
});

describe("summarizeTranscript — schema compliance", () => {
  it("output validates against SessionSummarySchema", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-valid-"));
    const transcript = writeTranscript(tmp, [
      { ts: tsAt(0), role: "builder", msg: { type: "system", subtype: "init" } },
      { ts: tsAt(1), role: "builder", msg: { type: "assistant", text: "hi" } },
      { ts: tsAt(2), role: "builder", msg: { type: "result", subtype: "success", numTurns: 1, costUsd: 0.5 } },
    ]);

    const summary = summarizeTranscript(transcript, {
      sessionId: "s1",
      role: "builder",
      packetId: "PKT-1",
      runId: "test",
      attempt: "fix-1/20",
      startedAt: tsAt(0),
      endedAt: tsAt(2),
      envelopeOutcome: { found: true, source: "staged" },
    });

    const parsed = SessionSummarySchema.safeParse(summary);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.attempt).toBe("fix-1/20");
      expect(parsed.data.costUsd).toBe(0.5);
      expect(parsed.data.numTurnsReportedBySdk).toBe(1);
    }
  });

  it("handles empty / non-existent transcripts gracefully", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssum-empty-"));
    const summary = summarizeTranscript(path.join(tmp, "missing.jsonl"), {
      sessionId: null,
      role: "builder",
      runId: "test",
      startedAt: tsAt(0),
    });

    expect(summary.turnCount).toBe(0);
    expect(summary.toolCallCount).toBe(0);
    expect(summary.endReason).toBe("still_running");
  });
});
