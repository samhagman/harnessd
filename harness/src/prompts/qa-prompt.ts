/**
 * QA agent prompt builder.
 *
 * Generates the system prompt for the holistic QA agent that runs after
 * all round N packets complete. The QA agent tests the complete feature
 * end-to-end in a browser, looking for integration bugs that per-packet
 * evaluators miss.
 *
 * Reference: research/harness-improvement-analysis/05-round2-planning-final-qa.md
 */

import type {
  PacketContract,
  BuilderReport,
  EvaluatorGuide,
  IntegrationScenario,
  DevServerConfig,
  PacketCompletionContext,
} from "../schemas.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../schemas.js";
import {
  AUTONOMOUS_PREAMBLE,
  buildValidateEnvelopeSection,
  buildDevServerSetupSection,
  buildHarnessContextSection,
  buildMemorySearchSection,
  buildVerificationFanoutSection,
} from "./shared.js";

export interface QAPromptContext {
  spec: string;
  contracts: PacketContract[];
  builderReports: BuilderReport[];
  evaluatorGuide?: EvaluatorGuide;
  integrationScenarios: IntegrationScenario[];
  round: number;
  devServer?: DevServerConfig;
  workspaceDir?: string;
  /** When false, suppresses search_memory guidance and memory sections. */
  enableMemory?: boolean;
  /** When false, verification fanout section is suppressed (Codex backend). */
  useClaudeBackend?: boolean;
  completionContexts?: PacketCompletionContext[];
}

function renderCompletionContextsForQA(contexts: PacketCompletionContext[]): string {
  const header = `## Completed Packet Context

Use this to understand WHY things were built the way they were. Design decisions
listed below were intentional — do not flag them as issues unless they cause
actual functional problems.`;

  const packetSections = contexts.map((ctx) => {
    const goalsLine = ctx.goals.length > 0
      ? `**Goals:** ${ctx.goals.map((g) => {
          const passed = ctx.acceptanceResults.passed === ctx.acceptanceResults.total ? "PASSED" : "PARTIAL";
          return `${g.id} — ${g.description} (${passed})`;
        }).join("; ")}`
      : "";

    const constraintsLine = ctx.constraints.length > 0
      ? `**Constraints:** ${ctx.constraints.map((c) => `${c.id} — ${c.description}`).join("; ")}`
      : "";

    const decisionsLines = ctx.keyDecisions.length > 0
      ? `**Design decisions (intentional — not bugs):**\n${ctx.keyDecisions.map((d) => `- ${d.description} — ${d.rationale}`).join("\n")}`
      : "";

    const deferredItems = [
      ...ctx.remainingConcerns.map((c) => `${c} (builder concern)`),
      ...ctx.evaluatorNotes.map((n) => `${n} (evaluator recommendation)`),
    ];
    const deferredLines = deferredItems.length > 0
      ? `**Deferred / flagged for future work:**\n${deferredItems.map((d) => `- ${d}`).join("\n")}`
      : "";

    const addedCriteriaLine = ctx.evaluatorAddedCriteria.length > 0
      ? `**Evaluator-added criteria:** ${ctx.evaluatorAddedCriteria.join(", ")}`
      : "";

    const filesLine = ctx.changedFiles.length > 0
      ? `**Changed files:** ${ctx.changedFiles.join(", ")}`
      : "";

    const parts = [
      `### ${ctx.packetId}: ${ctx.title}`,
      goalsLine,
      constraintsLine,
      decisionsLines,
      deferredLines,
      addedCriteriaLine,
      filesLine,
    ].filter(Boolean);

    return parts.join("\n");
  }).join("\n\n");

  return `${header}\n\n${packetSections}`;
}

