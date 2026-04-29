#!/usr/bin/env node
/**
 * generate-schemas.mts
 *
 * Generates JSON Schema files from Zod schemas in harness/src/schemas.ts.
 * Uses Zod v4's native `.toJSONSchema()` method.
 *
 * Output: harness/schemas/*.json
 *
 * Usage:
 *   npx tsx scripts/generate-schemas.mts
 *
 * Called automatically from main.ts at startup when schemas are missing
 * or stale (older than schemas.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  BuilderReportSchema,
  EvaluatorReportSchema,
  QAReportSchema,
  PacketContractSchema,
  ContractReviewSchema,
  PlanReviewSchema,
  PacketSchema,
  RiskRegisterSchema,
  EvaluatorGuideSchema,
  IntegrationScenarioListSchema,
  DevServerConfigSchema,
} from "../src/schemas.js";

// ------------------------------------
// Derived schema (planner output)
// ------------------------------------

// PlannerOutputSchema is defined locally in planner.ts and not exported
// from schemas.ts. Reconstruct it here from its exported components.
const PlannerOutputSchema = z.object({
  spec: z.string(),
  packets: z.array(PacketSchema),
  riskRegister: RiskRegisterSchema,
  evaluatorGuide: EvaluatorGuideSchema,
  planSummary: z.string(),
  integrationScenarios: IntegrationScenarioListSchema.default({ scenarios: [] }),
  devServer: DevServerConfigSchema.nullish(),
});

// Round-2 planner output: narrower than R1 — no integrationScenarios / devServer.
// Must match the local Round2PlannerOutputSchema in round2-planner.ts.
const Round2PlannerOutputSchema = z.object({
  spec: z.string(),
  packets: z.array(PacketSchema),
  riskRegister: RiskRegisterSchema,
  evaluatorGuide: EvaluatorGuideSchema,
  planSummary: z.string(),
});

// ------------------------------------
// Schema registry
// ------------------------------------

const SCHEMAS: Array<{ name: string; schema: z.ZodType; sourceSchema: string }> = [
  {
    name: "builder-report",
    schema: BuilderReportSchema,
    sourceSchema: "BuilderReportSchema",
  },
  {
    name: "evaluator-report",
    schema: EvaluatorReportSchema,
    sourceSchema: "EvaluatorReportSchema",
  },
  {
    name: "qa-report",
    schema: QAReportSchema,
    sourceSchema: "QAReportSchema",
  },
  {
    name: "contract-proposal",
    schema: PacketContractSchema,
    sourceSchema: "PacketContractSchema",
  },
  {
    name: "contract-review",
    schema: ContractReviewSchema,
    sourceSchema: "ContractReviewSchema",
  },
  {
    name: "plan-review",
    schema: PlanReviewSchema,
    sourceSchema: "PlanReviewSchema",
  },
  {
    name: "spec-packets",
    schema: PlannerOutputSchema,
    sourceSchema: "PlannerOutputSchema (reconstructed from PacketSchema + RiskRegisterSchema + EvaluatorGuideSchema + IntegrationScenarioListSchema + DevServerConfigSchema)",
  },
  {
    name: "round2-spec-packets",
    schema: Round2PlannerOutputSchema,
    sourceSchema: "Round2PlannerOutputSchema (reconstructed; no integrationScenarios / devServer — R2 reuses R1's plan-level decisions)",
  },
];

// ------------------------------------
// Generator
// ------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, "..", "schemas");

/**
 * OpenAI structured-outputs strict mode requires:
 *   - Every property in `properties` must also appear in `required`.
 *   - `additionalProperties: false` on every object.
 *   - Optional fields are not allowed — emulate with a nullable union.
 *
 * Zod v4's native `toJSONSchema()` emits standards-compliant JSON Schema
 * where optional fields are simply absent from `required`. OpenAI rejects
 * that with `invalid_json_schema`. This post-processor walks the schema
 * and lifts every non-required property to `required`, wrapping its type
 * in `anyOf: [..., {type: "null"}]` so the model may emit `null` instead.
 */
function openaiStrictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(openaiStrictify);
  if (node === null || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  // Recurse into common schema containers first
  for (const key of ["items", "contains", "not", "additionalItems"]) {
    if (out[key] !== undefined) out[key] = openaiStrictify(out[key]);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map(openaiStrictify);
    }
  }
  for (const key of ["$defs", "definitions"]) {
    if (out[key] && typeof out[key] === "object") {
      const defs = out[key] as Record<string, unknown>;
      out[key] = Object.fromEntries(
        Object.entries(defs).map(([k, v]) => [k, openaiStrictify(v)]),
      );
    }
  }

  if (out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, unknown>;
    const existingRequired = Array.isArray(out.required) ? [...out.required as string[]] : [];
    const requiredSet = new Set(existingRequired);

    const nextProps: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(props)) {
      const recursed = openaiStrictify(propSchema);
      if (requiredSet.has(propName)) {
        nextProps[propName] = recursed;
      } else {
        // Optional in source → nullable + required in output
        nextProps[propName] = {
          anyOf: [recursed, { type: "null" }],
        };
        requiredSet.add(propName);
      }
    }
    out.properties = nextProps;
    out.required = Array.from(requiredSet);
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
  }

  return out;
}

export function generateSchemas(outputDir: string = schemasDir): void {
  fs.mkdirSync(outputDir, { recursive: true });

  for (const { name, schema, sourceSchema } of SCHEMAS) {
    const outPath = path.join(outputDir, `${name}.json`);

    // Zod v4 native toJSONSchema
    const raw = (schema as z.ZodType & { toJSONSchema: () => unknown }).toJSONSchema();
    const jsonSchema = openaiStrictify(raw);

    const content = JSON.stringify(jsonSchema, null, 2) + "\n";
    fs.writeFileSync(outPath, content, "utf-8");
    console.log(`[schema] Generated ${name}.json  ←  ${sourceSchema}`);
  }
}

// ------------------------------------
// CLI entry point
// ------------------------------------

generateSchemas();
console.log(`[schema] All schemas written to ${schemasDir}`);
