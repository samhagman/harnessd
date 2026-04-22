/**
 * Unit tests for worker.ts — envelope extraction and parsing.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  extractEnvelope,
  parseEnvelopePayload,
} from "../../worker.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../../schemas.js";

// ------------------------------------
// extractEnvelope
// ------------------------------------

describe("extractEnvelope", () => {
  it("extracts JSON from between valid sentinel markers", () => {
    const payload = JSON.stringify({ role: "builder", packetId: "PKT-001", payload: { done: true } });
    const text = `Some assistant text here...\n${RESULT_START_SENTINEL}\n${payload}\n${RESULT_END_SENTINEL}\nMore text.`;

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("builder");
    expect(parsed.packetId).toBe("PKT-001");
  });

  it("returns null when no markers present", () => {
    const text = "This is just regular text with no sentinel markers.";
    expect(extractEnvelope(text)).toBeNull();
  });

  it("returns null when only start marker present (partial markers)", () => {
    const text = `Some text ${RESULT_START_SENTINEL} {"data": "incomplete"} but no end marker`;
    expect(extractEnvelope(text)).toBeNull();
  });

  it("returns null when only end marker present", () => {
    const text = `No start marker here ${RESULT_END_SENTINEL}`;
    expect(extractEnvelope(text)).toBeNull();
  });

  it("handles envelope with extra whitespace", () => {
    const payload = JSON.stringify({ role: "evaluator" });
    const text = `${RESULT_START_SENTINEL}\n\n  ${payload}  \n\n${RESULT_END_SENTINEL}`;

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("evaluator");
  });

  it("returns the LAST complete envelope when two complete envelopes are present", () => {
    const p1 = JSON.stringify({ role: "builder", payload: "first" });
    const p2 = JSON.stringify({ role: "evaluator", payload: "second" });
    const text = `${RESULT_START_SENTINEL}${p1}${RESULT_END_SENTINEL} gap ${RESULT_START_SENTINEL}${p2}${RESULT_END_SENTINEL}`;

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.payload).toBe("second");
  });

  it("skips a truncated first envelope (no END) and returns the second complete envelope", () => {
    // Simulates an agent that hit a per-turn output limit mid-JSON, then retried.
    const partialJson = '{"role":"planner","packets":[{"id":"PKT-001","title":"incomplete';
    const completeJson = JSON.stringify({ role: "planner", packets: [{ id: "PKT-001", title: "Setup" }] });
    const text = [
      `${RESULT_START_SENTINEL}`,
      partialJson,
      // No END marker for the first envelope
      `The prior partial envelope must be discarded — restarting with a compact, complete envelope.`,
      `${RESULT_START_SENTINEL}`,
      completeJson,
      `${RESULT_END_SENTINEL}`,
    ].join("\n");

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("planner");
    expect(parsed.packets[0].title).toBe("Setup");
  });

  it("strips ```json fence from the selected (last) envelope", () => {
    const payload = JSON.stringify({ role: "builder", done: true });
    const fenced = "```json\n" + payload + "\n```";
    const text = `${RESULT_START_SENTINEL}\n${fenced}\n${RESULT_END_SENTINEL}`;

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("builder");
    expect(parsed.done).toBe(true);
  });

  it("strips fence from the last envelope when multiple envelopes are present", () => {
    const p1 = JSON.stringify({ role: "builder", attempt: 1 });
    const p2 = JSON.stringify({ role: "builder", attempt: 2 });
    const fenced2 = "```json\n" + p2 + "\n```";
    const text = [
      `${RESULT_START_SENTINEL}`,
      p1,
      `${RESULT_END_SENTINEL}`,
      `Some prose between attempts.`,
      `${RESULT_START_SENTINEL}`,
      fenced2,
      `${RESULT_END_SENTINEL}`,
    ].join("\n");

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.attempt).toBe(2);
  });

  it("returns null when only START is present with no END anywhere", () => {
    const text = `${RESULT_START_SENTINEL} {"data": "incomplete"}`;
    expect(extractEnvelope(text)).toBeNull();
  });
});

// ------------------------------------
// parseEnvelopePayload
// ------------------------------------

describe("parseEnvelopePayload", () => {
  it("parses valid JSON matching schema", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });
    const json = JSON.stringify({ name: "test", count: 42 });

    const result = parseEnvelopePayload(json, schema);
    expect(result.error).toBeNull();
    expect(result.payload).toEqual({ name: "test", count: 42 });
  });

  it("returns error for invalid JSON", () => {
    const schema = z.object({ name: z.string() });
    const result = parseEnvelopePayload("{invalid json!!!", schema);
    expect(result.payload).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe("");
  });

  it("returns error for valid JSON that does not match schema", () => {
    const schema = z.object({
      name: z.string(),
      required_field: z.number(),
    });
    const json = JSON.stringify({ name: "test" }); // missing required_field

    const result = parseEnvelopePayload(json, schema);
    expect(result.payload).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe("");
  });

  it("validates nested objects", () => {
    const schema = z.object({
      report: z.object({
        status: z.enum(["pass", "fail"]),
        count: z.number(),
      }),
    });

    const valid = JSON.stringify({ report: { status: "pass", count: 5 } });
    const validResult = parseEnvelopePayload(valid, schema);
    expect(validResult.error).toBeNull();
    expect(validResult.payload!.report.status).toBe("pass");

    const invalid = JSON.stringify({ report: { status: "unknown", count: 5 } });
    const invalidResult = parseEnvelopePayload(invalid, schema);
    expect(invalidResult.payload).toBeNull();
  });
});
