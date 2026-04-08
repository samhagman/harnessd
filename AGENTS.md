# Harnessd

**A contract-driven harness for Codex to handle long-running autonomous tasks.**

---

## Vision

Harnessd enables AI agents to work autonomously on complex, multi-session tasks that exceed a single context window. The core insight: long-running agent success requires explicit planning, contract-based acceptance, durable state, and independent verification.

```
                              USER OBJECTIVE
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                               │
│  Resilient phase machine — never dies from agent crashes          │
│  Rate-limit backoff, nudge injection, inbox polling               │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────┐     ┌──────────────────────┐
│      PLANNER         │────▶│   PLAN REVIEWER      │
│  read-only, web      │◀────│   adversarial (Codex)│
│  research, interview │     │   max N rounds       │
│  → SPEC.md           │     └──────────────────────┘
│  → packets.json      │
│  → risk-register.json│
└──────────┬───────────┘
           │  operator approves plan
           ▼
┌──────────────────────┐
│  CONTRACT NEGOTIATOR │  ◀─── per packet
│  builder proposes    │
│  linter validates    │
│  evaluator reviews   │
│  max 10 rounds       │
│  → final.json        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│      BUILDER         │  ← only repo writer
│  implements packet   │
│  self-checks ACs     │
│  receives nudges     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│    TOOL GATES        │  typecheck + test
│    pass? ──────────────▶ continue
│    fail? ──────────────▶ back to builder (fix loop, max 10)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│     EVALUATOR        │  read-only, adversarial
│  disconfirms claims  │
│  diagnosticHypothesis│
│  contract-gap detect │
│  pass ─────────────────▶ next packet
│  fail ─────────────────▶ back to builder (fix loop)
│  contract gap ─────────▶ back to negotiation
└──────────┬───────────┘
           │  all packets done
           ▼
┌──────────────────────┐
│     QA RUNNER        │  holistic e2e browser testing
│  cross-packet issues │
│  max 10 rounds       │
│  pass ─────────────────▶ COMPLETE
│  fail ─────────────────▶ round 2+ planner
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  ROUND 2+ PLANNER    │  targeted fix packets
│  PKT-R{round}-NNN   │  from QA findings
│  → back to contract  │
│    negotiation       │
└──────────────────────┘

STATE: .harnessd/runs/<run-id>/
  run.json, events.jsonl, status.json, status.md
  spec/ (SPEC.md, packets.json, risk-register.json, evaluator-guide.json)
  packets/PKT-NNN/ (contract/, builder/, evaluator/)
  transcripts/ (organized by packet and role)
  inbox/ outbox/ (operator communication)
```

---

## Architecture (v2.2)

### Orchestrator
The top-level state machine. Drives planning → plan review → packet selection → contract negotiation → build → tool gates → evaluate → fix loops → QA → round 2+ planning → completion. Handles rate limits, pokes, nudges, resume, session recovery, and status rendering.

### Planner mode
Read-only agent that expands a user objective into `SPEC.md`, `packets.json`, `risk-register.json`, and `plan-summary.md`. Supports web research via perplexity, interactive interviews (`--interview`), and prior-run context.

### Plan Reviewer
Adversarial review of planner output (via Codex/GPT-5.4 by default). Multi-round negotiation with the planner. Max rounds configurable (`maxPlanReviewRounds`).

### Contract negotiation
Multi-round loop: contract builder proposes, contract linter validates, contract evaluator reviews. Supports accept/revise/split/escalate decisions. Max 10 rounds (configurable).

### Builder
The only repo writer. Implements one packet at a time against a finalized contract. Self-checks all acceptance criteria before claiming done. Receives completion summaries from prior packets, context overrides, and nudge files.

### Tool Gates
Automated quality gates between builder and evaluator. Default gates: typecheck (`tsc --noEmit`) and test (`vitest run`). Custom gates configurable per-project. Failures route back to builder fix loop.

### Evaluator
Strictly read-only. Disconfirms completion claims. Reports hard failures (with `diagnosticHypothesis`, `filesInvolved`, `rootCauseLayer`), rubric scores, and contract gaps. Must call `validate_envelope` before emitting. Anti-rationalization rule prevents dismissing unexpected state as "pre-existing."

### QA Runner
Holistic end-to-end testing after all R1 packets complete. Browser-based verification. Reports issues with diagnostic hypotheses. Multi-round: `maxRounds` configurable (default 10).

### Round 2+ Planner
Generates targeted fix packets from QA findings. Verifies root causes before creating packets. Round-specific packet IDs (`PKT-R{round}-NNN`).

### Session Recovery
Native SDK session resume (`resume: sessionId`) for Claude agents — full context on crash recovery. Codex agents fall back to a recovery agent that summarizes prior transcript.

