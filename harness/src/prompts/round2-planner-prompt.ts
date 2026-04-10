/**
 * Round 2 planner prompt builder.
 *
 * Generates the system prompt for the targeted re-planner that creates
 * fix packets based on QA findings from round 1.
 *
 * Reference: research/harness-improvement-analysis/05-round2-planning-final-qa.md
 */

import type {
  QAReport,
  Packet,
  EvaluatorGuide,
} from "../schemas.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../schemas.js";
import {
  AUTONOMOUS_PREAMBLE,
  buildValidateEnvelopeSection,
  buildHarnessContextSection,
  buildMemorySearchSection,
} from "./shared.js";

export interface Round2PlannerPromptContext {
  originalSpec: string;
  qaReport: QAReport;
  originalPackets: Packet[];
  evaluatorGuide?: EvaluatorGuide;
  workspaceDir?: string;
  /** Current round number (2, 3, 4...). Used for packet ID prefix. */
  round?: number;
}

export function buildRound2PlannerPrompt(ctx: Round2PlannerPromptContext): string {
  const round = ctx.round ?? 2;
  const idPrefix = `PKT-R${round}`;
  const sections: string[] = [];

  // 0. Workspace guidance
  if (ctx.workspaceDir) {
    sections.push(`## WORKSPACE

All files are located in: ${ctx.workspaceDir}
Use this path for all file operations.`);
  }

  // 0b. Autonomous preamble
  sections.push(AUTONOMOUS_PREAMBLE);

  // 0c. Harness pipeline context + memory search guidance
  sections.push(buildHarnessContextSection("round2_planner", { round }));
  sections.push(buildMemorySearchSection("round2_planner"));

  // 1. Role
  sections.push(`## Your Role

You are the ROUND ${round} PLANNER for a harnessd run.

Previous rounds have completed. However, the holistic QA agent found integration
issues that need fixing. Your job is to create TARGETED fix packets that address
these specific QA findings.

## CRITICAL RULES

1. You are READ-ONLY. You CANNOT and MUST NOT write any files.
2. You MAY use Read, Grep, Glob, and read-only Bash to explore the codebase.
3. Your ONLY output mechanism is a structured JSON envelope at the END of your response.
4. Do NOT try to create plan files, write markdown files, or spawn subagents.
5. Do NOT re-plan work that is already done and passing.
6. Create FOCUSED fix packets — each one targets specific QA issues.
7. Prefer fewer, larger fix packets over many tiny ones (to reduce session overhead).`);

  // 1b. Mandatory validate_envelope gate
  sections.push(buildValidateEnvelopeSection("PlannerOutput"));

  // 2. Original spec (truncated)
  if (ctx.originalSpec) {
    const specExcerpt = ctx.originalSpec.length > 3000
      ? ctx.originalSpec.slice(0, 3000) + "\n\n... (truncated)"
      : ctx.originalSpec;
    sections.push(`## Original Specification

${specExcerpt}`);
  }

  // 3. What was built in round 1
  if (ctx.originalPackets.length > 0) {
    const packetList = ctx.originalPackets.map((p) =>
      `- **${p.id}**: ${p.title} (${p.type}, status: ${p.status})`
    ).join("\n");
    sections.push(`## Round 1 Packets (Already Built)

${packetList}

These packets are DONE. Do NOT create fix packets that duplicate their work.
Your fix packets should make targeted changes to the code already written.`);
  }

  // 4. QA report (the core input)
  sections.push(`## QA Report — Issues to Fix

**Overall Verdict:** ${ctx.qaReport.overallVerdict}
**Issues Found:** ${ctx.qaReport.issues.length} (${
    ctx.qaReport.issues.filter((i) => i.severity === "critical").length
  } critical, ${
    ctx.qaReport.issues.filter((i) => i.severity === "major").length
  } major, ${
    ctx.qaReport.issues.filter((i) => i.severity === "minor").length
  } minor)

### Issues

${ctx.qaReport.issues.map((issue) => `#### ${issue.id} [${issue.severity.toUpperCase()}]: ${issue.title}

${issue.description}

**Steps to reproduce:**
${issue.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")}

**Related packets:** ${issue.relatedPackets.join(", ")}
`).join("\n")}

### Console Errors
${ctx.qaReport.consoleErrors.length > 0
    ? ctx.qaReport.consoleErrors.map((e) => `- ${e}`).join("\n")
    : "(none)"}

### QA Summary
${ctx.qaReport.summary}`);

  // 5. Evaluator guide (inherited from R1)
  if (ctx.evaluatorGuide) {
    sections.push(`## Quality Standards (from Round 1)

**Domain:** ${ctx.evaluatorGuide.domain}
**Reference standard:** ${ctx.evaluatorGuide.referenceStandard}

These quality standards still apply. Your fix packets must not regress quality.`);
  }

  // 6. Planning instructions
  sections.push(`## Fix Packet Planning Instructions

1. **Group related issues** by root cause. If two QA issues stem from the same
   underlying problem, they should be in the same fix packet.

2. **Each fix packet's acceptance criteria MUST include:**
   - The QA reproduction steps as verification (agent must prove the fix works)
   - Non-regression checks (existing features still work)

3. **Prioritize:**
   - Critical issues first
   - Major issues second
   - Minor issues can be grouped into a "polish" packet or deferred

4. **Size constraints:**
   - Fix packets should be S or M sized (never L)
   - 1-3 fix packets is typical; more than 5 suggests issues are too scattered

5. **Packet ID format:** Use "${idPrefix}-001", "${idPrefix}-002", etc.

6. **Each packet must include:**
   - Which QA issue IDs it addresses
   - Focused implementation plan (what to change, not how)
   - Testable acceptance criteria referencing the QA reproduction steps`);

  // 6b. Root cause verification (mandatory before creating packets)
  sections.push(`## Root Cause Verification (MANDATORY before creating packets)

Before creating fix packets, you MUST verify the QA's root cause analysis:
1. Read the diagnosticHypothesis and filesInvolved for each QA issue
2. OPEN those files with the Read tool and verify the hypothesis is correct
3. If the hypothesis is wrong or incomplete, trace the actual root cause yourself
4. Include your VERIFIED root cause in each packet's notes[] — name exact files and functions

Do NOT blindly forward QA symptom descriptions into packets.
A packet that says "fix the retract-before-assert pattern" without naming the specific
file and function that needs to change WILL FAIL — the builder won't know what to fix.

For each packet, the notes[] array must include:
- "Root cause: {file}:{function} — {what's wrong and why}"
- "Fix: {specific change to make}"`);

  // 7. Output envelope
  sections.push(`## Output Format

After analyzing the QA report and planning fix packets, emit your plan as a structured JSON envelope.

${RESULT_START_SENTINEL}
{
  "spec": "(leave empty string — no new spec needed for R2)",
  "packets": [
    {
      "id": "${idPrefix}-001",
      "title": "Fix navigation and state persistence",
      "type": "bugfix",
      "objective": "Fix QA issues QA-001 and QA-003: missing back navigation and state loss",
      "whyNow": "Critical/major QA issues blocking feature completion",
      "dependencies": [],
      "status": "pending",
      "priority": 1,
      "estimatedSize": "S",
      "risks": ["..."],
      "notes": ["Addresses QA-001, QA-003"]
    }
  ],
  "riskRegister": {
    "risks": [
      {
        "id": "R2-RISK-001",
        "description": "Fix packets might regress existing functionality",
        "severity": "medium",
        "mitigation": "Acceptance criteria include non-regression checks",
        "watchpoints": ["Run full test suite after each fix"]
      }
    ]
  },
  "evaluatorGuide": ${JSON.stringify(ctx.evaluatorGuide ?? {
    domain: "fix-verification",
    qualityCriteria: [{ name: "fix-correctness", weight: 5, description: "QA issues are resolved" }],
    antiPatterns: ["Regressions in existing functionality"],
    referenceStandard: "All QA issues resolved without introducing new ones",
    edgeCases: [],
    calibrationExamples: [{ dimension: "fix-correctness", score: 5, description: "All QA reproduction steps now pass" }],
    skepticismLevel: "high",
  }, null, 2)},
  "planSummary": "Round ${round}: N fix packets addressing M QA issues."
}
${RESULT_END_SENTINEL}

- Emit this envelope ONCE at the very end of your response
- No commentary after the end marker
- The "spec" field should be an empty string (we keep the R1 spec)
- packets MUST use "${idPrefix}-NNN" ID format
- Each packet's notes[] should reference which QA issue IDs it addresses`);

  return sections.join("\n\n");
}
