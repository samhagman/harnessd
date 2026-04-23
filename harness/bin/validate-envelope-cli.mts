#!/usr/bin/env npx tsx
/**
 * CLI envelope validator — shell-script equivalent of the validate_envelope MCP tool.
 * Used by Codex agents (which can't use MCP tools) to validate their output before emitting.
 *
 * Usage:
 *   npx tsx harness/bin/validate-envelope-cli.mts --schema EvaluatorReport --json '{"overall":"pass",...}'
 *   npx tsx harness/bin/validate-envelope-cli.mts --schema EvaluatorReport --criterion-ids AC-1,AC-2,AC-3 --json '...'
 *
 * Reads --json arg or stdin if --json is "-".
 * Exits 0 with {"valid":true} or exits 1 with {"valid":false,"errors":[...]}.
 */

import { z } from "zod";
import {
  PacketContractSchema,
  ContractReviewSchema,
  BuilderReportSchema,
  EvaluatorReportSchema,
  QAReportSchema,
} from "../src/schemas.js";

const SCHEMAS: Record<string, z.ZodType<unknown>> = {
  PacketContract: PacketContractSchema as z.ZodType<unknown>,
  ContractReview: ContractReviewSchema as z.ZodType<unknown>,
  BuilderReport: BuilderReportSchema as z.ZodType<unknown>,
  EvaluatorReport: EvaluatorReportSchema as z.ZodType<unknown>,
  QAReport: QAReportSchema as z.ZodType<unknown>,
};

function parseArgs() {
  const args = process.argv.slice(2);
  let schemaName = "";
  let jsonStr = "";
  let criterionIds: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--schema" && args[i + 1]) {
      schemaName = args[++i]!;
    } else if (args[i] === "--json" && args[i + 1]) {
      jsonStr = args[++i]!;
    } else if (args[i] === "--criterion-ids" && args[i + 1]) {
      criterionIds = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  return { schemaName, jsonStr, criterionIds };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const { schemaName, jsonStr, criterionIds } = parseArgs();

  if (!schemaName) {
    console.log(JSON.stringify({ valid: false, errors: ["Missing --schema argument. Available: PacketContract, ContractReview, BuilderReport, EvaluatorReport, QAReport"] }));
    process.exit(1);
  }

  const schema = SCHEMAS[schemaName];
  if (!schema) {
    console.log(JSON.stringify({ valid: false, errors: [`Unknown schema: ${schemaName}. Available: ${Object.keys(SCHEMAS).join(", ")}`] }));
    process.exit(1);
  }

  let input = jsonStr;
  if (!input || input === "-") {
    input = await readStdin();
  }

  try {
    const parsed = JSON.parse(input);
    const result = (schema as z.ZodType).safeParse(parsed);

    if (!result.success) {
      const errors = result.error.issues.map((issue: z.ZodIssue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      }));
      console.log(JSON.stringify({ valid: false, errors }, null, 2));
      process.exit(1);
    }

    // Extra validation for EvaluatorReport: check criterion IDs
    if (schemaName === "EvaluatorReport" && criterionIds.length > 0) {
      const validIds = new Set(criterionIds);
      const verdicts = (parsed as any).criterionVerdicts ?? [];
      const badIds = verdicts
        .map((v: any) => v.criterionId)
        .filter((id: string) => !validIds.has(id));
      const missingIds = criterionIds.filter(
        (id) => !verdicts.some((v: any) => v.criterionId === id),
      );

      const warnings: string[] = [];
      if (badIds.length > 0) {
        warnings.push(
          `criterionVerdicts contains IDs not in the contract: ${badIds.join(", ")}. ` +
          `Valid IDs are: ${criterionIds.join(", ")}. Use the EXACT criterion IDs from the contract.`,
        );
      }
      if (missingIds.length > 0) {
        warnings.push(
          `Missing verdicts for: ${missingIds.join(", ")}. You must provide a verdict for every acceptance criterion.`,
        );
      }
      if (warnings.length > 0) {
        console.log(JSON.stringify({ valid: false, errors: warnings }, null, 2));
        process.exit(1);
      }
    }

    console.log(JSON.stringify({ valid: true }));
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ valid: false, errors: [`JSON parse error: ${msg}`] }));
    process.exit(1);
  }
}

main();
