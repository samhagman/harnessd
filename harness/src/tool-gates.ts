/**
 * Tool gates — automated checks that run between builder and evaluator phases.
 *
 * Gates are fast-fail filters that catch common builder failures (type errors,
 * test failures) without spending evaluator tokens. Each gate runs a shell
 * command in the workspace directory and parses the output.
 *
 * When a blocking gate fails, the orchestrator synthesizes an EvaluatorReport
 * with the failures and loops back to the builder — no evaluator session needed.
 *
 * Reference: research/harness-improvement-analysis/04-tooling-integration.md
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { EvaluatorReport, PacketType, ProjectConfig } from "./schemas.js";

// ------------------------------------
// Types
// ------------------------------------

export interface ToolGate {
  name: string;
  description: string;
  /** Shell command to run (in workspace dir) */
  command: string;
  /** Parse stdout/stderr into structured result */
  parseOutput: (stdout: string, stderr: string, exitCode: number) => ToolGateResult;
  /** If true, failure blocks evaluator from starting */
  blocking: boolean;
  /** Only run for these packet types (undefined = all) */
  packetTypes?: PacketType[];
  /** Max time in ms before the gate command is killed */
  timeoutMs: number;
}

export interface ToolGateResult {
  passed: boolean;
  summary: string;
  errors?: string[];
}

export interface GateRunResult {
  gate: string;
  passed: boolean;
  blocking: boolean;
  summary: string;
  errors: string[];
  durationMs: number;
  /** Whether the gate was skipped (e.g., no tsconfig found) */
  skipped: boolean;
  skipReason?: string;
}

// ------------------------------------
// Default gates
// ------------------------------------

/**
 * Detect whether a tsconfig.json exists in the workspace or a nearby subdirectory.
 * Returns the path to tsconfig.json if found, or null.
 */
export function detectTsConfig(workspaceDir: string): string | null {
  // Check workspace root first
  const rootConfig = path.join(workspaceDir, "tsconfig.json");
  if (fs.existsSync(rootConfig)) return rootConfig;

  // Check common subdirectories (monorepo patterns)
  for (const sub of ["src", "app", "packages"]) {
    const subConfig = path.join(workspaceDir, sub, "tsconfig.json");
    if (fs.existsSync(subConfig)) return subConfig;
  }

  return null;
}

/**
 * Parse TypeScript compiler output into structured errors.
 * TSC outputs errors in the format: file(line,col): error TSNNNN: message
 */
export function parseTscErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match tsc error format: path(line,col): error TSxxxx: message
    if (/\(\d+,\d+\):\s*error\s+TS\d+:/.test(trimmed)) {
      errors.push(trimmed);
    }
    // Also match simpler format: error TSxxxx: message
    else if (/^error\s+TS\d+:/.test(trimmed)) {
      errors.push(trimmed);
    }
  }

  return errors;
}

/**
 * Parse test runner output for failure counts.
 * Handles vitest and jest output formats.
 */
export function parseTestErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // vitest/jest failure lines: FAIL path/to/test.ts > suite > test name
    if (/^(FAIL|×|✗)\s+/.test(trimmed)) {
      errors.push(trimmed);
    }
    // vitest summary: Tests  X failed
    else if (/Tests?\s+\d+\s+failed/.test(trimmed)) {
      errors.push(trimmed);
    }
    // jest summary: Tests: X failed, Y passed
    else if (/Tests:\s+\d+\s+failed/.test(trimmed)) {
      errors.push(trimmed);
    }
    // vitest "AssertionError" or "Error:" lines inside failure blocks
    else if (/^(AssertionError|Error|TypeError|ReferenceError):/.test(trimmed)) {
      errors.push(trimmed);
    }
  }

  return errors;
}

/**
 * Detect the test runner and command for the workspace.
 * Returns the npm test command if a test script is found, null otherwise.
 */
export function detectTestCommand(workspaceDir: string): string | null {
  const pkgJsonPath = path.join(workspaceDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const scripts = pkgJson.scripts ?? {};

    // Check for test script
    if (scripts.test) {
      // Use npx vitest run directly if it's a vitest project (avoids interactive mode)
      if (typeof scripts.test === "string" && scripts.test.includes("vitest")) {
        return "npx vitest run";
      }
      return "npm test";
    }

    // Check for vitest in devDependencies even without test script
    const devDeps = pkgJson.devDependencies ?? {};
    if (devDeps.vitest) return "npx vitest run";

    // Check for jest
    if (devDeps.jest || devDeps["@jest/core"]) return "npx jest --ci";

    return null;
  } catch {
    return null;
  }
}

