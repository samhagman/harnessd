# Inbox Protocol — Complete Reference

All operator control happens through JSON files written to `.harnessd/runs/<run-id>/inbox/`. This is the single communication channel between the operator and the running harness.

## Table of Contents
- [How to send a message](#sending)
- [How messages are processed](#processing)
- [Phase gating](#phase-gating)
- [Message preservation](#preservation)
- [All message types](#message-types)

---

<a id="sending"></a>
## How to Send a Message

Write a JSON file to the run's inbox directory. The filename doesn't matter (use a timestamp for uniqueness), but it must end in `.json` and must NOT start with `CONSUMED__`.

```bash
# Helper: get the latest run directory
RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"

# Write a message
echo '{"type":"approve_plan","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","message":"Looks good"}' \
  > "$RUN_DIR/inbox/$(date +%s).json"
```

Every message must have:
- `type` (string) — the message type (see list below)
- `createdAt` (string) — ISO timestamp

Optional fields depending on type:
- `message` (string) — human-readable text
- `packetId` (string) — target packet ID (e.g., "PKT-002")
- `context` (string) — context text for `inject_context`

---

<a id="processing"></a>
## How Messages Are Processed

The orchestrator has **two** inbox processors running concurrently:

### 1. Global Background Poller (every 3 seconds)

Runs on a `setInterval` for the entire lifetime of the orchestrator. Handles time-sensitive messages that need to reach agents during active sessions:

| Type | What it does |
|------|-------------|
| `send_to_agent` | Queues for live streamInput() delivery + writes nudge.md + context-overrides.md |
| `inject_context` | Writes to context-overrides.md |
| `pivot_agent` | Calls abortSession() to kill running agent + writes context files |

The poller has a re-entrancy lock — if a previous poll is still processing (e.g., waiting on streamInput timeout), the next poll skips.

### 2. Synchronous processInbox (top of each loop iteration)

Runs once at the top of every orchestrator loop iteration, between phases. Handles control flow messages that affect the state machine:

| Type | What it does |
|------|-------------|
| `approve_plan` | Transitions from `awaiting_plan_approval` → `selecting_packet` |
| `approve_packet` | Transitions from `awaiting_human_review` → `selecting_packet` (marks packet done) |
| `reject_packet` | Transitions from `awaiting_human_review` → `fixing_packet` (writes eval report with feedback) |
| `reset_packet` | Clears packet artifacts, resets status, transitions to `selecting_packet` |
| `pause` | Sets `pauseAfterCurrentPacket` flag |
| `stop_after_current` | Sets `stopRequested` flag |
| `resume` | Transitions from `paused` back to active phase |
| `send_to_agent` | Fallback: writes nudge.md + context-overrides.md (in case poller missed it) |
| `inject_context` | Fallback: writes context-overrides.md |

---

<a id="phase-gating"></a>
## Phase Gating

Some messages only make sense during specific phases. To prevent premature consumption (e.g., `approve_plan` consumed while the planner is still running), these messages are **phase-gated**:

| Message | Required phase |
|---------|---------------|
| `approve_plan` | `awaiting_plan_approval` |
| `approve_packet` | `awaiting_human_review` |
| `reject_packet` | `awaiting_human_review` |

If a gated message arrives during the wrong phase, it stays in inbox (not consumed, not renamed) until the required phase is reached. This means you can write `approve_plan` while the planner is still running — it will be picked up automatically when the plan gate is reached.

All other message types are processed immediately regardless of phase.

---

<a id="preservation"></a>
## Message Preservation

Processed messages are **never deleted**. They are renamed with a `CONSUMED__` prefix:

```
inbox/
├── CONSUMED__1774616087-approve.json    # Already processed
├── CONSUMED__1774616192-nudge.json      # Already processed
└── 1774620087-new-nudge.json            # Pending — will be processed
```

The inbox reader filters for files ending in `.json` that do NOT start with `CONSUMED__`. This preserves a complete audit trail.

---

<a id="message-types"></a>
## All Message Types

### approve_plan
Approve the generated plan and begin packet execution.
```json
{"type": "approve_plan", "createdAt": "2026-03-27T10:00:00Z", "message": "Plan looks good, proceed"}
```
Phase-gated: only consumed during `awaiting_plan_approval`.

### approve_packet
Approve a packet that passed evaluation and is waiting for human sign-off.
```json
{"type": "approve_packet", "createdAt": "2026-03-27T10:00:00Z", "packetId": "PKT-003", "message": "Ship it"}
```
Phase-gated: only consumed during `awaiting_human_review`.

### reject_packet
Reject a packet and send it back to the fix loop with feedback.
```json
{"type": "reject_packet", "createdAt": "2026-03-27T10:00:00Z", "packetId": "PKT-003", "message": "The layout breaks on mobile. Use CSS grid."}
```
Phase-gated: only consumed during `awaiting_human_review`. The message text is written as an evaluator report so the builder sees the feedback.

### send_to_agent
Send a steering message to the currently running agent.
```json
{"type": "send_to_agent", "createdAt": "2026-03-27T10:00:00Z", "message": "Use gold (#D4A853) for the star color, not yellow"}
```
Processed by global poller. Delivers via streamInput() if session active, file fallback otherwise.

### pivot_agent
Kill the running agent and restart with new instructions.
```json
{"type": "pivot_agent", "createdAt": "2026-03-27T10:00:00Z", "message": "Switch to CSS modules instead of inline styles"}
```
Processed by global poller. Calls abortSession() to kill the agent.

### inject_context
Add context for future agent sessions (does NOT reach the current agent).
```json
{"type": "inject_context", "createdAt": "2026-03-27T10:00:00Z", "context": "Client wants dark mode support"}
```
Appended to `spec/context-overrides.md`.

### reset_packet
Clear all artifacts for a packet and rebuild from scratch.
```json
{"type": "reset_packet", "createdAt": "2026-03-27T10:00:00Z", "packetId": "PKT-002", "message": "Wrong approach, redo from contract"}
```
Processed synchronously. Clears contract/builder/evaluator dirs.

### pause
Pause after the current packet completes.
```json
{"type": "pause", "createdAt": "2026-03-27T10:00:00Z", "message": "Taking a break"}
```

### resume
Resume a paused run.
```json
{"type": "resume", "createdAt": "2026-03-27T10:00:00Z"}
```

### stop_after_current
Stop the run after the current packet completes (sets stopRequested flag).
```json
{"type": "stop_after_current", "createdAt": "2026-03-27T10:00:00Z"}
```

### poke
General-purpose message (logged as event, no specific action).
```json
{"type": "poke", "createdAt": "2026-03-27T10:00:00Z", "message": "How's it going?"}
```

### summarize
Request a status summary (logged as event).
```json
{"type": "summarize", "createdAt": "2026-03-27T10:00:00Z"}
```
