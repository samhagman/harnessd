/**
 * MCP tool that agents can call to validate their result envelope JSON
 * against the expected Zod schema BEFORE emitting the final output.
 *
 * This prevents wasted retries from schema validation failures —
 * the agent gets errors inline and can fix them in the same session.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

import {
  PacketContractSchema,
  ContractReviewSchema,
  BuilderReportSchema,
  EvaluatorReportSchema,
} from "./schemas.js";

const SCHEMAS: Record<string, z.ZodType<unknown>> = {
  PacketContract: PacketContractSchema as z.ZodType<unknown>,
  ContractReview: ContractReviewSchema as z.ZodType<unknown>,
  BuilderReport: BuilderReportSchema as z.ZodType<unknown>,
  EvaluatorReport: EvaluatorReportSchema as z.ZodType<unknown>,
};

/**
 * Create an MCP server config with a `validate_envelope` tool.
 * Pass the returned config into the session's mcpServers option.
 */
export function createValidationMcpServer() {
  return createSdkMcpServer({
    name: "harnessd-validation",
    version: "1.0.0",
    tools: [
      tool(
        "validate_envelope",
        "Validate a JSON object against a harnessd schema before emitting it as your result envelope. " +
        "Call this with your proposed result JSON and the schema name. " +
        "Returns either {valid: true} or {valid: false, errors: [...]} so you can fix issues before emitting. " +
        "Available schemas: PacketContract, ContractReview, BuilderReport, EvaluatorReport",
        {
          schema_name: z.enum(["PacketContract", "ContractReview", "BuilderReport", "EvaluatorReport"])
            .describe("Which schema to validate against"),
          json_string: z.string()
            .describe("The JSON string to validate (your proposed envelope payload)"),
        },
        async (args) => {
          const schema = SCHEMAS[args.schema_name];
          if (!schema) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors: [`Unknown schema: ${args.schema_name}`] }) }],
            };
          }

          try {
            const parsed = JSON.parse(args.json_string);
            const result = schema.safeParse(parsed);

            if (result.success) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ valid: true }) }],
              };
            }

            // Format Zod errors into readable messages
            const errors = result.error.issues.map((issue: any) => ({
              path: issue.path.join("."),
              message: issue.message,
              code: issue.code,
              expected: issue.expected,
              received: issue.received,
            }));

            return {
              content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors }, null, 2) }],
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors: [`JSON parse error: ${msg}`] }) }],
            };
          }
        },
      ),
    ],
  });
}
