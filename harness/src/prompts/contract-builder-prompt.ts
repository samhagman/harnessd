/**
 * Contract builder prompt — generates proposals for packet contracts.
 *
 * Reference: TAD sections 11, 18.5
 */

import type {
  Packet,
  AcceptanceTemplate,
  ContractReview,
  PacketContract,
  EvaluatorReport,
} from "../schemas.js";
import { RESULT_START_SENTINEL, RESULT_END_SENTINEL } from "../schemas.js";
import {
  type BackendCapabilities,
  AUTONOMOUS_PREAMBLE,
  buildValidateEnvelopeSection,
  buildHarnessContextSection,
  buildMemorySearchSection,
} from "./shared.js";

export function buildContractBuilderPrompt(
  packet: Packet,
  template: AcceptanceTemplate,
  specExcerpt: string,
  priorReview?: ContractReview,
  existingContract?: PacketContract,
  evaluatorReport?: EvaluatorReport,
  enableMemory?: boolean,
  backendCapabilities?: BackendCapabilities,
): string {
  const supportsMcp = backendCapabilities?.supportsMcpServers ?? true;
  const supportsOutputSchema = backendCapabilities?.supportsOutputSchema ?? false;
  const sections: string[] = [];

  sections.push(AUTONOMOUS_PREAMBLE);

  sections.push(buildHarnessContextSection("contract_builder", { packetId: packet.id, memoryEnabled: enableMemory }));
  sections.push(buildMemorySearchSection("contract_builder", enableMemory));

  if (supportsMcp) {
    sections.push(buildValidateEnvelopeSection("PacketContract"));
  }

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

  sections.push(`## Packet to Plan

**ID:** ${packet.id}
**Title:** ${packet.title}
**Type:** ${packet.type}
**Objective:** ${packet.objective}
**Why now:** ${packet.whyNow}

${packet.risks.length > 0 ? `**Known risks:**\n${packet.risks.map((r) => `- ${r}`).join("\n")}` : ""}
${packet.notes.length > 0 ? `**Notes:**\n${packet.notes.map((n) => `- ${n}`).join("\n")}` : ""}`);

  sections.push(`## Acceptance Template for "${packet.type}"

Required criterion kinds: ${template.requiredCriterionKinds.join(", ")}

Default criteria (specialize these for this packet):
${template.defaultCriteria
  .map(
    (c) =>
      `- **${c.id}** (${c.kind}, ${c.blocking ? "blocking" : "advisory"}): ${c.description}`,
  )
  .join("\n")}

Include all required criterion kinds. Additional criteria beyond the required ones are welcome.
Make each criterion specific and testable for THIS packet.`);

  sections.push(`## Specification Context

${specExcerpt}`);

  sections.push(`## Scope Constraint

Keep the packet bounded and completable in one builder session. If the scope feels
too large, say so explicitly in \`outOfScope\` and consider proposing a split.
All fields are required (see example below). Out-of-scope must not be empty.

## Goals, Constraints, and Guidance

Your contract MUST separate intent into three explicit sections:

**Goals** are verifiable outcomes. Each maps to one or more acceptance criteria.
Example: "Zero ESLint boundary violations in the target package" — verified by AC-001.

**Constraints** are non-negotiable restrictions. They limit the solution space without
prescribing a solution. Every constraint MUST have a rationale.
Example: scope:"Only modify files within src/" — rationale: "test fixtures stay frozen."
If you haven't deeply investigated the codebase to know the right approach,
don't constrain the approach. State the goal; let the builder find the path.

**Guidance** is principle-level direction with no hard fail. Reference architectural
principles by name; do not copy-paste rules.
Example: "Follow dependency-direction (architectural-principles)."

Available principle names: screaming-architecture, dependency-direction, contracts-first,
colocated-integration, modular-monolith, shared-escape-hatch, anti-corruption-layer.

### The Litmus Test
"If the builder achieves all goals but violates this, should the packet FAIL?"
- Yes → constraint (add rationale)
- "Depends on why" → guidance
- The behavior IS the goal → goal

Each acceptance criterion should map to a goal — constraints don't need dedicated
acceptance criteria unless they have a natural verification command.`);

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

  const exampleJson = `{
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
  "goals": [
    {"id": "G-001", "description": "...", "acceptanceCriteriaIds": ["AC-001", "AC-002"]}
  ],
  "constraints": [
    {"id": "C-001", "description": "...", "kind": "scope", "rationale": "..."}
  ],
  "guidance": [
    {"id": "GD-001", "description": "...", "source": "architectural-principles", "principle": "dependency-direction"}
  ],
  "reviewChecklist": ["..."],
  "proposedCommitMessage": "harnessd(${packet.id}): ..."
}`;

  if (supportsOutputSchema) {
    sections.push(`## Output Format

Emit your contract proposal as structured JSON matching the output schema.
Do NOT use envelope sentinels. The output schema enforces the correct structure.

Your final answer must match this shape:

${exampleJson}

- Emit your final answer ONCE — the harness reads the last structured output`);
  } else {
    sections.push(`## Output Format

Emit your contract proposal as a structured JSON envelope:

${RESULT_START_SENTINEL}
${exampleJson}
${RESULT_END_SENTINEL}

- Emit this envelope ONCE at the very end
- No commentary after the end marker

**IMPORTANT:** Before emitting the envelope, validate using Option 1 (MCP tool) or Option 2 (CLI)
from the "MANDATORY: Validate Before Emitting" section above. Fix any errors before emitting.`);
  }

  sections.push(`## Remember

The contract is the design. Every acceptance criterion you write here costs (or saves)
builder cycles later — make them specific and testable.`);

  return sections.join("\n\n");
}
