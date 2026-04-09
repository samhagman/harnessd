# Harnessd

**A contract-driven orchestrator for long-running autonomous AI agent tasks.**

Harnessd breaks complex objectives into small, verifiable packets — each with a negotiated contract, independent builder, adversarial evaluator, and automated quality gates. It survives crashes, rate limits, and multi-hour execution, keeping an operator in the loop the entire time.

---

## Why Harnessd

AI agents can write code, but they struggle with tasks that span hours or days. Context windows fill up. Agents declare victory prematurely. Nobody verifies the work. State is lost between sessions.

Harnessd solves this by treating autonomous agent work the way you'd treat a construction project: **plan first, agree on acceptance criteria, build incrementally, inspect independently, and fix what fails.**

```
Objective: "Add authentication with Clerk to the Next.js app"
   │
   ├── Plan: 9 packets (middleware, routes, session, UI, ...)
   ├── Each packet: negotiated contract → build → gates → evaluate → done
   ├── QA: holistic browser testing across all packets
   └── Result: 18 hours, 29 packets (incl. security + QA fixes), zero human coding
```

### Key ideas

- **Contracts before code.** Every packet starts with negotiation — scope, acceptance criteria, evidence requirements — agreed upon before the builder writes a line.
- **Adversarial verification.** The evaluator is a separate agent whose only job is to disconfirm the builder's claims. It cannot write code — only read, test, and report.
- **Operator-in-the-loop.** Send nudges, pivots, and resets to running agents in real time. Force-approve stuck packets. Inject context mid-session.
- **Durable state.** Every event, transcript, contract, and result is persisted to disk. Harnessd resumes from exactly where it stopped — including native SDK session resume for full context recovery.
- **Multi-model.** Claude builds. Codex/GPT evaluates. Use the right model for each role.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/samhagman/harnessd.git
cd harnessd/harness
npm install

# Run the harness on an objective
npx tsx src/main.ts --workspace /path/to/your/project "your objective here"

# Interactive planning (interview before planning)
npx tsx src/main.ts --workspace /path/to/project --interview "your objective"

# Plan only (review before building)
npx tsx src/main.ts --workspace /path/to/project --plan-only "your objective"
```

### Prerequisites

- Node.js 20+
- An Anthropic API key (set `ANTHROPIC_API_KEY`)
- Optional: [Codex CLI](https://github.com/openai/codex) for adversarial evaluator roles

---

## How It Works

```
                              USER OBJECTIVE
                                    │
                                    v
┌───────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR                              │
│  Resilient phase machine — survives agent crashes, rate limits    │
└───────────────┬───────────────────────────────────────────────────┘
                │
                v
┌────────────────────┐       ┌────────────────────┐
│      PLANNER       │──────>│   PLAN REVIEWER    │
│  read-only, web    │<──────│  adversarial review │
│  research, specs   │       │  (Codex / GPT-5.4)  │
│  → SPEC.md         │       └────────────────────┘
│  → packets.json    │
└────────┬───────────┘
         │  operator approves
         v
┌────────────────────┐
│ CONTRACT NEGOTIATOR│  per packet, multi-round
│  builder proposes  │  linter validates structure
│  evaluator reviews │  max 10 rounds → final.json
└────────┬───────────┘
         v
┌────────────────────┐
│      BUILDER       │  the only agent that writes code
│  implements packet │  self-checks acceptance criteria
│  receives nudges   │  operator can steer in real time
└────────┬───────────┘
         v
┌────────────────────┐
│    TOOL GATES      │  automated quality checks
│  typecheck (tsc)   │  test suite (vitest)
│  custom gates      │  pass → evaluator, fail → builder
└────────┬───────────┘
         v
┌────────────────────┐
│     EVALUATOR      │  read-only, adversarial
│  disconfirms claims│  runtime evidence required
│  scores rubrics    │  pass → next packet
│  detects gaps      │  fail → back to builder
└────────┬───────────┘
         │  all packets done
         v
