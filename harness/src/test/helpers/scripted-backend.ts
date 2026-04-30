/**
 * Shared test helpers for scripted backends and envelope fixtures.
 *
 * ScriptedBackend replays pre-defined message sequences in order —
 * one script per runSession() call — without spawning real processes.
 * Used across scenario and orchestrator integration tests.
 */

import type { AgentMessage, AgentBackend, AgentSessionOptions, NudgeOutcome } from "../../backend/types.js";
import {
  RESULT_START_SENTINEL,
  RESULT_END_SENTINEL,
} from "../../schemas.js";

export class ScriptedBackend implements AgentBackend {
  private callIndex = 0;
  private scripts: AgentMessage[][];
  private lastSessionId: string | null = null;
  readonly calls: AgentSessionOptions[] = [];

  constructor(scripts: AgentMessage[][]) {
    this.scripts = scripts;
  }

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    this.calls.push(opts);
    const idx = this.callIndex++;
    const script = this.scripts[idx];
    if (!script) {
      throw new Error(`ScriptedBackend: no script for call index ${idx}`);
    }
    for (const msg of script) {
      if (msg.sessionId) this.lastSessionId = msg.sessionId;
      yield msg;
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  queueNudge(_text: string): NudgeOutcome {
    return { handled: false };
  }

  abortSession(): string | null {
    return this.lastSessionId;
  }

  supportsResume(): boolean { return true; }
  supportsMcpServers(): boolean { return false; }
  nudgeStrategy(): "stream" | "abort-resume" | "none" { return "none"; }
  supportsOutputSchema(): boolean { return false; }
}

export function makeScript(text: string, sessionId: string = "sess-001"): AgentMessage[] {
  return [
    { type: "system", subtype: "init", sessionId },
    { type: "assistant", text },
    { type: "result", subtype: "success", text, isError: false, numTurns: 1, sessionId },
  ];
}

export function plannerEnvelope(opts?: { requiresHumanReview?: boolean }): string {
  const payload = {
    spec: "# Test Spec\n\nGoal: build the thing.\n",
    packets: [
      {
        id: "PKT-001",
        title: "Add helper utility",
        type: "tooling",
        objective: "Create a helper utility",
        whyNow: "Foundation for other work",
        dependencies: [],
        status: "pending",
        priority: 1,
        estimatedSize: "S",
        risks: [],
        notes: [],
        requiresHumanReview: opts?.requiresHumanReview ?? false,
      },
    ],
    riskRegister: {
      risks: [
        {
          id: "RISK-001",
          description: "Might not work",
          severity: "low",
          mitigation: "Test it",
          watchpoints: ["Check exit codes"],
        },
      ],
    },
    evaluatorGuide: {
      domain: "tooling",
      qualityCriteria: [{ name: "correctness", weight: 5, description: "Tests pass" }],
      antiPatterns: ["hardcoded paths"],
      referenceStandard: "Clean code",
      edgeCases: ["empty input"],
      calibrationExamples: [{ dimension: "correctness", score: 5, description: "All tests pass" }],
      skepticismLevel: "normal",
    },
    planSummary: "One packet: helper utility.\n",
  };
  return `Here is the plan:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

export function contractBuilderEnvelope(packetId: string, round: number = 1): string {
  const payload = {
    packetId,
    round,
    status: "proposed",
    title: `Implement ${packetId}`,
    packetType: "tooling",
    objective: `Implement the ${packetId} packet`,
    inScope: ["Create the utility script"],
    outOfScope: ["Deployment automation"],
    assumptions: ["Node.js available"],
    risks: [{ id: "R1", description: "Might be slow", mitigation: "Profile it" }],
    likelyFiles: ["src/helper.ts"],
    implementationPlan: ["Step 1: Read codebase", "Step 2: Implement"],
    backgroundJobs: [],
    microFanoutPlan: [],
    acceptance: [
      {
        id: "AC-001",
        kind: "command",
        description: "Script runs successfully",
        blocking: true,
        evidenceRequired: ["command output"],
      },
    ],
    reviewChecklist: ["Check exit codes"],
    proposedCommitMessage: `harnessd(${packetId}): implement utility`,
  };
  return `Here is the contract:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

export function contractEvaluatorAcceptEnvelope(packetId: string, round: number = 1): string {
  const payload = {
    packetId,
    round,
    decision: "accept",
    scores: { scopeFit: 5, testability: 5, riskCoverage: 4, clarity: 5, specAlignment: 5 },
    requiredChanges: [],
    suggestedCriteriaAdditions: [],
    missingRisks: [],
    rationale: "Contract looks good, accepting.",
  };
  return `Review complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

export function builderReportEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "builder-session-001",
    changedFiles: ["src/helper.ts"],
    commandsRun: [{ command: "npx tsc --noEmit", exitCode: 0, summary: "type check passes" }],
    liveBackgroundJobs: [],
    microFanoutUsed: [],
    selfCheckResults: [
      { criterionId: "AC-001", status: "pass", evidence: "Script runs with exit 0" },
    ],
    remainingConcerns: [],
    claimsDone: true,
  };
  return `Implementation complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}

export function evaluatorPassEnvelope(packetId: string): string {
  const payload = {
    packetId,
    sessionId: "evaluator-session-001",
    overall: "pass",
    hardFailures: [],
    rubricScores: [],
    criterionVerdicts: [
      {
        criterionId: "AC-001",
        verdict: "pass",
        evidence: "Script runs with exit 0, output matches expected",
      },
    ],
    missingEvidence: [],
    nextActions: [],
    contractGapDetected: false,
  };
  return `Evaluation complete:\n\n${RESULT_START_SENTINEL}\n${JSON.stringify(payload)}\n${RESULT_END_SENTINEL}\n`;
}
