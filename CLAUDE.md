# Harnessd

**A contract-driven harness for Claude Code to handle long-running autonomous tasks.**

---

## Vision

Harnessd enables AI agents to work autonomously on complex, multi-session tasks that exceed a single context window. The core insight: long-running agent success requires explicit planning, contract-based acceptance, durable state, and independent verification.

```
┌────────────────────────────────────────────────────────────────────┐
│                          USER                                       │
│                            │                                        │
│                            ▼                                        │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    ORCHESTRATOR                               │  │
│  │  • Planner mode: objective → SPEC.md + packets.json           │  │
│  │  • Packet selection: linear, dependency-aware                 │  │
│  │  • Contract negotiation: multi-round builder↔evaluator        │  │
│  │  • Status rendering, poke/resume, rate-limit recovery         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                            │                                        │
│            ┌───────────────┼───────────────┐                        │
│            ▼               ▼               ▼                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │   PLANNER    │  │   CONTRACT   │  │   PACKET     │             │
│  │  read-only   │  │  NEGOTIATOR  │  │   RUNNER     │             │
│  │  SPEC.md     │  │  multi-round │  │              │             │
│  │  packets.json│  │  lint+review │  │  ┌────────┐  │             │
│  │  risks.json  │  │  final.json  │  │  │BUILDER │  │             │
│  └──────────────┘  └──────────────┘  │  └───┬────┘  │             │
│                                       │      │       │             │
│                                       │      ▼       │             │
│                                       │  ┌────────┐  │             │
│                                       │  │EVALUAT.│  │             │
│                                       │  │(r/o)   │  │             │
│                                       │  └───┬────┘  │             │
│                                       │      │       │             │
│                                       │      ▼       │             │
│                                       │  fix loop    │             │
│                                       │  or done     │             │
│                                       └──────────────┘             │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    STATE (.harnessd/)                          │  │
│  │  • run.json — phase machine state                             │  │
│  │  • events.jsonl — append-only event stream                    │  │
│  │  • status.json / status.md — human-readable status            │  │
│  │  • spec/ — SPEC.md, packets.json, risk-register.json,         │  │
│  │           evaluator-guide.json, planning-context.json         │  │
│  │  • packets/PKT-NNN/ — contract, builder, evaluator artifacts  │  │
│  │  • transcripts/ — organized by packet and role                │  │
│  │  • inbox/ outbox/ — operator communication channel            │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Architecture (v2)

### Orchestrator
The top-level state machine. Drives planning → packet selection → contract negotiation → build → evaluate → fix loops → completion. Handles rate limits, pokes, resume, and status rendering.

### Planner mode
Read-only agent that expands a user objective into `SPEC.md`, `packets.json`, `risk-register.json`, and `plan-summary.md`.

### Contract negotiation
Multi-round loop: contract builder proposes, contract linter validates, contract evaluator reviews. Supports accept/revise/split/escalate decisions. Max 4 rounds (5 for risky packet types).

### Builder
The only repo writer. Implements one packet at a time against a finalized contract. Self-checks all acceptance criteria before claiming done.

### Evaluator
Strictly read-only. Disconfirms completion claims. Reports hard failures, rubric scores, and contract gaps. If a contract gap is found, the packet returns to negotiation (not just a fix loop).

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Packet** | Smallest durable implementation unit (coherent, independently verifiable) |
| **Contract** | Negotiated agreement with explicit acceptance criteria before building |
| **Acceptance criteria** | Mix of hard gates (commands, scenarios, invariants) and rubrics |
| **Packet types** | bugfix, ui_feature, backend_feature, migration, refactor, long_running_job, integration, tooling |
| **Result envelope** | `===HARNESSD_RESULT_START===` ... JSON ... `===HARNESSD_RESULT_END===` |
| **AgentBackend** | Abstraction over SDK — enables testing with FakeBackend (zero quota) |
| **Linear execution** | One packet at a time; parallelism only inside the active builder |

---

## Project Structure

```
harnessd/
├── CLAUDE.md                        # This file
├── HARNESS-BEST-PRACTICES.md        # Core harness philosophy
│
├── harness/                         # The harness implementation
│   ├── src/                         # v2 source modules
│   │   ├── main.ts                  # CLI entry point
│   │   ├── orchestrator.ts          # Main state machine
│   │   ├── worker.ts                # Generic agent session runner
│   │   ├── planner.ts               # Planner mode
│   │   ├── contract-negotiator.ts   # Multi-round negotiation
│   │   ├── contract-linter.ts       # Pre-evaluator contract validation
│   │   ├── packet-runner.ts         # Builder execution
│   │   ├── evaluator-runner.ts      # Read-only evaluator
│   │   ├── schemas.ts               # Zod schemas + types
│   │   ├── state-store.ts           # .harnessd/ file management
│   │   ├── event-log.ts             # Append-only JSONL events
│   │   ├── status-renderer.ts       # status.json + status.md
│   │   ├── permissions.ts           # Role-based tool restrictions
│   │   ├── templates.ts             # Acceptance criteria templates
│   │   ├── background-jobs.ts       # Long-running command tracker
│   │   ├── prompts/                 # Prompt builders per role
│   │   │   ├── planner-prompt.ts
│   │   │   ├── builder-prompt.ts
│   │   │   ├── evaluator-prompt.ts
│   │   │   ├── contract-builder-prompt.ts
│   │   │   └── contract-evaluator-prompt.ts
│   │   ├── backend/                 # Agent backend abstraction
│   │   │   ├── types.ts             # AgentBackend + AgentSession interfaces
│   │   │   ├── claude-sdk.ts        # Real SDK implementation (v2 sessions)
│   │   │   └── fake-backend.ts      # Test double (zero quota, sessions)
│   │   └── test/                    # vitest test suite
│   │       ├── unit/                # 8 unit test files
│   │       └── scenarios/           # 2 scenario test files
│   │
│   ├── run.sh                       # Launch harness
│   ├── tail.sh                      # Tail logs (multiple modes)
│   ├── status.sh                    # Print run status
│   ├── poke.sh                      # Send poke to running harness
│   ├── resume.sh                    # Resume an interrupted run
│   ├── tmux.sh                      # 3-pane tmux operator layout
│   │
│   ├── projects/                    # Project plan templates
│   │   └── example-project/
│   └── logs/                        # Session logs (gitignored)
│
├── plans/                           # Plans for developing Harnessd
│   ├── harnessd-upgrade-tad.md      # v2 Technical Architecture Document
│   └── harness-init/
│       └── HARNESS-FAQ.md           # 130 design questions
│
└── inspiration/                     # Reference materials
    ├── ai-agent-harness-research-report.md
    └── openclaw-bot/                # Reference implementation
