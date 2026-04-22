---
name: harnessd-operator
description: "Use when running a harnessd run, starting a harness, resuming a run, monitoring a run, or the user says 'monitor', 'watch the harness', 'keep an eye on it', 'set up monitoring', 'status loop', 'run the retrospective', 'start a new run', 'launch a run', 'set up a run'. Also offer this proactively when a harness run is started. Covers: workspace preparation, run launching, run monitoring with deep failure investigation, operator steering (nudge/pivot/reset), diagnostics and troubleshooting, and post-run retrospective with haiku swarm for deferred work reports."
---

# Harnessd Operator

Unified skill for operating harnessd runs end-to-end. Five capabilities:

```
                              harnessd-operator
   ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
   │  LAUNCH       │  MONITORING   │  STEERING    │ DIAGNOSTICS  │ RETROSPECTIVE│
   │              │              │              │              │              │
   │  workspace   │  15-min loop │  nudge       │  health check│  haiku swarm │
   │  prep & keys │  deep invest │  pivot       │  event trace │  chunk agents│
   │  run config  │  auto-nudge  │  reset       │  agent debug │  compile     │
   │  start run   │              │              │              │  final report│
   └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```

## Quick decisions

| You are… | Go to | Key rule |
|---|---|---|
| Starting a run | §1 | Prepared mode beats autonomous — better context, fewer wasted cycles. |
| Monitoring a live run | §2 | Read agent text, not just tool calls. Tool output alone misleads. |
| Agent going wrong way | §3 | Nudge on first miscommunication — every round compounds. |
| Something broken | §4 | Check HTTPS / rate-limit before killing. Silent heartbeat ≠ dead. |
| Run completed | §5 | Run the retrospective automatically — don't ask. |

## Critical thresholds (commit to muscle memory)

These are the decisions most often botched under pressure. If you read only this section, you'll still do the right thing 90% of the time.

- **Miscommunication → nudge immediately, on the first occurrence.** Wrong file, wrong diagnosis, format loop, false-positive reject. Every wasted round compounds — a second round of the same mistake means you already watched one round burn.
- **Genuine difficulty → let it work.** Right file, different strategies tried each round, net progress (fewer hard failures than last time). The harness is designed to work through hard problems; your job is telling stuck-and-miscommunicating apart from tractable-and-working.
- **After any nudge → verify receipt within 60s.** A nudge that lands after the builder has already emitted its result is wasted — the builder won't see it until the next fix session, burning an entire eval cycle.
- **If you know the current cycle will fail → apply the no-waste rule.** Kill, reset, restart. Don't watch a 15-min cycle die because "the state machine will work it out." It will, but slowly.
- **If you've diagnosed the problem AND written the fix → execute it.** Don't ask "want me to proceed?" for standard unblocks (kill/nudge/resume). The diagnosis is the authorization; asking just delays an obvious fix while retries burn. Reserve confirmation for destructive or cross-system actions (deletes, force-push, shared infra), not for harnessd steering.
- **Never diagnose from tool calls alone — read the agent's actual text.** Before concluding "the builder is doing X" or "the evaluator is stuck on Y", read the assistant-message text content in the transcript (`transcripts/<packet>/<role>-*.jsonl`, filter `type:"assistant"`). Tool calls are signposts — they show what the agent *did*, not what it *thought*. An agent can be tool-looping productively (exploring the right file with different queries) or stuck unproductively (re-reading the same file while confused about which packet it's on) and the patterns look identical from tool calls alone. The agent's text is where intent and self-diagnosis live. If you haven't read the text, you haven't diagnosed — you've guessed.

---

## 1. Starting a New Run

When the user wants to start a new harnessd run, walk them through setup. There are two modes:

```
Do you want to prepare the workspace first (RECOMMENDED)?
  YES --> PREPARED MODE: set up workspace, keys, references, then launch
  NO  --> AUTONOMOUS MODE: harnessd creates workspace and figures it out
```

**Always recommend Prepared Mode.** Autonomous mode works, but prepared runs succeed faster and with fewer wasted cycles because the agents have better context from the start.

### Prepared Mode (Recommended)

Walk through these steps interactively with the operator:

#### Step 1: Create or choose a workspace

The workspace is the directory where agents will read and write code. It should be separate from the harnessd repo itself.

```bash
# Option A: Fresh project
mkdir -p /path/to/my-project && cd /path/to/my-project && git init

# Option B: Existing repo
cd /path/to/existing-project
```

