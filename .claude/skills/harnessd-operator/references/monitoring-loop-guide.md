# Monitoring Loop Guide — Two-Layer Deep Investigation Protocol

## 1. Overview

Every 15-minute check spawns a sonnet deep-dive agent that reads actual transcripts. This catches miscommunication early and lets genuine difficulty work through.

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Main Cron Loop (Claude)                                 │
│                                                                  │
│  Step 1: Quick status (events, phase, process, heartbeat)        │
│  Step 2: Compute transcript deltas from monitor-state.json       │
│  Step 3: Launch sonnet deep-dive agent (foreground)              │
│  Step 4: Parse ===MONITOR_ASSESSMENT=== output                   │
│  Step 5: Act on findings (nudge / investigate / report)          │
│  Step 6: Update monitor-state.json, report to user               │
│                                                                  │
│  Fallback: if sonnet fails, do shallow check (events+heartbeat)  │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Sonnet Deep-Dive Agent                                  │
│                                                                  │
│  Reads NEW transcript lines (offset from state file)             │
│  Checks tool calls, file edits, hard failures                    │
│  Assesses: real progress vs stuck loop vs miscommunication       │
│  Returns structured JSON assessment                              │
│                                                                  │
│  If investigate_further → Layer 2b: second sonnet reads source   │
│  Max depth: 2 agents, then escalate to user                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1: Main Cron Loop

### Step 1: Quick Status Collection

```bash
RUN_DIR=".harnessd/runs/<RUN_ID>"

# 1. Run state
cat "$RUN_DIR/run.json" | python3 -c "
import json,sys; r=json.load(sys.stdin)
print(f'Phase: {r[\"phase\"]}')
print(f'Packet: {r[\"currentPacketId\"]}')
print(f'Round: {r.get(\"round\",1)}')
print(f'R2 done: {r.get(\"round2CompletedPacketIds\",[])}')
"

# 2. Recent events
tail -10 "$RUN_DIR/events.jsonl" | python3 -c "
import sys,json
[print(f'{json.loads(l)[\"ts\"][11:19]} | {json.loads(l)[\"event\"]} | {json.loads(l).get(\"packetId\",\"\")} | {json.loads(l).get(\"detail\",\"\")}') for l in sys.stdin if l.strip()]
"

# 3. Heartbeat freshness
PKT=$(cat "$RUN_DIR/run.json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('currentPacketId',''))")
for role in builder evaluator; do
  cat "$RUN_DIR/packets/$PKT/$role/heartbeat.json" 2>/dev/null | python3 -c "import json,sys; h=json.load(sys.stdin); print(f'$role: {h[\"ts\"]} turns={h.get(\"turnCount\",\"?\")}')" 2>/dev/null
done

# 4. Process check
ps aux | grep 'tsx.*main.*resume' | grep -v grep | wc -l

# 5. Load monitoring state
cat "$RUN_DIR/monitor-state.json" 2>/dev/null || echo "No state file (first check)"
```

**Immediate actions:**
- `phase: failed` with exhausted retries → reset phase + restart immediately (see below)
- `phase: completed` → report + cancel cron + offer retrospective
- Process count = 0 → restart
- `phase: rate_limited` → report wait time, no action needed

### Step 2: Compute Transcript Deltas

Read `monitor-state.json` for `transcriptLinesSeen` and `lastEventCount`.

```bash
# Find all transcript files for current packet
ls -1 "$RUN_DIR/transcripts/$PKT/"*.jsonl 2>/dev/null

# For each file, compute new lines
for f in "$RUN_DIR/transcripts/$PKT/"*.jsonl; do
  total=$(wc -l < "$f")
  seen=<from transcriptLinesSeen, default 0>
  new=$((total - seen))
  # Defensive: if total < seen (truncated), reset seen to 0
  echo "$f: $total total, $seen seen, $new new"
done

# New events
total_events=$(wc -l < "$RUN_DIR/events.jsonl")
new_events=$((total_events - lastEventCount))
```

### Step 3: Launch Sonnet Deep-Dive

Launch a **foreground** sonnet Agent with the deep-dive prompt (see Layer 2 below). Pass it:
- Quick status summary from Step 1
- New event lines
- Transcript file list with offsets and new line counts
- Current phase, packet, round

### Step 4: Parse Assessment

The sonnet returns structured output between markers:

