#!/usr/bin/env npx tsx
/**
 * MCP stdio server exposing the `gate_check` tool.
 *
 * This is the stdio-process counterpart to `createGateCheckMcpServer()` in
 * harness/src/gate-check-tool.ts. Codex agents that support MCP server
 * registration use this so they can run quality gates (typecheck + test)
 * from within their session and fix failures before emitting their result.
 *
 * Usage (launched by Codex via -c mcp_servers.<name>.command):
 *   tsx /abs/path/to/harness/bin/gate-check-mcp.mts
 *
 * Environment variables (all required):
 *   HARNESSD_WORKSPACE_DIR   Absolute path to the workspace the builder is working in.
 *   HARNESSD_PACKET_TYPE     The packet type being built (bugfix, ui_feature, etc.).
 *   HARNESSD_GATE_CONFIG     JSON blob matching the ProjectConfig shape (or subset thereof).
 *                            Parsed by ProjectConfigSchema.parse() — unknown keys are ignored.
 *                            Example:
 *                              HARNESSD_GATE_CONFIG='{"enableDefaultGates":true,"toolGates":[]}'
 *
 * Config design choice: JSON blob in an env var was chosen over a file path because:
 *   - The caller (codex-cli.ts) already has the ProjectConfig object in memory.
 *   - Serializing it inline avoids creating a temp file that must be cleaned up.
 *   - Codex -c mcp_servers.<name>.env.KEY=VALUE supports arbitrary values.
 *
 * Hard requirement: each tool invocation is bounded to 30 seconds.
 * This ensures that a SIGTERM arriving during an in-flight MCP call is
 * not delayed more than 30 s (Phase 3 nudge latency bound).
 *
 * Note: gate commands themselves (tsc, vitest) have their own timeouts
 * (120 s and 300 s respectively) which supersede the 30 s MCP timeout.
 * The 30 s MCP timeout only fires if the gate infrastructure itself hangs
 * before starting to run (e.g., a broken workspaceDir or a corrupted config).
 * In practice, gates that take longer than 30 s are protected by their own
 * timeoutMs and will return a structured failure rather than hanging forever.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectConfigSchema } from "../src/schemas.js";
import { runToolGates } from "../src/tool-gates.js";
import type { PacketType } from "../src/schemas.js";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function loadConfig() {
  const workspaceDir = process.env.HARNESSD_WORKSPACE_DIR;
  if (!workspaceDir) {
    throw new Error("HARNESSD_WORKSPACE_DIR is required but not set.");
  }

  const packetTypeRaw = process.env.HARNESSD_PACKET_TYPE;
  if (!packetTypeRaw) {
    throw new Error("HARNESSD_PACKET_TYPE is required but not set.");
  }

  const configRaw = process.env.HARNESSD_GATE_CONFIG ?? "{}";
  let configJson: unknown;
  try {
    configJson = JSON.parse(configRaw);
  } catch (err) {
    throw new Error(`HARNESSD_GATE_CONFIG is not valid JSON: ${err}`);
  }

  const config = ProjectConfigSchema.parse(configJson);

  return {
    workspaceDir,
    packetType: packetTypeRaw as PacketType,
    config,
  };
}

const { workspaceDir, packetType, config } = loadConfig();

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

const TOOL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool call timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "harnessd-gate-check",
  version: "1.0.0",
});

server.registerTool(
  "gate_check",
  {
    description:
      "Run all configured harness quality gates (typecheck + full test suite) and return pass/fail for each with full error output. " +
      "Always runs ALL gates — no filtering. Call this before emitting your result envelope to catch errors early.",
    inputSchema: {},
  },
  async () => {
    const handler = async () => {
      const results = await runToolGates(workspaceDir, packetType, config);
      const passed = results.every((r) => r.passed || r.skipped);
      const summary = results.map((r) => ({
        gate: r.gate,
        passed: r.passed,
        skipped: r.skipped ?? false,
        summary: r.summary,
        errors: r.errors,
        durationMs: r.durationMs,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ passed, results: summary }, null, 2),
          },
        ],
      };
    };

    try {
      return await withTimeout(handler(), TOOL_TIMEOUT_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ passed: false, error: `Gate check error: ${msg}` }),
          },
        ],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