Ask the operator: "Where should the agents work? An existing repo, or should I create a fresh directory?"

#### Step 2: Name the run

Good run names are short, descriptive, and kebab-case:
- `auth-clerk` (feature being built)
- `fix-payment-webhooks` (bug being fixed)
- `migrate-to-prisma` (migration)

Ask: "What would you like to name this run?"

#### Step 3: Set up API keys

The harness needs at minimum `ANTHROPIC_API_KEY`. If using Codex for adversarial roles (`--codex-roles`), also `OPENAI_API_KEY`.

**Recommend a `.env` file in the workspace** (this is gitignored by default):
```bash
# /path/to/workspace/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...          # only if using --codex-roles
```

Check if keys are available without exposing values:
```bash
[[ -n "$ANTHROPIC_API_KEY" ]] && echo "ANTHROPIC_API_KEY: set" || echo "ANTHROPIC_API_KEY: NOT SET"
[[ -n "$OPENAI_API_KEY" ]] && echo "OPENAI_API_KEY: set" || echo "OPENAI_API_KEY: NOT SET"
```

If neither environment variables nor `.env` file are present, help the operator set them up. **Never print, log, or read the actual key values.**

#### Step 4: Prepare the workspace with context

This is the most impactful step. Agents work dramatically better when the workspace has context before the run starts.

**Recommend creating a CLAUDE.md (or AGENTS.md) in the workspace root** with:
- What the project is and what it does
- Tech stack and key dependencies
- Architecture overview (even a few sentences helps)
- Any conventions, patterns, or "don't do this" rules
- Links to relevant docs or references

**Recommend adding reference material** to the workspace:
- Design mockups or screenshots
- API documentation or OpenAPI specs
- Example code or reference implementations
- Any `.env.example` or config templates

Ask: "Do you have any reference material, design docs, API specs, or context you'd like to add to the workspace before we start? The more context the agents have upfront, the fewer wasted cycles."

#### Step 5: Configure the run

Help the operator choose settings based on their objective:

```bash
# Basic run
cd harness && npx tsx src/main.ts \
  --workspace /path/to/workspace \
  --run-id my-run-name \
  "the objective"

# With planning context (recommended for complex objectives)
cd harness && npx tsx src/main.ts \
  --workspace /path/to/workspace \
  --run-id my-run-name \
  --context planning-context.json \
  "the objective"

# Plan-only first pass (review before committing)
cd harness && npx tsx src/main.ts \
  --workspace /path/to/workspace \
  --run-id my-run-name \
  --plan-only \
  "the objective"

# With Codex evaluators (adversarial, different model biases)
cd harness && npx tsx src/main.ts \
  --workspace /path/to/workspace \
  --run-id my-run-name \
  --codex-roles evaluator,qa_agent,contract_evaluator \
  "the objective"
```

Recommend `--context` for complex objectives — help the operator create a `planning-context.json` with their vision, tech preferences, things to avoid, and definition of done. The operator skill is better at this than a CLI questionnaire because it can have a real conversation. Recommend `--plan-only` for operators who want to review the plan before any code is written.

**Creating planning-context.json:** Help the operator think through and create this file before launching. The schema is:
```json
{
  "vision": "High-level goal for the project",
  "techPreferences": ["TypeScript", "CSS modules", "no external UI libs"],
  "designReferences": ["https://example.com/mockup", "Material Design 3"],
  "avoidList": ["no Tailwind", "no SSR", "no Redux"],
  "doneDefinition": "All pages render, tests pass, Lighthouse score > 90",
  "customNotes": "Any other context for the planner"
}
```
All fields are optional. The planner receives this as additional context when creating the spec and packets.

#### Step 6: Launch and set up monitoring

After the run starts:
1. Offer to set up the tmux operator layout: `./harness/tmux.sh`
2. Offer to set up automated monitoring (see Section 2 below)
3. Explain the plan approval gate: the run will pause at `awaiting_plan_approval` and wait for the operator to review and approve the plan

The first gate the operator will hit is plan approval. Help them review `spec/SPEC.md`, `spec/packets.json`, and `spec/evaluator-guide.json`, then send the approval:
```bash
./harness/nudge.sh '{"type":"approve_plan","message":"approved"}'
```

Or write the approval JSON directly to the inbox.

### Autonomous Mode

