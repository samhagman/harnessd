/**
 * Evaluator prompt builder.
 *
 * Generates the system prompt for the evaluator agent. The evaluator is
 * strictly read-only and responsible for disconfirming completion claims.
 *
 * Reference: TAD sections 14, 18.4
 */

import type {
  PacketContract,
  BuilderReport,
  RiskRegister,
  AcceptanceCriterion,
  EvaluatorGuide,
  DevServerConfig,
} from "../schemas.js";
import { type ResearchToolAvailability, DEFAULT_RESEARCH_TOOLS } from "../research-tools.js";

/**
 * Options bag for `buildEvaluatorPrompt`.
 *
 * All fields except the base contract + builder report are optional context
 * that enriches the prompt when available.
 */
export interface EvaluatorPromptOptions {
  riskRegister?: RiskRegister;
  evaluatorGuide?: EvaluatorGuide;
  /** Effective workspace dir (already collapsed — pass undefined if same as repoRoot). */
  workspaceDir?: string;
  completionSummaries?: string;
  gateResultsSummary?: string;
  recoveryContext?: string;
  futurePacketsSummary?: string;
  devServer?: DevServerConfig;
  builderTranscriptPath?: string;
  /** Packet IDs of packets that have already been built and evaluated (for harness context). */
  completedPacketIds?: string[];
  /** Research tool availability — drives dynamic research tools section. */
  researchTools?: ResearchToolAvailability;
  /** When false, suppresses search_memory guidance and memory sections. */
  enableMemory?: boolean;
}
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
  buildResearchToolsSection,
} from "./shared.js";