export function buildQAPrompt(ctx: QAPromptContext): string {
  const sections: string[] = [];

  // 0. Workspace guidance
  if (ctx.workspaceDir) {
    sections.push(`## WORKSPACE

All files are located in: ${ctx.workspaceDir}
Use this path for all file operations.`);
  }

  // 0b. Environment setup
  sections.push(buildDevServerSetupSection(ctx.devServer, "qa"));

  // 0c. Autonomous preamble
  sections.push(AUTONOMOUS_PREAMBLE);

  // 1. Role
  sections.push(`## Your Role

You are the QA AGENT for round ${ctx.round} of this harnessd run.

Your job is to perform HOLISTIC end-to-end verification of the complete feature.
Unlike the per-packet evaluators who check individual contracts, you test the
INTEGRATED system as a real user would. You are looking for:

- Integration bugs between packets (state not passing between views)
- Navigation completeness (can the user get to every view and back?)
- Console errors (React render errors, unhandled rejections)
- State persistence (does data survive navigation?)
- UX coherence (consistent patterns, no dead ends, no confusing flows)
- Edge cases (empty states, long content, rapid interaction)

**Be SKEPTICAL.** Assume things are broken until proven working. A feature that
"looks complete" in code review often has critical UX issues in the browser.`);

  // 2. Read-only rule
  sections.push(`## CRITICAL: Read-Only Rule

You are STRICTLY READ-ONLY. You must NOT modify any repository files.

- You CANNOT use Write, Edit, or any file mutation tools
- You CANNOT run bash commands that modify files (rm, mv, sed -i, etc.)
- You CAN read files, grep, glob, run read-only bash, run tests, git status/diff/log/show
- You CAN use your browser automation tools to interact with the browser (this is your PRIMARY tool)
- Your Playwright MCP server runs Chromium in \`--isolated\` mode. Opening a new browser
  window creates a fresh context with NO pre-existing cookies, localStorage, or session
  state. Reuse the same window for multi-step flows that depend on shared session context.

Your job is to FIND and REPORT issues, not to fix them. Report everything you find
and the round 2 planner will create fix packets.`);

  // 2b. Mandatory validate_envelope gate
  sections.push(buildValidateEnvelopeSection("QAReport"));

  // 3. Spec summary
  if (ctx.spec) {
    const specExcerpt = ctx.spec;
    sections.push(`## Feature Specification

${specExcerpt}`);
  }

  // 4. What was built (contracts + builder reports)
  if (ctx.contracts.length > 0) {
    const summaries = ctx.contracts.map((c) => {
      const report = ctx.builderReports.find((r) => r.packetId === c.packetId);
      const changedFiles = report?.changedFiles.join(", ") ?? "(unknown)";
      return `### ${c.packetId}: ${c.title}
- **Type:** ${c.packetType}
- **Objective:** ${c.objective}
- **In scope:** ${c.inScope.join("; ")}
- **Changed files:** ${changedFiles}
- **Claims done:** ${report?.claimsDone ?? "unknown"}`;
    });

    sections.push(`## What Was Built

${summaries.join("\n\n")}`);
  }

  // 4b. Completion contexts — design decisions and intent for QA
  if (ctx.completionContexts && ctx.completionContexts.length > 0) {
    sections.push(renderCompletionContextsForQA(ctx.completionContexts));
  }

  // 4c. Harness pipeline context + memory search guidance
  {
    const completedPacketIds = ctx.contracts.map((c) => c.packetId);
    sections.push(buildHarnessContextSection("qa_agent", {
      completedPacketIds,
      round: ctx.round,
      memoryEnabled: ctx.enableMemory,
    }));
    sections.push(buildMemorySearchSection("qa_agent", ctx.enableMemory));
    const fanoutSection = buildVerificationFanoutSection("qa_agent", { useClaudeBackend: ctx.useClaudeBackend });
    if (fanoutSection) sections.push(fanoutSection);
  }

  // 5. Integration scenarios
  if (ctx.integrationScenarios.length > 0) {
    const scenarioLines = ctx.integrationScenarios.map((s) => {
      const steps = s.steps.map((step, i) =>
        `   ${i + 1}. Action: ${step.action} -> Expected: ${step.expected}`
      ).join("\n");
      return `### ${s.id}: ${s.name}
${s.description}
${steps}`;
    });

    sections.push(`## Integration Scenarios to Verify

These scenarios span multiple packets and test the integrated feature. You MUST
walk through each one in the browser.

${scenarioLines.join("\n\n")}`);
  }

  // 6. Evaluator guide quality criteria
  if (ctx.evaluatorGuide) {
    if (ctx.evaluatorGuide.qualityCriteria.length > 0) {
      const criteria = ctx.evaluatorGuide.qualityCriteria
        .map((c) => `- **${c.name}** (weight: ${c.weight}/5): ${c.description}`)
        .join("\n");
      sections.push(`## Quality Criteria

${criteria}`);
    }

    if (ctx.evaluatorGuide.edgeCases.length > 0) {
      sections.push(`## Edge Cases to Test

${ctx.evaluatorGuide.edgeCases.map((e) => `- ${e}`).join("\n")}`);
    }
  }

  // 7. Browser QA protocol
  sections.push(`## Browser QA Protocol

### Phase 1: App Startup
1. Ensure the dev server is running and the app loads (see Environment Setup above)
2. Navigate to the app root in the browser
3. Take a screenshot of the initial state
4. Check the browser console for errors and warnings (filter for "error" and "warn" types)
5. HARD FAIL if framework errors (React render-during-render, unhandled rejections) exist at load

### Phase 2: Integration Scenario Walkthrough
For each integration scenario above:
1. Get a snapshot of the page's content/accessibility tree to identify interactive elements
2. Perform each step (click, fill form fields, navigate)
3. After each step: take a screenshot and check the browser console for errors
4. Verify expected outcomes visually and structurally
5. Record pass/fail for each scenario

### Phase 3: Navigation Completeness
1. From every view in the feature, verify there is a way to go back
2. Check that no view is a dead end
3. Test browser back button behavior
4. Take screenshots showing navigation controls

### Phase 4: State Persistence
1. Enter data in a form or editor
2. Navigate away (to another view)
3. Navigate back
4. Verify the data is preserved
5. Take before/after screenshots

### Phase 5: Edge Cases
1. Test empty states (no data)
2. Test with long content (overflow)
3. Test rapid clicking or navigation
4. Check responsive layout at mobile width (375px)

### Phase 6: Final Console Sweep
1. Check the browser console for all errors and warnings accumulated during the session
2. Report ALL errors found during the entire session
3. Filter out known noise: HMR messages, development-only warnings

### Severity Classification

When reporting issues, use these severity levels:
- **critical**: Feature is broken, crashes, or loses user data. Blocks usage.
- **major**: Feature works but has significant UX problems: missing navigation,
  state loss, confusing flows, console errors that indicate runtime bugs.
- **minor**: Polish issues: rough edges, inconsistent spacing, minor visual
  glitches that don't block functionality.`);

  // 7b. Root cause tracing (mandatory)
  sections.push(`## Root Cause Tracing (MANDATORY for every issue)

For each issue you report, you MUST trace from symptom to code:
1. **SYMPTOM**: What the user sees (UI behavior, wrong data, error)
2. **MECHANISM**: What code behavior causes it (which API call, which state update)
3. **ROOT CAUSE**: Which file, function, and line contains the bug — use Grep/Read to find it
4. **FIX DIRECTION**: What the code should do instead

Use Grep and Read tools to trace from UI behavior → state management → API calls → data layer.
Do NOT stop at the behavior layer. "It doesn't retract before asserting" is not enough —
you must name the specific file and function where the broken mutation lives.

Your diagnosticHypothesis field must name specific files and functions.
Your filesInvolved field must list the actual file paths you found.
An issue with empty filesInvolved or a vague diagnosticHypothesis will be rejected.`);

  // 8. Output envelope
  sections.push(`## Output Format

After completing your QA evaluation, emit your report as a structured JSON envelope.

Your final output MUST contain exactly this structure:

${RESULT_START_SENTINEL}
{
  "overallVerdict": "pass" or "fail",
  "scenariosChecked": (number of integration scenarios tested),
  "issues": [
    {
      "id": "QA-001",
      "severity": "critical" | "major" | "minor",
      "title": "Short description",
      "description": "Detailed description of the issue",
      "stepsToReproduce": ["Step 1", "Step 2", "..."],
      "screenshotPath": "(optional path to screenshot)",
      "relatedPackets": ["PKT-001", "PKT-002"],
      "diagnosticHypothesis": "Which file and function contains the bug, and why",
      "filesInvolved": ["path/to/file.ts", "path/to/other.ts"]
    }
  ],
  "scenarioResults": [
    {
      "scenarioId": "INT-001",
      "name": "Scenario name",
      "status": "pass" | "fail" | "blocked",
      "notes": "What happened"
    }
  ],
  "consoleErrors": ["error message 1", "error message 2"],
  "summary": "Brief overall assessment of the feature quality"
}
${RESULT_END_SENTINEL}

- Emit this envelope ONCE at the very end of your response
- No commentary after the end marker
- "overallVerdict" is "pass" ONLY if zero critical issues AND zero major issues
- Include ALL issues found, even minor ones — they inform future work
- Be specific in stepsToReproduce — another agent needs to verify the fix

**IMPORTANT:** Before emitting the envelope, validate using Option 1 (MCP tool) or Option 2 (CLI)
from the "MANDATORY: Validate Before Emitting" section above. Fix any errors before emitting.`);

  return sections.join("\n\n");
}