For operators who want to skip setup:

```bash
cd harness && npx tsx src/main.ts \
  --workspace /tmp/harnessd-workspace-$(date +%s) \
  "the objective"
```

The harness will create the workspace, auto-generate a run ID, and start planning immediately. The operator still needs to approve the plan when prompted.

**Trade-offs:** Faster to start, but agents have less context. More cycles wasted on exploration. Better for simple objectives; worse for complex multi-day tasks.

---

## 2. Run Monitoring

Two-layer deep monitoring for harnessd runs. Every 15-minute check spawns a sonnet deep-dive agent that reads actual transcripts — not just events. This catches miscommunication early and lets genuine difficulty work through.

```
Layer 1: Main Cron Loop (Claude)         Layer 2: Sonnet Deep-Dive Agent
┌────────────────────────────┐          ┌────────────────────────────┐
│ Step 1: Quick status       │          │ Read NEW transcript lines  │
│ Step 2: Launch sonnet ─────┼─────────>│ Tool calls + AGENT TEXT    │
│ Step 3: Parse assessment   │<─────────┼─(text explains intent —    │
│ Step 4: Act (nudge/report) │          │  tool calls alone mislead) │
│ Step 5: Update state file  │          │ Return structured JSON     │
│                            │          │ If investigate_further:    │
│                            │          │   Launch 2nd sonnet for    │
│                            │          │   source code tracing      │
└────────────────────────────┘          └────────────────────────────┘
```

**CRITICAL:** The sonnet deep-dive must read agent TEXT content (what the
agent said/thought), not only tool calls (what the agent did). Tool calls
show actions; text content shows intent and self-diagnosis. Drawing
conclusions from tool-call patterns alone is the #1 source of false-
positive "stuck loop" diagnoses. See `monitoring-loop-guide.md` §3 for
the mandatory text-reading protocol.

### When to Offer

Proactively offer monitoring when:
- The user starts a harness run (`npx tsx src/main.ts ...`)
- The user resumes a run (`--resume`)
- The user asks about harness status
- A run is already active (check `.harnessd/runs/`)

### Setup

1. Detect the active run ID (most recent in `.harnessd/runs/`)
2. Use `CronCreate` with a `*/15 * * * *` schedule. Do not use `ScheduleWakeup`.
3. The cron prompt must instruct Claude to follow the two-layer protocol:
   - Step 1: Collect quick status (run.json, last 10 events, heartbeat, process check)
   - Step 2: Compute transcript deltas from `monitor-state.json`, launch a sonnet Agent to deep-dive into new transcript lines
   - Step 3: Parse the sonnet's `===MONITOR_ASSESSMENT===` output
   - Step 4: Act on findings (nudge, investigate further, or just report)
   - Step 5: Write updated `monitor-state.json`, report to user
   - Fallback: if sonnet fails/times out, fall back to shallow event-based check

See `references/monitoring-loop-guide.md` for the full protocol with prompt templates and decision tree.

### Memory Search

Before manually scanning JSONL files, query the run memory for targeted information:

```bash
./harness/memory.sh "why did evaluator fail PKT-003"
./harness/memory.sh "builder nudge acknowledgement PKT-002"
./harness/memory.sh --timeline --since 1h
```

Memory search is faster than raw transcript reading for discovery tasks ("why did X fail?", "did the builder acknowledge Y?", "what pattern was established?"). Fall back to raw transcript reading for real-time sessions (memory is only populated at phase completion) or for exact line-level detail.

See `references/memvid-memory.md` for query examples and search mode guidance.

### The Core Principle

Every check spawns a deep-dive agent. Shallow status checks miss stuck loops — the sonnet deep-dive reads actual transcripts and catches them.

The monitoring loop exists to catch **MISCOMMUNICATION** early and let **GENUINE DIFFICULTY** work through. These are different:

**Miscommunication (intervene immediately):** Builder is editing the wrong file. Evaluator is flagging false positives. Planner created packets for already-fixed issues. Schema mismatch causing a parse loop. Agent ignoring nudge instructions. **Every wasted round compounds.**

**Genuine difficulty (let it work):** Builder trying different strategies on the correct file. Fewer hard failures each round. Builder exploring the codebase. API transient errors that auto-retry. **Intervening would disrupt productive work.**

**The test:** "Is the agent doing the RIGHT THING slowly, or the WRONG THING quickly?"
- Right thing slowly → let it work, report progress
- Wrong thing quickly → intervene NOW