```

---

## Commands

```bash
# Run the harness on an objective
cd harness && npx tsx src/main.ts "your objective here"

# Plan only (don't build)
cd harness && npx tsx src/main.ts --plan-only "your objective"

# Interactive planning (interview before planning)
cd harness && npx tsx src/main.ts --interview "your objective"

# Agents work in a separate workspace
cd harness && npx tsx src/main.ts --workspace /tmp/my-project "your objective"

# Resume an interrupted run
cd harness && npx tsx src/main.ts --resume

# Check status
./harness/status.sh
./harness/status.sh --json
./harness/status.sh --watch

# Poke a running harness
./harness/poke.sh "summarize current packet"

# Launch tmux operator layout
./harness/tmux.sh

# Tail logs
./harness/tail.sh --events     # event stream
./harness/tail.sh --builder    # latest builder transcript
./harness/tail.sh --evaluator  # latest evaluator transcript

# Tests
cd harness && npx vitest run           # all tests (148 passing)
cd harness && npx tsc --noEmit         # typecheck
```

---

## Runtime Artifacts (.harnessd/)

```
.harnessd/                           # gitignored
  runs/<run-id>/
    run.json                         # RunState (phase machine)
    status.json                      # StatusSnapshot
    status.md                        # Human-readable status
    events.jsonl                     # Append-only event stream
    spec/
      SPEC.md                        # Planner output
      packets.json                   # Ordered packet list
      risk-register.json             # Risk register
      evaluator-guide.json           # Domain-specific quality criteria
      planning-context.json          # Operator interview context
      plan-summary.md                # Short summary
      context-overrides.md           # Injected context from operator
    packets/PKT-001/
      packet.json
      contract/
        proposal.r01.json            # Contract builder proposals
        review.r01.json              # Contract evaluator reviews
        final.json                   # Accepted contract
      builder/
        session.json                 # Worker session info
        transcript.jsonl             # Legacy transcript
        heartbeat.json               # Periodic heartbeat
        builder-report.json          # Self-check results
        result.json                  # Structured result
      evaluator/
        (same structure as builder)
    transcripts/                     # Organized transcript directory
      planner/
        planner-<timestamp>.jsonl
      PKT-001/
        builder-<timestamp>.jsonl
        evaluator-<timestamp>.jsonl
    inbox/                           # Operator control messages
    outbox/                          # Responses from harness
```

---

## Configuration Defaults

```json
{
  "maxNegotiationRounds": 6,
  "maxNegotiationRoundsRisky": 8,
  "maxFixLoopsPerPacket": 3,
  "staleWorkerMinutes": 15,
  "heartbeatWriteSeconds": 20,
  "resumeBackoffMinutes": [5, 15, 30, 60],
  "allowBuilderMicroFanout": true,
  "maxBuilderMicroFanoutAgents": 3,
  "allowDirectEditSubagents": false,
  "renderStatusOnEveryEvent": true
}
```

---

## Key Insights from Research

1. **Context is precious** — smallest set of high-signal tokens wins
2. **Specification quality > prompt iteration** — diminishing returns after 5 hours
3. **Two-agent pattern works** — initializer + coding agent for session continuity
4. **"One feature at a time"** — reduces context exhaustion by 71%
5. **10-iteration rule** — if prompts don't fix it, it's architectural
6. **Self-verification is critical** — without browser automation, features get marked done prematurely
7. **Contract-driven acceptance** — negotiate testable criteria before building, not after

---

## References

- `plans/harnessd-upgrade-tad.md` — v2 Technical Architecture Document
- `HARNESS-BEST-PRACTICES.md` — Harness building philosophy
- `inspiration/ai-agent-harness-research-report.md` — 90+ source systematic review
- `plans/harness-init/HARNESS-FAQ.md` — 130 design questions
- Anthropic: [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic: [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
