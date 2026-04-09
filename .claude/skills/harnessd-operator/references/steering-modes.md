# Steering Modes — Detailed Reference

Harnessd gives the operator three ways to change the direction of a running harness. They range from a gentle course correction to a full restart. Pick the lightest one that gets the job done — nudge is instant, pivot costs one retry cycle, reset costs a full re-negotiation.

## Table of Contents
- [Nudge (send_to_agent)](#nudge)
- [Pivot (pivot_agent)](#pivot)
- [Reset (reset_packet)](#reset)
- [Choosing the right mode](#choosing)

---

<a id="nudge"></a>
## 1. NUDGE — steer the running agent without stopping it

**Inbox type:** `send_to_agent`
**Strength:** Lightest — agent keeps working
**Latency:** ~3 seconds (poller interval)
**Event tag:** `[LIVE]` or `[FILE]`

### What it does

Injects a user message directly into the running agent's conversation via the SDK's `Query.streamInput()`. The agent sees it as a new user turn and incorporates it without restarting.

### How it works internally

```
Operator writes inbox file
        │
        ▼
Global nudge poller (setInterval, 3s) reads inbox
        │
        ▼
Calls backend.queueNudge(text)
        │
   ┌────┴─────┐
   │          │
returns     returns false
true        (no active session)
   │          │
   ▼          ▼
nudgeQueue   FILE fallback only:
.push()      nudge.md + context-overrides.md
   │
   ▼
for-await loop in runSession() drains queue
between SDK message yields:
   │
   ▼
q.streamInput(async function*() {
  yield { type: "user", message: {...}, priority: "next" }
}())
   │
   ▼
Agent receives it as a new user turn — [LIVE]
```

### Three delivery layers

Every nudge writes to all three layers regardless of live delivery success:

1. **LIVE (streamInput)** — injected into the running session. Agent sees it immediately as a user message. Only works when an agent session is actively running.
2. **FILE (nudge.md)** — written to `packets/PKT-NNN/nudge.md`. The builder's prompt instructs it to check this file before each major step. Read, incorporate, delete.
3. **RECORD (context-overrides.md)** — appended to `spec/context-overrides.md`. Permanent. Included in the prompt of every future builder session for this run.

### When to use

- "Also make the header sticky"
- "Use a warmer color for the accent"
- "The API endpoint changed to /v2/books"
- Any instruction the agent can incorporate without changing its approach

### Example

```bash
RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"
echo '{"type":"send_to_agent","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","message":"Make the star rating gold colored, not yellow. Use #D4A853."}' > "$RUN_DIR/inbox/$(date +%s).json"
```

---

<a id="pivot"></a>
## 2. PIVOT — kill the agent and restart with new direction

**Inbox type:** `pivot_agent`
**Strength:** Medium — kills current session, restarts same phase
**Latency:** ~10-15 seconds (kill + retry cooldown + new session startup)
**Event tag:** `[PIVOT]`

### What it does

Terminates the running agent via `Query.close()`, writes the pivot instructions to context files, and lets the orchestrator's resilient retry loop start a fresh agent session. The new agent has the pivot instructions in its prompt from the start.

### How it works internally

```
Operator writes inbox file
        │
        ▼
Global nudge poller reads inbox
        │
        ▼
backend.abortSession()
  → this.activeQuery.close()  ← kills the SDK subprocess
        │
        ▼
Writes to context-overrides.md: "PIVOT: <message>"
Writes to packets/PKT-NNN/nudge.md: "PIVOT: <message>"
        │
        ▼
for-await loop in runSession() terminates (query closed)
        │
        ▼
runSession() returns without result envelope
        │
        ▼
Orchestrator sees: builder didn't complete
  → "Auto-retry 1/5 in 10s..."
        │
        ▼
New builder session starts
  → prompt includes context-overrides.md with pivot instructions
  → prompt includes nudge.md with pivot instructions
```

### When to use

- "Stop what you're doing, this approach is wrong"
- "Switch from flexbox to CSS grid for the layout"
- "The design reference changed, use the new mockup"
- The agent is heading down the wrong path and a nudge won't fix it

### Example

```bash
echo '{"type":"pivot_agent","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","message":"Switch to CSS modules instead of inline styles. Create separate .module.css files for each component."}' > "$RUN_DIR/inbox/$(date +%s).json"
```

### Important: pivot does NOT clear artifacts

The contract is preserved. Builder artifacts from the killed session remain on disk. The new session picks up where the old one left off (same contract, same packet) but with new context. If you need to redo the contract too, use RESET instead.

---

<a id="reset"></a>
## 3. RESET — nuke everything and rebuild from scratch

**Inbox type:** `reset_packet`
**Strength:** Heaviest — clears all artifacts, re-negotiates, rebuilds
**Latency:** Minutes (full contract negotiation + build + evaluate cycle)
**Event tag:** `packet.reset`

### What it does

Deletes all artifacts for a packet (contract proposals, reviews, final contract, builder report, evaluator report), resets the packet status to `pending`, removes it from completed/failed/blocked lists, and lets the orchestrator re-select and re-process it from scratch.

### How it works internally

```
Operator writes inbox file
        │
        ▼
Synchronous processInbox reads it
(reset_packet is processed in the main loop, not the poller)
        │
        ▼
For the target packet:
  rm -rf packets/PKT-NNN/contract/
  rm -rf packets/PKT-NNN/builder/
  rm -rf packets/PKT-NNN/evaluator/
        │
        ▼
packets.json: packet status → "pending"
run.json: remove from completedPacketIds, failedPacketIds, blockedPacketIds
run.json: phase → "selecting_packet", currentPacketId → null
        │
        ▼
Orchestrator re-enters selecting_packet
  → selects the reset packet (it's pending again)
  → negotiating_contract (fresh)
  → building_packet (fresh)
  → evaluating_packet (fresh)
```

### When to use

- "This packet's contract was wrong from the start"
- "The acceptance criteria need to change"
- "Scrap everything about this feature and redo it"
- After editing the SPEC.md or evaluator guide and wanting a packet to be re-planned

### Example

```bash
echo '{"type":"reset_packet","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","packetId":"PKT-002","message":"The contract missed the responsive design requirement. Redo from scratch."}' > "$RUN_DIR/inbox/$(date +%s).json"
```

### Tip: edit artifacts before the rebuild starts

After sending `reset_packet`, you have a window (while the orchestrator processes the reset and starts re-selecting) to edit:
- `spec/SPEC.md` — update the specification
- `spec/evaluator-guide.json` — add anti-patterns, adjust weights
- `spec/packets.json` — change the packet's objective or notes

The new contract negotiation will use the updated artifacts.

---

<a id="choosing"></a>
## Choosing the Right Mode

```
Is the agent going the right direction but missing a detail?
  YES → NUDGE (send_to_agent)
  NO  ↓

Is the contract/approach right but the execution needs to change?
  YES → PIVOT (pivot_agent)
  NO  ↓

Is the whole approach wrong (contract, acceptance criteria, etc.)?
  YES → RESET (reset_packet)
```

| | Nudge | Pivot | Reset |
|--|-------|-------|-------|
| Agent keeps working? | Yes | No — killed | No — killed |
| Contract preserved? | Yes | Yes | No — cleared |
| Builder artifacts preserved? | Yes | Yes | No — cleared |
| Context-overrides written? | Yes | Yes | No (but you can edit spec) |
| Time cost | ~0 (instant) | ~15s (retry) | Minutes (full cycle) |
| Use count limit | Unlimited | Unlimited | Unlimited |
