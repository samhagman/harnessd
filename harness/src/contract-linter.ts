/**
 * Contract linter — validates a contract proposal before spending model calls on evaluator review.
 * Reference: TAD section 11.5
 */

import type { PacketType } from "./schemas.js";
import { PacketContractSchema, RISKY_PACKET_TYPES } from "./schemas.js";
import { getTemplate } from "./templates.js";

export interface LintResult {
  valid: boolean;
  errors: string[];
}

const USER_VISIBLE_TYPES: readonly PacketType[] = ["ui_feature", "backend_feature", "integration"];

/**
 * Lint a contract proposal. Returns errors if any rules are violated.
 * If lint fails, the orchestrator should auto-return to the builder
 * without spending model calls on evaluator review.
 */
export function lintContract(
  proposal: unknown,
  packetType: PacketType,
): LintResult {
  const errors: string[] = [];

  // 1. Schema validation
  const parseResult = PacketContractSchema.safeParse(proposal);
  if (!parseResult.success) {
    errors.push(`Schema validation failed: ${parseResult.error.message}`);
    return { valid: false, errors };
  }

  const contract = parseResult.data;

  // 2. outOfScope must not be empty
  if (contract.outOfScope.length === 0) {
    errors.push("outOfScope must not be empty. Explicitly state what is out of scope.");
  }

  // 3. acceptance must not be empty
  if (contract.acceptance.length === 0) {
    errors.push("acceptance must not be empty. At least one acceptance criterion is required.");
  }

  // 4. Required criterion kinds per packet type
  const template = getTemplate(packetType);
  if (template) {
    const presentKinds = new Set(contract.acceptance.map((c) => c.kind));
    for (const requiredKind of template.requiredCriterionKinds) {
      if (!presentKinds.has(requiredKind)) {
        errors.push(
          `Packet type "${packetType}" requires at least one "${requiredKind}" criterion.`,
        );
      }
    }
  }

  // 5. long_running_job must have observability criteria
  if (packetType === "long_running_job") {
    const hasObservability = contract.acceptance.some((c) => c.kind === "observability");
    if (!hasObservability) {
      errors.push(
        'Packet type "long_running_job" requires at least one "observability" criterion (heartbeat, logs, completion signal).',
      );
    }
  }

  // 6. User-visible packets need behavior/scenario criteria
  if (USER_VISIBLE_TYPES.includes(packetType)) {
    const hasBehavior = contract.acceptance.some((c) => c.kind === "scenario" || c.kind === "api");
    if (!hasBehavior) {
      errors.push(
        `User-visible packet type "${packetType}" requires at least one "scenario" or "api" criterion.`,
      );
    }
  }

  // 7. Risky packets need negative/invariant criteria
  if (RISKY_PACKET_TYPES.includes(packetType)) {
    const hasNegative = contract.acceptance.some((c) => c.kind === "negative" || c.kind === "invariant");
    if (!hasNegative) {
      errors.push(
        `Risky packet type "${packetType}" requires at least one "negative" or "invariant" criterion.`,
      );
    }
  }

  // 8. Blocking criteria must have evidence requirements
  for (const criterion of contract.acceptance) {
    if (criterion.blocking && criterion.evidenceRequired.length === 0) {
      errors.push(
        `Blocking criterion "${criterion.id}" must have at least one evidenceRequired entry.`,
      );
    }
  }

  // 9. Rubric criteria must have a rubric object — auto-fix with defaults if missing
  for (const criterion of contract.acceptance) {
    if (criterion.kind === "rubric" && !criterion.rubric) {
      (criterion as any).rubric = {
        scale: "1-5" as const,
        threshold: 3,
        dimensions: ["quality", "consistency", "polish"],
      };
    }
  }

  // 10. Goals: each blocking AC must map to a goal; goal AC references must exist
  if (contract.goals.length > 0) {
    const allMappedAcIds = new Set(contract.goals.flatMap((g) => g.acceptanceCriteriaIds));
    const blockingAcIds = contract.acceptance.filter((ac) => ac.blocking).map((ac) => ac.id);
    const unmappedBlocking = blockingAcIds.filter((id) => !allMappedAcIds.has(id));
    if (unmappedBlocking.length > 0) {
      errors.push(
        `Blocking acceptance criteria not mapped to any goal: ${unmappedBlocking.join(", ")}. Each blocking AC should verify at least one goal.`,
      );
    }

    const actualAcIds = new Set(contract.acceptance.map((ac) => ac.id));
    for (const goal of contract.goals) {
      const dangling = goal.acceptanceCriteriaIds.filter((id) => !actualAcIds.has(id));
      if (dangling.length > 0) {
        errors.push(
          `Goal "${goal.id}" references non-existent acceptance criteria: ${dangling.join(", ")}`,
        );
      }
    }
  }

  // 11. Constraints must have rationales
  if (contract.constraints.length > 0) {
    const noRationale = contract.constraints.filter((c) => !c.rationale);
    if (noRationale.length > 0) {
      errors.push(
        `Constraints without rationale: ${noRationale.map((c) => c.id).join(", ")}. Add rationale explaining WHY each constraint exists.`,
      );
    }
  }

  // 12. Scenario/API criteria must have a structured verification mechanism.
  //     Checks schema fields (command, scenario) rather than prose keywords in
  //     evidenceRequired — the contract evaluator handles evidence quality review.
  if (USER_VISIBLE_TYPES.includes(packetType)) {
    for (const criterion of contract.acceptance) {
      if (criterion.kind === "scenario" || criterion.kind === "api") {
        const hasStructuredVerification = !!criterion.command || !!criterion.scenario;
        if (!hasStructuredVerification && criterion.evidenceRequired.length === 0) {
          errors.push(
            `Scenario/API criterion '${criterion.id}' has no verification mechanism. ` +
              `Add a 'command' field, a 'scenario' with steps, or at least one 'evidenceRequired' entry.`,
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
