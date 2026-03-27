---
name: harnessd-operator
description: Operate the harnessd autonomous agent harness — launch runs, approve plans, steer running agents with live nudges (streamInput), pivot or reset packets, monitor progress, and debug failures. Use this skill whenever the user mentions harnessd, harness runs, packets, the orchestrator, or wants to interact with a long-running autonomous build. Also use when the user asks about plan approval, evaluator guides, contract negotiation, or anything related to .harnessd/ run artifacts.
---

# Harnessd Operator

You are operating **harnessd** — a contract-driven harness that runs Claude Code agents autonomously on complex, multi-session tasks. The harness plans, negotiates contracts, builds, evaluates, and fixes in a resilient loop. Your job is to launch, monitor, steer, and approve.

## How Harnessd Works

```
┌────────────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR (resilient loop)                  │
│                                                                        │
│  ┌──────────┐    ┌─────────────────────┐    ┌──────────────────────┐  │
│  │ PLANNER  │───▶│ PLAN APPROVAL GATE  │───▶│  PACKET SELECTION    │  │
│  │ (r/o)    │    │ (mandatory — waits  │    │  (linear, deps-     │  │
│  │          │    │  for operator inbox) │    │   aware)            │  │
│  └──────────┘    └─────────────────────┘    └────────┬─────────────┘  │
│                                                       │                │
│                          ┌────────────────────────────┘                │
│                          ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    PACKET LIFECYCLE                               │ │
│  │                                                                   │ │
│  │  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐        │ │
│  │  │  CONTRACT    │     │   BUILDER   │     │  EVALUATOR  │        │ │
│  │  │ NEGOTIATION  │────▶│ (repo writer│────▶│  (read-only │        │ │
│  │  │ (builder ↔   │     │  + nudge.md │     │   skeptic)  │        │ │
│  │  │  evaluator,  │     │  checking)  │     │             │        │ │
│  │  │  max 6 rds)  │     └──────┬──────┘     └──────┬──────┘        │ │
│  │  └──────────────┘            │                    │               │ │
│  │                              │               pass? ──┐            │ │
│  │                              │                │      │            │ │
│  │                         [PIVOT]           no──┘  yes─┤            │ │
│  │                         kills &                      │            │ │
│  │                         restarts              ┌──────▼──────┐     │ │
│  │                              │                │ HUMAN GATE? │     │ │
│  │                         [NUDGE]               │ (if packet  │     │ │
│  │                         mid-session           │ has review  │     │ │
│  │                         via streamInput       │ flag set)   │     │ │
│  │                              │                └──────┬──────┘     │ │
│  │                              ▼                       │            │ │
│  │                     fix loop ◀──── no ◀── eval fail  │            │ │
│  │                     (max 3)                          │            │ │
│  │                              │                       ▼            │ │
│  │                         [RESET]              ┌──────────────┐     │ │
│  │                         nukes all            │  NEXT PACKET │     │ │
│  │                         artifacts            │  or COMPLETE │     │ │
│  │                                              └──────────────┘     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  BACKGROUND: Global Nudge Poller (every 3s)                      │ │
│  │  Reads inbox/ for send_to_agent, pivot_agent, inject_context     │ │
│  │  Delivers via queueNudge → streamInput [LIVE] or file [FILE]    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  RESILIENT RETRY: max 5 consecutive failures per phase           │ │
│  │  Rate limit backoff: 5m → 15m → 30m → 60m                       │ │
│  │  Agent crash → auto-retry with 10s cooldown                      │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

**Phases:** `planning` → `awaiting_plan_approval` → `selecting_packet` → `negotiating_contract` → `building_packet` → `evaluating_packet` → `fixing_packet` → `awaiting_human_review` → `completed` / `failed`

**Key concepts:**
- **Packet** — smallest durable unit of work (one feature, one fix). Has type, dependencies, acceptance criteria.
- **Contract** — negotiated before building. Multi-round: builder proposes, linter validates, evaluator reviews. Acceptance criteria are testable and specific.
- **Evaluator guide** — domain-specific quality criteria (weights, anti-patterns, calibration examples, skepticism level). Shapes how the evaluator judges the builder's work. Editable mid-run.
- **Gates** — plan approval is mandatory. Per-packet review is planner-decided (`requiresHumanReview` field). Operator can toggle gates during plan review.
- **Autonomous preamble** — every agent is told to work continuously, treat operator messages as steering nudges, never stop to ask questions.

## Launching a Run

```bash
cd harness && npx tsx src/main.ts "your objective here"
cd harness && npx tsx src/main.ts --model claude-haiku-4-5-20251001 "objective"  # specific model
cd harness && npx tsx src/main.ts --workspace /tmp/project "objective"           # separate dir
cd harness && npx tsx src/main.ts --interview context.json "objective"           # pre-loaded context
cd harness && npx tsx src/main.ts --plan-only "objective"                        # plan without building
cd harness && npx tsx src/main.ts --resume [run-id]                              # resume interrupted run
```

## Three Ways to Steer

The operator has three steering modes, from lightest to heaviest. For full details on how each works internally (including flow diagrams and delivery layers), read `harnessd-operator/steering-modes.md`.

### NUDGE — steer without stopping (`send_to_agent`)
The running agent receives your message mid-session via `Query.streamInput()`. It keeps working.
```json
{"type": "send_to_agent", "createdAt": "...", "message": "Use gold #D4A853 for stars, not yellow"}
```

### PIVOT — kill and redirect (`pivot_agent`)
Kills the running agent, writes new instructions, orchestrator restarts the phase.
```json
{"type": "pivot_agent", "createdAt": "...", "message": "Switch to CSS grid layout"}
```

### RESET — nuke and rebuild (`reset_packet`)
Clears all artifacts for a packet. Re-negotiates contract, rebuilds from scratch.
```json
{"type": "reset_packet", "createdAt": "...", "packetId": "PKT-002", "message": "Wrong approach"}
```

## Gates

**Plan approval** (mandatory): after planning completes, the harness pauses at `awaiting_plan_approval`. Review SPEC.md, packets.json, evaluator-guide.json. Edit `requiresHumanReview` on packets if desired. Then approve:
```json
{"type": "approve_plan", "createdAt": "...", "message": "go"}
```

**Packet review** (per-packet): if a packet has `requiresHumanReview: true`, the harness pauses at `awaiting_human_review` after the evaluator passes. Approve or reject:
```json
{"type": "approve_packet", "createdAt": "...", "packetId": "PKT-003", "message": "ship it"}
{"type": "reject_packet", "createdAt": "...", "packetId": "PKT-003", "message": "redo the layout"}
```

Gate messages are **phase-gated** — they stay in inbox until the correct phase is reached. Writing `approve_plan` during planning is safe; it won't be consumed prematurely.

## Inbox

All control is through JSON files in `.harnessd/runs/<run-id>/inbox/`. For the complete list of all 12 message types with examples and processing details, read `harnessd-operator/inbox-protocol.md`.

```bash
RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"
echo '{"type":"...","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","message":"..."}' > "$RUN_DIR/inbox/$(date +%s).json"
```

Consumed messages are renamed `CONSUMED__<name>` (never deleted — full audit trail preserved).

## Monitoring

```bash
./harness/status.sh                    # current status
./harness/status.sh --watch            # live updates
./harness/tail.sh --events             # event stream
./harness/tail.sh --builder            # builder output
./harness/tail.sh --evaluator          # evaluator output
./harness/tail.sh --packet PKT-001     # specific packet
./harness/tmux.sh                      # 3-pane operator layout
```

## Editing Artifacts Mid-Run

These files can be edited while the harness is running — changes are picked up by the next agent session:

- **`spec/evaluator-guide.json`** — add anti-patterns, adjust quality weights, change skepticism level
- **`spec/packets.json`** — toggle `requiresHumanReview`, edit objectives, add notes
- **`spec/SPEC.md`** — update the specification (included in every agent prompt)

## Reference Files

For deeper information, read these reference docs:

- **`harnessd-operator/steering-modes.md`** — Detailed nudge/pivot/reset mechanics with internal flow diagrams, three delivery layers, and a decision guide for choosing the right mode
- **`harnessd-operator/inbox-protocol.md`** — All 12 message types with JSON examples, dual processing model (global poller vs synchronous), phase gating rules, message preservation
- **`harnessd-operator/file-map.md`** — Complete `.harnessd/runs/<run-id>/` directory structure with descriptions of every file and an "I want to..." lookup table
- **`harnessd-operator/diagnostics.md`** — Troubleshooting: quick health checks, event timeline reading, packet failure diagnosis, contract issues, gate deadlocks, rate limiting, common fix patterns

## Source Code

| File | Purpose |
|------|---------|
| `harness/src/orchestrator.ts` | State machine, gate model, global nudge poller |
| `harness/src/backend/claude-sdk.ts` | SDK wrapper: query(), streamInput(), queueNudge(), abortSession() |
| `harness/src/worker.ts` | Agent session runner, nudge queue drain, transcript logging |
| `harness/src/schemas.ts` | All Zod schemas and TypeScript types |
| `harness/src/packet-runner.ts` | Builder execution, nudge file path threading |
| `harness/src/prompts/builder-prompt.ts` | Builder prompt with nudge.md checking instruction |
| `harness/src/planner.ts` | Planner with interview context + requiresHumanReview guidance |
| `CLAUDE.md` | Project overview and architecture |