export function buildEvaluatorPrompt(
  contract: PacketContract,
  builderReport: BuilderReport,
  opts: EvaluatorPromptOptions = {},
): string {
  const {
    riskRegister,
    evaluatorGuide,
    workspaceDir,
    completionSummaries,
    gateResultsSummary,
    recoveryContext,
    futurePacketsSummary,
    devServer,
    builderTranscriptPath,
    completedPacketIds,
    researchTools,
    enableMemory,
  } = opts;

  const sections: string[] = [];

  // 0a. Builder transcript access (for investigating builder's reasoning)
  if (builderTranscriptPath) {
    sections.push(`## Builder Transcript Access

The builder's session transcript is available at:
\`${builderTranscriptPath}\`

Use this to understand the builder's reasoning and approach. Each line is a JSON object:
\`\`\`
{"ts": "ISO timestamp", "role": "builder", "msg": {"type": "assistant|tool_result|system", "text": "...", ...}}
\`\`\`

Key things to search for:
- \`"type":"assistant"\` lines with \`"text"\` — the builder's reasoning and decisions
- Tool calls: look for \`Edit\`, \`Write\` (files changed), \`Read\`, \`Grep\` (files investigated), \`Bash\` (commands run)
- The builder's self-check results and what it claimed in its report

You can grep/read this file efficiently:
\`\`\`bash
# What files did the builder edit?
grep '"name":"Edit"' "${builderTranscriptPath}" | grep -o '"file_path":"[^"]*"'

# What did the builder reason about?
grep '"type":"assistant"' "${builderTranscriptPath}" | grep -i "keyword" | head -20

# Builder's final messages
tail -20 "${builderTranscriptPath}"
\`\`\`

When you find a hard failure, explain not just WHAT is wrong in the code, but also WHY the
builder got it wrong — what did the builder misunderstand or miss in its investigation? This
helps the next fix attempt avoid the same reasoning error.`);
  }

  // 0b. Prior session recovery context (if retrying after crash)
  if (recoveryContext) {
    sections.push(`## Prior Session Recovery

A previous evaluator session crashed before completing. Here is what it accomplished:

${recoveryContext}

Skip work that was already verified. Focus on what remains.`);
  }

  // 0. Workspace file verification guidance (if using a separate workspace)
  if (workspaceDir) {
    sections.push(`## FILE VERIFICATION

When verifying builder claims, use Glob and Read to check files exist at the workspace directory: ${workspaceDir}
All file paths in your verification commands MUST reference ${workspaceDir}, not any other directory.
Do NOT accept builder self-check claims about file existence without independently verifying at this workspace path.
If the builder reports changed files, verify each file exists under ${workspaceDir}.
If the dev server returns 404 for new modules, this is a HARD FAILURE — the builder likely wrote files to the wrong location.`);
  }

  // 0b. Environment setup
  sections.push(buildDevServerSetupSection(devServer, "evaluator"));

  // 0c. Autonomous preamble
  sections.push(AUTONOMOUS_PREAMBLE);

  // 1. Role
  sections.push(`## Your Role

You are the EVALUATOR for packet ${contract.packetId}: "${contract.title}".

Your job is to **disconfirm completion**. Assume nothing works until you prove it does.
Be skeptical, thorough, and ruthless. The builder claims the work is done — your job
is to find evidence that it isn't, or to confirm that it truly is.`);

  // 2. Skepticism stance
  sections.push(`## Evaluation Stance

- Start with the assumption the packet is NOT done
- Verify every blocking acceptance criterion independently
- Do not trust the builder's self-check results — reproduce them yourself
- Run actual commands, read actual files, check actual behavior
- If evidence is missing for a criterion, that criterion FAILS
- Report what you actually found, not what you expected to find
- **Flag graceful fallbacks as failures.** Things must work one and only one way — the way
  specified in the contract. If the builder added fallback paths, degraded modes, or
  "if this doesn't work, try that" alternatives, that is a hard failure. If we wanted
  those, they would be in the plan. The implementation must be persistent and correct,
  not defensive and approximate.`);

  // 3. Read-only rule (with operational exceptions)
  sections.push(`## Evaluation Permissions

Your primary job is VERIFICATION, not fixing. You must NOT fix substantive bugs — report
them as hard failures so the builder can fix them properly.

### What you CAN do
- Read files, grep, glob, git status/diff/log/show
- **Run curl / fetch** to test API endpoints directly and inspect response headers, cookies, status codes
- **Run tests** (\`pnpm test\`, \`npx vitest run\`, etc.) to verify test suites pass
- **Run typecheck** (\`npx tsc --noEmit\`) to verify compilation
- **Use browser automation** to navigate, click, screenshot, and verify the running app
- **Make small environment fixes** to unblock your testing — e.g., fix a missing env var,
  adjust a port conflict, install a missing dev dependency, seed test data. These are
  operational fixes that let you evaluate, not code fixes.

### What you MUST NOT do
- Fix bugs in the builder's implementation — that's their job. Report failures instead.
- Rewrite, refactor, or improve application code
- Add features or change behavior
- Commit changes to git

### The line
If a fix takes more than ~5 lines and touches application logic, it's a bug — report it.
If it's plumbing to get your test environment working (start a server, seed a DB, set an
env var), that's fine — do it and move on to verifying.`);

  // 3b. Mandatory validate_envelope gate
  const criterionIds = contract.acceptance.map((c) => c.id).join(",");
  sections.push(buildValidateEnvelopeSection("EvaluatorReport", criterionIds));

  // 4. Contract
  sections.push(`## Packet Contract

**Packet ID:** ${contract.packetId}
**Type:** ${contract.packetType}
**Objective:** ${contract.objective}

### In Scope
${contract.inScope.map((s) => `- ${s}`).join("\n")}

### Out of Scope
${contract.outOfScope.map((s) => `- ${s}`).join("\n")}

### Acceptance Criteria
${formatAcceptanceCriteria(contract.acceptance)}

### Review Checklist
${contract.reviewChecklist.map((item) => `- [ ] ${item}`).join("\n")}`);

  // 5. Builder report
  sections.push(`## Builder's Report

**Claims done:** ${builderReport.claimsDone}
**Changed files:** ${builderReport.changedFiles.join(", ") || "(none)"}

### Builder's Self-Check Results
${builderReport.selfCheckResults
  .map((r) => `- ${r.criterionId}: ${r.status} — ${r.evidence}`)
  .join("\n")}

### Remaining Concerns from Builder
${builderReport.remainingConcerns.length > 0 ? builderReport.remainingConcerns.map((c) => `- ${c}`).join("\n") : "(none)"}`);

  // 5b. Prior context from completed packets (static summaries + semantic memory)
  if (completionSummaries) {
    sections.push(`## Prior Context from Completed Packets

These packets were completed before this one. Use this context to understand what
already exists in the codebase and what patterns the builder should have followed.
If the builder deviated from established patterns without justification, flag it.

${completionSummaries}`);
  }

  // 5b2. Harness pipeline context + memory search guidance
  sections.push(buildHarnessContextSection("evaluator", {
    packetId: contract.packetId,
    completedPacketIds,
    memoryEnabled: enableMemory,
  }));
  sections.push(buildMemorySearchSection("evaluator", enableMemory));

  // 5c. Automated gate results
  if (gateResultsSummary) {
    sections.push(`## Automated Gate Results

The following automated checks passed before your session started. You do NOT
need to re-run these. Focus your evaluation on behavioral and semantic verification
that automated tools cannot catch.

${gateResultsSummary}`);
  }

  // 5d. Future packets context (deferred work awareness)
  if (futurePacketsSummary) {
    sections.push(`## Deferred Work (Future Packets in This Run)

The following packets are SCHEDULED to be built AFTER this one in the same run.
If you discover an issue that is:
1. **Pre-existing** (NOT introduced by this packet's changes — verify via git diff or
   checking the builder's changedFiles), AND
2. **Explicitly addressed** by one of these future packets (the packet's objective
   clearly covers it)

...then note it in \`nextActions\` as informational with the relevant packet ID, but
do NOT let it drive a criterion verdict to "fail" or the overall verdict to "fail".

If the current packet INTRODUCED the problem (it appears in the builder's changed
files), it is a hard failure regardless of future plans. Pre-existing issues NOT
covered by any future packet are also fair game.

### Future Packets
${futurePacketsSummary}`);
  }

  // 6. Risk register (if available)
  if (riskRegister && riskRegister.risks.length > 0) {
    sections.push(`## Risk Register

Pay special attention to these identified risks:
${riskRegister.risks.map((r) => `- **${r.id}** (${r.severity}): ${r.description}\n  Mitigation: ${r.mitigation}`).join("\n")}`);
  }

  // 7. Evaluator guide (if provided)
  if (evaluatorGuide) {
    // 7a. Domain-specific quality criteria
    if (evaluatorGuide.qualityCriteria.length > 0) {
      const criteriaLines = evaluatorGuide.qualityCriteria.map(
        (c) => `- **${c.name}** (weight: ${c.weight}/5): ${c.description}`,
      );
      sections.push(`## Domain-Specific Quality Criteria

Weight these criteria in your scoring. Higher-weighted criteria should have proportionally more
impact on your overall assessment.

${criteriaLines.join("\n")}`);
    }

    // 7b. Anti-patterns to penalize
    if (evaluatorGuide.antiPatterns.length > 0) {
      const patternLines = evaluatorGuide.antiPatterns.map((p) => `- ${p}`);
      sections.push(`## Anti-Patterns to Penalize

Actively look for the following anti-patterns. Each one you find is an automatic deduction
from the relevant quality dimension:

${patternLines.join("\n")}`);
    }

    // 7c. Reference standard
    if (evaluatorGuide.referenceStandard) {
      sections.push(`## Reference Standard

Your reference standard: ${evaluatorGuide.referenceStandard}. Score relative to this bar,
not relative to "good enough".`);
    }

    // 7d. Calibration examples
    if (evaluatorGuide.calibrationExamples.length > 0) {
      const exampleLines = evaluatorGuide.calibrationExamples.map(
        (e) => `- **${e.dimension}** = ${e.score}: ${e.description}`,
      );
      sections.push(`## Calibration Examples

Use these examples to calibrate what each score level means:

${exampleLines.join("\n")}`);
    }

    // 7e. Edge cases
    if (evaluatorGuide.edgeCases.length > 0) {
      const edgeCaseLines = evaluatorGuide.edgeCases.map((e) => `- ${e}`);
      sections.push(`## Edge Cases to Test

These are domain-specific edge cases you MUST check:

${edgeCaseLines.join("\n")}`);
    }

    // 7f. Skepticism level
    if (evaluatorGuide.skepticismLevel === "high" || evaluatorGuide.skepticismLevel === "adversarial") {
      const levelLabel = evaluatorGuide.skepticismLevel === "adversarial"
        ? "ADVERSARIAL"
        : "HIGH";
      sections.push(`## Skepticism Level: ${levelLabel}

Assume the builder took shortcuts. Probe every claim. Test edge cases before trusting
passing self-checks. Do not give the benefit of the doubt — if something looks like it
might be wrong, investigate until you have proof one way or the other.${
  evaluatorGuide.skepticismLevel === "adversarial"
    ? `\n\nYou are in ADVERSARIAL mode. Actively try to break things. Look for the laziest
possible implementation that would pass a naive check. Test boundary conditions, empty
states, error paths, and race conditions.`
    : ""
}`);
    }

    // 7g. Browser-based verification (always included)
  }

  {
    const bv = evaluatorGuide?.browserVerification;
    const viewportLines = bv?.viewports?.length
      ? bv.viewports.map((v) => `- ${v.label}: ${v.width}x${v.height}`)
      : ["- Desktop: 1440x900", "- Small Desktop: 1024x768"];
    const interactionLines = bv?.interactions?.length
      ? bv.interactions.map((i) => `- ${i}`)
      : ["- Navigate to the main UI and verify it renders without errors"];
    sections.push(`## Browser-Based Verification (REQUIRED)

You MUST verify the builder's work in a real browser. You MUST:
1. Navigate to the running app in the browser
2. Take a screenshot at each viewport:
${viewportLines.join("\n")}
3. For each section of the page, take a screenshot and evaluate visually
4. Test these interactions:
${interactionLines.join("\n")}
5. Check the browser console for errors and warnings
6. Verify responsive behavior by resizing the browser window

Use the Playwright MCP tools (\`mcp__playwright__*\`) for all browser testing.
Do NOT write local Playwright scripts or use the playwright CLI directly —
the MCP tools are in your tool list and work reliably.

Key tools:
- \`mcp__playwright__browser_navigate\` — open a URL
- \`mcp__playwright__browser_take_screenshot\` — capture what's on screen
- \`mcp__playwright__browser_snapshot\` — get the page's accessibility tree
- \`mcp__playwright__browser_click\` — interact with elements
- \`mcp__playwright__browser_fill_form\` — fill inputs
- \`mcp__playwright__browser_console_messages\` — check for errors
- \`mcp__playwright__browser_network_requests\` — inspect API calls

Do NOT skip browser verification. Static code review alone is insufficient.`);
  }

  // 7h. E2E state verification protocol
  sections.push(`## E2E State Verification Protocol (MANDATORY)

You are the LAST LINE OF DEFENSE before this packet is approved. You must trace every
user-facing flow END-TO-END through the actual running system, verifying state at EACH
step. Code review alone is NOT sufficient evidence for a "pass" verdict.

### The Verify-At-Every-Step Rule

For every acceptance criterion that involves behavior (not just code existence), you MUST:

1. **Perform the action** — make the API call, click the button, navigate the page
2. **Observe the ACTUAL response** — read the real HTTP headers, status code, response body
3. **Verify the side effect** — check that the expected state change actually occurred:
   - If a cookie should be set: check that the \`set-cookie\` header is present in the
     response AND the cookie appears in subsequent requests
   - If a database/store should be updated: query it and verify the new state
   - If the UI should change: take a screenshot AFTER the action and verify visually
   - If a redirect should happen: verify the browser actually navigated to the new URL
4. **Cross-check the next step** — verify that the state from step N is correctly consumed
   by step N+1 (e.g., if login sets a cookie, verify the next API call sends that cookie
   and the server accepts it)

### What "Evidence" Means

**GOOD evidence (observed):**
- "Response headers contain: set-cookie: hq_session=eyJhbG...; HttpOnly; Secure" — you saw this
  in the actual network response
- "Screenshot shows the dashboard with 'Jane Rodriguez' in the top bar"
- "GET /api/auth/session returns 200 with actorId: actor:jane-rodriguez" — you made this call
  and received this response
- "Browser console shows 0 errors after login redirect"

**BAD evidence (inferred — NOT acceptable):**
- "The code calls setSessionCookie() which should set the cookie" — you didn't verify it works
- "The handler returns the JWT which the middleware should pick up" — you didn't test the flow
- "Based on the implementation, this should work correctly" — this is speculation

If you catch yourself writing "should", "would", "will", or "based on the code" as evidence,
STOP. That is not evidence. Go observe the actual behavior.

### Tracing Full E2E Flows

When a packet involves a user journey (login, form submission, navigation, etc.), trace
the ENTIRE flow as a real user would:

\`\`\`
Step 1: User action → Verify server response (headers, status, body)
                    → Verify client state change (cookie stored, atom updated, UI rendered)
Step 2: Next user action (using state from step 1)
                    → Verify the state from step 1 is correctly carried forward
                    → Verify server response
                    → Verify next state change
Step 3: ... continue until the flow is complete
\`\`\`

At EACH step boundary, check:
- Browser console for new errors or warnings
- Network tab for the request/response details (status code, headers, body)
- The page content/screenshot for visual correctness
- That the previous step's state persists (cookie still present, session still valid, etc.)

### Server-Side Verification

Don't just trust what the browser shows. Also verify server-side state:
- If a session was created: can you retrieve it via a server-side query?
- If data was written to the store: can you read it back independently?
- If middleware should block a request: does an unauthenticated request actually get 401?

### Anti-Hallucination Rule

Before you write ANY evidence in your criterion verdicts, ask yourself:
"Did I actually observe this, or am I inferring it from the code?"

If you are inferring, the evidence is INVALID. You must go observe it for real.
If you cannot observe it (tool limitation, server not running, etc.), the verdict
is "skip" with a skipReason, NOT "pass".`);

  // 7h-anti. Anti-rationalization rule
  sections.push(`## Anti-Rationalization Rule

If you observe application state that does not match the expected outcome
(wrong value, missing entity, unexpected data), you MUST report it as a
HARD FAILURE — even if you can imagine an innocent explanation like
"seed data", "prior test run", or "initialization order".

NEVER classify unexpected state as "pre-existing" without FIRST:
1. Checking whether the state existed BEFORE the builder's changes
2. Tracing the code path that produces the unexpected state
3. Confirming the anomaly is genuinely unrelated to this packet

"It was probably already like that" is NOT a valid evaluation finding.
Treat every state anomaly as a potential bug until proven otherwise.`);

  // 7h2. Root-cause analysis for hard failures
  sections.push(`## Root-Cause Analysis (MANDATORY for hard failures)

When you find a hard failure, do not just report the symptom — diagnose WHY it fails.
The builder will use your diagnosis to find and fix the right code. If you only report
symptoms, the builder will guess and often fix the wrong file.

For each hard failure, provide:

1. **diagnosticHypothesis**: Your theory about which component/function is broken.
   BAD: "The session returns 401 after acceptance"
   GOOD: "The session middleware (middleware/auth.ts) always picks the largest database
   via createAuthStack(), but accept-invitation created the session in the token's
   database. The actor doesn't exist in the largest DB, so validateSession() fails."

2. **filesInvolved**: ALL files the builder should investigate — not just the file
   that threw the error, but every file in the request/data flow.
   BAD: ["packages/web/app/routes/invite.tsx"]
   GOOD: ["packages/api/src/middleware/auth.ts", "packages/api/src/handlers/invitations.ts",
          "packages/core/src/auth/AuthService.ts", "packages/web/app/routes/invite.tsx"]

### How to diagnose

When a failure spans multiple system layers (client → API → middleware → store):
1. Trace the request through each layer
2. Identify WHERE in the chain the failure occurs (not just what the client sees)
3. Read the relevant middleware/service code to understand WHY
4. Name the specific function or condition that's rejecting/failing
5. List all files in the chain, not just the endpoint

If you don't have time for a full diagnosis, at minimum state which LAYER you think
is failing (client redirect? middleware auth? handler logic? database query?).`);

  // 7i. Browser verification tools (always available)
  sections.push(`## Browser Verification

You have access to Playwright MCP tools for browser verification. Use them to verify the builder's
work — not to fix problems (you are read-only).

### Browser Verification (Playwright MCP)
Use the Playwright MCP tools (\`mcp__playwright__*\`) for browser verification.
These are MCP tool calls in your tool list — do NOT use local playwright scripts.
The MCP server runs Chromium in \`--isolated\` mode. Opening a new browser
window creates a fresh context with NO pre-existing cookies, localStorage, or session
state. Reuse the same window for multi-step flows that depend on shared session context.

When verifying, use Playwright MCP to actually test in the browser:
- Take a screenshot of the current page state to verify visual correctness
- Check the browser console for errors and warnings — check AFTER each view transition,
  not just on initial load. React render errors often appear during state transitions.
- Click through interactive flows, fill form fields, and get a snapshot of the page's
  content/accessibility tree to verify interactions work correctly
- Check network requests: verify response status codes, headers (especially set-cookie),
  and response bodies match expectations
- Test at different viewports by resizing the browser window
Do NOT just read code — actually test in the browser. Static code review alone is
insufficient.`);

  // 7j. Research tools (dynamic based on availability)
  const researchSection = buildResearchToolsSection(
    researchTools ?? DEFAULT_RESEARCH_TOOLS,
    "evaluator",
  );
  if (researchSection) sections.push(researchSection);

  // 8. Mandatory criterion verdicts
  sections.push(`## Mandatory Criterion Verdicts

You MUST produce a verdict for EVERY acceptance criterion listed below. No exceptions.
Absence of failure is NOT evidence of success. You must actively verify each criterion.

If you cannot verify a criterion (e.g., requires running a blocked command), mark it
as "skip" with a skipReason explaining why you could not verify it.

If the builder's self-check says "pass" but you cannot independently reproduce the
evidence, the criterion verdict is "skip", not "pass".

**Skips are expensive.** Every \`skip\` on a blocking criterion forces the operator to
intervene manually or wastes a fix loop (the builder cannot fix "missing credentials").
Before marking ANY criterion as \`skip\`:
1. Check the workspace \`.env\` file for the required credentials
2. Attempt to start the dev server — if credentials are in \`.env\`, the server should work
3. Only mark \`skip\` if the server genuinely cannot start for reasons beyond your control
4. If you mark \`skip\`, explain EXACTLY what credential or service is missing and why

A \`skip\` verdict means "I tried and could not verify" — NOT "I chose not to try."
Code-path analysis alone does NOT satisfy scenario criteria when runtime verification
is possible. Start the dev server. Make the HTTP request. Observe the actual response.

## Evidence Strength Hierarchy

For scenario and api criteria, evidence quality is ranked:

1. **Runtime proof** (curl output, browser screenshot, dev server response, HTTP status codes) — STRONGEST
2. **Test suite proof** (vitest/jest output showing the scenario executes and passes) — STRONG
3. **Code inspection** (reading source, confirming logic looks correct) — WEAK

Code inspection is acceptable ONLY when runtime verification is genuinely blocked (sandbox restrictions, missing credentials that cannot be obtained).

**Critical rule:** If a scenario criterion's evidenceRequired lists runtime verification (e.g., "curl output", "browser observation", "HTTP response") but you only performed code inspection, the verdict MUST be "skip" (not "pass"), even if the code looks correct.

Code that typechecks and looks correct can still fail at runtime due to:
- Missing service wiring (service not in Layer composition)
- Wrong redirect URLs (API returns URL that doesn't work in browser)
- Third-party API behavior differences (test vs production)
- Race conditions only visible at runtime
- CSS/layout issues invisible in source code

"I read the code and it looks right" is NOT evidence that it works.

### Criteria Requiring Verdicts

${contract.acceptance
  .map((c) => {
    const blocking = c.blocking ? " [BLOCKING]" : " [advisory]";
    return `- **${c.id}**${blocking}: ${c.description}`;
  })
  .join("\n")}

Include a \`criterionVerdicts\` array in your report with one entry per criterion:
\`\`\`json
{
  "criterionId": "(AC id from above)",
  "verdict": "pass" | "fail" | "skip",
  "evidence": "(what you observed — required for all verdicts)",
  "skipReason": "(required if verdict is skip)"
}
\`\`\`

**Rules:**
- Every criterion ID listed above MUST appear in your criterionVerdicts array
- "pass" requires positive evidence — you observed the expected behavior
- "fail" requires evidence of what went wrong
- "skip" requires a skipReason explaining why verification was impossible
- If ANY blocking criterion has verdict "fail" or "skip", overall MUST be "fail"`);

  // 9. Handling discovered issues (severity-based routing)
  sections.push(`## Handling Discovered Issues

During evaluation you may find real problems NOT covered by the existing acceptance criteria.
Route each discovered issue by severity:

### Severity Guide

| Severity | Examples |
|----------|----------|
| **critical** | Security vulnerability, data loss, crash, complete feature failure, privilege escalation |
| **high** | Significant functionality broken, major UX failure, spec violation, authorization bypass |
| **medium** | Notable gap in behavior, edge case failure, inconsistent behavior |
| **low** | Cosmetic, minor inconsistency, style issue |

### Routing Rules

**low** — Note in \`nextActions\` only. Not binding. No structural change.

**medium** — Propose a new acceptance criterion via the \`addedCriteria\` array. Each proposed
criterion must be:
- Concrete and testable (a future evaluator can verify it)
- Specific to the defect you found (not a vague quality aspiration)
- Within the packet's existing scope (not scope creep)
- One criterion per class of defect (don't shotgun five criteria for one bug)

Do NOT include an \`id\` field — the orchestrator assigns IDs.
Do NOT set \`contractGapDetected\` when using \`addedCriteria\`.

**high / critical** — Set \`contractGapDetected: true\` in your report. Describe the gap in
\`nextActions\`. Do NOT include \`addedCriteria\`.

### Mutual Exclusivity

Your report must use \`addedCriteria\` OR \`contractGapDetected\`, never both.
Mixing them produces an invalid report that the orchestrator will reject.

- \`addedCriteria\` = medium issues → fix loop with expanded contract
- \`contractGapDetected\` = high/critical issues → back to contract negotiation

### What NOT to Add as Criteria

Do not propose criteria for:
- Style preferences or code formatting opinions
- Architectural suggestions that require redesign
- Issues already covered by existing acceptance criteria
- Cosmetic observations (use nextActions for low-severity items)
- Broad bug families ("all edge cases should be handled") — be specific`);

  // 10. Output envelope
  sections.push(`## Output Format

After completing your evaluation, emit your report as a structured JSON envelope.

Your final output MUST contain exactly this structure:

${RESULT_START_SENTINEL}
{
  "packetId": "${contract.packetId}",
  "sessionId": "(your session ID if available, or empty string)",
  "overall": "pass" or "fail",
  "hardFailures": [
    {
      "criterionId": "(id of failed criterion)",
      "description": "(what failed)",
      "evidence": "(exact output/observation)",
      "reproduction": ["(command 1)", "(command 2)"],
      "diagnosticHypothesis": "(your theory about WHY this fails — which component/function is broken, not just the symptom)",
      "filesInvolved": ["(file paths the builder should investigate — include ALL layers, not just the one that errored)"]
    }
  ],
  "rubricScores": [
    {
      "criterionId": "(id)",
      "score": (number),
      "threshold": (number),
      "rationale": "(why this score)"
    }
  ],
  "criterionVerdicts": [
    {
      "criterionId": "(AC id from the contract — one entry per criterion)",
      "verdict": "pass" | "fail" | "skip",
      "evidence": "(what you observed)",
      "skipReason": "(required if verdict is skip, omit otherwise)"
    }
  ],
  "missingEvidence": ["(criterion IDs with no evidence)"],
  "nextActions": ["(what the builder should fix)"],
  "contractGapDetected": false,
  "addedCriteria": [],
  "additionalIssuesOmitted": false,
  "advisoryEscalations": []
}
${RESULT_END_SENTINEL}

### addedCriteria (medium-severity issues only)

When you discover medium-severity issues not covered by existing criteria, propose new
acceptance criteria. Do NOT include an \`id\` field — the orchestrator assigns IDs.

Example entry:
\`\`\`json
{
  "kind": "scenario",
  "description": "Submitting the form with an empty email field shows an inline validation error and does not send a request",
  "blocking": true,
  "evidenceRequired": ["screenshot of validation error", "network tab showing no request fired"],
  "severity": "medium",
  "rationale": "Builder implemented the happy path but the form submits empty values to the API, causing a 500",
  "evidence": "Clicked Submit with email blank → POST /api/subscribe returned 500 Internal Server Error"
}
\`\`\`

### additionalIssuesOmitted

Set to \`true\` if you found more medium-severity issues than you reported in \`addedCriteria\`.
This signals to the orchestrator that the contract may need deeper review.

### advisoryEscalations (optional)

If you believe a non-blocking (advisory) criterion failure is severe enough to
block the packet, you can escalate it. Without escalation, advisory failures
produce warnings but do NOT block the packet.

\`\`\`json
"advisoryEscalations": [
  {
    "criterionId": "cleanup-no-regressions",
    "reason": "The builder introduced a security vulnerability that exposes user data to unauthenticated requests"
  }
]
\`\`\`

Only escalate when the issue was (a) introduced by this packet's changes and (b) severe
enough to warrant blocking despite being marked advisory. Pre-existing issues covered by
future packets should NOT be escalated.

### Rules

- Emit this envelope ONCE at the very end of your response
- No commentary after the end marker
- The "overall" field must be "pass" ONLY if ALL blocking criteria pass AND all blocking criterionVerdicts are "pass"
- The "criterionVerdicts" array MUST contain one entry for every acceptance criterion in the contract
- \`addedCriteria\` and \`contractGapDetected: true\` are mutually exclusive — never set both

**IMPORTANT:** Before emitting the envelope, validate using Option 1 (MCP tool) or Option 2 (CLI)
from the "MANDATORY: Validate Before Emitting" section above. Fix any errors before emitting.`);

  return sections.join("\n\n");
}

function formatAcceptanceCriteria(criteria: AcceptanceCriterion[]): string {
  return criteria
    .map((c) => {
      const blocking = c.blocking ? " [BLOCKING]" : " [advisory]";
      const cmd = c.command ? `\n  Command: \`${c.command}\`` : "";
      const expected = c.expected ? `\n  Expected: ${c.expected}` : "";
      const evidence = c.evidenceRequired.length > 0
        ? `\n  Evidence needed: ${c.evidenceRequired.join(", ")}`
        : "";
      return `- **${c.id}** (${c.kind})${blocking}: ${c.description}${cmd}${expected}${evidence}`;
    })
    .join("\n");
}
