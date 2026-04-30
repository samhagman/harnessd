#!/usr/bin/env npx tsx
/**
 * MCP stdio server exposing the `gate_check` tool.
 *
 * Codex agents that support MCP server registration use this to run quality
 * gates (typecheck + test) from within their session and fix failures before
 * emitting their result.
 *
 * Usage (launched by Codex via -c mcp_servers.<name>.command):
 *   tsx /abs/path/to/harness/bin/gate-check-mcp.mts
 *
 * Environment variables (all required):
 *   HARNESSD_WORKSPACE_DIR   Absolute path to the workspace the builder is working in.
 *   HARNESSD_PACKET_TYPE     The packet type being built (bugfix, ui_feature, etc.).
 *   HARNESSD_GATE_CONFIG     JSON blob matching the ProjectConfig shape (or subset thereof).
 *                            Parsed by ProjectConfigSchema.parse() — unknown keys are ignored.
 *                            Example: HARNESSD_GATE_CONFIG='{"enableDefaultGates":true,"toolGates":[]}'
 *
 * Config design choice: JSON blob in an env var was chosen over a file path because the caller
 * (codex-cli.ts) already has the ProjectConfig object in memory, avoiding a temp file.
 *
 * Each tool invocation is bounded to 30 seconds (Phase 3 nudge latency bound).
 * Gate commands themselves (tsc: 120 s, vitest: 300 s) have their own timeouts that
 * supersede this; the 30 s limit only fires if the gate infrastructure hangs before starting.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectConfigSchema } from "../src/schemas.js";
import { runToolGates } from "../src/tool-gates.js";
import type { PacketType } from "../src/schemas.js";
import { TOOL_TIMEOUT_MS, withTimeout } from "../src/mcp-server-helpers.js";

function loadConfig() {
  const workspaceDir = process.env.HARNESSD_WORKSPACE_DIR;
  if (!workspaceDir) throw new Error("HARNESSD_WORKSPACE_DIR is required but not set.");

  const packetTypeRaw = process.env.HARNESSD_PACKET_TYPE;
  if (!packetTypeRaw) throw new Error("HARNESSD_PACKET_TYPE is required but not set.");

  const configRaw = process.env.HARNESSD_GATE_CONFIG ?? "{}";
  let configJson: unknown;
  try {
    configJson = JSON.parse(configRaw);
  } catch (err) {
    throw new Error(`HARNESSD_GATE_CONFIG is not valid JSON: ${err}`);
  }

  return {
    workspaceDir,
    packetType: packetTypeRaw as PacketType,
    config: ProjectConfigSchema.parse(configJson),
  };
}

const { workspaceDir, packetType, config } = loadConfig();

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
        content: [{ type: "text" as const, text: JSON.stringify({ passed, results: summary }, null, 2) }],
      };
    };

    try {
      return await withTimeout(handler(), TOOL_TIMEOUT_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ passed: false, error: `Gate check error: ${msg}` }) }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
