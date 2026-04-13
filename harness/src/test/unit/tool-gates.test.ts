/**
 * Unit tests for tool-gates.ts — automated checks between builder and evaluator.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  detectTsConfig,
  detectTestCommand,
  executeGate,
  makeTypecheckGate,
  makeTestGate,
  resolveDefaultGates,
  resolveCustomGates,
  runToolGates,
  synthesizeEvalReportFromGates,
  formatGateResultsForPrompt,
  type GateRunResult,
  type ToolGate,
} from "../../tool-gates.js";
import { defaultProjectConfig } from "../../schemas.js";

// ------------------------------------
// Temp directory management
// ------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnessd-gates-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------
// detectTsConfig
// ------------------------------------

describe("detectTsConfig", () => {
  it("returns path when tsconfig.json is at workspace root", () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const result = detectTsConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, "tsconfig.json"));
  });

  it("returns null when no tsconfig.json exists", () => {
    const result = detectTsConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("finds tsconfig.json in src/ subdirectory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "tsconfig.json"), "{}");
    const result = detectTsConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, "src", "tsconfig.json"));
  });
});

// ------------------------------------
// detectTestCommand
// ------------------------------------

describe("detectTestCommand", () => {
  it("returns null when no package.json exists", () => {
    const result = detectTestCommand(tmpDir);
    expect(result).toBeNull();
  });

  it("returns 'npm test' for generic test script", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "mocha" } }),
    );
    const result = detectTestCommand(tmpDir);
    expect(result).toBe("npm test");
  });

  it("returns 'npx vitest run --silent' when test script uses vitest", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const result = detectTestCommand(tmpDir);
    expect(result).toBe("npx vitest run --silent");
  });

  it("returns 'npx vitest run --silent' when vitest is in devDependencies but no test script", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
    );
    const result = detectTestCommand(tmpDir);
    expect(result).toBe("npx vitest run --silent");
  });

  it("returns 'npx jest --ci' when jest is in devDependencies", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { jest: "^29.0.0" } }),
    );
    const result = detectTestCommand(tmpDir);
    expect(result).toBe("npx jest --ci");
  });

  it("returns null when package.json has no test script or test runner", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
    );
    const result = detectTestCommand(tmpDir);
    expect(result).toBeNull();
  });
});

// ------------------------------------
// parseTscErrors
// ------------------------------------

// parseTscErrors and parseTestErrors were removed — agents get full raw output
// instead of brittle regex-parsed fragments. No parsing of external tool output.

// ------------------------------------
// executeGate
// ------------------------------------

describe("executeGate", () => {
  it("returns passed for a command that exits 0", () => {
    const gate: ToolGate = {
      name: "echo-test",
      description: "Test gate",
      command: "echo hello",
      blocking: true,
      timeoutMs: 5000,
      parseOutput: (stdout, _stderr, exitCode) => ({
        passed: exitCode === 0,
        summary: exitCode === 0 ? "passed" : "failed",
      }),
    };
    const result = executeGate(gate, tmpDir);
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("echo-test");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.skipped).toBe(false);
  });

  it("returns failed for a command that exits non-zero", () => {
    const gate: ToolGate = {
      name: "fail-test",
      description: "Test gate",
      command: "exit 1",
      blocking: true,
      timeoutMs: 5000,
      parseOutput: (_stdout, _stderr, exitCode) => ({
        passed: exitCode === 0,
        summary: `exit code ${exitCode}`,
        errors: [`Failed with exit code ${exitCode}`],
      }),
    };
    const result = executeGate(gate, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("captures stdout in parseOutput", () => {
    const gate: ToolGate = {
      name: "stdout-test",
      description: "Test gate",
      command: "echo captured-output",
      blocking: false,
      timeoutMs: 5000,
      parseOutput: (stdout, _stderr, exitCode) => ({
        passed: exitCode === 0,
        summary: stdout.trim(),
      }),
    };
    const result = executeGate(gate, tmpDir);
    expect(result.summary).toBe("captured-output");
  });

  it("handles timeout", () => {
    const gate: ToolGate = {
      name: "timeout-test",
      description: "Test gate",
      command: "sleep 60",
      blocking: true,
      timeoutMs: 200,
      parseOutput: (_stdout, _stderr, exitCode) => ({
        passed: exitCode === 0,
        summary: "should not reach here",
      }),
    };
    const result = executeGate(gate, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("timed out");
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });
});

// ------------------------------------
// resolveDefaultGates
// ------------------------------------

describe("resolveDefaultGates", () => {
  it("returns typecheck gate when tsconfig.json exists", () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const config = defaultProjectConfig();
    const { gates, skippedGates } = resolveDefaultGates(tmpDir, "ui_feature", config);
    const names = gates.map((g) => g.name);
    expect(names).toContain("typecheck");
    // test gate should be skipped (no package.json)
    const skippedNames = skippedGates.map((g) => g.gate);
    expect(skippedNames).toContain("test");
  });

  it("skips typecheck when no tsconfig.json", () => {
    const config = defaultProjectConfig();
    const { gates, skippedGates } = resolveDefaultGates(tmpDir, "bugfix", config);
    expect(gates.map((g) => g.name)).not.toContain("typecheck");
    expect(skippedGates.map((g) => g.gate)).toContain("typecheck");
  });

  it("returns test gate when package.json has test script", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const config = defaultProjectConfig();
    const { gates } = resolveDefaultGates(tmpDir, "bugfix", config);
    expect(gates.map((g) => g.name)).toContain("test");
  });

  it("returns empty when enableDefaultGates is false", () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const config = { ...defaultProjectConfig(), enableDefaultGates: false };
    const { gates, skippedGates } = resolveDefaultGates(tmpDir, "ui_feature", config);
    expect(gates).toHaveLength(0);
    expect(skippedGates).toHaveLength(0);
  });
});

// ------------------------------------
// resolveCustomGates
// ------------------------------------

describe("resolveCustomGates", () => {
  it("returns custom gates matching packet type", () => {
    const config = {
      ...defaultProjectConfig(),
      toolGates: [
        { name: "lint", command: "npx eslint .", blocking: false, packetTypes: ["ui_feature" as const] },
        { name: "build", command: "npm run build", blocking: true },
      ],
    };
    const gates = resolveCustomGates("ui_feature", config);
    expect(gates).toHaveLength(2);
    expect(gates.map((g) => g.name)).toContain("lint");
    expect(gates.map((g) => g.name)).toContain("build");
  });

  it("filters out gates not matching packet type", () => {
    const config = {
      ...defaultProjectConfig(),
      toolGates: [
        { name: "lint", command: "npx eslint .", blocking: false, packetTypes: ["ui_feature" as const] },
      ],
    };
    const gates = resolveCustomGates("bugfix", config);
    expect(gates).toHaveLength(0);
  });

  it("includes gates with no packetTypes restriction", () => {
    const config = {
      ...defaultProjectConfig(),
      toolGates: [
        { name: "build", command: "npm run build", blocking: true },
      ],
    };
    const gates = resolveCustomGates("refactor", config);
    expect(gates).toHaveLength(1);
  });
});

// ------------------------------------
// runToolGates
// ------------------------------------

describe("runToolGates", () => {
  it("runs detected gates and returns results", async () => {
    // Create a workspace with a "passing" typecheck (just echo)
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const config = { ...defaultProjectConfig(), enableDefaultGates: false };
    config.toolGates = [
      { name: "echo-gate", command: "echo ok", blocking: true },
    ];
    const results = await runToolGates(tmpDir, "ui_feature", config);
    const echoResult = results.find((r) => r.gate === "echo-gate");
    expect(echoResult).toBeDefined();
    expect(echoResult!.passed).toBe(true);
  });

  it("returns skipped results for undetected default gates", async () => {
    const config = defaultProjectConfig();
    const results = await runToolGates(tmpDir, "bugfix", config);
    // Both typecheck and test should be skipped
    const skipped = results.filter((r) => r.skipped);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });
});

// ------------------------------------
// synthesizeEvalReportFromGates
// ------------------------------------

describe("synthesizeEvalReportFromGates", () => {
  it("creates a fail report from gate failures", () => {
    const gateResults: GateRunResult[] = [
      {
        gate: "typecheck",
        passed: false,
        blocking: true,
        summary: "TypeScript compilation failed with 3 error(s)",
        errors: ["src/main.ts(1,1): error TS2345: Bad type"],
        durationMs: 1200,
        skipped: false,
      },
      {
        gate: "test",
        passed: true,
        blocking: true,
        summary: "All tests passed",
        errors: [],
        durationMs: 3000,
        skipped: false,
      },
    ];

    const report = synthesizeEvalReportFromGates("PKT-001", gateResults);
    expect(report.overall).toBe("fail");
    expect(report.packetId).toBe("PKT-001");
    expect(report.sessionId).toBe("gate-check");
    expect(report.hardFailures).toHaveLength(1);
    expect(report.hardFailures[0]!.criterionId).toBe("gate:typecheck");
    expect(report.nextActions.length).toBeGreaterThanOrEqual(1);
    expect(report.contractGapDetected).toBe(false);
  });

  it("includes multiple failures", () => {
    const gateResults: GateRunResult[] = [
      {
        gate: "typecheck",
        passed: false,
        blocking: true,
        summary: "TS errors",
        errors: ["error1"],
        durationMs: 100,
        skipped: false,
      },
      {
        gate: "test",
        passed: false,
        blocking: true,
        summary: "Test failures",
        errors: ["test error"],
        durationMs: 200,
        skipped: false,
      },
    ];

    const report = synthesizeEvalReportFromGates("PKT-002", gateResults);
    expect(report.hardFailures).toHaveLength(2);
    expect(report.nextActions).toHaveLength(2);
  });

  it("excludes skipped gates from failures", () => {
    const gateResults: GateRunResult[] = [
      {
        gate: "typecheck",
        passed: true,
        blocking: true,
        summary: "Skipped",
        errors: [],
        durationMs: 0,
        skipped: true,
        skipReason: "No tsconfig",
      },
    ];

    const report = synthesizeEvalReportFromGates("PKT-003", gateResults);
    expect(report.hardFailures).toHaveLength(0);
  });
});

// ------------------------------------
// formatGateResultsForPrompt
// ------------------------------------

describe("formatGateResultsForPrompt", () => {
  it("formats passed gates", () => {
    const results: GateRunResult[] = [
      {
        gate: "typecheck",
        passed: true,
        blocking: true,
        summary: "TypeScript compilation passed",
        errors: [],
        durationMs: 1500,
        skipped: false,
      },
    ];
    const formatted = formatGateResultsForPrompt(results);
    expect(formatted).toContain("typecheck");
    expect(formatted).toContain("PASSED");
    expect(formatted).toContain("1.5s");
  });

  it("formats failed gates", () => {
    const results: GateRunResult[] = [
      {
        gate: "test",
        passed: false,
        blocking: true,
        summary: "Tests failed (exit code 1)",
        errors: ["FAIL src/test.ts"],
        durationMs: 3000,
        skipped: false,
      },
    ];
    const formatted = formatGateResultsForPrompt(results);
    expect(formatted).toContain("test");
    expect(formatted).toContain("FAILED");
  });

  it("formats skipped gates", () => {
    const results: GateRunResult[] = [
      {
        gate: "typecheck",
        passed: true,
        blocking: true,
        summary: "Skipped",
        errors: [],
        durationMs: 0,
        skipped: true,
        skipReason: "No tsconfig.json detected",
      },
    ];
    const formatted = formatGateResultsForPrompt(results);
    expect(formatted).toContain("skipped");
    expect(formatted).toContain("No tsconfig.json");
  });

  it("returns empty string for no results", () => {
    const formatted = formatGateResultsForPrompt([]);
    expect(formatted).toBe("");
  });
});

// ------------------------------------
// makeTypecheckGate
// ------------------------------------

describe("makeTypecheckGate", () => {
  it("creates a gate with correct properties", () => {
    const gate = makeTypecheckGate();
    expect(gate.name).toBe("typecheck");
    expect(gate.command).toBe("npx tsc -b --noEmit");
    expect(gate.blocking).toBe(true);
  });

  it("parseOutput returns passed for exit code 0", () => {
    const gate = makeTypecheckGate();
    const result = gate.parseOutput("", "", 0);
    expect(result.passed).toBe(true);
  });

  it("parseOutput returns failed with full raw output for non-zero exit", () => {
    const gate = makeTypecheckGate();
    const output = "src/foo.ts(1,1): error TS2345: Bad type\nsrc/bar.ts(2,3): error TS2304: Not found";
    const result = gate.parseOutput(output, "", 1);
    expect(result.passed).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0]).toContain("TS2345");
    expect(result.errors![0]).toContain("TS2304");
  });
});

// ------------------------------------
// makeTestGate
// ------------------------------------

describe("makeTestGate", () => {
  it("uses detected test command with --silent flag for vitest", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const gate = makeTestGate(tmpDir);
    expect(gate.name).toBe("test");
    expect(gate.command).toBe("npx vitest run --silent");
    expect(gate.blocking).toBe(true);
  });

  it("falls back to npm test when no detection", () => {
    const gate = makeTestGate(tmpDir);
    expect(gate.command).toBe("npm test");
  });
});