┌────────────────────┐
│     QA RUNNER      │  holistic e2e testing
│  browser-based     │  cross-packet integration
│  up to 10 rounds   │  pass → COMPLETE
│                    │  fail → targeted fix packets
└────────────────────┘
```

### The packet lifecycle

1. **Plan.** The planner reads your codebase, researches the problem (optionally via web search), and produces a spec with ordered packets, a risk register, and an evaluator guide.

2. **Review.** An adversarial reviewer (Codex by default) challenges the plan. Multi-round negotiation until the reviewer approves or max rounds are reached.

3. **Negotiate.** For each packet, a contract is proposed with explicit scope, acceptance criteria, evidence requirements, and risks. A structural linter validates it. A contract evaluator reviews it. Only accepted contracts proceed to building.

4. **Build.** The builder agent implements the packet against the finalized contract. It has full write access to the workspace and can use any tools. It self-checks every acceptance criterion before claiming done.

5. **Gate.** Automated tool gates run between builder and evaluator — typecheck, test suite, and any custom commands. Failures route back to the builder.

6. **Evaluate.** A read-only evaluator agent independently verifies each criterion. It must provide runtime evidence (not just code review) for scenario criteria. Failures include diagnostic hypotheses and root cause analysis.

7. **QA.** After all packets pass, a holistic QA agent tests the entire deliverable end-to-end in a browser. Issues generate targeted fix packets for round 2+.

---

## Operator Commands

Harnessd is designed for an operator to supervise long-running tasks. You're always in control.

```bash
# Check status
./harness/status.sh              # human-readable status
./harness/status.sh --json       # machine-readable
./harness/status.sh --watch      # live updates

# Steer a running builder
./harness/nudge.sh "use gold (#D4A853) for the star color, not yellow"

# Send a control message
./harness/poke.sh "summarize current packet"

# Resume an interrupted run
npx tsx src/main.ts --resume [run-id]

# Launch tmux operator layout (status + logs + control)
./harness/tmux.sh

# Tail logs
./harness/tail.sh --events       # event stream
./harness/tail.sh --builder      # latest builder transcript
./harness/tail.sh --evaluator    # latest evaluator transcript
```

### Steering modes

| Mode | What it does | When to use |
|------|-------------|-------------|
| **Nudge** | Injects a message into the running agent's conversation | Small corrections, added details |
| **Pivot** | Kills the agent and restarts with new direction | Wrong approach, dead-end execution |
| **Reset** | Deletes all packet artifacts, re-negotiates contract | Contract was wrong, need to rethink |
| **Force-approve** | Overrides evaluator failures with audit trail | Stuck on false positives, environment issues |

---

## Configuration

Harnessd works out of the box with sensible defaults. Override via CLI flags or a `harnessd.config.json` in your project root.

```bash
# Use Codex for adversarial roles
npx tsx src/main.ts --codex-roles evaluator,qa_agent,contract_evaluator "objective"

# Override model for all agents
npx tsx src/main.ts --model claude-haiku-4-5-20251001 "objective"