/** Build the default typecheck gate. */
export function makeTypecheckGate(): ToolGate {
  return {
    name: "typecheck",
    description: "TypeScript compilation succeeds with no errors",
    command: "npx tsc --noEmit",
    blocking: true,
    timeoutMs: 120_000, // 2 minutes
    parseOutput: (_stdout, stderr, exitCode) => {
      if (exitCode === 0) {
        return { passed: true, summary: "TypeScript compilation passed" };
      }

      const combined = _stdout + "\n" + stderr;
      const errors = parseTscErrors(combined);

      return {
        passed: false,
        summary: `TypeScript compilation failed with ${errors.length} error(s)`,
        errors: errors.length > 0 ? errors.slice(0, 30) : [combined.slice(0, 2000)],
      };
    },
  };
}

/** Build the default test gate. */
export function makeTestGate(workspaceDir: string): ToolGate {
  const testCmd = detectTestCommand(workspaceDir);

  return {
    name: "test",
    description: "Test suite passes",
    command: testCmd ?? "npm test",
    blocking: true,
    timeoutMs: 300_000, // 5 minutes
    parseOutput: (_stdout, stderr, exitCode) => {
      if (exitCode === 0) {
        return { passed: true, summary: "All tests passed" };
      }

      const combined = _stdout + "\n" + stderr;
      const errors = parseTestErrors(combined);

      return {
        passed: false,
        summary: `Tests failed (exit code ${exitCode})`,
        errors: errors.length > 0 ? errors.slice(0, 30) : [combined.slice(0, 2000)],
      };
    },
  };
}

// ------------------------------------
// Gate execution
// ------------------------------------

/**
 * Execute a single gate command in the workspace directory.
 * Returns a structured result with timing and error details.
 */
