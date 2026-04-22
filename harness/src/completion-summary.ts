/**
 * Packet completion context generation.
 *
 * After a packet passes evaluation, generates a structured context object
 * (PacketCompletionContext) that propagates intent, decisions, and outcomes
 * to subsequent builder, evaluator, and QA agents.
 *
 * Replaces the old markdown string approach with a typed schema — no regex
 * extraction, no arbitrary caps. The data is already bounded by the number
 * of packets (typically 5-15), so prompt builders can render it faithfully
 * for their audience without loss.
 *
 * Reference: Research analysis 03 — Proposal 6 (Packet Completion Summary)
 */

import { execSync } from "node:child_process";
import type {
  Packet,
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  PacketCompletionContext,
} from "./schemas.js";

/**
 * Extract commit messages from git log for the given SHAs.
 * Returns an array of message strings (just the subjects).
 * Falls back to empty array if git is unavailable or SHAs are missing.
 */
function extractCommitMessages(cwd?: string, commitShas?: string[] | null): string[] {
  if (!commitShas?.length || !cwd) return [];
  try {
    const output = execSync(
      `git log --no-walk --format="%s" ${commitShas.join(" ")}`,
      { cwd, encoding: "utf-8" },
    ).trim();
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Generate a structured completion context for a completed packet.
 *
 * This context is injected into every subsequent builder, evaluator, and QA
 * prompt so they understand not just WHAT was built but WHY. Three layers:
 *
 * - Intent: goals, constraints, and guidance from the contract
 * - Execution: changed files, key decisions, scope from the builder report
 * - Outcome: acceptance results and evaluator notes
 */
export function generateCompletionContext(
  packet: Packet,
  contract: PacketContract,
  builderReport: BuilderReport,
  evaluatorReport: EvaluatorReport,
  opts?: { cwd?: string; commitShas?: string[] | null },
): PacketCompletionContext {
  // Extract commit messages via git log
  const commitMessages = extractCommitMessages(
    opts?.cwd,
    opts?.commitShas ?? builderReport.commitShas,
  );

  // Acceptance results from evaluator verdicts
  const verdicts = evaluatorReport.criterionVerdicts;
  const acceptanceResults = {
    passed: verdicts.filter((v) => v.verdict === "pass").length,
    failed: verdicts.filter((v) => v.verdict === "fail").length,
    skipped: verdicts.filter((v) => v.verdict === "skip").length,
    total: verdicts.length,
  };

  return {
    packetId: packet.id,
    title: packet.title,
    packetType: packet.type,
    objective: contract.objective,

    // Intent — direct from contract, no filtering
    goals: contract.goals ?? [],
    constraints: contract.constraints ?? [],
    guidance: contract.guidance ?? [],

    // Execution — direct from builder report, no filtering
    changedFiles: builderReport.changedFiles,
    keyDecisions: builderReport.keyDecisions ?? [],
    inScope: contract.inScope,
    outOfScope: contract.outOfScope,
    commitMessages,

    // Outcome — direct from evaluator, no filtering
    acceptanceResults,
    evaluatorAddedCriteria: evaluatorReport.addedCriteria.map(
      (c) => `${c.kind}: ${c.description}`,
    ),
    remainingConcerns: builderReport.remainingConcerns,
    evaluatorNotes: evaluatorReport.nextActions,
  };
}
