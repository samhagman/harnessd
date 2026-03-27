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
): string {
  const sections: string[] = [];

  // 0. Autonomous preamble
  sections.push(`## Autonomous Operation

You are AUTONOMOUS. Work continuously toward your goal until it is complete.
Do NOT stop to ask questions. Do NOT wait for confirmation. Do NOT ask "shall I continue?".

If you receive a new message from the operator mid-session, it is a STEERING NUDGE.
Incorporate the new context and keep working. Do not treat it as a stop signal.
The only way you stop is by completing your goal and emitting the result envelope.`);

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

**IMPORTANT:** Before emitting the envelope, call the \`validate_envelope\` MCP tool with
schema_name="PacketContract" and your JSON to check it's valid. Fix any errors before emitting.`);

  return sections.join("\n\n");
}
