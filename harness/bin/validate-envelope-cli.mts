#!/usr/bin/env npx tsx
/**
 * CLI envelope validator — no-MCP fallback for Codex agents that cannot use
 * MCP tools. Shell-script equivalent of the validate_envelope MCP tool.
 *
 * Usage:
 *   npx tsx harness/bin/validate-envelope-cli.mts --schema EvaluatorReport --json '{"overall":"pass",...}'
 *   npx tsx harness/bin/validate-envelope-cli.mts --schema EvaluatorReport --criterion-ids AC-1,AC-2,AC-3 --json '...'
 *
 * Reads --json arg or stdin if --json is "-".
 * Exits 0 with {"valid":true} or exits 1 with {"valid":false,"errors":[...]}.
 */

import {
  SCHEMAS,
  SCHEMA_SOURCE_PATH,
  SCHEMA_SOURCE_CONTENTS,
  SCHEMA_HINT,
  persistStagedEnvelope,
  validateEnvelopeBody,
} from "../src/mcp-server-helpers.js";

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

  if (!SCHEMAS[schemaName]) {
    console.log(JSON.stringify({ valid: false, errors: [`Unknown schema: ${schemaName}. Available: ${Object.keys(SCHEMAS).join(", ")}`] }));
    process.exit(1);
  }

  let input = jsonStr;
  if (!input || input === "-") {
    input = await readStdin();
  }

  try {
    const parsed = JSON.parse(input);
    const errors = validateEnvelopeBody(schemaName, parsed, criterionIds);

    if (errors) {
      console.log(
        JSON.stringify(
          { valid: false, errors, schemaSourcePath: SCHEMA_SOURCE_PATH, schemaSource: SCHEMA_SOURCE_CONTENTS, hint: SCHEMA_HINT },
          null,
          2,
        ),
      );
      process.exit(1);
    }

    persistStagedEnvelope(schemaName, parsed);

    console.log(JSON.stringify({ valid: true }));
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ valid: false, errors: [`JSON parse error: ${msg}`] }));
    process.exit(1);
  }
}

main();