```
===MONITOR_ASSESSMENT===
{
  "healthy": true,
  "concerns": [],
  "action": "none",
  "nudgeText": "",
  "investigateTarget": "",
  "summary": "Builder progressing on AC-005 vitest fix, 3 files edited."
}
===END_ASSESSMENT===
```

### Step 5: Act on Findings

| action | What to do |
|--------|-----------|
| `"none"` | Report summary, done |
| `"nudge"` | Verify nudgeText has file:line specifics. Send via `./harness/nudge.sh "<nudgeText>"`. Then VERIFY (see below). |
| `"investigate_further"` | Launch a SECOND sonnet (Layer 2b). Max 2 levels, then escalate to user. |
| `"pivot"` | Confirm reasoning traces to transcript evidence. Send pivot via inbox. |
| `"reset"` | NEVER auto-reset. Report to user with reasoning, ask for approval. |

**After sending a nudge — MANDATORY verification:**
1. Sleep 30s, read builder transcript tail — did it acknowledge the nudge?
2. If builder already completed (emitted HARNESSD_RESULT_START) before the nudge: the nudge arrived too late. Apply the No-Waste Rule immediately:
   - Kill the harness (`pkill -f 'tsx.*main.*resume'`)
   - Write the nudge to `packets/PKT-XXX/nudge.md` (builder checks this on startup)
   - Set `run.json` phase to `fixing_packet`
   - Restart the harness
   - Verify builder reads the nudge within 30-60s
3. If builder acknowledged but isn't changing behavior: send a stronger nudge or pivot
4. Check again at 60s to confirm the builder is making the RIGHT changes, not just cosmetic ones

**The No-Waste Rule:** NEVER wait for a known-bad evaluator/builder cycle to complete. If you know the outcome will be failure (nudge arrived too late, builder submitted without fixing, evaluator testing stale state), kill + reset + restart immediately. Wasting 15 minutes on a cycle you know will fail is unacceptable.

### Step 6: Update State and Report

Write `monitor-state.json` with updated offsets and timestamps.

Report format: `Check #N | <phase> | PKT-X | <summary from sonnet>`

### Fallback

If the sonnet agent fails, times out, or returns malformed output:
1. Fall back to shallow check (report events + heartbeat)
2. Log that deep-dive failed
3. Never skip the check entirely

### Auto-Reset Protocol (for failed phase)

When `phase: failed` from exhausted retries:
1. Read events to find the last active phase before failure
2. Reset `run.json` phase back to that phase
3. Kill any stale harness processes
4. Restart: `nohup npx tsx harness/src/main.ts --resume <run-id>`
5. Report the reset but DO NOT cancel the cron
6. NEVER stop retrying — API outages are transient

---

## 3. Layer 2: Sonnet Deep-Dive Protocol

The sonnet deep-dive prompt template (Claude fills in `<brackets>` at runtime):

