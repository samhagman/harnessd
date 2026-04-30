#!/usr/bin/env npx tsx
/**
 * MCP stdio server exposing the `validate_envelope` tool.
 *
 * Codex agents that support MCP server registration use this instead of
 * validate-envelope-cli.mts, so they get inline validation feedback rather
 * than shelling out to a subprocess.
 *
 * Usage (launched by Codex via -c mcp_servers.<name>.command):
 *   tsx /abs/path/to/harness/bin/validate-envelope-mcp.mts
 *
 * Environment variables:
 *   HARNESSD_CRITERION_IDS          Comma-separated expected criterion IDs for
 *                                   EvaluatorReport cross-validation (optional).
 *   HARNESSD_STAGED_ENVELOPE_PATH   If set, persists validated envelope here so
 *                                   the orchestrator can recover it on delimiter failure.
 *
 * Each tool invocation is bounded to 30 seconds (Phase 3 nudge latency bound).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TOOL_TIMEOUT_MS,
  withTimeout,
  SCHEMAS,
  SCHEMA_SOURCE_PATH,
  SCHEMA_SOURCE_CONTENTS,
  SCHEMA_HINT,
  persistStagedEnvelope,
  validateEnvelopeBody,
} from "../src/mcp-server-helpers.js";

const expectedCriterionIds: string[] = (process.env.HARNESSD_CRITERION_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const server = new McpServer({
  name: "harnessd-validation",
  version: "1.0.0",
});

server.registerTool(
  "validate_envelope",
  {
    description:
      "Validate a JSON object against a harnessd schema before emitting it as your result envelope. " +
      "Call this with your proposed result JSON and the schema name. " +
      "Returns either {valid: true} or {valid: false, errors: [...]} so you can fix issues before emitting. " +
      "Available schemas: PacketContract, ContractReview, BuilderReport, EvaluatorReport, QAReport",
    inputSchema: {
      schema_name: z
        .enum(["PacketContract", "ContractReview", "BuilderReport", "EvaluatorReport", "QAReport"])
        .describe("Which schema to validate against"),
      json_string: z
        .string()
        .describe("The JSON string to validate (your proposed envelope payload)"),
    },
  },
  async ({ schema_name, json_string }) => {
    const handler = async () => {
      if (!SCHEMAS[schema_name]) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors: [`Unknown schema: ${schema_name}`] }) }],
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(json_string);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors: [`JSON parse error: ${msg}`] }) }],
        };
      }

      const errors = validateEnvelopeBody(schema_name, parsed, expectedCriterionIds);
      if (errors) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { valid: false, errors, schemaSourcePath: SCHEMA_SOURCE_PATH, schemaSource: SCHEMA_SOURCE_CONTENTS, hint: SCHEMA_HINT },
                null,
                2,
              ),
            },
          ],
        };
      }

      persistStagedEnvelope(schema_name, parsed);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ valid: true }) }],
      };
    };

    try {
      return await withTimeout(handler(), TOOL_TIMEOUT_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors: [`Tool error: ${msg}`] }) }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
