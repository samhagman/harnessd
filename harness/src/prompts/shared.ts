/**
 * Shared prompt fragments used across multiple agent prompt builders.
 *
 * This module exports reusable building blocks to keep prompt files DRY
 * and ensure behaviorally-identical text is never accidentally diverged.
 */

import type { DevServerConfig } from "../schemas.js";

// ---------------------------------------------------------------------------
// AUTONOMOUS_PREAMBLE
// ---------------------------------------------------------------------------

/**
 * The autonomous-operation preamble injected into every agent prompt.
 * Instructs the agent to work continuously without stopping for confirmation
 * and to treat incoming messages as steering nudges.
 */
export const AUTONOMOUS_PREAMBLE = `## Autonomous Operation

You are AUTONOMOUS. Work continuously toward your goal until it is complete.
Do NOT stop to ask questions. Do NOT wait for confirmation. Do NOT ask "shall I continue?".

If you receive a new message from the operator mid-session, it is a STEERING NUDGE.
Incorporate the new context and keep working. Do not treat it as a stop signal.
The only way you stop is by completing your goal and emitting the result envelope.`;

// ---------------------------------------------------------------------------
// CONTINUATION_PROMPT
// ---------------------------------------------------------------------------

/**
 * The message sent to an agent when resuming an interrupted session.
 * Used by all runner files when a prior session ID is available.
 */
export const CONTINUATION_PROMPT =
  "You were interrupted mid-session. Continue your work from where you left off. Complete your task and emit the result envelope when done.";

// ---------------------------------------------------------------------------
// buildValidateEnvelopeSection
// ---------------------------------------------------------------------------

/**
 * Generates the "MANDATORY: Validate Before Emitting" section.
 *
 * @param schemaName - The schema name to pass to validate-envelope (e.g. "BuilderReport")
 * @param criterionIdsFlag - Optional comma-separated criterion IDs for `--criterion-ids`
 *   (used by evaluator prompts to enforce full verdict coverage)
 */
export function buildValidateEnvelopeSection(
  schemaName: string,
  criterionIdsFlag?: string,
): string {
  const criterionIdsArg = criterionIdsFlag ? ` --criterion-ids ${criterionIdsFlag}` : "";
  const criterionIdsNote = criterionIdsFlag
    ? `\n\n(The \`--criterion-ids\` flag validates that your criterionVerdicts array covers every criterion in the contract. Use the criterion IDs listed in the contract above.)`
    : "";

  return `## MANDATORY: Validate Before Emitting

You MUST validate your result envelope BEFORE emitting it. This is not optional.
If you emit without validating, your output will be REJECTED and you will have to redo your work.

**Option 1 — MCP tool (preferred):**
Call \`validate_envelope\` with schema_name="${schemaName}" and json_string=<your JSON>

**Option 2 — CLI (if MCP tool unavailable):**
\`\`\`bash
echo '<your JSON>' | npx tsx /Users/sam/projects/harnessd/harness/bin/validate-envelope.mts --schema ${schemaName}${criterionIdsArg} --json -
\`\`\`
${criterionIdsNote}
If validation returns {valid: false}, FIX the errors and validate again.
ONLY after getting {valid: true} should you emit the envelope.
Do NOT skip this step. Do NOT emit first and hope it works.`;
}

// ---------------------------------------------------------------------------
// buildDevServerSetupSection
// ---------------------------------------------------------------------------

/**
 * Role-specific notes appended to the dev server setup section.
 * - builder: warns about dirty data from prior build sessions
 * - evaluator: warns about stale servers + dirty data from prior test sessions
 * - qa: same as evaluator but with an additional note about data vs code bugs
 */