### Completion Summary
Cross-packet context propagation — summaries of completed packets are passed to subsequent builders and evaluators.

### Multi-Model Backend
```
BackendFactory.forRole(role) → AgentBackend
  ├── ClaudeSdkBackend — planner, builder, contract_builder (session resume, MCP tools)
  ├── CodexCliBackend  — evaluator, qa_agent, contract_evaluator (CLI validate, no resume)
  └── FakeBackend      — tests (zero quota, deterministic replay)
```

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Packet** | Smallest durable implementation unit (coherent, independently verifiable) |
| **Contract** | Negotiated agreement with explicit acceptance criteria before building |
| **Acceptance criteria** | Mix of hard gates (commands, scenarios, invariants) and rubrics |
| **Packet types** | bugfix, ui_feature, backend_feature, migration, refactor, long_running_job, integration, tooling |
| **Result envelope** | `===HARNESSD_RESULT_START===` ... JSON ... `===HARNESSD_RESULT_END===` |
| **Tool gates** | Automated quality checks (typecheck, test) between builder and evaluator |
| **QA round** | Holistic e2e testing after all packets; triggers round 2+ fix planning |
| **Session resume** | Native SDK resume for Claude; transcript-summary fallback for Codex |
| **AgentBackend** | Abstraction over SDK — enables testing with FakeBackend (zero quota) |
| **Linear execution** | One packet at a time; parallelism only inside the active builder |

---

## Project Structure

```
harnessd/
├── AGENTS.md                        # This file
├── HARNESS-BEST-PRACTICES.md        # Core harness philosophy
│
├── harness/                         # The harness implementation
│   ├── src/                         # Source modules
│   │   ├── main.ts                  # CLI entry point
│   │   ├── orchestrator.ts          # Main state machine
│   │   ├── worker.ts                # Generic agent session runner
│   │   ├── planner.ts               # Planner mode
│   │   ├── plan-reviewer.ts         # Adversarial plan review
│   │   ├── contract-negotiator.ts   # Multi-round negotiation
│   │   ├── contract-linter.ts       # Pre-evaluator contract validation
│   │   ├── packet-runner.ts         # Builder execution
│   │   ├── evaluator-runner.ts      # Read-only evaluator
│   │   ├── tool-gates.ts            # Typecheck/test gates between builder & evaluator
│   │   ├── qa-runner.ts             # Holistic e2e QA testing
│   │   ├── round2-planner.ts        # Targeted fix packets from QA findings
│   │   ├── completion-summary.ts    # Cross-packet context propagation
│   │   ├── recovery-agent.ts        # Transcript summary for Codex crash recovery
│   │   ├── session-recovery.ts      # Native SDK session resume
│   │   ├── schemas.ts               # Zod schemas + types
│   │   ├── state-store.ts           # .harnessd/ file management
│   │   ├── event-log.ts             # Append-only JSONL events
│   │   ├── status-renderer.ts       # status.json + status.md
│   │   ├── permissions.ts           # Role-based tool restrictions
│   │   ├── templates.ts             # Acceptance criteria templates
│   │   ├── background-jobs.ts       # Long-running command tracker
│   │   ├── validation-tool.ts       # MCP validate_envelope tool
│   │   ├── prompts/                 # Prompt builders per role (8 files)
│   │   │   ├── planner-prompt.ts
│   │   │   ├── plan-review-prompt.ts
│   │   │   ├── builder-prompt.ts
│   │   │   ├── evaluator-prompt.ts
│   │   │   ├── qa-prompt.ts
│   │   │   ├── round2-planner-prompt.ts
│   │   │   ├── contract-builder-prompt.ts
│   │   │   └── contract-evaluator-prompt.ts
│   │   ├── backend/                 # Agent backend abstraction
│   │   │   ├── types.ts             # AgentBackend + AgentSession interfaces
│   │   │   ├── claude-sdk.ts        # Real SDK implementation (session resume)
│   │   │   ├── codex-cli.ts         # Codex CLI backend (GPT-5.4)
│   │   │   ├── backend-factory.ts   # Per-role backend selection
│   │   │   └── fake-backend.ts      # Test double (zero quota, sessions)
│   │   └── test/                    # vitest test suite
│   │       ├── unit/                # 11 unit test files
│   │       └── scenarios/           # 2 scenario test files
│   │
│   ├── bin/
│   │   └── validate-envelope.mts    # CLI validate_envelope for Codex agents
│   │
│   ├── run.sh                       # Launch harness
│   ├── tail.sh                      # Tail logs (multiple modes)
│   ├── status.sh                    # Print run status
│   ├── nudge.sh                     # Send nudge to running builder
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

# Name a run explicitly
cd harness && npx tsx src/main.ts --run-id my-project "your objective"

# Use Codex for adversarial roles
cd harness && npx tsx src/main.ts --codex-roles evaluator,qa_agent,contract_evaluator "your objective"
cd harness && npx tsx src/main.ts --codex-model gpt-5.4 --codex-roles evaluator "your objective"

# Override model for all agents
cd harness && npx tsx src/main.ts --model claude-haiku-4-5-20251001 "your objective"

# Resume an interrupted run
cd harness && npx tsx src/main.ts --resume [run-id]

# Check status
./harness/status.sh
./harness/status.sh --json
./harness/status.sh --watch

# Send a nudge to a running builder
./harness/nudge.sh "fix the mobile layout for AC-6"

# Poke a running harness
./harness/poke.sh "summarize current packet"

# Launch tmux operator layout
./harness/tmux.sh

# Tail logs
./harness/tail.sh --events     # event stream
./harness/tail.sh --builder    # latest builder transcript
./harness/tail.sh --evaluator  # latest evaluator transcript

# Tests
cd harness && npx vitest run           # all tests
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
  "maxNegotiationRounds": 10,
  "maxNegotiationRoundsRisky": 10,
  "maxFixLoopsPerPacket": 10,
  "staleWorkerMinutes": 15,
  "heartbeatWriteSeconds": 20,
  "resumeBackoffMinutes": [5, 15, 30, 60],
  "maxConsecutiveResumeFailures": 8,
  "allowBuilderMicroFanout": true,
  "maxBuilderMicroFanoutAgents": 3,
  "allowDirectEditSubagents": false,
  "renderStatusOnEveryEvent": true,
  "maxRounds": 10,
  "qaPassThreshold": { "maxCritical": 0, "maxMajor": 0, "maxMinor": 5 },
  "skipQA": false,
  "skipPlanReview": false,
  "maxPlanReviewRounds": 10,
  "enableDefaultGates": true,
  "toolGates": [],
  "devServer": null
}
```

