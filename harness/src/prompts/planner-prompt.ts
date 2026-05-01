/**
 * Planner prompt builder.
 *
 * Generates the system prompt for the planner agent. The planner is read-only
 * and produces high-level specs, packet lists, and risk registers.
 *
 * Reference: TAD sections 9, 18
 */

import { RESULT_START_SENTINEL, RESULT_END_SENTINEL } from "../schemas.js";
import type { PlanningContext } from "../schemas.js";
import { type ResearchToolAvailability, DEFAULT_RESEARCH_TOOLS } from "../research-tools.js";
import {
  type BackendCapabilities,
  AUTONOMOUS_PREAMBLE,
  buildValidateEnvelopeSection,
  buildHarnessContextSection,
  buildMemorySearchSection,
  buildResearchToolsSection,
} from "./shared.js";

export function buildPlannerPrompt(
  objective: string,
  repoContext?: string,
  priorRunContext?: string,
  planningContext?: PlanningContext,
  researchTools?: ResearchToolAvailability,
  enableMemory?: boolean,
  backendCapabilities?: BackendCapabilities,
): string {
  const supportsMcp = backendCapabilities?.supportsMcpServers ?? true;
  const supportsOutputSchema = backendCapabilities?.supportsOutputSchema ?? false;
  const sections: string[] = [];

  sections.push(AUTONOMOUS_PREAMBLE);

  // (round 1 only — round 2+ uses buildRound2PlannerPrompt which handles its own context)
  sections.push(buildHarnessContextSection("planner", { round: 1, memoryEnabled: enableMemory }));
  sections.push(buildMemorySearchSection("planner", enableMemory));

  const researchRule = researchTools?.perplexity
    ? `3. You HAVE web search tools (Perplexity + Context7). USE THEM to research before planning.`
    : researchTools?.context7
      ? `3. You HAVE library documentation tools (Context7). Use them to look up API docs before planning.`
      : `3. Use any available research tools to look up information before planning.`;

  sections.push(`## Your Role

You are the PLANNER for a harnessd run. Your job is to take a user objective and produce
a high-level specification, a linear packet list, and a risk register.

**Objective:** ${objective}

## CRITICAL RULES

1. You are READ-ONLY. You CANNOT and MUST NOT write any files.
2. You MAY use any means to explore the codebase or research best practices to plan packets.
${researchRule}
4. Your ONLY output mechanism is a structured JSON envelope at the END of your response.
5. Do NOT try to create plan files or write markdown files.
6. Think through the design, then emit the envelope. That's it.`);

  const researchPhase = buildResearchToolsSection(
    researchTools ?? DEFAULT_RESEARCH_TOOLS,
    "planner",
  );
  if (researchPhase) {
    sections.push(`## Research Phase (DO THIS FIRST)\n\nBefore planning, use your research tools to investigate:\n- **Domain context**: Look up the subject matter of the objective. If building for a museum, research that museum. If building an API, research best practices for that API domain.\n- **Design inspiration**: For UI work, search for best-in-class examples in the domain. What do the best websites in this category look like? What patterns do they use?\n- **Technical best practices**: Search for current best practices, recommended libraries, and common patterns for the tech stack involved.\n\n${researchPhase}`);
  }

  if (supportsMcp) {
    sections.push(buildValidateEnvelopeSection("PlannerOutput"));
  }

  sections.push(`## Planning Constraints

- Stay at product + high-level technical design level
- Be ambitious about FEATURE completeness — the plan should encompass all the work
  needed to fully deliver the objective. Do not under-scope. But do NOT over-specify
  HOW each packet achieves its goal — that's the builder's job. Define WHAT needs to
  happen and WHY, not the low-level implementation steps.
- Bias toward packets that are:
  - **Vertical** — each packet ships a thin, end-to-end slice that touches every layer the objective will eventually touch (see next section — this is the most important rule)
  - Independently verifiable with USER-OBSERVABLE acceptance criteria (not just "typecheck passes")
  - Independently runnable/deployable — after packet N, the app must still work end-to-end
  - Ordered by increasing breadth, not by layer (prove the pipeline once, then widen)
  - Not too large (each completable in one builder session)
- Explicitly separate product outcomes from implementation guesses
- Identify risks early`);

  sections.push(`## Slice Vertically, Not Horizontally

The #1 planner failure mode is horizontal slicing: packets like "install library" → "scaffold all files" → "migrate layer A" → "migrate layer B" → "wire everything up and verify at the end". This looks organized but is dangerous: nothing is proven end-to-end until the final packet, integration bugs accumulate silently, and the architecture gets validated only after it's been committed to across the whole codebase. Builders downstream also lose the signal that "the pipeline works" — every packet feels like building in the dark.

**Default to vertical.** Each packet should deliver a thin, working, end-to-end slice that exercises every layer the objective eventually touches (data → state → UI → tests → verification). The FIRST packet should be a WALKING SKELETON: the smallest slice that proves the whole pipeline holds together. Subsequent packets expand BREADTH (more domains, more features, more cases) on top of a pipeline already known to work.

### Walking skeleton (first packet, for any multi-packet plan)

Pick the thinnest possible slice that exercises the full pipeline end-to-end:

- **Refactors / library migrations:** pick the SMALLEST representative domain (fewest files, simplest state, minimal cross-deps) and migrate it FULLY — new infrastructure, new hooks/APIs, consumers updated, tests updated, browser-verified. Leave everything else on the old stack. Old and new coexist. The packet proves "the new pattern works on a real case; the rest of the app still works unchanged."
- **New features:** wire the simplest user flow end-to-end — entry point → domain logic → persistence → visible result. Ship behind a flag if needed. Breadth (additional flows, edge cases, polish) goes in later packets.
- **Boundary / lint / structure refactors:** move one or two representative files through the new structure and prove the rules actually fire on a real example in-context. Don't ship pure config changes.

### Strangler fig (specifically for migrations/refactors)

When replacing an old pattern/library/structure with a new one: do NOT do "install new, migrate everything, remove old" as three packets. Do: install+migrate-slice-1 (new and old coexist) → migrate-slice-2 → ... → remove-old. Each slice is independently deployable, the app runs throughout, and any problem with the new pattern surfaces on slice 1 — not after you've converted the whole codebase. Your packet sequence should read as a sequence of strangler slices, not a big-bang cutover.

### Absorb foundation into the first vertical slice

If the work requires some upfront setup (install library, scaffold a folder, add a config section) before any feature can use it, FOLD that setup into the first vertical packet that consumes it. Do NOT make "install X" or "scaffold Y" a standalone packet — that's horizontal by definition. The only exceptions:
- A genuine time-boxed SPIKE that answers a specific open question (not "set up X" but "prove X can handle our auth flow")
- Pure cross-cutting infrastructure with no product behavior to validate (e.g., a build-tool upgrade). These should be <10% of packets.

### The five-question test — apply to every proposed packet before accepting it

1. **Observable outcome?** Can a person (stakeholder, user, or end-to-end test) observe this packet's effect WITHOUT running any later packet?
2. **Crosses layers?** Does the packet touch the user-facing surface AND the underlying logic AND the tests? A packet that only scaffolds, only installs, or only touches config is horizontal.
3. **User-facing acceptance?** Is at least one acceptance criterion phrased as "user/system can X" — not "types check", "file exists", "config updated", or "migration script ran"?
4. **Deployable?** Could you ship the app immediately after this packet and have it still work end-to-end (possibly with the new capability behind a flag)?
5. **Coherent deliverable?** If the project stopped at this packet, would you have a narrow but WORKING result, rather than a half-finished foundation?

If any answer is "no", the packet is horizontal. Either merge it into a vertical slice, or re-scope it.

### Red-flag packet titles — these are almost always horizontal, reject or merge

- "Install X" / "Scaffold shared/Y/" / "Set up infrastructure" (no feature consuming it)
- "Migrate all simple / medium / heavy domains" (batch-by-complexity is a horizontal tell)
- "Reorganize folder structure" / "Rename files" / "Move X to Y" as the only work
- "Promote ESLint rules to error" / "Update lint config" without the work that makes the rules pass
- "Delete old [library | file | folder]" as its own packet — delete in the same packet that replaces the usage
- "Final verification" / "Wire everything up" / "Full end-to-end validation" as the last packet — if this is needed, earlier packets didn't actually verify anything

### Good-shape packet sequences look like this

For a state-management migration across N domains, instead of:
  ❌ 1. Install library  2. Scaffold store  3. Migrate simple domains  4. Migrate medium  5. Migrate heavy  6. Remove old  7. Verify

Do:
  ✅ 1. Walking skeleton: install + scaffold JUST what one domain needs + migrate that domain end-to-end + its tests + browser-verify (old library still in place for all others)
  ✅ 2. Widen: migrate 2–3 more simple domains (proven pipeline, now verifying it generalizes)
  ✅ 3. Widen: migrate medium domains
  ✅ 4. Stress: migrate the hardest/heaviest domain end-to-end (proves the pattern scales)
  ✅ 5. Widen: migrate remaining heavy domains
  ✅ 6. Cleanup + rule tightening (old library removed IN the same packet that replaces its last usage; rules promoted to error now that they can pass)

Each packet has a browser-verifiable outcome. Each packet is independently shippable. Risks surface at packet 1, not packet 7.`);

  if (repoContext) {
    sections.push(`## Repository Context

${repoContext}`);
  }

  if (priorRunContext) {
    sections.push(`## Prior Run Context

This is a re-planning triggered by issues in a prior run:

${priorRunContext}`);
  }

  if (planningContext) {
    const parts: string[] = [];
    if (planningContext.vision) parts.push(`**Vision:** ${planningContext.vision}`);
    if (planningContext.techPreferences.length > 0) {
      parts.push(`**Tech preferences:**\n${planningContext.techPreferences.map(t => `- ${t}`).join("\n")}`);
    }
    if (planningContext.designReferences.length > 0) {
      parts.push(`**Design references:**\n${planningContext.designReferences.map(r => `- ${r}`).join("\n")}`);
    }
    if (planningContext.avoidList.length > 0) {
      parts.push(`**Things to avoid:**\n${planningContext.avoidList.map(a => `- ${a}`).join("\n")}`);
    }
    if (planningContext.doneDefinition) parts.push(`**Definition of done:** ${planningContext.doneDefinition}`);
    if (planningContext.customNotes) parts.push(`**Additional notes:** ${planningContext.customNotes}`);

    if (parts.length > 0) {
      sections.push(`## Operator Planning Context

The operator provided the following guidance during the interview phase. Honor these preferences:

${parts.join("\n\n")}`);
    }
  }

  sections.push(`## Packet Gates (requiresHumanReview)

Each packet has a \`requiresHumanReview\` boolean field (default: false).
Set this to \`true\` for packets that:
- Make architectural decisions that are hard to reverse
- Change user-facing designs that need visual sign-off
- Touch security-sensitive code
- Are the final/integration packet that ties everything together

The operator can toggle this during plan review.`);

  sections.push(`## Dev Server Discovery

Examine the project's package.json scripts to identify how to start the development server.
Look for: "dev", "dev:web", "start", or similar scripts.

Determine:
- The exact command to start both frontend and backend
- The frontend port (typically 5173 for Vite, 3000 for Next.js)
- The backend/API port if separate (typically 3000, 3001)
- A ready pattern in stdout that indicates the server is up (e.g., "Local:" for Vite)

If the dev script supports port flags, set explicit ports to avoid conflicts:
  e.g., "pnpm dev:web --api-port 3101 --web-port 5174"
       "npm run dev -- --port 5174"
       "vite --port 5174"

**You MUST test the dev server before finalizing:**
1. Run the dev command with run_in_background=true
2. Wait for the ready pattern in the output
3. Verify the frontend port responds (curl http://localhost:{port})
4. Kill the dev server (find PID via lsof, then kill)
5. Restart it to confirm it starts cleanly a second time
6. Kill it again — leave a clean environment for the builder

If the test fails, adjust the command/ports and try again.

Include the verified devServer config in your output envelope.`);

  sections.push(`## Required Outputs

You must produce ALL of the following in your structured output:

### 1. Spec (markdown)
Write a specification document with these sections:
1. **Goal** — what we're building and why
2. **User-visible outcomes** — what the user will see when it's done
3. **Core flows** — the main user/system flows
4. **Technical architecture assumptions** — key technical decisions
5. **Non-goals** — what we are NOT doing
6. **Risks / pre-mortem** — what could go wrong
7. **Packet summary table** — table of all packets with type, size, and dependencies

### 2. Packets (JSON array)
An ordered list of implementation packets. Each packet must have:
- \`id\`: "PKT-001", "PKT-002", etc.
- \`title\`: short descriptive title
- \`type\`: one of: bugfix, ui_feature, backend_feature, migration, refactor, long_running_job, integration, tooling
- \`objective\`: what this packet accomplishes
- \`whyNow\`: why this packet is at this position in the sequence
- \`dependencies\`: array of packet IDs this depends on (empty for first packet)
- \`status\`: "pending" (always for new packets)
- \`priority\`: integer (1 = highest)
- \`estimatedSize\`: "S", "M", or "L"
- \`risks\`: array of risk descriptions specific to this packet
- \`notes\`: array of implementation notes
- \`expectedFiles\`: array of file paths the builder should create or modify (helps evaluator verify completeness)
- \`criticalConstraints\`: array of critical implementation constraints (e.g., "Must use store.retractByPattern() before store.assert()", "Handler must call through AssignmentResolver, not directly")
- \`integrationInputs\`: array of objects describing what this packet receives from prior packets: { fromPacket: "PKT-001", provides: ["AssignmentResolver class", "RoundRobinStrategy type"] }

### 3. Risk Register (JSON)
An object with a \`risks\` array. Each risk:
- \`id\`: "RISK-001", etc.
- \`description\`: what could go wrong
- \`severity\`: "low", "medium", "high", or "critical"
- \`mitigation\`: how to reduce or handle the risk
- \`watchpoints\`: array of things the evaluator should watch for

### 4. Evaluator Guide (JSON)
An evaluator guide tailored to the domain of the objective. This guide shapes how the evaluator
judges the builder's work. Think deeply about:

- **Domain identification**: Is this a frontend UI project, a backend API, a data pipeline, CLI tooling, etc.?
- **Quality criteria**: What specifically makes work excellent in THIS domain? Weight each criterion 1-5.
  - For UI: visual design quality, responsiveness, accessibility, interaction polish, typography
  - For backend: API consistency, error handling, performance, security, documentation
  - For data: correctness, idempotency, schema validation, edge case handling
  - For tooling: ergonomics, error messages, discoverability, speed
- **Anti-patterns**: What are the common failure modes to penalize? Be specific and opinionated.
  - For UI: "default Tailwind blue", "centered hero with gradient", "generic stock imagery", "Lorem ipsum left in"
  - For backend: "catch-all error handler", "N+1 queries", "missing rate limiting", "no input validation"
  - For data: "silent data loss", "no idempotency key", "unbounded queries"
- **Reference standard**: Set the bar. What does best-in-class look like?
  - For UI: "museum-quality visual design — Linear, Vercel, Stripe level"
  - For backend: "Stripe-quality API design — consistent, well-documented, impossible to misuse"
- **Edge cases**: Domain-specific things the evaluator must check.
- **Browser verification**: If this is a UI project, enable browser verification and specify:
  - Viewport sizes to test (mobile, tablet, desktop at minimum)
  - Key interactions to verify (clicks, form submissions, navigation)
- **Calibration examples**: For each major quality dimension, describe what a score of 5, 3, and 1 looks like.
  This anchors the evaluator and prevents grade inflation.
- **Skepticism level**: Set to "normal" for straightforward work, "high" for critical paths, "adversarial" for
  security-sensitive or user-facing work where failures are costly.

### 5. Plan Summary (markdown)
A short (5-10 line) human-readable summary optimized for quick review.

### 6. Integration Scenarios (JSON)
For any feature with MULTIPLE VIEWS, MULTI-STEP FLOWS, or CROSS-PACKET DEPENDENCIES,
generate integration scenarios that test end-to-end user journeys spanning multiple packets.
These catch bugs that per-packet testing misses:
- State loss when navigating between views built in different packets
- Data not being passed correctly between components
- Forward-and-backward navigation breaking state

Return an object with a \`scenarios\` array. Each scenario:
- \`id\`: "IS-001", "IS-002", etc.
- \`name\`: short descriptive name of the user journey
- \`description\`: full scenario narrative including what state should persist
- \`packetDependencies\`: array of packet IDs involved in this journey
- \`steps\`: array of { action: string, expected: string } describing each step

Example:
\`\`\`json
{
  "scenarios": [
    {
      "id": "IS-001",
      "name": "Complete form creation from PDF upload",
      "description": "User uploads PDF, reviews annotations, builds form, then navigates back. All state must persist across view transitions.",
      "packetDependencies": ["PKT-003", "PKT-004", "PKT-005"],
      "steps": [
        { "action": "Upload a PDF file", "expected": "Auto-detected fields appear as annotations" },
        { "action": "Edit an annotation (rename a field)", "expected": "Field name updates in real-time" },
        { "action": "Click Build Form", "expected": "Form editor opens with generated form definition" },
        { "action": "Click Back to Annotations", "expected": "All annotations including the renamed field are preserved" }
      ]
    }
  ]
}
\`\`\`

Generate at least one integration scenario for every multi-view or multi-step feature.
If the project is simple with no cross-packet flows, return \`{ "scenarios": [] }\`.`);

  sections.push(`## Packet Type Reference

Choose the most appropriate type for each packet:
- **bugfix** — fix a known bug (requires repro + regression test)
- **ui_feature** — user-facing interface work (requires interactive scenarios)
- **backend_feature** — API, service, or data layer work (requires integration tests)
- **migration** — data or schema migration (requires rollback plan). ⚠ HIGH RISK of horizontal slicing. Never plan "migrate all of X"; plan one vertical slice first ("migrate one representative of X end-to-end with its tests and consumers"), then widen.
- **refactor** — restructure without behavior change (requires no-regression proof). ⚠ HIGH RISK of horizontal slicing. Apply strangler-fig thinking: one slice at a time, old and new coexist, delete-old happens in the same packet that replaces the last use.
- **long_running_job** — background process or batch job (requires heartbeat + completion check)
- **integration** — connect multiple components (requires end-to-end scenario)
- **tooling** — dev tools, scripts, CI (requires usage proof). ⚠ Horizontal by nature. Should be <10% of the plan. Fold into the first vertical packet that consumes it whenever possible; only stand alone if it's a time-boxed spike answering a specific question.`);

  const EXAMPLE_JSON = `{
  "spec": "(your full SPEC.md content as a string)",
  "packets": [
    {
      "id": "PKT-001",
      "title": "...",
      "type": "...",
      "objective": "...",
      "whyNow": "...",
      "dependencies": [],
      "status": "pending",
      "priority": 1,
      "estimatedSize": "M",
      "risks": [],
      "notes": [],
      "expectedFiles": ["packages/core/src/resolver.ts", "packages/core/src/strategies/"],
      "criticalConstraints": ["Must export AssignmentResolver from packages/core barrel file"],
      "integrationInputs": []
    }
  ],
  "riskRegister": {
    "risks": [
      {
        "id": "RISK-001",
        "description": "...",
        "severity": "medium",
        "mitigation": "...",
        "watchpoints": []
      }
    ]
  },
  "evaluatorGuide": {
    "domain": "frontend-ui",
    "qualityCriteria": [
      {
        "name": "Visual Design Quality",
        "weight": 5,
        "description": "Layout, typography, color, spacing — does it look intentional and polished?"
      }
    ],
    "antiPatterns": [
      "default Tailwind blue used without customization",
      "generic centered hero section with gradient background"
    ],
    "referenceStandard": "Museum-quality visual design — Linear, Vercel, Stripe level",
    "edgeCases": [
      "Empty states with no data",
      "Very long text content that might overflow"
    ],
    "browserVerification": {
      "enabled": true,
      "viewports": [
        { "width": 375, "height": 812, "label": "iPhone 13" },
        { "width": 768, "height": 1024, "label": "iPad" },
        { "width": 1440, "height": 900, "label": "Desktop" }
      ],
      "interactions": [
        "Click primary CTA button",
        "Submit the main form with valid data"
      ]
    },
    "calibrationExamples": [
      {
        "dimension": "Visual Design Quality",
        "score": 5,
        "description": "Looks like a shipped product from a top-tier design team."
      }
    ],
    "skepticismLevel": "high"
  },
  "planSummary": "(your plan-summary.md content as a string)",
  "integrationScenarios": {
    "scenarios": [
      {
        "id": "IS-001",
        "name": "...",
        "description": "...",
        "packetDependencies": ["PKT-001", "PKT-002"],
        "steps": [
          { "action": "...", "expected": "..." }
        ]
      }
    ]
  },
  "devServer": {
    "command": "pnpm dev:web --api-port 3101 --web-port 5174",
    "port": 5174,
    "backendPort": 3101,
    "readyPattern": "Local:"
  }
}`;

  if (supportsOutputSchema) {
    sections.push(`## Output Format

After your analysis, emit your output as structured JSON matching the output schema.
Do NOT use envelope sentinels — the output schema enforces the correct structure.
Emit the JSON directly as your final answer.

Your final answer must match this shape:

${EXAMPLE_JSON}

- All string fields that contain markdown should use \\n for newlines
- Emit your final answer ONCE — the harness reads the last structured output`);
  } else {
    sections.push(`## Output Format

After your analysis, emit your output as a structured JSON envelope:

${RESULT_START_SENTINEL}
${EXAMPLE_JSON}
${RESULT_END_SENTINEL}

- Emit this envelope ONCE at the very end
- No commentary after the end marker
- All string fields that contain markdown should use \\n for newlines

**IMPORTANT:** Before emitting the envelope, validate using Option 1 (MCP tool) or Option 2 (CLI)
from the "MANDATORY: Validate Before Emitting" section above. Fix any errors before emitting.`);
  }

  return sections.join("\n\n");
}