const DEV_SERVER_CLEAN_DATA_NOTES: Record<"builder" | "evaluator" | "qa", string> = {
  builder: `5. **Clean data state:** Previous sessions may have left dirty data in the database.
   - Look for data directories (\`.tmp-*\`, \`data/\`, \`*.db\`, \`*.sqlite\`) in the workspace
   - If you find SQLite DBs or data files from prior sessions, DELETE them
   - The dev server's bootstrap will recreate clean seed data on fresh start

Do NOT assume the dev environment is clean from a previous session.
Do NOT skip this step — stale servers AND stale data cause false test failures.`,

  evaluator: `5. **Clean data state:** Previous test sessions may have left dirty data in the database.
   Before testing, check for accumulated/duplicate data:
   - Look for data directories (\`.tmp-*\`, \`data/\`, \`*.db\`, \`*.sqlite\`) in the workspace
   - If you find SQLite DBs or data files, DELETE them so the server re-seeds from scratch
   - The dev server's bootstrap will recreate clean seed data on fresh start
   - This prevents false failures from stale data accumulated across prior builder/evaluator sessions

Do NOT assume the dev environment is clean from a previous session.
Do NOT skip this step — stale servers AND stale data will cause false test failures.
Previous sessions have failed because stale servers served outdated code and accumulated
duplicate data caused incorrect state that looked like code bugs but was really dirty test data.`,

  qa: `5. **Clean data state:** Previous test sessions may have left dirty data in the database.
   Before testing, check for accumulated/duplicate data:
   - Look for data directories (\`.tmp-*\`, \`data/\`, \`*.db\`, \`*.sqlite\`) in the workspace
   - If you find SQLite DBs or data files, DELETE them so the server re-seeds from scratch
   - The dev server's bootstrap will recreate clean seed data on fresh start
   - This prevents false failures from stale data accumulated across prior builder/evaluator sessions

Do NOT assume the dev environment is clean from a previous session.
Do NOT skip this step — stale servers AND stale data will cause false test failures.
When you find unexpected data (duplicate values, wrong permissions, stale entities),
consider whether the DATA is dirty from prior test runs before concluding the CODE is wrong.`,
};

/** Fallback setup section when no devServer config is available. */
const DEV_SERVER_FALLBACK_NOTES: Record<"builder" | "evaluator" | "qa", string> = {
  builder: `## Environment Setup

Before browser testing, check package.json for the dev command, start it with
run_in_background=true, and navigate to the URL it prints. Kill any stale
processes on the same ports first.`,

  evaluator: `## Environment Setup

Before browser testing, check package.json for the dev command, start it with
run_in_background=true, and navigate to the URL it prints. Kill any stale
processes on the same ports first.
Previous evaluator sessions have failed because stale servers were serving outdated code.`,

  qa: `## Environment Setup

Before browser testing, check package.json for the dev command, start it with
run_in_background=true, and navigate to the URL it prints. Kill any stale
processes on the same ports first.`,
};

/**
 * Generates the "Environment Setup" section for builder, evaluator, and QA prompts.
 *
 * When `devServer` is provided, emits detailed step-by-step setup instructions
 * tailored to the role. When absent, emits a short generic fallback.
 *
 * @param devServer - Optional dev server configuration from the planner
 * @param role      - "builder" | "evaluator" | "qa" — controls role-specific copy
 */
export function buildDevServerSetupSection(
  devServer: DevServerConfig | undefined,
  role: "builder" | "evaluator" | "qa",
): string {
  if (!devServer) {
    return DEV_SERVER_FALLBACK_NOTES[role];
  }

  const portFilter = devServer.backendPort
    ? `:${devServer.port}|:${devServer.backendPort}`
    : `:${devServer.port}`;

  const cleanDataNote = DEV_SERVER_CLEAN_DATA_NOTES[role];

  return `## Environment Setup (Do This First)

Before ${role === "builder" ? "starting any work" : "verifying anything in the browser"}, ensure you have a clean dev environment:

1. Kill any stale dev server processes:
   \`lsof -iTCP -sTCP:LISTEN -P -n | grep -E '${portFilter}'\`
   If anything is listening on these ports, kill those PIDs: \`kill <pid>\`

2. Start the dev server fresh from your workspace:
   \`${devServer.command}\`
   Run this with run_in_background=true.

3. Wait for the server to be ready (look for "${devServer.readyPattern}" in the output).
   Then verify http://localhost:${devServer.port} returns HTML.

4. For ALL browser testing, navigate to http://localhost:${devServer.port}
   (the frontend). The frontend proxies API calls automatically.

${cleanDataNote}`;
}
