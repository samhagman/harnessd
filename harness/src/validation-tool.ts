/**
 * MCP tool that agents can call to validate their result envelope JSON
 * against the expected Zod schema BEFORE emitting the final output.
 *
 * This prevents wasted retries from schema validation failures —
 * the agent gets errors inline and can fix them in the same session.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const SCHEMA_SOURCE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "schemas.ts",
);
let SCHEMA_SOURCE_CONTENTS = "";
try {
  SCHEMA_SOURCE_CONTENTS = fs.readFileSync(SCHEMA_SOURCE_PATH, "utf-8");
} catch {
  SCHEMA_SOURCE_CONTENTS = "(schemas.ts source unavailable - read failed)";
}

const SCHEMA_HINT = "The full Zod schema source is included above. Read it as the authoritative spec for every field. If a field's value is empty/unknown, pass [] for arrays or omit optional fields - do not invent placeholder content.";

function invalidValidationResponse(payload: Record<string, unknown>) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...payload,
        schemaSourcePath: SCHEMA_SOURCE_PATH,
        schemaSource: SCHEMA_SOURCE_CONTENTS,
        hint: SCHEMA_HINT,
      }, null, 2),
    }],
  };
}

/**
 * Persist a successfully-validated envelope body to disk so the orchestrator
 * can recover it even if the model fails to wrap its final assistant text
 * in `===HARNESSD_RESULT_*===` delimiters (the recurring markdown-fence
 * regression).
 *
 * Path is read from `HARNESSD_STAGED_ENVELOPE_PATH` env var, set by the
 * harness at session launch. If unset (e.g. unit tests, ad-hoc runs), the
 * persistence step is silently skipped — validation behavior is unchanged.
 *
 * Last-write-wins: the model can call validate_envelope multiple times in
 * one session iterating on shape; the final pre-emission call is what the
 * orchestrator reads.
 */
function persistStagedEnvelope(schemaName: string, validatedBody: unknown): void {
  const stagedPath = process.env.HARNESSD_STAGED_ENVELOPE_PATH;
  if (!stagedPath) return;
  try {
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    const tmp = stagedPath + ".tmp";
    const payload = JSON.stringify({
      validatedAt: new Date().toISOString(),
      schemaName,
      validatedBody,
    }, null, 2);
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, stagedPath);
  } catch (err) {
    // Persistence is best-effort: if the staged file can't be written,
    // the orchestrator falls back to delimiter parsing. Log via stderr
    // (visible in harness logs) but never throw inside the MCP tool.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[validate_envelope] failed to persist staged envelope to ${stagedPath}: ${msg}\n`);
  }
}

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
              return invalidValidationResponse({ valid: false, errors });
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
                return invalidValidationResponse({ valid: false, errors: warnings });
              }
            }

            // Persist the validated body so the orchestrator can recover it
            // from staged-envelope.json regardless of how the model formats
            // its final assistant text (delimiters, markdown fences, plain).
            persistStagedEnvelope(args.schema_name, parsed);

            return {
              content: [{ type: "text" as const, text: JSON.stringify({ valid: true }) }],
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return invalidValidationResponse({ valid: false, errors: [`JSON parse error: ${msg}`] });
          }
        },
      ),
    ],
  });
}
