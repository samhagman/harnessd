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

## What to Investigate

**For builders:** What files were read/edited (Edit/Write tool calls)? Is the
builder making progress or editing the same files repeatedly? Did it read
nudge.md? Is it addressing the evaluator's feedback or fixing something else?

**For evaluators:** Extract any HARNESSD_RESULT_START envelope. What hard
failures were found? Are they the SAME criteria as previous rounds (check
events for prior evaluator.failed)? Do the failures look legitimate or
like false positives? Did the evaluator actually run tests or just reason?

**For QA:** What did the QA report say? Are issues real or nitpicks?
Are they the same issues from the prior QA round?

**For all:** Is the agent stuck in a loop? Fresh heartbeat? Making net progress?

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
- Same criterion failing 2+ rounds with no progress → nudge immediately
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

## 8. Pivot Protocol

When nudging isn't enough:

- **3 nudges on same issue failed** → The nudge itself is wrong. Re-investigate from scratch. Read the actual code, not just the transcript.
- **Packet exhausts max fix loops** → Tell the user. Split scope, add context-overrides, adjust acceptance criteria. Never force-approve.
- **Evaluator keeps crashing (network errors)** → Kill stale processes (dev servers on configured ports), clean up port conflicts.
- **Builder ignores nudge** → Check events for `nudge.sent`. `[LIVE]` = agent got it. `[FILE]` = check if builder read nudge.md. Neither = nudge wasn't delivered.

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
