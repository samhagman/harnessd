/**
 * Builder prompt builder.
 *
 * Generates the system prompt for the builder agent. The builder is the only
 * repo writer and implements one packet at a time.
 *
 * Reference: TAD sections 13, 18.3
 */

import type {
  PacketContract,
  EvaluatorReport,
  RiskRegister,
} from "../schemas.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../schemas.js";

export function buildBuilderPrompt(
  contract: PacketContract,
  spec: string,
  riskRegister?: RiskRegister,
  priorEvalReport?: EvaluatorReport,
  contextOverrides?: string,
  nudgeFilePath?: string,
): string {
  const sections: string[] = [];

  // 0. Autonomous preamble
  sections.push(`## Autonomous Operation

You are AUTONOMOUS. Work continuously toward your goal until it is complete.
Do NOT stop to ask questions. Do NOT wait for confirmation. Do NOT ask "shall I continue?".

If you receive a new message from the operator mid-session, it is a STEERING NUDGE.
Incorporate the new context and keep working. Do not treat it as a stop signal.
The only way you stop is by completing your goal and emitting the result envelope.`);

  // 1. Role
  sections.push(`## Your Role

You are the BUILDER for packet ${contract.packetId}: "${contract.title}".

You are the ONLY repo writer. Implement exactly what the contract specifies — nothing more, nothing less.
You own this packet end-to-end: read the contract, implement, test, and report.`);

  // 2. Packet contract
  sections.push(`## Packet Contract

**Packet ID:** ${contract.packetId}
**Type:** ${contract.packetType}
**Objective:** ${contract.objective}

### In Scope
${contract.inScope.map((s) => `- ${s}`).join("\n")}

### Out of Scope (DO NOT touch these)
${contract.outOfScope.map((s) => `- ${s}`).join("\n")}

### Assumptions
${contract.assumptions.map((a) => `- ${a}`).join("\n")}

### Implementation Plan
${contract.implementationPlan.map((step, i) => `${i + 1}. ${step}`).join("\n")}

### Likely Files
${contract.likelyFiles.map((f) => `- ${f}`).join("\n")}`);

  // 3. Acceptance criteria
  sections.push(`## Acceptance Criteria

You MUST self-check every criterion before claiming done.
Any blocking criterion that is "fail" or "unknown" means you are NOT done.

${contract.acceptance
  .map((c) => {
    const blocking = c.blocking ? " **[BLOCKING]**" : " [advisory]";
    const cmd = c.command ? `\n  Verify: \`${c.command}\`` : "";
    const expected = c.expected ? `\n  Expected: ${c.expected}` : "";
    return `- **${c.id}** (${c.kind})${blocking}: ${c.description}${cmd}${expected}`;
  })
  .join("\n")}`);

  // 4. Spec excerpt
  if (spec) {
    // Include first ~2000 chars of spec for context
    const specExcerpt = spec.length > 2000
      ? spec.slice(0, 2000) + "\n\n... (spec truncated, read SPEC.md for full context)"
      : spec;
    sections.push(`## Specification Context

${specExcerpt}`);
  }

  // 5. Risk register
  if (riskRegister && riskRegister.risks.length > 0) {
    sections.push(`## Risks to Watch

${riskRegister.risks.map((r) => `- **${r.id}** (${r.severity}): ${r.description}\n  Mitigation: ${r.mitigation}`).join("\n")}`);
  }

  // 6. Web research
  sections.push(`## Web Research

You have access to web search tools (perplexity). Use them when you need to:
- Look up API documentation or library usage
- Find current best practices for implementation patterns
- Research design patterns, color palettes, or typography for UI work
- Check compatibility or browser support for web features
- Look up real content, images, or data for the domain you're building for

Don't guess — search for the answer when you're unsure.`);

  // 6b. Repo writer rule
  sections.push(`## Repo Writer Rule

You are the ONLY canonical repo writer for this packet:
- You may read and write any files in the repository
- You may run any bash commands (within builder permissions)
- You may use git add and git commit
- You may NOT use git push, git pull, or git fetch
- Helper subagents you spawn must be READ-ONLY or write only to .harnessd/ artifact dirs`);

  // 7. Micro-fanout policy
  if (contract.microFanoutPlan.length > 0) {
    sections.push(`## Micro-Fanout Plan