### Intervention Threshold

- **Miscommunication signals → intervene on the FIRST occurrence.** Don't wait for 3 rounds.
- **"Intervene" means: nudge (one attempt only), then pivot (up to two), then reset (last resort).** See Section 3 for the full escalation ladder.
- **Same criterion failing 2+ rounds with no progress → nudge immediately.** The builder is stuck on a communication gap.
- **Same criterion failing but with real progress (fewer failures each round) → report, don't nudge.**

### Monitoring State

Each check reads/writes `.harnessd/runs/<run-id>/monitor-state.json` to track what's been seen:
- `transcriptLinesSeen` — per-file line counts so the sonnet only reads NEW lines
- `lastEventCount` — for computing new events since last check
- `checkCount` / `nudgesSent` — for reporting

Consecutive failure counts are derived from `events.jsonl` at check time (not duplicated in state). See `references/monitoring-state-schema.md` for the full schema.

### Sending Nudges

ALWAYS use the nudge script:
```bash
./harness/nudge.sh "your message here"
```

NEVER write `.md` files directly to `inbox/` -- the orchestrator only reads `.json` files and will silently ignore markdown.

The nudge script handles JSON formatting, correct inbox path, and proper message structure. It works for any active run.

### Nudge Verification Protocol (MANDATORY)

After sending ANY nudge, you MUST verify it was received and acted on. A nudge that arrives after the builder has already emitted its result is wasted — the builder won't see it until the next fix session, which means an entire eval cycle is thrown away.

**After every nudge:**
1. Wait 30 seconds, then read the builder transcript tail (last 10-15 lines)
2. Look for acknowledgement: the builder should reference the nudge content within its first few turns
3. If NOT acknowledged after 60 seconds: check if the builder already completed (emitted HARNESSD_RESULT_START). If so, the nudge arrived too late — take immediate action (see No-Waste Rule below)
4. If acknowledged: verify the builder is actually changing behavior, not just acknowledging and continuing its previous approach
5. Check again at 60 seconds to confirm the builder is making the RIGHT changes

**Signs the nudge worked:**
- Builder text says "nudge file identifies..." or "operator says..." and names the specific issues
- Builder starts reading/editing the files mentioned in the nudge
- Builder's approach changes from what it was doing before

**Signs the nudge did NOT work:**
- Builder continues its previous approach without mentioning the nudge
- Builder acknowledges the nudge but doesn't change behavior ("noted, but I'll finish my current approach first")
- Builder already emitted result before nudge arrived
- Nudge went to the wrong run (check the delivery path in the event log)

### No-Waste Rule (CRITICAL)

**NEVER wait for a known-bad cycle to complete.** If you know the current evaluator or builder session will fail (because your nudge arrived too late, or because the builder submitted without fixing the issue), do NOT wait 10-15 minutes for the evaluator to re-discover the same failures.

Instead:
1. **Kill the harness immediately** (`pkill -f 'tsx.*main.*resume'`)
2. **Write the nudge directly to the packet's nudge.md** (`packets/PKT-XXX/nudge.md`) so the next builder session reads it on startup
3. **Reset run.json phase to `fixing_packet`** so the builder restarts immediately
4. **Restart the harness** (`nohup npx tsx src/main.ts --resume <run-id>`)
5. **Verify the builder reads the nudge** within 30-60 seconds

This saves 10-20 minutes per wasted cycle. Over a long run, this can save hours.

**When to apply the No-Waste Rule:**
- Nudge sent as [FILE] but builder already emitted result → the evaluator will find the same failures
- You know the evaluator will fail because the builder didn't fix the issue → don't let it run for 15 min
- The builder is about to submit a false pass and you can't stop it in time → kill + reset + nudge.md
- The evaluator is checking stale state (Vite cache, old build) → kill, clear cache, restart

### Awaiting-Human-Review Rule (stop monitoring)

**When the run phase is `awaiting_human_review`, stop the monitoring cron immediately.** The harness is paused indefinitely until the operator approves or rejects. Polling produces no signal — every check returns the same state until the human responds. Hourly status reports add noise without value.

What to do:
1. Detect `awaiting_human_review` in the phase field.
2. `CronDelete` the monitoring job.
3. Tell the operator the run is paused for their sign-off and what's pending (which packet, what passed, where to find the artifacts).
4. Wait silently for the operator's next message. Do NOT reschedule a check, do NOT poll, do NOT set a wakeup. Restart monitoring only when the operator returns and asks you to.

