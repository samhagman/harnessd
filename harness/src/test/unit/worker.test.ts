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

  it("extracts only the first envelope if multiple exist", () => {
    const p1 = JSON.stringify({ role: "builder", payload: "first" });
    const p2 = JSON.stringify({ role: "evaluator", payload: "second" });
    const text = `${RESULT_START_SENTINEL}${p1}${RESULT_END_SENTINEL} gap ${RESULT_START_SENTINEL}${p2}${RESULT_END_SENTINEL}`;

    const result = extractEnvelope(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.payload).toBe("first");
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
