# File Map — Complete Directory Reference

Every harnessd run writes its entire state to `.harnessd/runs/<run-id>/`. This is the single source of truth — the orchestrator reads and writes these files, and the operator can inspect or modify them at any time.

## Directory Structure

```
.harnessd/
└── runs/
    └── run-20260327-093802-66bf/           # Run ID: date-time-random
        │
        ├── run.json                         # STATE MACHINE
        │   Phase, current packet, completed/failed/blocked lists,
        │   operator flags (pauseAfterCurrentPacket, stopRequested),
        │   rate limit state, worker info.
        │   This is what status.sh reads.
        │
        ├── events.jsonl                     # EVENT STREAM
        │   Append-only. One JSON object per line.
        │   Every phase transition, agent start/stop, nudge, gate,
        │   approval, and error is recorded here.
        │   Fields: ts, event, phase?, packetId?, detail?
        │
        ├── status.json                      # MACHINE-READABLE STATUS
        │   StatusSnapshot: runId, phase, objective, elapsed,
        │   currentPacket, packetsComplete/Total, alerts, nextAction.
        │   Updated on every phase change.
        │
        ├── status.md                        # HUMAN-READABLE STATUS
        │   Markdown rendering of status.json.
        │   What ./harness/status.sh prints.
        │
        ├── spec/                            # PLANNING ARTIFACTS
        │   ├── SPEC.md                      # High-level specification
        │   │   Written by planner. Sections: Goal, User-visible
        │   │   outcomes, Core flows, Technical architecture,
        │   │   Non-goals, Risks, Packet summary table.
        │   │
        │   ├── packets.json                 # PACKET LIST
        │   │   Array of packets. Each has: id, title, type,
        │   │   objective, whyNow, dependencies, status, priority,
        │   │   estimatedSize, risks, notes, requiresHumanReview.
        │   │   Operator can edit this mid-run (toggle gates, reorder).
        │   │
        │   ├── risk-register.json           # IDENTIFIED RISKS
        │   │   { risks: [{ id, description, severity, mitigation,
        │   │   watchpoints }] }
        │   │
        │   ├── evaluator-guide.json         # QUALITY CRITERIA
        │   │   Domain-specific guide for the evaluator:
        │   │   domain, qualityCriteria (weighted), antiPatterns,
        │   │   referenceStandard, edgeCases, browserVerification,
        │   │   calibrationExamples, skepticismLevel.
        │   │   Operator can edit mid-run — next evaluator picks it up.
        │   │
        │   ├── planning-context.json        # OPERATOR INTERVIEW
        │   │   Optional. Written by --interview flag or operator skill.
        │   │   { vision, techPreferences, designReferences,
        │   │   avoidList, doneDefinition, customNotes }
        │   │
        │   ├── plan-summary.md              # SHORT SUMMARY
        │   │   5-10 line human-readable summary of the plan.
        │   │
        │   └── context-overrides.md         # ACCUMULATED CONTEXT
        │       Append-only. Every nudge, pivot, and inject_context
        │       adds a timestamped entry here. Included in every
        │       future builder prompt for this run.
        │
        ├── packets/                         # PER-PACKET ARTIFACTS
        │   └── PKT-001/
        │       ├── nudge.md                 # NUDGE FILE
        │       │   Builder checks this before each major step.
        │       │   Written by nudge poller on send_to_agent/pivot.
        │       │   Builder reads, incorporates, deletes.
        │       │
        │       ├── contract/                # CONTRACT NEGOTIATION
        │       │   ├── proposal.r01.json    # Round 1 proposal
        │       │   ├── review.r01.json      # Round 1 review
        │       │   ├── proposal.r02.json    # Round 2 proposal (if revised)
        │       │   ├── review.r02.json      # Round 2 review
        │       │   └── final.json           # ACCEPTED contract
        │       │       Contains: acceptance criteria, in/out scope,
        │       │       implementation plan, risks, likely files,
        │       │       background jobs, micro-fanout plan.
        │       │
        │       ├── builder/                 # BUILDER ARTIFACTS
        │       │   ├── session.json         # Session metadata
        │       │   │   sessionId, role, startedAt, endedAt,
        │       │   │   transcriptPath, resultPath.
        │       │   │
        │       │   ├── transcript.jsonl     # Legacy transcript
        │       │   │   Also in transcripts/PKT-001/ (new location).
        │       │   │
        │       │   ├── heartbeat.json       # LIVENESS CHECK
        │       │   │   { sessionId, role, ts, turnCount }
        │       │   │   Updated every 20s. Stale = agent may be dead.
        │       │   │
        │       │   ├── builder-report.json  # SELF-CHECK RESULTS
        │       │   │   { packetId, changedFiles, commandsRun,
        │       │   │   selfCheckResults, claimsDone }
        │       │   │
        │       │   └── result.json          # WORKER RESULT
        │       │       { envelopeFound, payload, sessionId,
        │       │       numTurns, hadError, transcriptPath }
        │       │
        │       └── evaluator/               # EVALUATOR ARTIFACTS
        │           ├── session.json
        │           ├── transcript.jsonl
        │           ├── heartbeat.json
        │           ├── evaluator-report.json  # EVALUATION RESULT
        │           │   { overall: "pass"|"fail", hardFailures,
        │           │   rubricScores, missingEvidence, nextActions,
        │           │   contractGapDetected }
        │           └── result.json
        │
        ├── transcripts/                     # ORGANIZED TRANSCRIPTS
        │   ├── planner/
        │   │   ├── planner-2026-03-27T09-00-00-000Z.jsonl
        │   │   └── planner-2026-03-27T09-05-00-000Z.jsonl  # retry
        │   └── PKT-001/
        │       ├── contract_builder-2026-03-27T09-10-00-000Z.jsonl
        │       ├── contract_evaluator-2026-03-27T09-12-00-000Z.jsonl
        │       ├── builder-2026-03-27T09-15-00-000Z.jsonl
        │       ├── builder-2026-03-27T09-20-00-000Z.jsonl  # retry
        │       └── evaluator-2026-03-27T09-25-00-000Z.jsonl
        │   Each file is a complete JSONL transcript of one agent
        │   session. Multiple files per role = multiple attempts.
        │   Format: { ts, role, msg: AgentMessage }
        │
        └── inbox/                           # OPERATOR CONTROL
            ├── 1774620087-nudge.json        # Pending message
            ├── CONSUMED__1774616087-approve.json  # Processed
            └── CONSUMED__1774616192-nudge.json    # Processed
```

## Key Files for Common Tasks

| I want to... | Read this file |
|---|---|
| Check current phase | `run.json` → `.phase` |
| See what packet is building | `run.json` → `.currentPacketId` |
| Read the plan | `spec/SPEC.md` |
| See packet list + gates | `spec/packets.json` |
| Check evaluator criteria | `spec/evaluator-guide.json` |
| See what nudges were sent | `spec/context-overrides.md` |
| Check if builder is alive | `packets/PKT-NNN/builder/heartbeat.json` → `.ts` |
| See why evaluator failed | `packets/PKT-NNN/evaluator/evaluator-report.json` |
| Read contract details | `packets/PKT-NNN/contract/final.json` |
| See full event history | `events.jsonl` |
| Read agent conversation | `transcripts/PKT-NNN/builder-*.jsonl` |