This applies to any phase that requires human action with no automated trigger — `awaiting_plan_approval`, `awaiting_human_review`, etc. If the operator wants to be reminded, they will say so explicitly ("ping me in an hour"); otherwise, silence is correct.

### Contract-Conflict Rule (CRITICAL — intervene early on impossible ACs)

**Within 2 evaluator rounds, if the same failures persist AND they look like AC-vs-AC contradictions or AC-vs-constraint impossibilities, amend the contract immediately. Do NOT let the builder cycle 5+ times trying to satisfy unsatisfiable criteria.**

Signs of an unsatisfiable AC (look for these on every failure report):
- Two ACs require opposite states (e.g., "git status empty" + "no commits allowed" + "files must change")
- An AC requires a runtime resource that the constraints forbid acquiring (e.g., "fresh clone must produce DB" + "only 4 prereqs allowed, no manual binary download" + binary has no public source)
- An AC requires exact text/structure that another AC's required text directly violates (e.g., heading must contain "design intent" + grep for "design intent" must return zero matches)
- Builder failure descriptions repeatedly use phrases like "impossible to satisfy both," "mutually exclusive," "no path satisfies"

**When you spot one, act in this order (5 minutes total):**

1. **Identify the conflict precisely.** Name the two ACs and explain in one sentence why they cannot both be true.
2. **Amend the contract in place.** Edit `.harnessd/runs/<run-id>/packets/PKT-XXX/contract/final.json` directly. For each removed AC, replace its description with `[REMOVED <date> BY OPERATOR — UNSATISFIABLE] Original: <text>. REMOVED because <reason>. Do not evaluate.` and set `blocking: false`. For reworded ACs, prepend `Reworded <date>:` and explain.
3. **Log the decision.** Append to `.harnessd/runs/<run-id>/spec/decision-log.md` (create if missing). Entry format:
   ```
   ## YYYY-MM-DD HH:MM UTC — PKT-XXX contract amendment
   **Decision:** <what changed>
   **Reasoning:** <the conflict>
   **Scope:** <which ACs, which packets affected>
   ```
4. **Send a nudge** (`./harness/nudge.sh`) telling the builder to re-read the contract and explaining what changed.
5. **Don't kill the harness** unless the builder has already submitted with the old contract — the next fix attempt will read the updated final.json.

**Why this matters.** Contract conflicts are not the builder's fault and cannot be fixed by more attempts. Every cycle on an unsatisfiable AC burns 15-30 minutes for nothing. On the build-ontology run, three packets (PKT-011, PKT-013, PKT-014) collectively burned ~10 hours bouncing on contract conflicts before force-approve. Five-minute amendments at the first sign of a conflict would have saved ~8 hours.

**Distinguish from genuine builder difficulty.**
- Builder making real progress (fewer failures each round, different failures, real product fixes landing) → let it work
- Same N failures bouncing across rounds with no decline AND failures look like impossibilities → amend contract
- Failures decline but stall at strictness items (file location, exact heading text, format conventions) → after 3 rounds, force-approve per existing rule

### Stopping Monitoring

Use `CronDelete` with the job ID returned by `CronCreate`. Or the cron auto-expires after 7 days.

---

## 3. Operator Steering

Three modes for changing the direction of a running harness. When a miscommunication is detected, follow a strict escalation ladder — one nudge attempt, then up to two pivots, then reset as the last resort.

### Escalation Ladder

```
MISCOMMUNICATION DETECTED
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ STEP 1 -- NUDGE (max 1 attempt per miscommunication)       │
│   Send via streamInput + FILE + RECORD layers              │
│   Verify receipt in 30-60s (see Nudge Verification below)  │
└────────────────────┬───────────────────────────────────────┘
                     │ nudge acknowledged + behavior changed?
                     │ YES → done
                     │ NO  ↓
┌────────────────────▼───────────────────────────────────────┐
│ STEP 2 -- PIVOT #1 (1st of 2 pivot attempts)               │
│   Kill current session, restart with new direction baked in│
│   Verify compliance within one builder cycle               │
└────────────────────┬───────────────────────────────────────┘
                     │ first pivot produced compliance?
                     │ YES → done
                     │ NO  ↓
┌────────────────────▼───────────────────────────────────────┐
│ STEP 3 -- PIVOT #2 (2nd of 2 pivot attempts)               │
│   Use stronger / more explicit context than pivot #1       │
│   Add concrete examples, exact file:line expectations      │
│   Verify compliance within one builder cycle               │
└────────────────────┬───────────────────────────────────────┘
                     │ second pivot produced compliance?
                     │ YES → done
                     │ NO  ↓
┌────────────────────▼───────────────────────────────────────┐
│ STEP 4 -- RESET (nuclear — last resort only)               │
│   Delete ALL packet artifacts, redo from contract          │
│   Edit spec / evaluator-guide before re-negotiation starts │
└────────────────────────────────────────────────────────────┘
```

