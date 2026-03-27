# Harnessd Operator Experience — Spec + Implementation Plan

**Date:** 2026-03-26
**Status:** Ready for implementation
**Depends on:** harnessd v2 (upgrade-v2 branch, current state)

---

## 1. Narrative & Goals

### Why

Harnessd v2 can run autonomously — plan, negotiate contracts, build, evaluate, fix, repeat. But after running it live on an ICA Boston landing page, we discovered the operator is a **spectator, not a participant**. For runs that last hours or days, the operator needs to:

- Shape the plan before execution starts
- See what the evaluator is checking and adjust it
- Talk to running agents mid-session ("use grid not flexbox")
- Hard-pivot when the approach is wrong
- Review critical packets before the harness moves on

The current tools (poke.sh, status.sh, tmux) give visibility but not control. This upgrade makes the operator a first-class participant.

### What Success Looks Like

1. The operator can have a conversation about the plan before it runs
2. The operator can send a message to a running builder and it adjusts without stopping
3. The operator can hard-pivot (kill + redirect) with the agent retaining its history
4. Critical packets pause for human review after evaluation passes
5. All agent thinking is preserved and inspectable
6. A single Claude Code skill gives the operator full control conversationally
7. All of this is proven working via a live end-to-end test

---

## 2. Design

### 2.1 Gate Model

**Plan gate (mandatory):** After the planner finishes, the orchestrator sets phase to `awaiting_plan_approval` and stops. The operator reviews SPEC.md, packets.json, evaluator-guide.json. When satisfied, writes an approval. Harness continues.

**Packet gates (planner-decided):** Each packet gets a `requiresHumanReview: boolean` field. The planner decides which packets need sign-off based on risk/visibility. After the evaluator passes on a gated packet, the orchestrator sets phase to `awaiting_human_review` instead of moving on. Operator reviews, approves or sends back.

Operator can toggle `requiresHumanReview` on any packet during plan review.

### 2.2 Persistent Sessions (v2 SDK)

Replace `query()` with the v2 session API:

- `unstable_v2_createSession(options)` → `SDKSession` with `.send()`, `.stream()`, `.close()`
- `unstable_v2_resumeSession(sessionId, options)` → reconnect with full history
- `forkSession(sessionId)` → branch a session

This enables:
- **Nudge:** `session.send("also check dark mode")` injected into a live builder
- **Hard pivot:** `session.send("STOP. New approach: ...")` or `close()` + `resumeSession()` with redirect
- **Crash recovery:** saved sessionId → `resumeSession()` with full context

Pin SDK to exact `0.2.83` in package.json.

### 2.3 Autonomous Preamble

Every role prompt gets this preamble:

```
You are AUTONOMOUS. Work continuously toward your goal until it is complete.
Do NOT stop to ask questions. Do NOT wait for confirmation. Do NOT ask "shall I continue?".

If you receive a new message from the operator mid-session, it is a STEERING NUDGE.
Incorporate the new context and keep working. Do not treat it as a stop signal.
The only way you stop is by completing your goal and emitting the result envelope.
```

### 2.4 Interactive Planning

**Stage 1 — Interview:** Before the planner runs, the orchestrator writes a `planning-context.json` file. This can be pre-populated by the operator skill asking questions: vision, tech preferences, design references, things to avoid, what "done" looks like. The planner's prompt includes this context.

**Stage 2 — Planner runs:** With the interview context + web research. Produces SPEC.md, packets.json, evaluator-guide.json, risk-register.json.

**Stage 3 — Review:** Orchestrator sets phase `awaiting_plan_approval`. Operator reviews and edits artifacts conversationally. Approval file triggers continuation.

### 2.5 Transcript Preservation

All agent transcripts (raw JSONL including thinking blocks) preserved under:

```
.harnessd/runs/<run-id>/
  transcripts/
    planner/
      attempt-01-<timestamp>.jsonl
      attempt-02-<timestamp>.jsonl
    PKT-001/
      contract-builder-r01-<timestamp>.jsonl
      contract-evaluator-r01-<timestamp>.jsonl
      builder-<timestamp>.jsonl
      evaluator-<timestamp>.jsonl
      evaluator-retry-01-<timestamp>.jsonl
      builder-fix-01-<timestamp>.jsonl
    PKT-002/
      ...
```

Role + round/attempt + timestamp in filename. Packet-level grouping. Nothing overwritten.

### 2.6 Nudge vs Hard Pivot

