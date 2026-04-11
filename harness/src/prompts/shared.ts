/**
 * Shared prompt fragments used across multiple agent prompt builders.
 *
 * This module exports reusable building blocks to keep prompt files DRY
 * and ensure behaviorally-identical text is never accidentally diverged.
 *
 * Table of contents:
 * 1. AUTONOMOUS_PREAMBLE
 * 2. CONTINUATION_PROMPT
 * 3. buildValidateEnvelopeSection
 * 4. buildDevServerSetupSection
 * 5. buildHarnessContextSection  — where the agent sits in the pipeline
 * 6. buildMemorySearchSection    — how to use search_memory effectively
 * 7. buildResearchToolsSection   — dynamic research tool instructions
 */

import type { DevServerConfig } from "../schemas.js";
import type { ResearchToolAvailability } from "../research-tools.js";

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
echo '<your JSON>' | npx tsx harness/bin/validate-envelope.mts --schema ${schemaName}${criterionIdsArg} --json -
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
Previous evaluator sessions have failed because stale servers were serving outdated code.

**Before concluding credentials are unavailable:** Read the workspace \`.env\` file.
If CLERK_SECRET_KEY, VITE_CLERK_PUBLISHABLE_KEY, or other required keys are present,
the dev server WILL work — start it and do runtime verification.`,

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
 * @param devServer  - Optional dev server configuration from the planner
 * @param role       - "builder" | "evaluator" | "qa" — controls role-specific copy
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

// ---------------------------------------------------------------------------
// buildHarnessContextSection
// ---------------------------------------------------------------------------

/**
 * Generates the "Your Place in the Harness" section for each agent role.
 *
 * This section tells each agent where it sits in the pipeline, what ran before
 * it, and what happens after. It also includes role-tailored search_memory
 * examples so the agent knows what to look for.
 *
 * @param role                - Agent role name
 * @param opts.packetId       - Current packet (for packet-scoped agents)
 * @param opts.completedPacketIds - Packets already finished (for context)
 * @param opts.round          - Round number (for planner/round2_planner)
 * @param opts.memoryEnabled  - When false, strip search_memory example lines (default: true)
 */