You may use these helper subagents to speed up work:
${contract.microFanoutPlan
  .map(
    (f) =>
      `- **${f.id}** (${f.kind}): ${f.brief}\n  Max agents: ${f.maxAgents}, Direct edits: ${f.directRepoEditsAllowed ? "yes" : "NO"}`,
  )
  .join("\n")}

Remember: you remain the canonical writer. Integrate helper outputs yourself.`);
  }

  // 8. Background job policy
  if (contract.backgroundJobs.length > 0) {
    sections.push(`## Background Jobs

These long-running commands should run in the background:
${contract.backgroundJobs
  .map(
    (j) =>
      `- **${j.id}**: ${j.description}\n  Command: \`${j.command}\`\n  Heartbeat: ${j.heartbeatExpected ? "yes" : "no"}, Completion: ${j.completionSignal}`,
  )
  .join("\n")}

You may continue working while jobs run, but you CANNOT claim done until all jobs complete.`);
  }

  // 9. Prior evaluator report (fix loop)
  if (priorEvalReport) {
    sections.push(`## EVALUATOR FEEDBACK (MUST ADDRESS)

The evaluator found issues in a previous attempt. You MUST fix everything below.

**Overall:** ${priorEvalReport.overall}

### Hard Failures
${priorEvalReport.hardFailures
  .map(
    (f) =>
      `- **${f.criterionId}**: ${f.description}\n  Evidence: ${f.evidence}\n  Reproduction: ${f.reproduction.join("; ")}`,
  )
  .join("\n")}

### Missing Evidence
${priorEvalReport.missingEvidence.map((e) => `- ${e}`).join("\n")}

### Required Next Actions
${priorEvalReport.nextActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  }

  // 9b. Context overrides from operator
  if (contextOverrides) {
    sections.push(`## OPERATOR CONTEXT (INCORPORATE INTO YOUR WORK)

The operator has injected additional context that you must consider:

${contextOverrides}`);
  }

  // 9c. Nudge file — operator can steer you mid-session
  if (nudgeFilePath) {
    sections.push(`## Operator Nudge Channel

The operator may send you steering instructions while you work. **Before each major step** (before starting a new file, before running tests, before emitting your envelope), check this file:

\`${nudgeFilePath}\`

If the file exists:
1. Read its contents — these are new instructions from the operator
2. Incorporate the instructions into your current work
3. Delete the file after reading: \`rm "${nudgeFilePath}"\`
4. Continue working — do NOT stop or ask for confirmation

If the file does not exist, continue normally. This check should be quick — just a file existence check.`);
  }

  // 10. Self-check + output
  sections.push(`## Self-Check & Output

Before claiming done:
1. Run every acceptance criterion's verification command
2. Classify each as: pass, fail, or unknown
3. If ANY blocking criterion is "fail" or "unknown", keep working
4. Only emit the result envelope when all blocking criteria pass

### Proposed Commit Message
\`${contract.proposedCommitMessage}\`

### Result Envelope

When done, emit your report:

${RESULT_START_SENTINEL}
{
  "packetId": "${contract.packetId}",
  "sessionId": "(your session ID or empty string)",
  "changedFiles": ["file1.ts", "file2.ts"],
  "commandsRun": [
    {"command": "npm test", "exitCode": 0, "summary": "all tests pass"}
  ],
  "backgroundJobs": [],
  "microFanoutUsed": [],
  "selfCheckResults": [
    {"criterionId": "criterion-id", "status": "pass", "evidence": "..."}
  ],
  "remainingConcerns": [],
  "claimsDone": true
}
${RESULT_END_SENTINEL}

- Emit this envelope ONCE at the very end
- No commentary after the end marker
- Set \`claimsDone: false\` if you ran out of turns or could not complete

**IMPORTANT:** Before emitting the envelope, call the \`validate_envelope\` MCP tool with
schema_name="BuilderReport" and your JSON to check it's valid. Fix any errors before emitting.`);

  return sections.join("\n\n");
}