**Nudge** (agent keeps working):
- Edit evaluator-guide.json → next evaluator picks it up
- Edit packets.json → next packet selection picks it up
- `session.send("new instructions")` → running agent absorbs and continues

**Hard Pivot** (stop and redirect):
- `session.close()` → kills active agent
- Edit artifacts (spec, packets, evaluator guide, whatever needs changing)
- Reset packet status to `pending` if re-running
- Delete that packet's builder/evaluator artifacts
- Resume orchestrator → picks up from current state with new context
- Or: `resumeSession(savedId)` → agent has full history + new redirect message

### 2.7 Operator Skill

A single file: `harness/operator-skill.md` (loaded as a Claude Code skill or CLAUDE.md include).

Contains comprehensive knowledge:
- Full architecture explanation (orchestrator, planner, contract negotiation, builder, evaluator, fix loops, resilient retry)
- File protocol: where every artifact lives, what it means, how to read/write it
- Control mechanisms: how to pause, resume, stop, approve plans, approve packets, send nudges, hard pivot
- Steering: how to edit evaluator guide, packets, inject context
- Diagnostics: how to read transcripts, contract rounds, evaluator reports, heartbeats
- Pointers to source: CLAUDE.md, TAD, schemas.ts, all source files for deep dives
- NOT restricted: the skill teaches capabilities, doesn't limit them

### 2.8 Inbox Protocol Extensions

New inbox message types:

```json
{"type": "approve_plan", "message": "Looks good, go"}
{"type": "approve_packet", "packetId": "PKT-003", "message": "Ship it"}
{"type": "reject_packet", "packetId": "PKT-003", "message": "The layout is wrong, redo with grid"}
{"type": "send_to_agent", "message": "Use CSS grid instead of flexbox for the gallery"}
{"type": "inject_context", "context": "The client just told me they want a dark theme"}
```

---

## 3. Implementation Plan

### Phase 1: SDK Migration + Session Persistence

**Goal:** Replace `query()` with v2 session API throughout.

**Files to change:**
- `harness/package.json` — pin SDK to exact `0.2.83`
- `harness/src/backend/types.ts` — new `AgentSession` interface with `send()`, `stream()`, `close()`, `sessionId`
- `harness/src/backend/claude-sdk.ts` — implement using `unstable_v2_createSession` / `unstable_v2_resumeSession`
- `harness/src/backend/fake-backend.ts` — update FakeBackend to simulate multi-turn sessions (queue responses per `send()`)
- `harness/src/worker.ts` — refactor to use session.send() + session.stream() instead of iterating query()

**Key design:** `AgentBackend.createSession(options)` returns an `AgentSession`. `worker.ts` calls `session.send(prompt)` then iterates `session.stream()`. The session handle is stored so the orchestrator can call `session.send()` for nudges.

**Autonomous preamble:** Add to all prompt builders (planner, builder, evaluator, contract builder, contract evaluator).

**Verify:**
- `npx tsc --noEmit` passes
- `npx vitest run` passes (FakeBackend updated)
- Existing scenario tests still work with new session model

### Phase 2: Gate Model + New Phases

**Goal:** Add plan approval gate and per-packet human review gates.

**Files to change:**
- `harness/src/schemas.ts` — add `awaiting_plan_approval` and `awaiting_human_review` to `RunPhaseSchema`. Add `requiresHumanReview: z.boolean().default(false)` to `PacketSchema`. Add new inbox message types to `InboxMessageSchema`.
- `harness/src/orchestrator.ts` — new phase handlers for `awaiting_plan_approval` and `awaiting_human_review`. Plan approval: after planning completes, transition to `awaiting_plan_approval` instead of `selecting_packet`. Wait for `approve_plan` inbox message. Packet approval: after evaluator passes on a gated packet, transition to `awaiting_human_review`. Wait for `approve_packet` or `reject_packet`.
- `harness/src/prompts/planner-prompt.ts` — tell planner about `requiresHumanReview` field, when to use it (high-risk, user-facing, architectural decisions).

**Inbox processing updates:**
- `approve_plan` → transition from `awaiting_plan_approval` to `selecting_packet`
- `approve_packet` → transition from `awaiting_human_review` to `selecting_packet` (mark packet done)
- `reject_packet` → transition from `awaiting_human_review` to `fixing_packet` with operator feedback as eval report
- `send_to_agent` → call `session.send()` on the active session
- `inject_context` → write to a `context-overrides.md` file that gets appended to the next agent prompt