export function executeGate(
  gate: ToolGate,
  workspaceDir: string,
): GateRunResult {
  const start = Date.now();

  try {
    const result = execSync(gate.command, {
      cwd: workspaceDir,
      timeout: gate.timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    const parseResult = gate.parseOutput(result, "", 0);
    return {
      gate: gate.name,
      passed: parseResult.passed,
      blocking: gate.blocking,
      summary: parseResult.summary,
      errors: parseResult.errors ?? [],
      durationMs: Date.now() - start,
      skipped: false,
    };
  } catch (err: unknown) {
    // execSync throws on non-zero exit code or timeout
    const execError = err as { stdout?: string; stderr?: string; status?: number | null; signal?: string; killed?: boolean };

    // Detect timeout: execSync sets signal=SIGTERM on timeout, status=null
    if (execError.signal === "SIGTERM" || execError.killed) {
      return {
        gate: gate.name,
        passed: false,
        blocking: gate.blocking,
        summary: `Gate timed out after ${gate.timeoutMs}ms`,
        errors: [`Command killed after ${gate.timeoutMs}ms timeout: ${gate.command}`],
        durationMs: Date.now() - start,
        skipped: false,
      };
    }

    const stdout = execError.stdout ?? "";
    const stderr = execError.stderr ?? "";
    const exitCode = execError.status ?? 1;

    const parseResult = gate.parseOutput(stdout, stderr, exitCode);
    return {
      gate: gate.name,
      passed: parseResult.passed,
      blocking: gate.blocking,
      summary: parseResult.summary,
      errors: parseResult.errors ?? [],
      durationMs: Date.now() - start,
      skipped: false,
    };
  }
}

// ------------------------------------
// Main gate runner
// ------------------------------------

/**
 * Determine which default gates are applicable for a workspace and packet type.
 * Returns gates that should run (detection passed).
 */
export function resolveDefaultGates(
  workspaceDir: string,
  packetType: PacketType,
  config: ProjectConfig,
): { gates: ToolGate[]; skippedGates: GateRunResult[] } {
  const gates: ToolGate[] = [];
  const skippedGates: GateRunResult[] = [];

  if (!config.enableDefaultGates) {
    return { gates, skippedGates };
  }

  // TypeCheck gate — only if tsconfig.json is detected
  const tsConfig = detectTsConfig(workspaceDir);
  if (tsConfig) {
    gates.push(makeTypecheckGate());
  } else {
    skippedGates.push({
      gate: "typecheck",
      passed: true,
      blocking: true,
      summary: "Skipped: no tsconfig.json found",
      errors: [],
      durationMs: 0,
      skipped: true,
      skipReason: "No tsconfig.json detected in workspace",
    });
  }

  // Test gate — only if test runner is detected
  const testCmd = detectTestCommand(workspaceDir);
  if (testCmd) {
    gates.push(makeTestGate(workspaceDir));
  } else {
    skippedGates.push({
      gate: "test",
      passed: true,
      blocking: true,
      summary: "Skipped: no test runner detected",
      errors: [],
      durationMs: 0,
      skipped: true,
      skipReason: "No test script or test runner detected in workspace",
    });
  }

  return { gates, skippedGates };
}

/**
 * Resolve custom gates from project config.
 * These are user-defined gates that run in addition to defaults.
 */
export function resolveCustomGates(
  packetType: PacketType,
  config: ProjectConfig,
): ToolGate[] {
  return config.toolGates
    .filter((g) => !g.packetTypes || g.packetTypes.includes(packetType))
    .map((g) => ({
      name: g.name,
      description: `Custom gate: ${g.name}`,
      command: g.command,
      blocking: g.blocking,
      timeoutMs: 120_000,
      parseOutput: (_stdout: string, stderr: string, exitCode: number) => {
        if (exitCode === 0) {
          return { passed: true, summary: `${g.name} passed` };
        }
        const combined = (_stdout + "\n" + stderr).trim();
        return {
          passed: false,
          summary: `${g.name} failed (exit code ${exitCode})`,
          errors: combined ? [combined.slice(0, 2000)] : [`Exit code ${exitCode}`],
        };
      },
    }));
}

/**
 * Run all applicable tool gates for a workspace and packet type.
 *
 * Returns results for all gates (run + skipped). The orchestrator checks
 * for blocking failures and decides whether to skip the evaluator.
 */
export async function runToolGates(
  workspaceDir: string,
  packetType: PacketType,
  config: ProjectConfig,
): Promise<GateRunResult[]> {
  const { gates: defaultGates, skippedGates } = resolveDefaultGates(workspaceDir, packetType, config);
  const customGates = resolveCustomGates(packetType, config);

  const allGates = [...defaultGates, ...customGates];
  const results: GateRunResult[] = [...skippedGates];

  for (const gate of allGates) {
    console.log(`[gate] Running ${gate.name}: ${gate.command}`);
    const result = executeGate(gate, workspaceDir);
    console.log(`[gate] ${gate.name}: ${result.passed ? "PASSED" : "FAILED"} (${result.durationMs}ms)`);
    results.push(result);
  }

  return results;
}

// ------------------------------------
// Evaluator report synthesis
// ------------------------------------

/**
 * Synthesize an EvaluatorReport from gate failures.
 *
 * When blocking gates fail, the orchestrator uses this to create a fake
 * evaluator report that routes the packet back to the builder's fix loop.
 * This saves the cost of a full evaluator session.
 */
export function synthesizeEvalReportFromGates(
  packetId: string,
  gateResults: GateRunResult[],
): EvaluatorReport {
  const failures = gateResults.filter((g) => !g.passed && !g.skipped);

  const hardFailures = failures.map((f) => ({
    criterionId: `gate:${f.gate}`,
    description: f.summary,
    evidence: f.errors.join("\n"),
    reproduction: [f.gate === "typecheck" ? "npx tsc --noEmit" : f.gate === "test" ? "npm test" : f.gate],
  }));

  const nextActions = failures.map((f) => {
    if (f.gate === "typecheck") {
      return `Fix TypeScript compilation errors. Run \`npx tsc --noEmit\` and resolve all errors before claiming done.`;
    }
    if (f.gate === "test") {
      return `Fix failing tests. Run the test suite and ensure all tests pass before claiming done.`;
    }
    return `Fix ${f.gate} gate: ${f.summary}`;
  });

  return {
    packetId,
    sessionId: "gate-check",
    overall: "fail",
    hardFailures,
    rubricScores: [],
    criterionVerdicts: [],
    missingEvidence: [],
    nextActions,
    contractGapDetected: false,
  };
}

// ------------------------------------
// Formatting for prompt injection
// ------------------------------------

/**
 * Format gate results as a summary for injection into the evaluator prompt.
 * This tells the evaluator what automated checks already passed so it can
 * focus on behavioral and semantic verification.
 */
export function formatGateResultsForPrompt(gateResults: GateRunResult[]): string {
  if (gateResults.length === 0) return "";

  const lines = gateResults.map((g) => {
    if (g.skipped) {
      return `- **${g.gate}**: skipped (${g.skipReason ?? "not applicable"})`;
    }
    const status = g.passed ? "PASSED" : "FAILED";
    const timing = g.durationMs > 0 ? ` (${(g.durationMs / 1000).toFixed(1)}s)` : "";
    return `- **${g.gate}**: ${status}${timing}${g.passed ? "" : ` -- ${g.summary}`}`;
  });

  return lines.join("\n");
}