### Escalation Budget Table

| Attempt | Action | Budget consumed |
|---------|--------|----------------|
| Miscommunication detected | 1 nudge | 1 nudge |
| Nudge fails compliance check | 1st pivot | 1 nudge + 1 pivot |
| 1st pivot fails compliance | 2nd pivot (stronger context) | 1 nudge + 2 pivots |
| 2nd pivot fails compliance | reset_packet | nuclear |

**Rules:**
- Nudge: max 1 attempt per miscommunication. If the compliance check (30-60s post-nudge) shows the agent did not acknowledge or did not change behavior, escalate immediately to pivot -- do not send a second nudge.
- Pivot: max 2 attempts. The second pivot should be materially stronger than the first -- more explicit instructions, concrete examples, or tighter scope.
- Reset: only after 1 nudge + 2 pivots have all failed. Requires full contract re-negotiation.

### NUDGE -- steer without stopping

Injects a user message into the running agent's conversation via `streamInput()`. Agent keeps working, incorporates the new instruction.

```bash
./harness/nudge.sh "Use gold (#D4A853) for the star color, not yellow"
```

Three delivery layers (all written automatically):
1. **LIVE** -- streamInput injection, agent sees it immediately
2. **FILE** -- `nudge.md` in packet dir, builder checks before each step
3. **RECORD** -- appended to `context-overrides.md`, permanent for this run

**When to use:** small corrections, added details, API changes -- anything the agent can incorporate without changing its approach.

### PIVOT -- kill and restart with new direction

Terminates the running agent via `Query.close()`, writes pivot instructions to context files, and lets the retry loop start a fresh session with the new direction baked into its prompt.

```bash
RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"
echo '{"type":"pivot_agent","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","message":"Switch to CSS modules instead of inline styles"}' > "$RUN_DIR/inbox/$(date +%s).json"
```

Contract is preserved. Builder artifacts from the killed session remain. New session picks up same contract + packet but with pivot context. Latency: ~15 seconds.

**When to use:** wrong approach, wrong framework, design reference changed -- the current execution path is a dead end.

### RESET -- nuke and rebuild from scratch

Deletes ALL artifacts for a packet (contract, builder, evaluator), resets status to `pending`, and lets the orchestrator re-process from contract negotiation.

```bash
echo '{"type":"reset_packet","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","packetId":"PKT-002","message":"The contract missed responsive design. Redo from scratch."}' > "$RUN_DIR/inbox/$(date +%s).json"
```

**When to use:** contract was wrong, acceptance criteria need to change, fundamental rethink needed.

**Tip:** After sending `reset_packet`, you have a window to edit `spec/SPEC.md`, `spec/evaluator-guide.json`, or `spec/packets.json` before re-negotiation starts.

| | Nudge | Pivot | Reset |
|--|-------|-------|-------|
| Agent keeps working? | Yes | No | No |
| Contract preserved? | Yes | Yes | No |
| Builder artifacts preserved? | Yes | Yes | No |
| Time cost | ~0 | ~15s | Minutes |

See `references/steering-modes.md` for detailed internal mechanics and flow diagrams.
See `references/inbox-protocol.md` for all message types and phase gating rules.

---

## 4. Diagnostics

Quick reference for troubleshooting. Full details in the reference docs.

### Quick Health Check

```bash
RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"

# Current state
cat "$RUN_DIR/run.json" | jq '{phase, currentPacketId, completedPacketIds, failedPacketIds}'

# Is the current agent alive?
PKT=$(cat "$RUN_DIR/run.json" | jq -r .currentPacketId)
cat "$RUN_DIR/packets/$PKT/builder/heartbeat.json" 2>/dev/null | jq '{ts, turnCount}'

# Last 5 events
tail -5 "$RUN_DIR/events.jsonl" | jq -r '[.ts[11:19], .event, .packetId // "", .detail // ""] | join(" | ")'
```

