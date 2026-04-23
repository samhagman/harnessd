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
import type { BackendCapabilities } from "./builder-prompt.js";

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

  // 0. Autonomous preamble
  sections.push(AUTONOMOUS_PREAMBLE);

  // 0a. Harness pipeline context + memory search guidance
  sections.push(buildHarnessContextSection("contract_builder", { packetId: packet.id, memoryEnabled: enableMemory }));
  sections.push(buildMemorySearchSection("contract_builder", enableMemory));

  // 0b. Mandatory validate_envelope gate (only when MCP is available)
  if (supportsMcp) {
    sections.push(buildValidateEnvelopeSection("PacketContract"));
  }

  // 0c. Renegotiation context (additive renegotiation after evaluator gap)
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
- **goals**: explicit outcomes to achieve (each with acceptanceCriteriaIds mapping to ACs)
- **constraints**: hard restrictions with kind and rationale
- **guidance**: principles and preferences (reference architectural-thinking by name)
- **reviewChecklist**: items for the evaluator to check
- **proposedCommitMessage**: git commit message in format "harnessd(${packet.id}): ..."

### Scope Constraint
Keep the packet bounded and completable in one builder session.
If the scope feels too large, say so in the contract.`);

  // 4a. Goals, constraints, and guidance teaching section
  sections.push(`## Goals, Constraints, and Guidance

Your contract MUST separate intent into three explicit sections:

### Goals (WHAT to achieve)
Goals are verifiable outcomes. Each goal maps to one or more acceptance criteria.
The builder succeeds by achieving the goal — the acceptance criteria prove it.

GOOD goal: "Zero ESLint boundary violations in the target package"
GOOD goal: "All existing tests pass after refactor"
BAD goal:  "Use max 12 bridge files" — this prescribes HOW, not WHAT

For each goal, list the acceptance criteria IDs that verify it.

### Constraints (hard boundaries)
Constraints are non-negotiable restrictions. They limit the solution space but
do NOT prescribe the solution. Think: what would a staff engineer tell a senior
engineer they MUST NOT do?

GOOD constraint (scope): "Only modify files within src/"
GOOD constraint (tech-stack): "Must use the existing Vitest test framework"
GOOD constraint (behavior): "Public API signatures must not change"
GOOD constraint (safety): "No credential exposure in committed files"
BAD constraint: "Max 12 bridge files" — this prescribes the implementation approach
BAD constraint: "Must use the adapter pattern" — this prescribes the solution

Every constraint MUST have a rationale explaining WHY it exists.
If you haven't deeply investigated the codebase to know the right approach,
don't constrain the approach. State the GOAL and let the builder find the path.

### Guidance (principles and preferences)
Guidance informs the builder's thinking without hard-failing on deviation.
Reference architectural principles by name rather than copy-pasting rules.

GOOD guidance: "Follow dependency-direction principle (architectural-principles)"
GOOD guidance: "The existing codebase uses barrel exports — follow this pattern"
GOOD guidance: "Prefer fewer shared bridge files where architecturally sound"

Available architectural principles you can reference by name:
- screaming-architecture — file tree should scream what the app does
- dependency-direction — dependencies flow inward only
- contracts-first — define types/schemas before implementation
- colocated-integration — integration logic stays in one file
- modular-monolith — cross-module imports through barrel files only
- shared-escape-hatch — only move to shared/ when 2+ consumers NOW
- anti-corruption-layer — translation boundary at third-party edges

### The Litmus Test
Before adding anything to constraints, ask: "If the builder achieves all goals
but violates this, should the packet FAIL?" If yes, it's a constraint.
If "it depends on why they deviated," it's guidance.

### Acceptance Criteria Verify GOALS
Each acceptance criterion should map to a goal. Constraints are checked
separately — they don't need dedicated acceptance criteria unless they have
a natural verification command.`);

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

  // 6. Output format — conditional on whether the backend supports structured output schema
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

  return sections.join("\n\n");
}
