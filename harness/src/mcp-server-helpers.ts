/**
 * Shared utilities for harnessd MCP stdio server binaries (bin/*.mts).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  PacketContractSchema,
  ContractReviewSchema,
  BuilderReportSchema,
  EvaluatorReportSchema,
  QAReportSchema,
} from "./schemas.js";

export const TOOL_TIMEOUT_MS = 30_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool call timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

export const SCHEMAS: Record<string, z.ZodType<unknown>> = {
  PacketContract: PacketContractSchema as z.ZodType<unknown>,
  ContractReview: ContractReviewSchema as z.ZodType<unknown>,
  BuilderReport: BuilderReportSchema as z.ZodType<unknown>,
  EvaluatorReport: EvaluatorReportSchema as z.ZodType<unknown>,
  QAReport: QAReportSchema as z.ZodType<unknown>,
};

export const SCHEMA_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "schemas.ts",
);

export let SCHEMA_SOURCE_CONTENTS = "";
try {
  SCHEMA_SOURCE_CONTENTS = readFileSync(SCHEMA_SOURCE_PATH, "utf-8");
} catch {
  SCHEMA_SOURCE_CONTENTS = "(schemas.ts source unavailable — read failed)";
}

export const SCHEMA_HINT =
  "The full Zod schema source is included above. Read it as the authoritative spec for every field. " +
  "If a field's value is empty/unknown, pass [] for arrays or omit optional fields — do not invent placeholder content.";

/**
 * Persists a validated envelope body to HARNESSD_STAGED_ENVELOPE_PATH so the
 * orchestrator can recover it if delimiters are missing in the model's final output.
 * Last-write-wins; silently skipped if env var is unset.
 */
export function persistStagedEnvelope(schemaName: string, validatedBody: unknown): void {
  const stagedPath = process.env.HARNESSD_STAGED_ENVELOPE_PATH;
  if (!stagedPath) return;
  try {
    mkdirSync(dirname(stagedPath), { recursive: true });
    const tmp = stagedPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ validatedAt: new Date().toISOString(), schemaName, validatedBody }, null, 2));
    renameSync(tmp, stagedPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[validate_envelope] failed to persist staged envelope to ${stagedPath}: ${msg}\n`);
  }
}

/**
 * Validates a parsed JSON value against an envelope schema.
 * For EvaluatorReport, also checks criterion ID coverage when expectedCriterionIds is given.
 * Returns null on success, or an array of error strings on failure.
 */
export function validateEnvelopeBody(
  schemaName: string,
  parsed: unknown,
  expectedCriterionIds: string[],
): string[] | null {
  const schema = SCHEMAS[schemaName];
  if (!schema) {
    return [`Unknown schema: ${schemaName}. Available: ${Object.keys(SCHEMAS).join(", ")}`];
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return result.error.issues.map((issue: z.ZodIssue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
  }

  if (schemaName === "EvaluatorReport" && expectedCriterionIds.length > 0) {
    const validIds = new Set(expectedCriterionIds);
    const verdicts = (parsed as { criterionVerdicts?: Array<{ criterionId: string }> }).criterionVerdicts ?? [];
    const errors: string[] = [];

    const badIds = verdicts.map((v) => v.criterionId).filter((id) => !validIds.has(id));
    if (badIds.length > 0) {
      errors.push(
        `criterionVerdicts contains IDs not in the contract: ${badIds.join(", ")}. ` +
        `Valid IDs are: ${expectedCriterionIds.join(", ")}. Use the EXACT criterion IDs from the contract.`,
      );
    }

    const missingIds = expectedCriterionIds.filter((id) => !verdicts.some((v) => v.criterionId === id));
    if (missingIds.length > 0) {
      errors.push(
        `Missing verdicts for: ${missingIds.join(", ")}. You must provide a verdict for every acceptance criterion.`,
      );
    }

    if (errors.length > 0) return errors;
  }

  return null;
}
