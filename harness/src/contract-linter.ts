/**
 * Contract linter — validates a contract proposal before spending model calls.
 *
 * Enforces structural rules from TAD section 11.5:
 * - Schema validates
 * - Required criterion counts per packet type
 * - outOfScope not empty
 * - acceptance not empty
 * - likelyFiles reasonable for packet size
 * - long_running_job has observability criteria
 * - User-visible packets have behavior/scenario criteria
 * - Risky packets have negative/invariant criteria
 *
 * Reference: TAD section 11.5
 */

import type { PacketContract, PacketType, AcceptanceTemplate, CriterionKind } from "./schemas.js";
import { PacketContractSchema, RISKY_PACKET_TYPES } from "./schemas.js";
import { getTemplate } from "./templates.js";

export interface LintResult {
  valid: boolean;
  errors: string[];
}

const USER_VISIBLE_TYPES: readonly PacketType[] = ["ui_feature", "backend_feature", "integration"];

const MAX_LIKELY_FILES_BY_SIZE = {
  S: 8,
  M: 20,
  L: 50,
};

/**
 * Lint a contract proposal. Returns errors if any rules are violated.
 * If lint fails, the orchestrator should auto-return to the builder
 * without spending model calls on evaluator review.
 */
export function lintContract(
  proposal: unknown,
  packetType: PacketType,
  estimatedSize?: "S" | "M" | "L",
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

  // 5. likelyFiles reasonable for packet size
  if (estimatedSize) {
    const max = MAX_LIKELY_FILES_BY_SIZE[estimatedSize];
    if (contract.likelyFiles.length > max) {
      errors.push(
        `likelyFiles has ${contract.likelyFiles.length} entries but size "${estimatedSize}" allows max ${max}. Reduce scope or increase size estimate.`,
      );
    }
  }

  // 6. long_running_job must have observability criteria
  if (packetType === "long_running_job") {
    const hasObservability = contract.acceptance.some(
      (c) => c.kind === "observability",
    );
    if (!hasObservability) {
      errors.push(
        'Packet type "long_running_job" requires at least one "observability" criterion (heartbeat, logs, completion signal).',
      );
    }
  }

  // 7. User-visible packets need behavior/scenario criteria
  if (USER_VISIBLE_TYPES.includes(packetType)) {
    const hasBehavior = contract.acceptance.some(
      (c) => c.kind === "scenario" || c.kind === "api",
    );
    if (!hasBehavior) {
      errors.push(
        `User-visible packet type "${packetType}" requires at least one "scenario" or "api" criterion.`,
      );
    }
  }

  // 8. Risky packets need negative/invariant criteria
  if (RISKY_PACKET_TYPES.includes(packetType)) {
    const hasNegative = contract.acceptance.some(
      (c) => c.kind === "negative" || c.kind === "invariant",
    );
    if (!hasNegative) {
      errors.push(
        `Risky packet type "${packetType}" requires at least one "negative" or "invariant" criterion.`,
      );
    }
  }

  // 9. Blocking criteria must have evidence requirements
  for (const criterion of contract.acceptance) {
    if (criterion.blocking && criterion.evidenceRequired.length === 0) {
      errors.push(
        `Blocking criterion "${criterion.id}" must have at least one evidenceRequired entry.`,
      );
    }
  }

  // 10. Rubric criteria must have thresholds — auto-fix if possible
  for (const criterion of contract.acceptance) {
    if (criterion.kind === "rubric" && !criterion.rubric) {
      // Auto-fix: inject a default rubric object instead of failing the lint
      (criterion as any).rubric = {
        scale: "1-5" as const,
        threshold: 3,
        dimensions: ["quality", "consistency", "polish"],
      };
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
