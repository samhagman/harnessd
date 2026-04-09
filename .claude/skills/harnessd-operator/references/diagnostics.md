# Diagnostics — Troubleshooting Guide

When something goes wrong with a harnessd run, this guide helps you find what happened and fix it.

## Table of Contents
- [Quick health check](#health-check)
- [Reading the event timeline](#events)
- [Diagnosing packet failures](#packet-failures)
- [Contract negotiation issues](#contract-issues)
- [Builder problems](#builder-problems)
- [Evaluator problems](#evaluator-problems)
- [Gate deadlocks](#gate-deadlocks)
- [Rate limiting](#rate-limiting)
- [Common patterns](#common-patterns)

---

<a id="health-check"></a>
## Quick Health Check

```bash
RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"

# What's happening right now?
cat "$RUN_DIR/run.json" | jq '{phase, currentPacketId, completedPacketIds, failedPacketIds}'

# Is the current agent alive?
PKT=$(cat "$RUN_DIR/run.json" | jq -r .currentPacketId)
cat "$RUN_DIR/packets/$PKT/builder/heartbeat.json" 2>/dev/null | jq '{ts, turnCount}'

# Last 5 events
tail -5 "$RUN_DIR/events.jsonl" | jq -r '[.ts[11:19], .event, .packetId // "", .detail // ""] | join(" | ")'
```

If the heartbeat timestamp is more than 2 minutes old and the phase is `building_packet` or `evaluating_packet`, the agent session has likely died. The orchestrator's retry loop will restart it automatically (up to 5 times).

---

<a id="events"></a>
## Reading the Event Timeline

The event stream (`events.jsonl`) is the definitive record of everything that happened.

```bash
# Full timeline with phase context
cat "$RUN_DIR/events.jsonl" | jq -r '[.ts[11:19], .event, .phase // "—", .packetId // "—", .detail // ""] | join(" | ")'

# Just nudge/pivot events
grep '"nudge.sent"\|"context.injected"\|"packet.reset"' "$RUN_DIR/events.jsonl" | jq .detail

# Just failures
grep '"failed"\|"error"' "$RUN_DIR/events.jsonl" | jq -r '[.event, .detail // ""] | join(": ")'
```

### Key event types to watch

| Event | Meaning |
|-------|---------|
| `planning.completed` | Plan ready, packets created |
| `plan.awaiting_approval` | Waiting for operator approve |
| `plan.approved` | Operator approved, execution starting |
| `contract.accepted` | Contract negotiation succeeded |
| `builder.started` | Builder agent launched |
| `builder.completed` | Builder finished and claims done |
| `builder.failed` | Builder session ended without completing |
| `worker.resumed` | Auto-retry after failure |
| `evaluator.passed` | Evaluator confirmed work is done |
| `evaluator.failed` | Evaluator found issues |
| `packet.done` | Packet fully complete |
| `packet.awaiting_review` | Waiting for human review (gated packet) |
| `packet.approved` | Operator approved gated packet |
| `packet.rejected` | Operator rejected, back to fix loop |
| `packet.reset` | Packet artifacts cleared, rebuilding |
| `nudge.sent` | Nudge delivered — check `[LIVE]` vs `[FILE]` in detail |

---

<a id="packet-failures"></a>
## Diagnosing Packet Failures

When a packet ends up in `failedPacketIds`:

```bash
PKT="PKT-001"

# What was the last evaluator's verdict?
cat "$RUN_DIR/packets/$PKT/evaluator/evaluator-report.json" | jq '{overall, hardFailures, nextActions}'

# How many build attempts were there?
grep "builder.started.*$PKT" "$RUN_DIR/events.jsonl" | wc -l

# What did the builder claim?
cat "$RUN_DIR/packets/$PKT/builder/builder-report.json" | jq '{claimsDone, remainingConcerns, selfCheckResults}'

# Did it hit the max fix loops?
grep "packet.failed.*$PKT" "$RUN_DIR/events.jsonl" | jq .detail
```

**Common causes:**
- Builder can't satisfy acceptance criteria → check if criteria are realistic in `contract/final.json`
- Evaluator keeps finding new issues → check if evaluator guide is too strict
- Builder session keeps dying → check if the task is too large for one session

---

<a id="contract-issues"></a>
## Contract Negotiation Issues

If negotiation takes too many rounds or escalates:

```bash
PKT="PKT-001"

# How many rounds?
ls "$RUN_DIR/packets/$PKT/contract/" | grep proposal | wc -l

# What did each review say?
for f in "$RUN_DIR/packets/$PKT/contract/review.r"*.json; do
  echo "--- $(basename $f) ---"
  cat "$f" | jq '{decision, scores, requiredChanges}'
done

# Was there a lint failure?
grep "lint failed" "$RUN_DIR/events.jsonl" | grep "$PKT"
```

**Fixes:**
- If lint keeps failing: the contract builder is producing invalid JSON. Check transcript for what it's emitting.
- If evaluator keeps saying "revise": scores may be borderline. After round 3, the evaluator is told to accept if scores average 4+.
- If escalated: packet may be too large. Consider editing packets.json to split it.

---

<a id="builder-problems"></a>
## Builder Problems

### Builder keeps dying (builder.failed events)

```bash
# Check the transcript for errors
LATEST=$(ls -t "$RUN_DIR/transcripts/$PKT/builder-"*.jsonl | head -1)
# Look for error messages
grep '"isError":true' "$LATEST" | jq .msg.text

# Check if it's a context exhaustion issue
wc -l "$LATEST"  # Many lines = ran out of context
```

**Common causes:**
- Context exhaustion: too many turns. Builder ran out of space before finishing.
- Tool errors: a bash command failed and the builder gave up.
- Rate limiting: the SDK hit rate limits internally.

### Builder claims done but evaluator disagrees

Check what the builder self-reported vs what the evaluator found:

```bash
# Builder's self-check
cat "$RUN_DIR/packets/$PKT/builder/builder-report.json" | jq '.selfCheckResults[] | select(.status != "pass")'

# Evaluator's hard failures
cat "$RUN_DIR/packets/$PKT/evaluator/evaluator-report.json" | jq '.hardFailures'
```

If the builder's self-checks all pass but the evaluator finds issues, the acceptance criteria may need better verification commands.

---

<a id="evaluator-problems"></a>
## Evaluator Problems

### Evaluator keeps failing packets that look fine

The evaluator guide may be too strict. Check:

```bash
cat "$RUN_DIR/spec/evaluator-guide.json" | jq '{skepticismLevel, qualityCriteria: [.qualityCriteria[] | {name, weight}]}'
```

**Fixes:**
- Lower `skepticismLevel` from "adversarial" to "high" or "normal"
- Reduce weights on less important criteria
- Add calibration examples that show what a passing score looks like

### Evaluator session dies without producing a report

```bash
grep "evaluator.failed.*without report" "$RUN_DIR/events.jsonl"
```

The orchestrator auto-retries. If it happens repeatedly, the evaluator prompt may be too large (too many acceptance criteria, too much builder report context).

---

<a id="gate-deadlocks"></a>
## Gate Deadlocks

### Stuck at awaiting_plan_approval

The harness is waiting for you. Review the plan and approve:

```bash
# Quick review
cat "$RUN_DIR/spec/plan-summary.md"
cat "$RUN_DIR/spec/packets.json" | jq '.[].title'

# Approve
echo '{"type":"approve_plan","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","message":"go"}' > "$RUN_DIR/inbox/$(date +%s).json"
```

### Stuck at awaiting_human_review

A gated packet passed evaluation and is waiting for your sign-off:

```bash
PKT=$(cat "$RUN_DIR/run.json" | jq -r .currentPacketId)

# Check what was built
cat "$RUN_DIR/packets/$PKT/builder/builder-report.json" | jq .changedFiles
cat "$RUN_DIR/packets/$PKT/evaluator/evaluator-report.json" | jq .overall

# Approve or reject
echo '{"type":"approve_packet","createdAt":"...","packetId":"'$PKT'","message":"ship it"}' > "$RUN_DIR/inbox/$(date +%s).json"
```

---

<a id="rate-limiting"></a>
## Rate Limiting

The orchestrator handles rate limits automatically with exponential backoff:
- Default backoff schedule: 5min, 15min, 30min, 60min
- Events: `worker.rate_limited` with backoff duration in detail

```bash
grep "rate_limited" "$RUN_DIR/events.jsonl" | jq -r '[.ts[11:19], .detail] | join(" ")'
```

There's nothing you need to do — just wait. The harness will resume automatically.

---

<a id="common-patterns"></a>
## Common Patterns

### "The run completed but the result is wrong"

Use `reset_packet` on the problematic packet after editing the evaluator guide to catch the issue:

```bash
# Add the missing quality check
jq '.antiPatterns += ["the specific issue you found"]' "$RUN_DIR/spec/evaluator-guide.json" > /tmp/eg.json && mv /tmp/eg.json "$RUN_DIR/spec/evaluator-guide.json"

# Reset the packet
echo '{"type":"reset_packet","createdAt":"...","packetId":"PKT-003","message":"Missed responsive design"}' > "$RUN_DIR/inbox/$(date +%s).json"
```

### "I want to add a new requirement mid-run"

Use `inject_context` for the next agent, or `send_to_agent` for the current one:

```bash
# For the currently running agent
echo '{"type":"send_to_agent","createdAt":"...","message":"Also add dark mode support"}' > "$RUN_DIR/inbox/$(date +%s).json"

# For all future agents
echo '{"type":"inject_context","createdAt":"...","context":"Client requires dark mode support across all components"}' > "$RUN_DIR/inbox/$(date +%s).json"
```

### "The harness process died"

Just resume — the orchestrator picks up from the last saved state:

```bash
cd harness && npx tsx src/main.ts --resume
```

### "I want to see what the agent is doing right now"

```bash
# Live builder output
./harness/tail.sh --builder

# Or read the latest transcript directly
LATEST=$(ls -t "$RUN_DIR/transcripts/PKT-"*/builder-*.jsonl 2>/dev/null | head -1)
tail -f "$LATEST" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
```