export function buildHarnessContextSection(
  role: string,
  opts?: {
    packetId?: string;
    completedPacketIds?: string[];
    round?: number;
    memoryEnabled?: boolean;
  },
): string {
  const packetId = opts?.packetId;
  const completedPacketIds = opts?.completedPacketIds ?? [];
  const round = opts?.round ?? 1;
  const memoryEnabled = opts?.memoryEnabled;

  let result: string;
  switch (role) {
    case "builder": {
      const priorBuilderSearch = completedPacketIds.length > 0
        ? `\n   Search: \`search_memory({query: "architectural decisions", packetId: "${completedPacketIds[0]}"})\``
        : "";
      const priorPacketList = completedPacketIds.length > 0
        ? completedPacketIds.join(", ")
        : "(none — you are the first builder)";

      result = `## Your Place in the Harness

You are the **builder** for packet ${packetId ?? "(current packet)"} in a multi-packet harness run.

### What happened before you:
1. **Planner** — analyzed the objective, researched the domain, and produced a specification
   with packets, risk register, and evaluator guide.
   Search: \`search_memory({query: "planner decisions spec", role: "planner"})\`
2. **Plan Reviewer** — adversarially reviewed the plan and negotiated revisions
3. **Contract Negotiator** — for YOUR packet, a contract was proposed and reviewed
   with explicit acceptance criteria you must satisfy.
   Search: \`search_memory({query: "contract acceptance criteria", packetId: "${packetId ?? ""}"})\`
4. **Prior Builders** — ${priorPacketList} — already built and evaluated. Their builders
   made architectural decisions and established patterns you should follow.${priorBuilderSearch}
5. **Prior Evaluators** — independently verified each completed packet. Their findings may
   flag patterns you should follow or issues you should avoid.
   Search: \`search_memory({query: "evaluator findings", role: "evaluator"})\`

### What happens after you:
- **Tool Gates** — automated typecheck + test suite run on your changes
- **Evaluator** — a separate read-only agent will independently verify every acceptance
  criterion. It cannot write code — it can only read, test, and report.`;
      break;
    }

    case "evaluator": {
      result = `## Your Place in the Harness

You are the **evaluator** for packet ${packetId ?? "(current packet)"}. Your job is to independently
verify the builder's claims — you are adversarial, not collaborative.

### What happened before you:
1. **Planner** — created the spec and acceptance criteria framework.
   Search: \`search_memory({query: "spec objectives", role: "planner"})\`
2. **Contract Negotiator** — agreed on the acceptance criteria you must now verify.
   Search: \`search_memory({query: "contract acceptance criteria", packetId: "${packetId ?? ""}"})\`
3. **Builder** — implemented ${packetId ?? "this packet"} and claims done. You have their self-check report.
   Search their reasoning: \`search_memory({query: "implementation approach", role: "builder", packetId: "${packetId ?? ""}"})\`
4. **Tool Gates** — automated typecheck and tests already passed. You verify beyond gates.
5. **Prior Evaluators** — see what patterns they validated or flagged.
   Search: \`search_memory({query: "prior evaluation patterns", role: "evaluator"})\`

### What happens after you:
- **Pass** → packet marked done, next packet starts
- **Fail** → builder gets your diagnostic hypothesis and tries again
- **Contract Gap** → back to contract negotiation with your findings`;
      break;
    }

    case "planner": {
      // Note: round > 1 planning uses the "round2_planner" role, not "planner".
      result = `## Your Place in the Harness

You are the **first agent** in this harness pipeline. Memory is mostly empty at this point
because no other agents have run yet.

### What happens after you:
- **Plan Reviewer** — adversarially reviews your output before the operator sees it
- **Operator approval** — the operator reviews and approves (or modifies) the plan
- **Contract Negotiation** — for each packet, a contract is proposed and reviewed
- **Building** — builders implement each packet against finalized contracts
- **Evaluation** — evaluators independently verify each completed packet
- **QA** — holistic E2E testing after all packets complete

Ground your plan in research using available research tools before planning.`;
      break;
    }

    case "round2_planner": {
      result = `## Your Place in the Harness

You are the **round ${round} planner** creating targeted fix packets from QA findings.

### What happened before you:
1. **Round 1 Planner** — created the original spec, packets, and risk register
2. **Plan Reviewer** — adversarially reviewed and approved the original plan
3. **Builders** (all R1 packets) — implemented each packet against negotiated contracts
4. **Evaluators** (all R1 packets) — independently verified each packet. All passed.
5. **Tool Gates** — typecheck + tests passed for every R1 packet
6. **QA Agent (round ${round - 1})** — ran holistic E2E testing and found issues to fix

You have access to the FULL memory trail of everything that happened across all prior rounds.
Search for QA findings: \`search_memory({query: "QA findings issues"})\`
Search for builder decisions: \`search_memory({query: "builder reasoning implementation"})\`
Search for evaluator findings: \`search_memory({query: "evaluator report hard failures"})\`

### What happens after you:
- Your fix packets go through contract negotiation → building → evaluation → QA again`;
      break;
    }

    case "qa_agent": {
      const allPackets = completedPacketIds.length > 0
        ? completedPacketIds.join(", ")
        : "(all R1 packets)";
      result = `## Your Place in the Harness

You are the **QA agent** running holistic end-to-end testing after ALL packets are built.

### What happened before you:
1. **Planner** → spec with integration scenarios and quality criteria
   Search: \`search_memory({query: "integration scenarios spec"})\`
2. **Builders** (${allPackets}) → each implemented and self-checked against their contract
   Search: \`search_memory({query: "builder report changed files"})\`
3. **Evaluators** (${allPackets}) → each independently verified. All passed.
   Search: \`search_memory({query: "evaluator report pass"})\`
4. **Tool Gates** → typecheck + tests passed for every packet

You have access to the FULL memory of everything that happened across all packets.
Search: \`search_memory({query: "cross-packet integration decisions architectural"})\`

### What happens after you:
- **Pass** → run complete
- **Fail** → your findings generate targeted fix packets in round ${round + 1}`;
      break;
    }

    case "contract_builder": {
      result = `## Your Place in the Harness

You are the **contract builder** proposing a contract for packet ${packetId ?? "(current packet)"}.
You translate a planned packet into actionable scope with explicit acceptance criteria.

### What happened before you:
1. **Planner** — created the spec and packet list. The spec defines what this packet must accomplish.
   Search: \`search_memory({query: "spec objectives packet plan", role: "planner"})\`
2. **Plan Reviewer** — reviewed and approved the plan. Check for reviewer notes on this packet.
   Search: \`search_memory({query: "plan review issues suggestions"})\`
3. **Prior contracts** — if other packets were contracted before this one, search for patterns.
   Search: \`search_memory({query: "accepted contract criteria patterns"})\`

### What happens after you:
- **Contract Evaluator** — reviews your proposal for quality. May require revisions.
- **Builder** — implements against the finalized contract. Vague criteria = wasted build cycles.
- **Evaluator** — verifies the implementation against your criteria.`;
      break;
    }

    case "contract_evaluator": {
      result = `## Your Place in the Harness

You are the **contract evaluator** reviewing a contract proposal for packet ${packetId ?? "(current packet)"}.
Your job is to ensure the contract is specific, testable, and properly scoped before building starts.

### What happened before you:
1. **Planner** — defined the spec and this packet's objective.
   Search: \`search_memory({query: "spec objectives", role: "planner"})\`
2. **Contract Builder** — just proposed this contract. You review it for quality.
3. **Prior accepted contracts** — established patterns for what good contracts look like.
   Search: \`search_memory({query: "accepted contract acceptance criteria"})\`

### What happens after you:
- **Accept** → builder gets this contract and starts implementing
- **Revise** → contract builder revises and you review again (max 10 rounds)
- A weak contract leads to weak implementation — be rigorous now to save fix loops later.`;
      break;
    }

    case "plan_reviewer": {
      result = `## Your Place in the Harness

You are the **plan reviewer** adversarially reviewing the planner's output.
You are the last checkpoint before the operator sees the plan.

### What happened before you:
1. **Planner** — just finished analyzing the objective and producing spec + packets + risk register.
   Their reasoning is in memory now.
   Search: \`search_memory({query: "planner reasoning decisions", role: "planner"})\`

### What happens after you:
- **Approve** → operator reviews the plan and can modify/approve it before building starts
- **Revise** → planner revises and you review again (max ${opts?.round ?? 10} rounds)
- Problems you catch now cost nothing to fix. Problems you miss cost full build cycles.`;
      break;
    }

    default: {
      result = `## Your Place in the Harness

You are a **${role}** agent in a multi-phase harness run.
Memory from prior agent phases is available via \`search_memory\`.`;
      break;
    }
  }

  // Strip search_memory example lines when memory is disabled.
  if (memoryEnabled === false) {
    result = result
      .split("\n")
      .filter((line) => !line.includes("search_memory"))
      .join("\n");
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildResearchToolsSection
// ---------------------------------------------------------------------------

/**
 * Build the "Research Tools" prompt section based on what tools are available.
 * Returns role-appropriate guidance. Returns empty string if no tools available.
 */
export function buildResearchToolsSection(
  availability: ResearchToolAvailability,
  role: "builder" | "evaluator" | "planner",
): string {
  const { context7, perplexity } = availability;

  if (!context7 && !perplexity) return "";

  const sections: string[] = [];

  // Header — role-specific framing
  if (role === "builder") {
    sections.push(`## Research Tools\n\nYou have access to these research tools. Use them — don't guess at APIs.`);
  } else if (role === "evaluator") {
    sections.push(`## Research Tools\n\nYou have access to these tools for VERIFICATION purposes. Use them to verify the builder's work — not to fix problems (you are read-only).`);
  } else {
    sections.push(`## Research Tools\n\nYou have access to research tools. Use them to ground your plan in real data.`);
  }

  // Context7 section
  if (context7) {
    if (role === "evaluator") {
      sections.push(`### Context7 (Library Documentation)
If you need to verify that an implementation follows library conventions, use Context7
to check the current docs:
1. Call \`resolve-library-id\` with the library name
2. Call \`query-docs\` with the library ID and your verification question
Use this when an implementation looks suspicious or uses unfamiliar API patterns.`);
    } else {
      sections.push(`### Context7 (Library Documentation)
When you need to look up API documentation for libraries (React, Effect-TS, Jotai, etc.),
use the Context7 MCP tools:
1. Call \`resolve-library-id\` with the library name to find the library ID
2. Call \`query-docs\` with the library ID and your specific question to fetch current documentation
This is more reliable than guessing at API signatures. Your training data may be outdated —
Context7 gives you CURRENT documentation.
Use Context7 for: API syntax, configuration, version migration, setup instructions.`);
    }
  }

  // Perplexity section
  if (perplexity) {
    if (role === "evaluator") {
      sections.push(`### Perplexity (Web Search)
Use \`perplexity_search\` or \`perplexity_ask\` when you need to:
- Verify browser compatibility claims
- Check if an implementation follows current best practices
- Confirm that the builder's approach is valid for the target platform
Do NOT use research tools to look up how to fix problems — report what needs fixing instead.`);
    } else if (role === "planner") {
      sections.push(`### Perplexity (Web Search)
Use Perplexity's tools to research before planning:
- \`perplexity_search\` for quick factual lookups and finding URLs
- \`perplexity_ask\` for AI-answered questions with citations
- \`perplexity_research\` for in-depth multi-source investigation
Research the domain, design inspiration, and technical best practices. Ground your plan in research, not assumptions.`);
    } else {
      // builder
      sections.push(`### Perplexity (Web Search)
For current best practices or recent API changes, use Perplexity's tools:
- \`perplexity_search\` for quick factual lookups and finding URLs
- \`perplexity_ask\` for AI-answered questions with citations
- \`perplexity_research\` for in-depth multi-source investigation
Use Perplexity for: design patterns, browser compatibility, real-world examples, domain content
(colors, typography, real data), and anything beyond library-specific docs.`);
    }
  }

  // Preference guidance when both available
  if (context7 && perplexity) {
    sections.push(`Prefer Context7 over Perplexity for library-specific questions.
Prefer Perplexity over Context7 for design, patterns, and domain knowledge.`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// buildMemorySearchSection
// ---------------------------------------------------------------------------

/**
 * Generates the "Run Memory Search" section with vocabulary guide and
 * role-specific when-to-search guidance.
 *
 * Memory is a flat semantic search space — document titles contain role names
 * and packet IDs which can be used to bias results.
 *
 * @param role          - Agent role for role-specific search guidance
 * @param memoryEnabled - When false, returns empty string (default: true)
 */
export function buildMemorySearchSection(role: string, memoryEnabled?: boolean): string {
  if (memoryEnabled === false) return "";
  const roleGuidance = buildRoleSearchGuidance(role);

  return `## Run Memory Search

You have access to the run's semantic memory via the \`search_memory\` MCP tool.
This lets you find reasoning, decisions, reports, and artifacts from ALL prior agent phases.

**IMPORTANT:** \`search_memory\` is already available as a direct MCP tool call — you do NOT
need to discover it via ToolSearch. Just call it directly:

\`search_memory({query: "...", k: 5, role: "builder", packetId: "PKT-001"})\`

**CLI fallback (if MCP tool is not responding):**
\`npx tsx harness/bin/search-memory.mts --query "..." --k 5\`

### How to Search Effectively

Memory is a semantic search space. Use descriptive queries — include role names, packet IDs,
and category terms to bias results:
- **By role**: Include "builder", "evaluator", "planner", "contract" in your query
- **By packet**: Include "PKT-001", "PKT-003", etc.
- **By category**: Use "reasoning", "tool call", "report", "contract", "decision"
- **Exact match**: Use \`mode: "lex"\` for keyword-exact searches (function names, file paths)

Optional \`role\` and \`packetId\` parameters prepend those terms to your query for bias.

### What's in Memory

| Category | Title format | What it contains |
|----------|-------------|-----------------|
| Agent reasoning | "builder reasoning — PKT-001 — turn 3" | The agent's thinking and decisions |
| Tool calls | "Tool call: Bash — PKT-001" | Tool name + full input args |
| Tool results | "Tool result — PKT-001" | Tool output (success or error) |
| Builder reports | "Builder report — PKT-001" | Changed files, self-check results |
| Evaluator reports | "Evaluator report (pass) — PKT-001" | Verdicts, hard failures, diagnostics |
| Contracts | "Contract: Auth middleware — PKT-001" | Scope, acceptance criteria, plan |
| Contract rounds | "Contract proposal round 2 — PKT-001" | Each negotiation round |
| Spec artifacts | "Specification (SPEC.md)" | Full spec, packet list, risk register |
| Completion summaries | "Completion summary — PKT-001" | Key decisions, files, integration points |
| Operator messages | "Operator: send_to_agent — PKT-001" | Nudges, pivots, context injections |
| Prompts | "planner prompt (chunk 1/5)" | The full prompt each agent received |
| Session events | "Session start/end — builder — PKT-001" | Session lifecycle with cost/turns |
| Agent events | "Agent event: api_retry — PKT-001" | SDK/CLI events during sessions |

${roleGuidance}`;
}

function buildRoleSearchGuidance(role: string): string {
  switch (role) {
    case "builder":
      return `### When to Search (Builder) — DO THIS BEFORE WRITING CODE

**MANDATORY first step:** Before writing any code, search memory for patterns and decisions
from prior packets. This prevents you from contradicting established architecture or
re-investigating problems already solved.

\`search_memory({query: "architectural decisions patterns", role: "builder"})\`
\`search_memory({query: "completion summary integration points"})\`

Then search as needed during implementation:

- **When you're unsure about an integration point** — find how prior builders wired things:
  \`search_memory({query: "integration wiring API endpoint", role: "builder"})\`

- **When the contract references prior work** — find what prior packets established:
  \`search_memory({query: "completion summary", packetId: "PKT-001"})\`

- **If an evaluator previously failed this packet** — find their exact diagnostic hypothesis:
  \`search_memory({query: "evaluator hard failures diagnostic", role: "evaluator"})\`

- **During fix loops** — if you're retrying after a gate or evaluator failure, search for
  what you tried before and what the failure was:
  \`search_memory({query: "builder reasoning fix attempt", packetId: "PKT-001"})\`
  \`search_memory({query: "gate failed typecheck test error"})\``;

    case "evaluator":
      return `### When to Search (Evaluator)

Search memory to understand builder intent and catch reasoning errors:

- **Before starting verification** — read builder reasoning to understand their approach:
  \`search_memory({query: "builder reasoning implementation approach", role: "builder"})\`

- **When a test fails unexpectedly** — check if the builder mentioned this scenario:
  \`search_memory({query: "builder self-check results evidence", role: "builder"})\`

- **When verifying cross-packet integration** — find what prior packets established:
  \`search_memory({query: "completion summary integration points"})\`

- **When you find a pattern that looks wrong** — check if it was intentional:
  \`search_memory({query: "architectural decision rationale"})\``;

    case "planner":
      return `### When to Search (Planner — Round 2+)

If this is round 2 or later, memory has the full history to inform your fix packets:

- **QA findings** — what issues need fixing:
  \`search_memory({query: "QA issues critical major findings"})\`

- **Builder implementation decisions** — what code patterns were established:
  \`search_memory({query: "builder reasoning implementation decisions"})\`

- **Evaluator reports** — what was verified and what failed previously:
  \`search_memory({query: "evaluator report hard failures"})\``;

    case "round2_planner":
      return `### When to Search (Round 2 Planner)

You have the full history of all prior rounds. Use it to create precise fix packets:

- **QA findings to fix** — the specific issues driving this replanning:
  \`search_memory({query: "QA issues critical major findings"})\`

- **Prior builder patterns** — understand what code patterns exist:
  \`search_memory({query: "builder reasoning implementation decisions"})\`

- **Prior evaluator findings** — context on what failed before and was later fixed:
  \`search_memory({query: "evaluator report hard failures diagnostic"})\`

- **Completion summaries** — understand what each packet established:
  \`search_memory({query: "completion summary files integration points"})\``;

    case "qa_agent":
      return `### When to Search (QA Agent)

You have the richest memory context — everything from all packets. Use it:

- **Cross-packet integration points** — find where packets hand off to each other:
  \`search_memory({query: "cross-packet integration decisions handoff"})\`

- **What each builder changed** — understand the scope of each packet's work:
  \`search_memory({query: "builder report changed files"})\`

- **Evaluator verdicts** — confirm all packets actually passed:
  \`search_memory({query: "evaluator report overall verdict pass"})\`

- **Spec integration scenarios** — find the scenarios you should walk through:
  \`search_memory({query: "integration scenarios user journey"})\`

- **Known risks** — find what the planner flagged as risky:
  \`search_memory({query: "risk register watchpoints"})\``;

    case "contract_builder":
      return `### When to Search (Contract Builder)

Search to avoid reinventing patterns already established:

- **Prior accepted contracts** — find what good contracts look like in this run:
  \`search_memory({query: "accepted contract acceptance criteria patterns"})\`

- **Spec details for this packet** — find relevant spec context:
  \`search_memory({query: "specification packet objective", role: "planner"})\`

- **Prior contract evaluator feedback** — find what the evaluator required in past rounds:
  \`search_memory({query: "contract review required changes"})\``;

    case "contract_evaluator":
      return `### When to Search (Contract Evaluator)

Search to calibrate your review against established patterns:

- **Accepted contracts from prior packets** — what quality bar was set before:
  \`search_memory({query: "accepted contract acceptance criteria"})\`

- **Spec objectives** — verify the proposal aligns with the planner's intent:
  \`search_memory({query: "specification objectives planner"})\`

- **Prior contract revision history** — understand what has been revised and why:
  \`search_memory({query: "contract proposal revision round"})\``;

    case "plan_reviewer":
      return `### When to Search (Plan Reviewer)

The planner just finished — their reasoning is fresh in memory:

- **Planner's research and decisions** — understand why they structured the plan this way:
  \`search_memory({query: "planner reasoning research decisions", role: "planner"})\`

- **Full specification** — read what the planner produced:
  \`search_memory({query: "specification SPEC.md packets"})\``;

    default:
      return `### When to Search

Search memory when you need context from prior agent phases:
\`search_memory({query: "relevant terms for your context"})\``;
  }
}
