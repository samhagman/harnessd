/**
 * Contract builder prompt — generates proposals for packet contracts.
 *
 * Reference: TAD sections 11, 18.5
 */

import type {
  Packet,
  AcceptanceTemplate,
  RiskRegister,
  ContractReview,
  PacketContract,
  EvaluatorReport,
} from "../schemas.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../schemas.js";

export function buildContractBuilderPrompt(
  packet: Packet,
  template: AcceptanceTemplate,
  specExcerpt: string,
  priorReview?: ContractReview,
  existingContract?: PacketContract,
  evaluatorReport?: EvaluatorReport,
): string {
  const sections: string[] = [];

  // 0. Autonomous preamble
  sections.push(`## Autonomous Operation

You are AUTONOMOUS. Work continuously toward your goal until it is complete.
Do NOT stop to ask questions. Do NOT wait for confirmation. Do NOT ask "shall I continue?".

If you receive a new message from the operator mid-session, it is a STEERING NUDGE.
Incorporate the new context and keep working. Do not treat it as a stop signal.
The only way you stop is by completing your goal and emitting the result envelope.`);

  // 0a. Mandatory validate_envelope gate
  sections.push(`## MANDATORY: Validate Before Emitting

You MUST validate your result envelope BEFORE emitting it. This is not optional.
If you emit without validating, your output will be REJECTED and you will have to redo your work.

**Option 1 — MCP tool (preferred):**
Call \`validate_envelope\` with schema_name="PacketContract" and json_string=<your JSON>

**Option 2 — CLI (if MCP tool unavailable):**
\`\`\`bash
echo '<your JSON>' | npx tsx /Users/sam/projects/harnessd/harness/bin/validate-envelope.mts --schema PacketContract --json -
\`\`\`

If validation returns {valid: false}, FIX the errors and validate again.
ONLY after getting {valid: true} should you emit the envelope.
Do NOT skip this step. Do NOT emit first and hope it works.`);

  // 0b. Renegotiation context (additive renegotiation after evaluator gap)
  if (existingContract && evaluatorReport) {
    const hardFailuresFormatted = evaluatorReport.hardFailures.length > 0
      ? evaluatorReport.hardFailures
          .map((f) => `- **${f.criterionId}**: ${f.description}\n  Evidence: ${f.evidence}\n  Reproduction: ${f.reproduction.join("; ")}`)
          .join("\n")
      : "(none)";

    const nextActionsFormatted = evaluatorReport.nextActions.length > 0
      ? evaluatorReport.nextActions.map((a, i) => `${i + 1}. ${a}`).join("\n")
      : "(none)";

    const existingCriteriaFormatted = existingContract.acceptance
      .map((c) => `- **${c.id}** (${c.kind}, ${c.blocking ? "blocking" : "advisory"}): ${c.description}`)
      .join("\n");

    sections.push(`## Renegotiation Context

You are renegotiating an existing contract after the evaluator found a high/critical
issue. The existing contract was previously accepted and the builder already
implemented against it.

### Default: Additive Renegotiation
Keep ALL existing criteria (they were already satisfied). Keep the implementation
plan intact unless the gap makes it invalid. ADD new criteria and/or scope items
to address the evaluator's findings. ADD risks if the gap revealed new ones.

Only restructure if the evaluator's finding reveals the fundamental approach is wrong.

### Evaluator's Findings

**Hard Failures:**
${hardFailuresFormatted}

**Required Next Actions:**
${nextActionsFormatted}

### Existing Accepted Contract

**Acceptance Criteria:**
${existingCriteriaFormatted}

**In Scope:**
${existingContract.inScope.map((s) => `- ${s}`).join("\n")}

**Out of Scope:**
${existingContract.outOfScope.map((s) => `- ${s}`).join("\n")}

**Implementation Plan:**
${existingContract.implementationPlan.map((step, i) => `${i + 1}. ${step}`).join("\n")}`);
  }

  // 1. Packet objective
  sections.push(`## Packet to Plan

**ID:** ${packet.id}
**Title:** ${packet.title}
**Type:** ${packet.type}
**Size:** ${packet.estimatedSize}
**Objective:** ${packet.objective}
**Why now:** ${packet.whyNow}

${packet.risks.length > 0 ? `**Known risks:**\n${packet.risks.map((r) => `- ${r}`).join("\n")}` : ""}
${packet.notes.length > 0 ? `**Notes:**\n${packet.notes.map((n) => `- ${n}`).join("\n")}` : ""}`);

  // 2. Acceptance template
  sections.push(`## Acceptance Template for "${packet.type}"

Required criterion kinds: ${template.requiredCriterionKinds.join(", ")}

Default criteria (specialize these for this packet):
${template.defaultCriteria
  .map(
    (c) =>
      `- **${c.id}** (${c.kind}, ${c.blocking ? "blocking" : "advisory"}): ${c.description}`,
  )
  .join("\n")}

You MUST include all required criterion kinds. You may add more criteria.
Make each criterion specific and testable for THIS packet.`);

  // 3. Spec excerpt
  sections.push(`## Specification Context

${specExcerpt}`);

  // 4. Contract requirements
  sections.push(`## Required Contract Fields

Your contract proposal MUST include ALL of these fields:
- **packetId**: "${packet.id}"
- **round**: (current round number)
- **status**: "proposed"
- **title**: descriptive title
- **packetType**: "${packet.type}"
- **objective**: specific objective
- **inScope**: explicit list of what IS in scope
- **outOfScope**: explicit list of what is NOT (must not be empty)
- **assumptions**: things you're assuming are true
- **risks**: specific risks with mitigations
- **likelyFiles**: files that will probably be modified
- **implementationPlan**: ordered steps
- **backgroundJobs**: any long-running commands needed (can be empty)
- **microFanoutPlan**: any parallelizable subwork (can be empty)
- **acceptance**: specialized acceptance criteria (must include required kinds)
- **reviewChecklist**: items for the evaluator to check
- **proposedCommitMessage**: git commit message in format "harnessd(${packet.id}): ..."

### Scope Constraint
Keep the packet bounded and completable in one builder session.
If the scope feels too large, say so in the contract.`);

  // 4b. Data integrity rule
  sections.push(`## Data Integrity Rule

If this packet involves mutating application state (database writes, store updates,
cache mutations, triple store assertions), at least one acceptance criterion MUST
verify the post-mutation data invariant directly — not just the UI appearance.

Examples:
- "After updating permission level: query the data store and assert exactly 1 value per entity per attribute"
- "After creating an entity: query the store directly and verify all expected properties exist"
- "After deleting: query the store and verify the entity is absent"

UI looking correct is NOT sufficient evidence that a mutation worked.
The evaluator must independently query the data layer to verify state integrity.`);

  // 5. Prior review (if revising)
  if (priorReview) {
    sections.push(`## REVISION REQUIRED

The contract evaluator reviewed your previous proposal and requires changes.

**Decision:** ${priorReview.decision}
**Rationale:** ${priorReview.rationale}

### Scores
- Scope fit: ${priorReview.scores.scopeFit}/5
- Testability: ${priorReview.scores.testability}/5
- Risk coverage: ${priorReview.scores.riskCoverage}/5
- Clarity: ${priorReview.scores.clarity}/5
- Spec alignment: ${priorReview.scores.specAlignment}/5

### Required Changes
${priorReview.requiredChanges.map((c) => `- ${c}`).join("\n")}

### Missing Risks
${priorReview.missingRisks.length > 0 ? priorReview.missingRisks.map((r) => `- ${r}`).join("\n") : "(none)"}

### Suggested Additional Criteria
${priorReview.suggestedCriteriaAdditions.length > 0 ? priorReview.suggestedCriteriaAdditions.map((c) => `- ${c.id} (${c.kind}): ${c.description}`).join("\n") : "(none)"}

Address ALL required changes. Do not ignore the evaluator's feedback.`);
  }

  // 6. Output format
  sections.push(`## Output Format

Emit your contract proposal as a structured JSON envelope:

${RESULT_START_SENTINEL}
{
  "packetId": "${packet.id}",
  "round": ${priorReview ? priorReview.round + 1 : 1},
  "status": "proposed",
  "title": "...",
  "packetType": "${packet.type}",
  "objective": "...",
  "inScope": ["..."],
  "outOfScope": ["..."],
  "assumptions": ["..."],
  "risks": [{"id": "...", "description": "...", "mitigation": "..."}],
  "likelyFiles": ["..."],
  "implementationPlan": ["step 1", "step 2"],
  "backgroundJobs": [],
  "microFanoutPlan": [],
  "acceptance": [
    {
      "id": "...",
      "kind": "command",
      "description": "...",
      "blocking": true,
      "evidenceRequired": ["..."]
    }
  ],
  "reviewChecklist": ["..."],
  "proposedCommitMessage": "harnessd(${packet.id}): ..."
}
${RESULT_END_SENTINEL}

- Emit this envelope ONCE at the very end
- No commentary after the end marker

**IMPORTANT:** Before emitting the envelope, validate using Option 1 (MCP tool) or Option 2 (CLI)
from the "MANDATORY: Validate Before Emitting" section above. Fix any errors before emitting.`);

  return sections.join("\n\n");
}
