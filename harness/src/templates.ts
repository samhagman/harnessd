/**
 * Acceptance criteria templates per packet type.
 *
 * Each template defines the required criterion kinds and default criteria
 * that the contract builder starts from. The evaluator critiques the
 * specialization, not a blank page.
 *
 * Reference: TAD section 12.3
 */

import path from "node:path";

import type {
  PacketType,
  AcceptanceTemplate,
} from "./schemas.js";
import { atomicWriteJson } from "./state-store.js";

const templates: Record<PacketType, AcceptanceTemplate> = {
  bugfix: {
    type: "bugfix",
    requiredCriterionKinds: ["command", "negative"],
    defaultCriteria: [
      {
        id: "repro",
        kind: "command",
        blocking: true,
        description: "Bug can no longer be reproduced with the original reproduction steps",
        evidenceRequired: ["reproduction command", "output showing fix"],
      },
      {
        id: "regression-test",
        kind: "command",
        blocking: true,
        description: "Regression test added and passing",
        evidenceRequired: ["test command", "test output"],
      },
      {
        id: "no-side-effects",
        kind: "invariant",
        blocking: true,
        description: "No unrelated test failures introduced",
        evidenceRequired: ["full test suite output"],
      },
    ],
  },

  ui_feature: {
    type: "ui_feature",
    requiredCriterionKinds: ["scenario", "invariant"],
    defaultCriteria: [
      {
        id: "interactive-scenario",
        kind: "scenario",
        blocking: true,
        description: "At least one interactive user scenario works end-to-end",
        evidenceRequired: ["scenario steps", "observed behavior"],
      },
      {
        id: "no-console-errors",
        kind: "invariant",
        blocking: true,
        description: "No new console errors in browser",
        evidenceRequired: ["console output"],
      },
      {
        id: "design-polish",
        kind: "rubric",
        blocking: false,
        description: "Visual design meets quality expectations",
        rubric: { scale: "1-5", threshold: 3, dimensions: ["polish", "consistency", "responsiveness"] },
        evidenceRequired: ["screenshot or visual inspection"],
      },
    ],
  },

  backend_feature: {
    type: "backend_feature",
    requiredCriterionKinds: ["command", "scenario"],
    defaultCriteria: [
      {
        id: "route-works",
        kind: "command",
        blocking: true,
        description: "API route / service endpoint responds correctly",
        evidenceRequired: ["request command", "response"],
      },
      {
        id: "integration",
        kind: "scenario",
        blocking: true,
        description: "Integration scenario with dependent services passes",
        evidenceRequired: ["scenario steps", "final state"],
      },
      {
        id: "error-handling",
        kind: "negative",
        blocking: true,
        description: "Error paths return appropriate status codes and messages",
        evidenceRequired: ["error request", "error response"],
      },
    ],
  },

  migration: {
    type: "migration",
    requiredCriterionKinds: ["command", "artifact", "negative"],
    defaultCriteria: [
      {
        id: "forward-migration",
        kind: "command",
        blocking: true,
        description: "Forward migration completes successfully",
        evidenceRequired: ["migration command", "output"],
      },
      {
        id: "data-integrity",
        kind: "artifact",
        blocking: true,
        description: "Data integrity check passes (row counts, checksums)",
        evidenceRequired: ["check command", "results"],
      },
      {
        id: "rollback-plan",
        kind: "negative",
        blocking: true,
        description: "Rollback or restore plan documented and tested",
        evidenceRequired: ["rollback steps", "test output"],
      },
    ],
  },

  refactor: {
    type: "refactor",
    requiredCriterionKinds: ["command", "invariant"],
    defaultCriteria: [
      {
        id: "no-behavior-change",
        kind: "command",
        blocking: true,
        description: "Full test suite passes with no behavior changes",
        evidenceRequired: ["test command", "output"],
      },
      {
        id: "scope-bounded",
        kind: "invariant",
        blocking: true,
        description: "Changed files are within the expected scope",
        evidenceRequired: ["git diff --stat"],
      },
      {
        id: "code-clarity",
        kind: "rubric",
        blocking: false,
        description: "Code is clearer and more maintainable after refactor",
        rubric: { scale: "1-5", threshold: 3, dimensions: ["clarity", "simplicity", "consistency"] },
        evidenceRequired: ["diff review"],
      },
    ],
  },

  long_running_job: {
    type: "long_running_job",
    requiredCriterionKinds: ["command", "artifact", "observability", "negative"],
    defaultCriteria: [
      {
        id: "launch-job",
        kind: "command",
        blocking: true,
        description: "Job launches successfully and returns a PID or task identifier",
        evidenceRequired: ["launch command", "pid/task id"],
      },
      {
        id: "heartbeat",
        kind: "observability",
        blocking: true,
        description: "Job emits heartbeat while running",
        evidenceRequired: ["heartbeat timestamp", "log snippet"],
      },
      {
        id: "artifact-complete",
        kind: "artifact",
        blocking: true,
        description: "Expected output artifact exists and passes integrity checks",
        evidenceRequired: ["file path", "size/hash/check"],
      },
      {
        id: "failure-log",
        kind: "negative",
        blocking: true,
        description: "Failure case produces useful error logs",
        evidenceRequired: ["failure trigger", "log output"],
      },
    ],
  },

  integration: {
    type: "integration",
    requiredCriterionKinds: ["scenario", "negative"],
    defaultCriteria: [
      {
        id: "e2e-scenario",
        kind: "scenario",
        blocking: true,
        description: "Multi-component end-to-end scenario passes",
        evidenceRequired: ["scenario steps", "final state"],
      },
      {
        id: "env-setup",
        kind: "command",
        blocking: true,
        description: "Environment setup is documented and reproducible",
        evidenceRequired: ["setup command", "verification"],
      },
      {
        id: "failure-path",
        kind: "negative",
        blocking: true,
        description: "Failure path is handled gracefully",
        evidenceRequired: ["failure trigger", "observed behavior"],
      },
      {
        id: "cleanup",
        kind: "command",
        blocking: false,
        description: "Cleanup after test leaves environment in known state",
        evidenceRequired: ["cleanup command", "state check"],
      },
    ],
  },

  tooling: {
    type: "tooling",
    requiredCriterionKinds: ["command"],
    defaultCriteria: [
      {
        id: "tool-works",
        kind: "command",
        blocking: true,
        description: "Tool runs successfully with expected output",
        evidenceRequired: ["command", "output"],
      },
      {
        id: "help-output",
        kind: "command",
        blocking: false,
        description: "Tool provides help/usage information",
        evidenceRequired: ["help command", "output"],
      },
    ],
  },
};

/**
 * Get the acceptance template for a given packet type.
 */
export function getTemplate(packetType: PacketType): AcceptanceTemplate {
  return templates[packetType];
}

/**
 * Get all templates.
 */
export function getAllTemplates(): Record<PacketType, AcceptanceTemplate> {
  return { ...templates };
}

/**
 * Initialize acceptance template files in the project directory.
 */
export function initializeAcceptanceTemplates(projectDir: string): void {
  for (const [type, template] of Object.entries(templates)) {
    atomicWriteJson(path.join(projectDir, "acceptance-templates", `${type}.json`), template);
  }
}