```
You are a diagnostic agent for harnessd run <RUN_ID>.
Read what happened since the last monitoring check and assess health.

## Memory Search (if available)
Before reading raw transcripts, query the run memory for targeted information:
./harness/memory.sh "current builder progress on <PKT_ID>"
./harness/memory.sh "evaluator failures for <PKT_ID>"
Use results to focus your transcript reading on relevant sections.
If the memory file does not exist or the query returns no results, skip this step and proceed directly to transcript reading.

## Current State
Phase: <PHASE> | Packet: <PKT_ID> | Role: <ROLE> | Round: <ROUND>
Process: <alive/dead> | Last heartbeat: <AGE>
Check #<N> | Last check: <LAST_CHECK_AT>

## New Events Since Last Check (<N> new)
<paste new event lines>

## Transcript Files to Read
<for each file with new lines:>
File: <FULL_PATH>
Read from line: <OFFSET+1>
New lines: <COUNT>

Read each file with: Read tool, offset=<OFFSET>, limit=<COUNT>
If >500 new lines: read first 100 and last 400.

## MANDATORY: Read the agent's actual text content, not just tool calls

Tool calls show WHAT the agent did. The agent's text content shows WHY.
Never draw conclusions from tool call patterns alone — always read the
assistant's `msg.text` and `msg.raw.message.content[].text` to understand
the agent's reasoning.

Specifically extract and read:

1. **The last 3-5 assistant text messages.** These usually contain the
   agent's self-diagnosis of whatever it's doing. Look for phrases like
   "Proceeding to...", "Falling back to...", "The X isn't working so I'll...".
2. **Thinking blocks** (`content[].type === "thinking"`). These show the
   agent's reasoning at each turn.
3. **Any `text` content that follows a failed tool call.** Agents often
   explain their workaround in the next text message.

Use this jq pattern to extract all assistant text (both regular and thinking):
```bash
jq -r 'select(.msg.type == "assistant") |
       .ts as $ts |
       (.msg.raw.message.content // []) |
       map(select(.type == "text" or .type == "thinking")) |
       map(.text // .thinking // "") |
       select(length > 0) |
       "\($ts) | \(.[])"' <transcript.jsonl> | tail -20
```

Or via Read the whole transcript with offset/limit and grep through the
`"text":` values yourself — but do not skip this step.

### Red flag: deriving intent from tool calls alone

**Anti-example (what went wrong in onhq-arch-refactor check #1):** The
sonnet saw 11 mentions of `validate_envelope` in tool calls and concluded
"planner is stuck in a validate_envelope loop." The actual assistant text
at line 75 said: *"The PlannerOutput schema isn't registered in the
validator. Proceeding to emit the envelope directly per the prompt's
documented structure."* The planner had diagnosed the issue and was
actively emitting the envelope. A nudge telling it to "skip validation
and emit directly" was completely redundant.

**Rule:** Before you conclude an agent is stuck, read the agent's last
assistant text message in full. If the agent has self-diagnosed and is
taking corrective action, `action: "none"` is correct even if earlier
tool calls look repetitive.

## What to Investigate

**For all agents:** What does the agent SAY it's doing (text content)?
What did it actually DO (tool calls)? Are those consistent? If the agent
says "I'll skip X and do Y" but then keeps trying X, that's a real stuck
loop. If the agent says "I'll skip X and do Y" and then starts doing Y,
that's healthy self-correction.

**For builders:** What files were read/edited (Edit/Write tool calls)? Is
the builder making progress or editing the same files repeatedly? Did it
read nudge.md? Is it addressing the evaluator's feedback or fixing
something else? CRITICAL: read the builder's own text to see if it
understands the evaluator's hard failures — don't just count edits.

**For evaluators:** Extract any HARNESSD_RESULT_START envelope. What hard
failures were found? Are they the SAME criteria as previous rounds (check
events for prior evaluator.failed)? Do the failures look legitimate or
like false positives? Did the evaluator actually run tests or just reason?
Read the evaluator's text between tool calls — it often explains its
reasoning for each criterion.

**For planners:** Did the planner read all the architecture docs
specified in the planning context? Did it emit a complete result envelope
with SPEC.md, packets.json, etc.? CRITICAL: check for the envelope
markers (`HARNESSD_RESULT_START` / `HARNESSD_RESULT_END`) before
concluding the planner is stuck — an emitted envelope means the planning
phase is complete even if the phase hasn't transitioned yet.

**For QA:** What did the QA report say? Are issues real or nitpicks?
Are they the same issues from the prior QA round?

**For all:** Is the agent stuck in a loop? Fresh heartbeat? Making net
progress? Does the agent's text indicate it understands its situation, or
is it confused?

## Your Output

Analyze the transcripts, then output your assessment between these markers:

===MONITOR_ASSESSMENT===
{
  "healthy": true/false,
  "concerns": ["specific concern grounded in transcript evidence", ...],
  "action": "none" | "nudge" | "investigate_further" | "pivot" | "reset",
  "nudgeText": "exact nudge text with file:line references (empty if no nudge)",
  "investigateTarget": "what source files to read and why (empty if not investigating)",
  "summary": "2-3 sentence summary of what happened and current health"
}
===END_ASSESSMENT===

Rules:
- "nudge" requires exact file:line root cause + why current approach fails + what to do instead
- "investigate_further" = you see red flags but need to read actual source code to confirm
- First-time failures are healthy (harness handles them). Only flag 2+ repeated failures.
- Never recommend "reset" — flag for human decision
- If unsure, prefer "investigate_further" over "nudge" — wrong nudges waste rounds
```

---

## 4. Layer 2b: Second-Level Investigation

When the first sonnet says `investigate_further`, launch a second sonnet to read actual source code.

**Max depth: 2 sonnet agents.** If the second can't determine the issue, escalate to user.

```
A monitoring agent found a concern in harnessd run <RUN_ID> and needs
you to verify by reading actual source code.

## Concern
<paste investigateTarget from first sonnet>

## Evidence from Transcripts
<paste relevant transcript excerpts cited by first sonnet>

## Your Task
1. Read the source files mentioned in the concern (use Read tool)
2. Trace the execution path: function A → function B → function C
3. Check if the builder's recent edits are reachable in the code flow
4. Determine: is the concern real? What exactly is wrong?

===INVESTIGATION_RESULT===
{
  "confirmed": true/false,
  "rootCause": "specific diagnosis with file:line",
  "fixRecommendation": "what the builder should do",
  "action": "nudge" | "none",
  "nudgeText": "exact nudge if confirmed (empty otherwise)"
}
===END_INVESTIGATION===
```

---

## 5. Intervention Decision Guide

### INTERVENE IMMEDIATELY (miscommunication — don't wait for 3+ rounds)

- Builder is editing the **WRONG FILE** — evaluator says "fix usePermissions.ts" but builder edits "ActorSwitcher.tsx"
- Builder is solving a **DIFFERENT PROBLEM** — evaluator says "retract before assert" but builder adds client-side dedup
- Planner created packets for **ALREADY-FIXED** issues (reading wrong QA report, stale context)
- Evaluator is flagging **FALSE POSITIVES** — criterion says "button exists" but evaluator fails on "button error handling"
- Agent is **IGNORING NUDGE** — check if it read nudge.md in its transcript
- **Schema/format mismatch** causing a parse loop (agent produces output but it fails to parse every time)
- Builder and evaluator using **DIFFERENT COMMANDS** (e.g., root vitest vs package-local vitest)

These are COMMUNICATION failures, not hard problems. Every wasted round compounds. Nudge immediately.

### LET IT WORK (genuine difficulty — report but don't intervene)

- Builder trying different approaches to the same real problem (editing correct file, different strategies)
- Evaluator finding **new** issues each round (not the same criterion repeating)
- Fix loop making **NET PROGRESS** — fewer hard failures each round, even if not zero yet
- Builder exploring the codebase to understand the problem (Read/Grep calls, subagent launches)
- API errors / transient crashes that the harness auto-retries

These are HARD PROBLEMS being worked through. The agents are on the right track.

### The Test

Ask: **"Is the agent doing the RIGHT THING slowly, or the WRONG THING quickly?"**

- Right thing slowly → let it work, report progress
- Wrong thing quickly → intervene NOW, every round wasted compounds

### Threshold

- Miscommunication signals → intervene on **FIRST** occurrence
- **"Intervene" = one nudge attempt, then up to two pivots, then reset.** See the escalation ladder in SKILL.md Section 3.
- Same criterion failing 2+ rounds with no progress → nudge immediately (1 attempt only -- if it fails, pivot)
- Same criterion but fewer failures each round → report, don't nudge

---

## 6. Transcript Reading Guide

### JSONL Format

Each line is a JSON object:
```json
{"ts": "2026-04-01T16:32:56Z", "role": "builder", "msg": {"type": "assistant", "text": "...", "sessionId": "..."}}
```

### Key `msg.type` values

| type | Meaning |
|------|---------|
| `system` | Session init, hooks |
| `assistant` | Agent text output + tool calls |
| `tool_result` | Tool output returned to agent |
| `result` | Session end (success/error) |
| `event` | API events (rate_limit, compact, retry) |

### Tool Calls to Look For

- `Edit` / `Write` — files the agent changed (check `input.file_path`)
- `Read` — files the agent investigated
- `Bash` — commands run (test commands, dev server, git)
- `Grep` / `Glob` — codebase searches

### Reading Text Content (MANDATORY, not optional)

Tool calls show actions. Text content shows intent. Always read both.

For Claude transcripts, assistant text lives in:
- `.msg.text` (the normalized field, usually present)
- `.msg.raw.message.content[].text` where `content[].type === "text"`
- `.msg.raw.message.content[].thinking` where `content[].type === "thinking"`

For Codex transcripts, text lives in:
- `.msg.text` (normalized)
- `.msg.raw.output_text` or `.msg.raw.message.content` depending on event type

Extract with jq (works for both backends because `msg.text` is normalized):
```bash
# All assistant text in order
jq -r 'select(.msg.type == "assistant" and (.msg.text // "") != "") |
       "\(.ts) | \(.msg.text[0:300])"' <transcript.jsonl>

# Last 10 assistant messages
jq -r 'select(.msg.type == "assistant" and (.msg.text // "") != "") |
       "\(.ts) | \(.msg.text[0:500])"' <transcript.jsonl> | tail -10

# Thinking blocks (Claude only)
jq -r 'select(.msg.type == "assistant") |
       .ts as $ts |
       (.msg.raw.message.content // []) |
       map(select(.type == "thinking") | .thinking // "") |
       select(length > 0) |
       "\($ts) | \(.[])"' <transcript.jsonl>
```

Or when using the Read tool on the JSONL file, look for:
- `"text":"..."` — regular assistant text (what the agent said)
- `"thinking":"..."` — thinking blocks (what the agent reasoned)

Both matter. The text between tool calls is where agents diagnose
problems, explain workarounds, and announce their next step. Skipping
text content and deriving conclusions from tool-call patterns alone is
the #1 source of false-positive "stuck loop" diagnoses.

### Extracting HARNESSD_RESULT_START Envelopes

```bash
grep "HARNESSD_RESULT_START" "$TRANSCRIPT" | tail -1 | \
  python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['msg'].get('text',''))"
```

Then parse the JSON between `===HARNESSD_RESULT_START===` and `===HARNESSD_RESULT_END===`.

### Claude vs Codex Transcripts

Same JSONL format (both go through `worker.ts logMessage()`). The difference is only in `msg.raw` — Codex has `type: "item.completed"` with nested structure, Claude has `type: "assistant"` with direct content. For analysis purposes, use `msg.text` and `msg.type` which are normalized across both backends.

---

## 7. Nudge Quality Requirements

Every nudge must include:
- **The exact root cause** — not "the session returns 401" but "validateSession() at AuthService.ts:360 calls store.getEntity() against the largest database, which doesn't contain the invited actor"
- **The exact file(s) and line numbers** to fix
- **Why the builder's current approach doesn't work** — "your multi-database search at line 289 is dead code because validateSession() throws at line 268 before reaching it"
- **What specifically to change** — concrete options, not vague advice

```bash
./harness/nudge.sh "# Root Cause: [title]

The builder's fix at [file:line] doesn't work because [reason].

The actual failure chain:
1. [function A] calls [function B] at [file:line]
2. [function B] does [thing] which fails because [reason]
3. The builder's fix at [file:line] is unreachable because step 2 throws first

The fix should be:
Option A: [specific change in specific file]
Option B: [alternative approach]

The file to change is [file], NOT [file the builder keeps editing]."
```

---

## 8. Escalation Protocol

When a single nudge isn't enough, follow the strict escalation ladder -- 1 nudge, 2 pivots, then reset. Do not send a second nudge; move directly to pivot.

**Nudge failed (acknowledged but no behavior change, or ignored):**
- Do NOT send a second nudge. One nudge attempt per miscommunication.
- Escalate immediately to pivot #1.
- Re-investigate from scratch before pivoting -- read the actual code, not just the transcript, so the pivot context is accurate.

**Pivot #1 failed (compliance check after first pivot shows same problem):**
- Escalate to pivot #2 with stronger/more explicit context.
- Pivot #2 should include concrete examples, exact file:line expectations, or tighter scope compared to pivot #1.

**Pivot #2 failed (compliance check after second pivot still shows same problem):**
- Escalate to reset_packet. This is the nuclear option -- full contract re-negotiation.
- NEVER auto-reset. Report to user with full reasoning and get approval.

**Other escalation triggers:**
- **Packet exhausts max fix loops** → Tell the user. Split scope, add context-overrides, adjust acceptance criteria. Never force-approve.
- **Evaluator keeps crashing (network errors)** → Kill stale processes (dev servers on configured ports), clean up port conflicts.
- **Builder ignores nudge** → Check events for `nudge.sent`. `[LIVE]` = agent got it. `[FILE]` = check if builder read nudge.md. Neither = nudge wasn't delivered. Either way, escalate to pivot after one failed nudge attempt.

---

## 9. What NOT to Do

- Don't force-approve packets — ever
- Don't send vague nudges ("fix the session issue") — always include code-level specifics
- Don't say "looks good, builder is working on it" when the same failure has repeated 2+ times — investigate
- Don't skip the deep-dive agent even if the run looks healthy — the deep-dive catches things events don't show
- Don't assume the builder's explore agents found the right thing
- Don't write .md files to inbox/ — they get silently ignored. Always use `./harness/nudge.sh`
- Don't stop retrying on API failures — reset and restart, that's the point of monitoring
- Don't wait for 3 rounds to intervene on a miscommunication — intervene on first occurrence
