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
  QAReportSchema,
} from "./schemas.js";

const SCHEMAS: Record<string, z.ZodType<unknown>> = {
  PacketContract: PacketContractSchema as z.ZodType<unknown>,
  ContractReview: ContractReviewSchema as z.ZodType<unknown>,
  BuilderReport: BuilderReportSchema as z.ZodType<unknown>,
  EvaluatorReport: EvaluatorReportSchema as z.ZodType<unknown>,
  QAReport: QAReportSchema as z.ZodType<unknown>,
};

/**
 * Create an MCP server config with a `validate_envelope` tool.
 * Pass the returned config into the session's mcpServers option.
 *
 * @param expectedCriterionIds  When provided, the EvaluatorReport validator
 *   also checks that every criterionId in criterionVerdicts matches one of
 *   these IDs exactly. This catches ID format mismatches (AC-001 vs AC-1)
 *   before the envelope is emitted, so the agent can fix it in-session.
 */
export function createValidationMcpServer(expectedCriterionIds?: string[]) {
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
          schema_name: z.enum(["PacketContract", "ContractReview", "BuilderReport", "EvaluatorReport", "QAReport"])
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

            if (!result.success) {
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
            }

            // Extra validation for EvaluatorReport: check criterion IDs match the contract
            if (args.schema_name === "EvaluatorReport" && expectedCriterionIds && expectedCriterionIds.length > 0) {
              const validIds = new Set(expectedCriterionIds);
              const verdicts = (parsed as any).criterionVerdicts ?? [];
              const badIds = verdicts
                .map((v: any) => v.criterionId)
                .filter((id: string) => !validIds.has(id));
              const missingIds = expectedCriterionIds.filter(
                (id) => !verdicts.some((v: any) => v.criterionId === id),
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
                  content: [{ type: "text" as const, text: JSON.stringify({ valid: false, errors: warnings }, null, 2) }],
                };
              }
            }

            return {
              content: [{ type: "text" as const, text: JSON.stringify({ valid: true }) }],
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
