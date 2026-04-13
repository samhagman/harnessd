/**
 * MCP tool that agents can call to run all harness quality gates
 * (typecheck + full test suite) against their current code BEFORE emitting
 * the result envelope.
 *
 * This surfaces gate failures inline so the builder can fix them in the same
 * session, avoiding a wasted build→gate→fix→rebuild cycle.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

import type { PacketType, ProjectConfig } from "./schemas.js";
import { runToolGates } from "./tool-gates.js";

/**
 * Create an MCP server config with a `gate_check` tool.
 * Pass the returned config into the session's mcpServers option.
 *
 * @param workspaceDir  Absolute path to the workspace the builder is working in.
 * @param packetType    The packet type being built (used for gate filtering).
 * @param config        Project config (toolGates, enableDefaultGates, etc.).
 */
export function createGateCheckMcpServer(
  workspaceDir: string,
  packetType: PacketType,
  config: ProjectConfig,
) {
  return createSdkMcpServer({
    name: "harnessd-gate-check",
    version: "1.0.0",
    tools: [
      tool(
        "gate_check",
        "Run all configured harness quality gates (typecheck + full test suite) and return pass/fail for each with full error output. Always runs ALL gates — no filtering.",
        {},
        async () => {
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
            content: [{
              type: "text" as const,
              text: JSON.stringify({ passed, results: summary }, null, 2),
            }],
          };
        },
      ),
    ],
  });
}
