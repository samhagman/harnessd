#!/usr/bin/env npx tsx
/**
 * MCP stdio server exposing the `validate_envelope` tool.
 *
 * This is the MCP-server counterpart to validate-envelope-cli.mts.
 * Codex agents that support MCP server registration (Phase 2+) use this
 * instead of the CLI shim, so they get inline validation feedback rather than
 * having to shell out to a separate process.
 *
 * The tool schema and behavior mirror `createValidationMcpServer()` in
 * harness/src/validation-tool.ts exactly.
 *
 * Usage (launched by Codex via -c mcp_servers.<name>.command):
 *   tsx /abs/path/to/harness/bin/validate-envelope-mcp.mts
 *
 * Environment variables:
 *   HARNESSD_CRITERION_IDS  Comma-separated expected criterion IDs for
 *                           EvaluatorReport cross-validation (optional).
 *                           e.g. "AC-1,AC-2,AC-3"
 *
 * Hard requirement: each tool invocation is bounded to 30 seconds.
 * This ensures that a SIGTERM arriving during an in-flight MCP call is
 * not delayed more than 30 s (Phase 3 nudge latency bound).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  PacketContractSchema,
  ContractReviewSchema,
  BuilderReportSchema,
  EvaluatorReportSchema,
  QAReportSchema,
} from "../src/schemas.js";

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

const SCHEMAS: Record<string, z.ZodType<unknown>> = {
  PacketContract: PacketContractSchema as z.ZodType<unknown>,
  ContractReview: ContractReviewSchema as z.ZodType<unknown>,
  BuilderReport: BuilderReportSchema as z.ZodType<unknown>,
  EvaluatorReport: EvaluatorReportSchema as z.ZodType<unknown>,
  QAReport: QAReportSchema as z.ZodType<unknown>,
};

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

/** Criterion IDs injected at launch time for EvaluatorReport cross-validation. */
const expectedCriterionIds: string[] = (process.env.HARNESSD_CRITERION_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
      const schema = SCHEMAS[schema_name];
      if (!schema) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ valid: false, errors: [`Unknown schema: ${schema_name}`] }),
            },
          ],
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(json_string);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ valid: false, errors: [`JSON parse error: ${msg}`] }),
            },
          ],
        };
      }

      const result = schema.safeParse(parsed);

      if (!result.success) {
        const errors = result.error.issues.map((issue: z.ZodIssue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ valid: false, errors }, null, 2),
            },
          ],
        };
      }

      // Extra validation for EvaluatorReport: check criterion IDs match the contract
      if (schema_name === "EvaluatorReport" && expectedCriterionIds.length > 0) {
        const validIds = new Set(expectedCriterionIds);
        const verdicts = (parsed as { criterionVerdicts?: Array<{ criterionId: string }> }).criterionVerdicts ?? [];
        const badIds = verdicts
          .map((v) => v.criterionId)
          .filter((id) => !validIds.has(id));
        const missingIds = expectedCriterionIds.filter(
          (id) => !verdicts.some((v) => v.criterionId === id),
        );

        const warnings: string[] = [];
        if (badIds.length > 0) {
          warnings.push(
            `criterionVerdicts contains IDs not in the contract: ${badIds.join(", ")}. ` +
            `Valid IDs are: ${expectedCriterionIds.join(", ")}. ` +
            `Use the EXACT criterion IDs from the contract.`,
          );
        }
        if (missingIds.length > 0) {
          warnings.push(
            `Missing verdicts for: ${missingIds.join(", ")}. ` +
            `You must provide a verdict for every acceptance criterion.`,
          );
        }
        if (warnings.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ valid: false, errors: warnings }, null, 2),
              },
            ],
          };
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ valid: true }) }],
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
            text: JSON.stringify({ valid: false, errors: [`Tool error: ${msg}`] }),
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