# Name a run
npx tsx src/main.ts --run-id my-feature "objective"
```

<details>
<summary>Full configuration defaults</summary>

```json
{
  "maxNegotiationRounds": 10,
  "maxFixLoopsPerPacket": 10,
  "staleWorkerMinutes": 15,
  "heartbeatWriteSeconds": 20,
  "maxConsecutiveResumeFailures": 8,
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

</details>

---

## Runtime Artifacts

All state is persisted to `.harnessd/runs/<run-id>/` — fully inspectable, resumable, and auditable.

```
.harnessd/runs/<run-id>/
├── run.json                    # Phase machine state
├── events.jsonl                # Append-only event log
├── status.json / status.md     # Current status snapshot
├── spec/
│   ├── SPEC.md                 # Planner output
│   ├── packets.json            # Ordered packet list
│   ├── risk-register.json      # Risk register
│   └── evaluator-guide.json    # Domain-specific quality criteria
├── packets/PKT-001/
│   ├── contract/
│   │   ├── proposal.r01.json   # Contract proposals
│   │   └── final.json          # Accepted contract
│   ├── builder/
│   │   ├── builder-report.json # Self-check results
│   │   └── result.json         # Structured output
│   └── evaluator/
│       └── evaluator-report.json
├── transcripts/                # Full agent transcripts
│   ├── planner/
│   └── PKT-001/
│       ├── builder-*.jsonl
│       └── evaluator-*.jsonl
└── inbox/ outbox/              # Operator communication
```

---

## Architecture

### Multi-model backend

```
BackendFactory.forRole(role)
  ├── ClaudeSdkBackend   — planner, builder, contract_builder
  │                        (session resume, MCP tools)
  ├── CodexCliBackend    — evaluator, qa_agent, contract_evaluator
  │                        (adversarial roles, no session resume)
  └── FakeBackend        — tests (zero API calls, deterministic replay)
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| **One packet at a time** | Linear execution prevents state conflicts. Parallelism happens inside the builder via sub-agents. |
| **Contracts before code** | Explicit acceptance criteria prevent scope creep and give the evaluator concrete things to verify. |
| **Separate builder and evaluator models** | Adversarial evaluation is more honest when done by a different model with different biases. |
| **Structural linter before LLM evaluator** | Catches mechanical issues (missing criteria, wrong schema) without burning model calls. |
| **Runtime evidence > code review** | Code that typechecks can still fail at runtime. Scenario criteria require actual execution. |
| **Durable state on disk** | `.harnessd/` survives crashes, rate limits, and machine restarts. No external database needed. |

---

## Testing

All tests use `FakeBackend` — a deterministic test double that replays scripted messages with zero API calls.

```bash
cd harness
npx vitest run           # 281 tests
npx tsc --noEmit         # typecheck
```

```ts
// Example: test evaluator pass
const backend = FakeBackend.success(JSON.stringify({
  verdict: "pass",
  hardFailures: [],
}));
const result = await runEvaluator(backend, contract, builderReport, config);
expect(result.report.verdict).toBe("pass");
```

---

## Production Experience

Harnessd has been validated on 15+ end-to-end runs across real codebases:

| Run | Duration | Packets | Outcome |
|-----|----------|---------|---------|
| auth-identity | ~75 hours | 11 R1 + 10 QA rounds | Complete. 8 harness bugs found and fixed during run. |
| auth-clerk | ~18 hours | 9 R1 + 10 security + 10 R2 QA fixes | Complete. Full Clerk auth integration. |
| onlang-forms | Multi-session | Multi-packet UI build | Complete. QA caught cross-packet issues. |

---

## Design Philosophy

Harnessd is built on five principles from the [research report](inspiration/ai-agent-harness-research-report.md) (90+ sources from Anthropic, OpenAI, DeepMind, and practitioners):

1. **Never trust, always verify.** Every implementation must pass independent verification by a separate agent that cannot write code.
2. **Fail forward.** Failed verification feeds back into the next builder iteration with diagnostic hypotheses, not just "try again."
3. **State is truth.** Plan documents, contracts, and event logs are the source of truth — not agent memory.
4. **Guardrails, not hand-holding.** Restrict dangerous operations, but let agents work autonomously within their scope.
5. **Log everything.** Full transcripts, structured events, and heartbeats enable post-hoc debugging and operator awareness.

### References

- Anthropic: [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic: [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Research report](inspiration/ai-agent-harness-research-report.md) — 90+ source systematic review
- [Best practices](HARNESS-BEST-PRACTICES.md) — Core harness philosophy
- [FAQ](plans/harness-init/HARNESS-FAQ.md) — 130 design questions and answers

---

## License

[MIT with Attribution](LICENSE). Use it however you want — just keep a visible link back to this repo in your README.

