/**
 * Unit tests for gate-check-tool.ts — the MCP gate_check tool.
 *
 * Strategy: vi.mock the tool-gates module so runToolGates never executes
 * real shell commands. Capture the tool handler from the SdkMcpToolDefinition
 * returned by tool() and invoke it directly.
 *
 * The SDK's tool() function returns a plain object:
 *   { name, description, inputSchema, handler, ... }
 *
 * createSdkMcpServer receives a tools array of these objects. We mock the
 * SDK to capture the tools array, then call handler() directly in tests.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";

// ------------------------------------
// Mocks — must be hoisted before imports
// ------------------------------------

// Capture tools passed to createSdkMcpServer so we can invoke handlers
let capturedTools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    createSdkMcpServer: (options: {
      name: string;
      version?: string;
      tools?: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    }) => {
      capturedTools = options.tools ?? [];
      return { type: "sdk", name: options.name, instance: {} };
    },
    tool: (
      name: string,
      description: string,
      inputSchema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => ({
      name,
      description,
      inputSchema,
      handler,
      annotations: undefined,
      _meta: undefined,
    }),
  };
});

vi.mock("../../tool-gates.js", () => ({
  runToolGates: vi.fn(),
}));

// ------------------------------------
// Imports (after mocks are hoisted)
// ------------------------------------

import { createGateCheckMcpServer } from "../../gate-check-tool.js";
import { runToolGates } from "../../tool-gates.js";
import { defaultProjectConfig } from "../../schemas.js";
import type { GateRunResult } from "../../tool-gates.js";

const mockRunToolGates = runToolGates as MockedFunction<typeof runToolGates>;

// ------------------------------------
// Helpers
// ------------------------------------

function makeGateResult(overrides: Partial<GateRunResult> = {}): GateRunResult {
  return {
    gate: "typecheck",
    passed: true,
    blocking: true,
    summary: "TypeScript compilation passed",
    errors: [],
    durationMs: 500,
    skipped: false,
    ...overrides,
  };
}

/**
 * Invoke the gate_check tool handler and parse the JSON result.
 * createGateCheckMcpServer populates capturedTools via the SDK mock.
 */
async function invokeGateCheck(): Promise<{ passed: boolean; results: GateRunResult[] }> {
  const tool = capturedTools.find((t) => t.name === "gate_check");
  if (!tool) throw new Error("gate_check tool not found in capturedTools");
  const result = await tool.handler({}) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as { passed: boolean; results: GateRunResult[] };
}

// ------------------------------------
// Tests
// ------------------------------------

describe("createGateCheckMcpServer", () => {
  const workspaceDir = "/fake/workspace";
  const config = defaultProjectConfig();

  beforeEach(() => {
    capturedTools = [];
    mockRunToolGates.mockReset();
  });

  it("returns an MCP server config with a gate_check tool", () => {
    mockRunToolGates.mockResolvedValue([]);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    expect(capturedTools).toHaveLength(1);
    expect(capturedTools[0]!.name).toBe("gate_check");
  });

  it("passes workspaceDir, packetType, and config to runToolGates", async () => {
    mockRunToolGates.mockResolvedValue([makeGateResult()]);
    createGateCheckMcpServer(workspaceDir, "bugfix", config);
    await invokeGateCheck();

    expect(mockRunToolGates).toHaveBeenCalledWith(workspaceDir, "bugfix", config);
  });

  it("returns { passed: true, results } when all gates pass", async () => {
    const passingResults: GateRunResult[] = [
      makeGateResult({ gate: "typecheck", passed: true, summary: "0 errors" }),
      makeGateResult({ gate: "test", passed: true, summary: "12/12 passed" }),
    ];
    mockRunToolGates.mockResolvedValue(passingResults);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const output = await invokeGateCheck();
    expect(output.passed).toBe(true);
    expect(output.results).toHaveLength(2);
    expect(output.results[0]!.gate).toBe("typecheck");
    expect(output.results[1]!.gate).toBe("test");
  });

  it("returns { passed: false } with full error details when a gate fails", async () => {
    const longError = "A".repeat(20_000); // larger than any truncation cap would allow
    const failingResults: GateRunResult[] = [
      makeGateResult({
        gate: "typecheck",
        passed: false,
        summary: "TypeScript compilation failed with 5 error(s)",
        errors: [longError],
      }),
    ];
    mockRunToolGates.mockResolvedValue(failingResults);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const output = await invokeGateCheck();
    expect(output.passed).toBe(false);
    expect(output.results[0]!.passed).toBe(false);
    // Errors must be passed through as-is — NO truncation
    expect(output.results[0]!.errors).toHaveLength(1);
    expect(output.results[0]!.errors[0]).toBe(longError);
    expect(output.results[0]!.errors[0]!.length).toBe(20_000);
  });

  it("returns { passed: false } when any gate fails even if others pass", async () => {
    const mixedResults: GateRunResult[] = [
      makeGateResult({ gate: "typecheck", passed: true }),
      makeGateResult({ gate: "test", passed: false, summary: "3 tests failed" }),
    ];
    mockRunToolGates.mockResolvedValue(mixedResults);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const output = await invokeGateCheck();
    expect(output.passed).toBe(false);
  });

  it("preserves skipped gates in output with skipped: true", async () => {
    const skippedResult: GateRunResult = {
      gate: "typecheck",
      passed: true, // skipped gates are "passing" from the overall perspective
      blocking: true,
      summary: "Skipped — no tsconfig.json found",
      errors: [],
      durationMs: 0,
      skipped: true,
      skipReason: "No tsconfig.json detected",
    };
    mockRunToolGates.mockResolvedValue([skippedResult]);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const output = await invokeGateCheck();
    expect(output.passed).toBe(true); // skipped counts as passing
    expect(output.results[0]!.skipped).toBe(true);
    expect(output.results[0]!.gate).toBe("typecheck");
  });

  it("returns { passed: true } when all gates are skipped", async () => {
    const allSkipped: GateRunResult[] = [
      { gate: "typecheck", passed: true, blocking: true, summary: "Skipped", errors: [], durationMs: 0, skipped: true },
      { gate: "test", passed: true, blocking: true, summary: "Skipped", errors: [], durationMs: 0, skipped: true },
    ];
    mockRunToolGates.mockResolvedValue(allSkipped);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const output = await invokeGateCheck();
    expect(output.passed).toBe(true);
  });

  it("includes durationMs and summary in each result", async () => {
    const result = makeGateResult({ gate: "typecheck", durationMs: 1234, summary: "No errors" });
    mockRunToolGates.mockResolvedValue([result]);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const output = await invokeGateCheck();
    expect(output.results[0]!.durationMs).toBe(1234);
    expect(output.results[0]!.summary).toBe("No errors");
  });

  it("returns valid JSON in the MCP text content", async () => {
    mockRunToolGates.mockResolvedValue([makeGateResult()]);
    createGateCheckMcpServer(workspaceDir, "tooling", config);

    const tool = capturedTools.find((t) => t.name === "gate_check")!;
    const raw = await tool.handler({}) as { content: Array<{ type: string; text: string }> };

    expect(raw.content).toHaveLength(1);
    expect(raw.content[0]!.type).toBe("text");
    expect(() => JSON.parse(raw.content[0]!.text)).not.toThrow();
  });
});
