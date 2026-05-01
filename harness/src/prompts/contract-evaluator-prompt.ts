/**
 * Contract evaluator prompt — reviews contract proposals for quality.
 *
 * Reference: TAD sections 11, 18.6
 */

import type {
  PacketContract,
  PacketType,
  RiskRegister,
} from "../schemas.js";
import { RESULT_START_SENTINEL, RESULT_END_SENTINEL, RISKY_PACKET_TYPES } from "../schemas.js";
import {
  AUTONOMOUS_PREAMBLE,
  buildValidateEnvelopeSection,
  buildHarnessContextSection,
  buildMemorySearchSection,
  buildVerificationFanoutSection,
} from "./shared.js";

const USER_VISIBLE_TYPES: readonly PacketType[] = ["ui_feature", "backend_feature", "integration"];

export function buildContractEvaluatorPrompt(
  proposal: PacketContract,
  riskRegister?: RiskRegister,
  enableMemory?: boolean,
  useClaudeBackend?: boolean,
): string {
  const sections: string[] = [];

  sections.push(AUTONOMOUS_PREAMBLE);

  sections.push(buildHarnessContextSection("contract_evaluator", { packetId: proposal.packetId, memoryEnabled: enableMemory }));
  sections.push(buildMemorySearchSection("contract_evaluator", enableMemory));
  const fanoutSection = buildVerificationFanoutSection("contract_evaluator", { useClaudeBackend });
  if (fanoutSection) sections.push(fanoutSection);

  sections.push(`## Your Role

You are the CONTRACT EVALUATOR. Decide accept / revise / split / escalate.

Above all: catch **over-prescription** — constraints disguised as goals are the #1
cause of wasted builder cycles in the run pipeline. The detailed criteria are below;
the over-prescription check is the one no deterministic linter can do for you.

Only accept contracts that are specific, testable, and properly scoped.`);

  sections.push(`## Over-Prescription Detection (CRITICAL)

Your most important job is catching constraints that should be goals or guidance.
Over-prescriptive constraints are the #1 cause of wasted builder cycles.

### Red flags — require revision:
- **Constraint specifies HOW not WHAT**: "Max 12 bridge files" → move to guidance or remove
- **Constraint conflicts with a goal**: Goal "zero violations" + Constraint "only files in inScope" → flag if fixing violations requires touching files outside inScope
- **Constraint too strict for the goal type**: "No behavior changes" on a refactor → suggest "No changes to public API contracts" instead
- **Constraint without rationale**: Every constraint needs a rationale. No rationale = the author didn't think about whether it's truly a hard boundary
- **AC that enforces a constraint**: "git diff shows max 12 files" is over-prescriptive. ACs should verify goals, not police constraints

When you find over-prescription, require the contract builder to:
1. Move the item to guidance (if it's a preference)
2. Restate it as a goal (if it's really an outcome)
3. Add a rationale (if it's truly a constraint but missing justification)
4. Resolve conflicts between goals and constraints`);

  sections.push(buildValidateEnvelopeSection("ContractReview"));

  const isUserVisible = USER_VISIBLE_TYPES.includes(proposal.packetType);
  const isRisky = RISKY_PACKET_TYPES.includes(proposal.packetType);

  sections.push(`## Packet Type Expectations

**Type:** ${proposal.packetType}
${isUserVisible ? "- This is a USER-VISIBLE packet. It MUST have at least one scenario/api criterion." : ""}
${isRisky ? "- This is a RISKY packet type. It MUST have at least one negative/invariant criterion." : ""}
${proposal.packetType === "long_running_job" ? "- This is a LONG-RUNNING JOB. It MUST have observability criteria (heartbeat, completion signal)." : ""}`);

  sections.push(`## Contract Proposal (Round ${proposal.round})

**Packet ID:** ${proposal.packetId}
**Title:** ${proposal.title}
**Objective:** ${proposal.objective}

### In Scope
${proposal.inScope.map((s) => `- ${s}`).join("\n")}

### Out of Scope
${proposal.outOfScope.map((s) => `- ${s}`).join("\n")}

### Assumptions
${proposal.assumptions.map((a) => `- ${a}`).join("\n")}

### Risks
${proposal.risks.map((r) => `- **${r.id}**: ${r.description} (mitigation: ${r.mitigation})`).join("\n")}

### Likely Files (${proposal.likelyFiles.length})
${proposal.likelyFiles.map((f) => `- ${f}`).join("\n")}

### Implementation Plan
${proposal.implementationPlan.map((step, i) => `${i + 1}. ${step}`).join("\n")}

### Acceptance Criteria (${proposal.acceptance.length})
${proposal.acceptance
  .map(
    (c) =>
      `- **${c.id}** (${c.kind}, ${c.blocking ? "blocking" : "advisory"}): ${c.description}\n  Evidence: ${c.evidenceRequired.join(", ")}`,
  )
  .join("\n")}

### Review Checklist
${proposal.reviewChecklist.map((item) => `- ${item}`).join("\n")}${
  proposal.goals && proposal.goals.length > 0
    ? `\n\n### Goals (${proposal.goals.length})\n${proposal.goals.map((g) => `- **${g.id}**: ${g.description} (verifies: ${g.acceptanceCriteriaIds.join(", ")})`).join("\n")}`
    : ""
}${
  proposal.constraints && proposal.constraints.length > 0
    ? `\n\n### Constraints (${proposal.constraints.length})\n${proposal.constraints.map((c) => `- **${c.id}** (${c.kind}): ${c.description}${c.rationale ? ` — Rationale: ${c.rationale}` : " — ⚠ NO RATIONALE"}`).join("\n")}`
    : ""
}${
  proposal.guidance && proposal.guidance.length > 0
    ? `\n\n### Guidance (${proposal.guidance.length})\n${proposal.guidance.map((g) => `- **${g.id}**: ${g.description}${g.principle ? ` (principle: ${g.principle})` : ""}`).join("\n")}`
    : ""
}`);

  if (riskRegister && riskRegister.risks.length > 0) {
    sections.push(`## Risk Register (verify coverage)

${riskRegister.risks.map((r) => `- **${r.id}** (${r.severity}): ${r.description}`).join("\n")}

Check that the contract addresses relevant risks.`);
  }

  sections.push(`## Acceptance Conditions

A contract is acceptable ONLY when ALL of these are true:
1. Objective aligns with packet + spec
2. Scope is explicit and bounded
3. Out-of-scope is explicit (not empty)
4. **Out-of-scope does not contradict the objective.** If an outOfScope item excludes testing or verification of the primary flow described in the objective, flag it. Example: objective says "implement auth login" but outOfScope says "authentication token validation" — that's a contradiction.
5. Acceptance criteria are specific and testable
6. User-visible packets have at least one behavior/scenario criterion
7. Risky packets have at least one negative/invariant criterion
8. Long-running packets have heartbeat/completion verification
9. Rubric criteria have thresholds
10. Commands and evidence plans are reproducible
11. Packet is small enough to finish in one builder cycle
12. Goals array is not empty — contracts must have explicit goals
13. Each blocking acceptance criterion maps to at least one goal
14. Constraints have rationales and don't prescribe solutions
15. No constraint conflicts with a goal`);

  sections.push(`## Output Format

Emit your review as a structured JSON envelope:

${RESULT_START_SENTINEL}
{
  "packetId": "${proposal.packetId}",
  "round": ${proposal.round},
  "decision": "accept" | "revise" | "split" | "escalate",
  "scores": {
    "scopeFit": (1-5),
    "testability": (1-5),
    "riskCoverage": (1-5),
    "clarity": (1-5),
    "specAlignment": (1-5),
    "intentSeparation": (1-5)
  },
  "requiredChanges": ["change 1", "change 2"],
  "suggestedCriteriaAdditions": [
    {"id": "...", "kind": "...", "description": "...", "blocking": true, "evidenceRequired": ["..."]}
  ],
  "missingRisks": ["risk description"],
  "rationale": "explanation of decision"
}
${RESULT_END_SENTINEL}

### Decision guide:
- **accept**: Contract is good enough for the builder to start. Minor imperfections are OK — the evaluator will catch real issues later during verification. Err toward accepting if scores average 4+.
- **revise**: Structural issues that would prevent meaningful evaluation. Do NOT revise for polish or preferences — only for gaps that would make the contract untestable.
- **split**: Packet is too large. Suggest how to split.
- **escalate**: Fundamental issues that need human or replanning input.

### IMPORTANT: Pragmatism over perfection
This is round ${proposal.round}. ${pragmatismNote(proposal.round)}

Emit the envelope ONCE at the end. No commentary after the end marker.

**IMPORTANT:** Before emitting the envelope, validate using Option 1 (MCP tool) or Option 2 (CLI)
from the "MANDATORY: Validate Before Emitting" section above. Fix any errors before emitting.`);

  sections.push(`## Remember

Accept / revise / split / escalate. Above all: catch over-prescription — constraints
disguised as goals are the single biggest waster of builder cycles in the run pipeline.`);

  return sections.join("\n\n");
}

function pragmatismNote(round: number): string {
  if (round >= 3) {
    return `After ${round} rounds, be pragmatic. If the contract has clear scope, testable criteria, and scores average 4+, ACCEPT IT. The builder and evaluator phases will catch real issues — the contract just needs to be good enough to guide implementation. Do not hold up the pipeline for cosmetic improvements.`;
  }
  return "Focus on structural completeness — does the contract have clear scope, testable criteria, and adequate risk coverage?";
}