---

## Testing

All tests use `FakeBackend` — a deterministic test double that replays scripted messages with zero API calls. It implements the same `AgentBackend` interface as the real backends.

```ts
// Common pattern: simulate an agent that emits a valid result
const backend = FakeBackend.success(JSON.stringify({ verdict: "pass", hardFailures: [] }));
const result = await runEvaluator(backend, contract, builderReport, config);

expect(result.report.verdict).toBe("pass");
expect(backend.calls).toHaveLength(1);           // assert what was passed to the agent
expect(backend.calls[0].prompt).toContain("...");  // check prompt content
```

**Factory methods:**
- `FakeBackend.success(text)` — agent runs and emits result envelope containing `text`
- `FakeBackend.error(text)` — agent crashes with error (test retry/recovery paths)
- `FakeBackend.fromScript(messages[])` — full control over yielded `AgentMessage` sequence

`backend.calls[]` records every `runSession()` invocation for assertion. `backend.nudgeMessages[]` records nudges.

---

## Gotchas

1. **Inbox only reads `*.json`** — `.md` files placed in `inbox/` are silently ignored. Always use `nudge.sh` or write JSON directly.
2. **`permissionMode: "plan"` blocks ALL tools** — this activates Claude Code's built-in plan mode. For read-only agents that still need Read/Grep/Glob/Bash, use `permissionMode: "bypassPermissions"` with `disallowedTools` instead.
3. **`streamInput()` hangs from `setInterval`** — must be called from within the `for-await` loop that consumes query messages. The nudge queue pattern (`backend.queueNudge()` → drain inside loop) is the correct approach.
4. **Read-only agents will try to write files** — without an explicit CRITICAL RULES section at the top of the prompt saying "You CANNOT write files, your only output is the envelope", agents default to trying Write/Edit/Agent tools.
5. **All agents must call `validate_envelope` before emitting** — Claude agents use the MCP tool, Codex agents use `bin/validate-envelope.mts`. Without this, agents emit malformed JSON that fails parsing and wastes a full retry cycle.
6. **Dirty data accumulates across QA rounds** — builders/evaluators leave test artifacts in shared state. Multi-round QA can fail on stale data, not real bugs. No automated cleanup mechanism exists yet.

---

## References

- `plans/harnessd-upgrade-tad.md` — v2 Technical Architecture Document
- `HARNESS-BEST-PRACTICES.md` — Harness building philosophy
- `inspiration/ai-agent-harness-research-report.md` — 90+ source systematic review
- `plans/harness-init/HARNESS-FAQ.md` — 130 design questions
- Anthropic: [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic: [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
