/**
 * Packet completion summary generation.
 *
 * After a packet passes evaluation, generates a concise markdown summary
 * that propagates context to subsequent builder and evaluator agents.
 * This eliminates the "cold start" problem where each agent must
 * re-discover what prior packets created.
 *
 * Reference: Research analysis 03 — Proposal 6 (Packet Completion Summary)
 */

import { execSync } from "node:child_process";
import type {
  Packet,
  PacketContract,
  BuilderReport,
  EvaluatorReport,
} from "./schemas.js";

/**
 * Generate a concise markdown summary of a completed packet.
 *
 * This summary is injected into every subsequent builder and evaluator
 * prompt under a "Previously Completed Packets" section. It must be
 * compact (target: under 500 tokens) but contain the information that
 * eliminates exploratory reads:
 *
 * - What was built (packet name + description)
 * - Key files created/modified (from builder report)
 * - Patterns established (from builder report decisions)
 * - Integration points (from contract)
 * - Acceptance criteria results (from evaluator report)
 */
export function generateCompletionSummary(
  packet: Packet,
  contract: PacketContract,
  builderReport: BuilderReport,
  evaluatorReport: EvaluatorReport,
  opts?: { cwd?: string; commitShas?: string[] | null },
): string {
  const lines: string[] = [];

  // Header
  lines.push(`### ${packet.id}: ${packet.title}`);
  lines.push(`**Type:** ${packet.type} | **Status:** done`);
  lines.push("");

  // What was built — one-liner from the contract objective
  lines.push(`**Objective:** ${contract.objective}`);
  lines.push("");

  // Key files — from builder report
  if (builderReport.changedFiles.length > 0) {
    lines.push("**Files changed:**");
    for (const f of builderReport.changedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  // Commits — from builder's git discipline
  const commitShas = opts?.commitShas ?? builderReport.commitShas;
  if (commitShas?.length && opts?.cwd) {
    lines.push("**Commits:**");
    for (const sha of commitShas) {
      try {
        const msg = execSync(`git log --format="%s" -1 ${sha}`, { cwd: opts.cwd, encoding: "utf-8" }).trim();
        lines.push(`- \`${sha.slice(0, 7)}\` ${msg}`);
      } catch {
        lines.push(`- \`${sha.slice(0, 7)}\` (commit message unavailable)`);
      }
    }
    lines.push("");
  } else {
    // Fallback: extract from self-check evidence (legacy path for pre-commitShas reports)
    const decisions = extractKeyDecisions(builderReport);
    if (decisions.length > 0) {
      lines.push("**Key decisions/patterns:**");
      for (const d of decisions) {
        lines.push(`- ${d}`);
      }
      lines.push("");
    }
  }

  // Integration points — what this packet exposes for other packets to use.
  // Derived from the contract's inScope items and acceptance criteria.
  const integrationPoints = extractIntegrationPoints(contract);
  if (integrationPoints.length > 0) {
    lines.push("**Integration points:**");
    for (const ip of integrationPoints) {
      lines.push(`- ${ip}`);
    }
    lines.push("");
  }

  // Acceptance results — brief summary of pass/fail/advisory
  const criteriaResults = summarizeCriteriaResults(evaluatorReport);
  if (criteriaResults) {
    lines.push(`**Acceptance:** ${criteriaResults}`);
    lines.push("");
  }

  // Evaluator notes — anything the evaluator flagged as advisory/next-actions
  // that might affect subsequent packets
  if (evaluatorReport.nextActions.length > 0) {
    const relevantActions = evaluatorReport.nextActions;
    lines.push("**Evaluator notes for future packets:**");
    for (const a of relevantActions) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Extract key implementation decisions from the builder report.
 * Looks at self-check evidence for pattern indicators and remaining concerns.
 */
function extractKeyDecisions(report: BuilderReport): string[] {
  const decisions: string[] = [];

  // Extract from self-check evidence — look for technology/pattern mentions
  for (const check of report.selfCheckResults) {
    if (check.status === "pass" && check.evidence.length > 20) {
      // Include evidence that mentions specific technologies, patterns, or ports
      const evidence = check.evidence;
      if (
        /(?:using|chose|implemented with|running on port|configured|set up)/i.test(evidence) &&
        evidence.length < 200
      ) {
        decisions.push(evidence);
      }
    }
  }

  // Include remaining concerns that could affect downstream packets
  for (const concern of report.remainingConcerns) {
    if (concern.length < 200) {
      decisions.push(`[concern] ${concern}`);
    }
  }

  // Cap at 5 to keep the summary compact
  return decisions;
}

/**
 * Extract integration points from the contract — things this packet
 * exposes that other packets might depend on.
 */
function extractIntegrationPoints(contract: PacketContract): string[] {
  const points: string[] = [];

  // From inScope items that mention "API", "component", "hook", "route", "export"
  for (const item of contract.inScope) {
    if (/(?:api|component|hook|route|export|endpoint|interface|type|schema|store|context|provider)/i.test(item)) {
      points.push(item);
    }
  }

  // Cap at 5
  return points;
}

/**
 * Summarize criterion results into a compact one-liner.
 */
function summarizeCriteriaResults(report: EvaluatorReport): string {
  if (report.criterionVerdicts.length === 0) {
    // Fallback to overall
    return `Overall: ${report.overall}`;
  }

  const passed = report.criterionVerdicts.filter((v) => v.verdict === "pass").length;
  const failed = report.criterionVerdicts.filter((v) => v.verdict === "fail").length;
  const skipped = report.criterionVerdicts.filter((v) => v.verdict === "skip").length;
  const total = report.criterionVerdicts.length;

  const parts = [`${passed}/${total} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return parts.join(", ");
}