**Verify:**
- Unit test: gate phases transition correctly on approval/rejection
- Scenario test: plan → awaiting_plan_approval → approve → selecting_packet
- Scenario test: packet with requiresHumanReview → build → eval pass → awaiting_human_review → approve → next packet

### Phase 3: Interactive Planning

**Goal:** Add interview context and plan review flow.

**Files to change/create:**
- `harness/src/schemas.ts` — add `PlanningContextSchema` (vision, techPreferences, designReferences, avoidList, doneDefinition, customNotes)
- `harness/src/orchestrator.ts` — in `handlePlanning()`, check for `spec/planning-context.json`. If it exists, pass to planner. If not, create empty one.
- `harness/src/prompts/planner-prompt.ts` — add interview context section to prompt when planning-context.json is provided
- `harness/src/main.ts` — `--interview` flag that collects answers interactively before launching, writes planning-context.json

The interview can also happen through the operator skill: you tell Claude Code your vision, it writes planning-context.json, then you launch the run.

**Verify:**
- Launch with `--interview` → prompts for input → writes planning-context.json → planner uses it
- Launch with pre-existing planning-context.json → planner incorporates it

### Phase 4: Transcript Reorganization

**Goal:** Move all transcripts to organized `transcripts/` directory.

**Files to change:**
- `harness/src/worker.ts` — write transcripts to `transcripts/<packetId>/<role>-<timestamp>.jsonl` instead of `packets/<packetId>/<role>/transcript.jsonl`. Include thinking blocks (don't filter them from the JSONL).
- `harness/src/orchestrator.ts` — pass transcript path info through worker config
- `harness/tail.sh` — update to find transcripts in new location

**Backward compat:** Old runs with transcripts in the old location still work (tail.sh checks both).

**Verify:**
- Run produces transcripts in new location
- `tail.sh --builder` finds them
- Multiple attempts create separate files, nothing overwritten

### Phase 5: Nudge + Hard Pivot via Session

**Goal:** Wire session.send() through the orchestrator for live agent communication.

**Files to change:**
- `harness/src/orchestrator.ts` — store active session handle. In `processInbox()`, handle `send_to_agent` by calling `activeSession.send(message)`. Handle `inject_context` by writing to context-overrides.md.
- `harness/src/worker.ts` — expose the session handle to the orchestrator after creation
- `harness/src/orchestrator.ts` — for hard pivots: add a `reset_packet` inbox type that sets a packet back to `pending`, clears its artifacts, and restarts from `selecting_packet`

**Verify:**
- Send nudge to running builder via inbox → builder receives and continues
- Hard pivot: reset packet → re-negotiates contract → rebuilds

### Phase 6: Operator Skill

**Goal:** Write the comprehensive skill document.

**File to create:**
- `harness/operator-skill.md` — the full operator knowledge base

**Contents:**
- Architecture overview (what is harnessd, how it works, the phase model)
- File map (where everything lives, what each artifact means)
- All control operations (pause, resume, stop, approve, reject, nudge, pivot)
- Steering guide (edit evaluator guide, edit packets, toggle gates, inject context, send to agent)
- Diagnostics guide (read status, events, transcripts, contracts, reports)
- Source pointers (CLAUDE.md, TAD, schemas.ts, key source files)
- Example conversations (what to say for common operations)

**Verify:**
- Load skill in a fresh Claude Code session
- Ask "how's the harness doing?" → reads status correctly
- Ask "show me the evaluator guide" → reads and presents it
- Ask "pause the harness" → writes correct inbox message
- Ask "tell the builder to use dark colors" → writes send_to_agent message

### Phase 7: End-to-End Verification

**Goal:** Prove everything works by running a real harness with operator interaction.

**Test prompt:** "Create a single-page React app with Vite that shows a list of 5 books with title, author, and a star rating component. Include a filter by genre dropdown."

This is simple enough to plan fast but has enough structure to exercise all the machinery.

**Test script:**

1. **Launch with interview context:**
   Write a planning-context.json with: "Use TypeScript, CSS modules, no external UI libraries. The rating should be interactive (clickable stars)."
   Launch: `./run.sh --workspace /tmp/harnessd-test-books "Create a book list app..."`

2. **Verify plan gate:**
   Check that harness pauses at `awaiting_plan_approval`
   Read SPEC.md and packets.json from the operator skill session
   Edit: toggle `requiresHumanReview` on the final packet
   Approve the plan

3. **Verify autonomous execution:**
   Watch PKT-001 go through contract → build → evaluate without stopping
   Check transcripts appear in `transcripts/PKT-001/`

4. **Verify nudge (send to running agent):**
   While a builder is running, send: `{"type": "send_to_agent", "message": "Make the star rating gold colored, not yellow"}`
   Verify the builder receives the message (check transcript) and continues working

5. **Verify evaluator guide edit:**
   Edit evaluator-guide.json to add an anti-pattern: "no default browser focus outlines"
   Verify next evaluator run includes this in its prompt

6. **Verify packet gate:**
   The final packet (marked requiresHumanReview) should pause at `awaiting_human_review`
   Review the output
   Approve it

7. **Verify hard pivot:**
   If any packet fails evaluation, send a `reset_packet` to re-run it
   Verify it re-negotiates and rebuilds

8. **Verify crash recovery:**
   Kill the tmux session mid-build
   Resume with `./resume.sh`
   Verify the agent picks up with session history (uses resumeSession)

9. **Final state:**
   All packets complete
   Book list app works (dev server starts, shows books, filter works, stars clickable)
   All transcripts preserved in `transcripts/`
   Events log shows full lifecycle including gates and nudges

**Verify all of the above by actually running it and checking each step via tmux capture-pane and file inspection.**

---

## 4. Key Files

### Files to create
| File | Purpose |
|------|---------|
| `harness/operator-skill.md` | Comprehensive operator knowledge for Claude Code |
| `harness/src/schemas.ts` (edits) | New phases, requiresHumanReview, PlanningContext, inbox types |

### Files to modify
| File | Why |
|------|-----|
| `harness/package.json` | Pin SDK to exact 0.2.83 |
| `harness/src/backend/types.ts` | AgentSession interface |
| `harness/src/backend/claude-sdk.ts` | v2 session API implementation |
| `harness/src/backend/fake-backend.ts` | Multi-turn session simulation |
| `harness/src/worker.ts` | Session-based execution, transcript reorganization |
| `harness/src/orchestrator.ts` | Gate phases, session handle, nudge/pivot inbox handlers |
| `harness/src/prompts/planner-prompt.ts` | Interview context, requiresHumanReview guidance |
| `harness/src/prompts/builder-prompt.ts` | Autonomous preamble |
| `harness/src/prompts/evaluator-prompt.ts` | Autonomous preamble |
| `harness/src/prompts/contract-builder-prompt.ts` | Autonomous preamble |
| `harness/src/prompts/contract-evaluator-prompt.ts` | Autonomous preamble |
| `harness/src/main.ts` | --interview flag |
| `harness/tail.sh` | New transcript location |

### Reference files
| File | Why |
|------|-----|
| `plans/harnessd-upgrade-tad.md` | Original architecture |
| `CLAUDE.md` | Project overview (update after implementation) |
| `harness/src/schemas.ts` | All data types |

---

## 5. Implementation Order

Phases are sequential — each builds on the prior:

```
Phase 1: SDK migration (foundation — everything else depends on sessions)
    |
Phase 2: Gate model (new phases + inbox handlers)
    |
Phase 3: Interactive planning (interview + plan review)
    |
Phase 4: Transcript reorganization (independent, can parallel with 3)
    |
Phase 5: Nudge + hard pivot (needs sessions from 1 + inbox from 2)
    |
Phase 6: Operator skill (needs everything above to document)
    |
Phase 7: End-to-end verification (proves it all works)
```

Estimated: Phases 1-5 are code changes (~1500 lines modified/added). Phase 6 is a document (~500 lines). Phase 7 is live testing.

---

## 6. Risks

| Risk | Mitigation |
|------|------------|
| v2 SDK API is unstable/alpha | Pin to exact version. Wrap in AgentBackend abstraction so SDK changes are contained to one file. |
| `session.send()` might not work as expected for nudges | Test early in Phase 1. If it doesn't inject cleanly, fall back to close + resumeSession with appended context. |
| Persistent sessions might not survive process restarts | resumeSession is explicitly for this. Test in Phase 7. If it fails, fall back to fresh session with transcript summary in prompt. |
| Gate phases might deadlock if operator forgets to approve | Status shows alerts for awaiting states. `/loop` babysitter recipe can remind operator. |
| FakeBackend needs significant rework for sessions | Keep it simple — queue of responses per send() call. Don't over-engineer. |