### Key Event Types

| Event | Meaning |
|-------|---------|
| `contract.accepted` | Contract negotiation succeeded |
| `builder.completed` | Builder claims done |
| `evaluator.passed` | Evaluator confirmed work is done |
| `evaluator.failed` | Evaluator found issues |
| `packet.done` | Packet fully complete |
| `nudge.sent` | Check `[LIVE]` vs `[FILE]` in detail |
| `packet.reset` | Packet artifacts cleared, rebuilding |
| `packet.awaiting_review` | Waiting for human sign-off |

### Common Patterns

- **Heartbeat >2 min stale + active phase** -- agent session likely died, orchestrator will auto-retry
- **Same criterion failing 3+ rounds** -- trigger deep investigation (see monitoring guide)
- **Builder keeps editing same file** -- may be fixing wrong layer
- **Evaluator crash (no report)** -- check for stale dev servers on ports 3000/3001/5173
- **Run completed but result is wrong** -- use `reset_packet` after updating evaluator guide

See `references/diagnostics.md` for the full troubleshooting guide.
See `references/file-map.md` for the complete `.harnessd/` directory structure reference.

---

## 5. Post-Run Retrospective

When the run completes (you see "Ready for deferred work report!" in status or the phase is `completed`/`failed`), automatically run the retrospective. Don't ask the user -- they expect this as the final automated step.

### Why

Completed runs have deferred items and design tradeoffs scattered across dozens or hundreds of transcript files. Nobody reads them manually. The retrospective extracts, compiles, and categorizes them into a single actionable report.

### Quick Summary

```
Phase 1: Haiku Swarm (automated, parallel)
  ┌─────────────────────────────────────────┐
  │  List all transcripts per packet        │
  │           |                             │
  │           v                             │
  │  Chunk into groups of 3 files           │
  │           |                             │
  │           v                             │
  │  Launch 1 haiku agent per chunk         │
  │  (all parallel, run_in_background)      │
  │           |                             │
  │           v                             │
  │  Each writes a chunk report:            │
  │  deferred/{PKT}-chunk-{N}.md           │
  │           |                             │
  │           v                             │
  │  Per-packet compilation agent           │
  │  dedupes chunks --> {PKT}-report.md     │
  └─────────────────────────────────────────┘

Phase 2: Operator Review (you, with explore agents)
  ┌─────────────────────────────────────────┐
  │  Read all packet reports                │
  │  Cross-reference: was it fixed later?   │
  │  Verify key findings (sonnet agents)    │
  │  Compile FINAL-DEFERRED-REPORT.md       │
  │  Report to user                         │
  └─────────────────────────────────────────┘
```

### Scale Estimate

One agent per 3 transcripts. For a typical 8-packet run (~166 transcript files):
- ~59 chunk agents + ~10 compilation agents = ~69 haiku agents
- All parallel, 1-3 min each
- Total wall time: ~3-5 minutes

### Output

Final report goes to: `.harnessd/runs/<run-id>/deferred/FINAL-DEFERRED-REPORT.md`

See `references/retrospective-guide.md` for the complete protocol including chunk agent prompts, compilation agent prompts, operator review steps, and final report template.

---

## Reference Files

| File | Contents |
|------|----------|
| `references/monitoring-loop-guide.md` | Deep investigation protocol: status collection, progress assessment, 5 investigation depth levels, nudge quality requirements, pivot protocol |
| `references/retrospective-guide.md` | Haiku swarm protocol: partitioning, chunk agent prompt, compilation agent prompt, operator review steps, final report template |
| `references/diagnostics.md` | Troubleshooting commands: health check, event reading, packet failure diagnosis, contract issues, builder/evaluator problems, gate deadlocks, rate limiting |
| `references/steering-modes.md` | Detailed nudge/pivot/reset mechanics with internal flow diagrams, delivery layers, examples, and decision tree |
| `references/inbox-protocol.md` | All JSON message types, processing pipeline (poller vs synchronous), phase gating rules, message preservation |
| `references/file-map.md` | Complete `.harnessd/runs/` directory structure with every file explained |
| `references/memvid-memory.md` | Run memory search: querying `.mv2` files, common query examples, when to use memvid vs raw transcripts |
