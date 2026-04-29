# Session Diagnostics Reference

`harness/diagnose.sh <packet-id> [--role <role>] [--attempt N]` classifies a
worker session into one of eleven sealed states and recommends a specific
action. This document enumerates each classification, its detection rule,
and the operator action.

The classifier is built on top of `session-summary.json` (which the harness
writes at session end and periodically during long sessions). The CLI falls
back to live transcript computation if the artifact isn't available.

---

## Classification priority order

The classifier checks in this order; first match wins. **Terminal**
classifications (the session has ended) are checked before **in-progress**
classifications, which are checked before **quality indicators**.

### Terminal — session ended cleanly with envelope

#### `envelope_emitted_clean`
**Detection:** `endReason` ∈ {`envelope_emitted_via_staged_file`, `envelope_emitted`}.

The model called `validate_envelope` with `valid:true` (which persisted to
`staged-envelope.json`) and/or emitted a delimited envelope. Orchestrator
recovered the body. No format drift.

**Recommended action:** No action. Evaluator can proceed.

#### `envelope_format_drift`
**Detection:** `endReason == envelope_emitted_via_fence_fallback` OR
`endReason == session_crashed_no_envelope` (last-ditch — work likely
happened but the envelope wasn't recoverable).

The model successfully completed work but emitted in a non-canonical
format (markdown ```json fences with no delimiters, or no parseable
envelope at all). With Fix 1 deployed, this becomes rare — `validate_envelope`'s
side-effect persistence catches most cases.

**Recommended action (fence fallback):** No action. Work was accepted
via the fallback path; this is telemetry only. If this recurs frequently
for one role/model, audit prompt rendering for delimiter clarity.

**Recommended action (no envelope at all):** Verify the work landed via
`git log` and `gate_check`. If it did, manual envelope recovery (write
`builder-report.json` from observed state, reset phase to
`evaluating_packet`). Note that this case should be rare with Fix 1 deployed
— if you see it, audit whether `validate_envelope` was actually called.

### Terminal — session ended without envelope

#### `api_outage_terminal`
**Detection:** `endReason == api_timeout_after_retries`. SDK exhausted its
retry budget (typically 10 retries with exponential backoff) and emitted
a synthetic timeout result.

**Recommended action:** Restart the session. The harness's auto-resume
should handle this transparently; if it doesn't, kill the harness process
and restart with `--resume`.

#### `rate_limited_pending`
**Detection:** `endReason == rate_limited`.

**Recommended action:** Wait for the rate-limit window to clear. Check
`resetsAt` in `events.jsonl` for the precise timestamp. Do NOT restart —
that consumes more of the same quota.

### In-progress — session still alive

#### `api_outage_in_progress`
**Detection:** `apiRetries.length >= 3` AND no terminal state matched above.

The SDK is mid-retry-storm. `worker.api_retry_storm` event has been emitted
to `events.jsonl`. SDK budget allows up to 10 retries spanning ~4h with
backoff. Sessions often recover.

**Recommended action:** WAIT. Do NOT kill before attempt 10 exhausts. Check
the Anthropic status page if the outage persists past ~30 min. Re-run
diagnose.sh in 30 min.

#### `compaction_in_progress`
**Detection:** `endReason == compaction_pending`. SDK emitted
`status: "compacting"` but no `compact_boundary` yet.

Compactions on >100K tokens routinely take 60-180+ seconds. Very large
contexts (>200K) can take 30+ min — the 4h46m gap in the run that
prompted these tools was 4h46m of api_retry, NOT compaction; do not
confuse the two.

**Recommended action:** WAIT. Compaction is SDK-internal and self-recovering.
Re-run diagnose.sh in 5-10 min.

#### `compaction_completed_recently`
**Detection:** Most recent `compact_boundary` ≤ 5 min ago.

**Recommended action:** WAIT. Give the model a few turns to resume work
post-compaction; the first turn after a compaction can be slow as it
re-grounds in its own auto-summary.

#### `awaiting_envelope_emit`
**Detection:** `endReason == still_running`, `validate_envelope` tool was
called ≥1 time, no envelope discovered yet.

The model is likely emitting the final envelope text right now. With Fix 1
deployed, the staged-envelope.json may already exist (the orchestrator
will read it on session end).

**Recommended action:** WAIT briefly (≤1 min). Do not interrupt.

### Quality indicators — session running, may need action

#### `silent_extended_thinking`
**Detection:** Session live, fewer than 3 retries, longest gap < 10 min OR
session age < 30 min.

This is the legitimate "Don't Kill on Silence" case: Opus 4.7 high-effort
can think silently for 5-10+ min between tool calls.

**Recommended action:** WAIT. Re-run diagnose.sh in 10 min.

#### `stuck_loop_definite`
**Detection:** ≥12 total tool calls, ≥60% are the same read-only tool
(Read/Grep/Bash/Glob), zero Edit/Write/NotebookEdit calls.

The model is reading without writing — almost certainly stuck in
investigation without converging on a fix.

**Recommended action:** Send a nudge identifying the loop. Reference exact
files and an explicit next step. If it continues post-nudge, kill and
reset the packet via `packet_reset` inbox message.

### Catch-all

#### `unclassified`
**Detection:** No other classifier matched.

**Recommended action:** Do NOT act on intuition. Read the transcript
directly via `./harness/session.sh <packet> --all` and the underlying
`transcripts/<packet>/*.jsonl` files. The absence of a clean classification
is itself signal that the situation is novel.

---

## When to use diagnose.sh vs session.sh

- **`diagnose.sh`** — answers "what's happening AND what should I do?" with
  a sealed classification + bounded evidence. Use this first.
- **`session.sh`** — answers "what happened in detail?" with a 30-line
  narrative including turn-count, tool-call mix, gap analysis, envelope
  source. Use this for deeper context on a classified session.

The cron monitoring loop should call `diagnose.sh` first on each tick;
only escalate to `session.sh` (or raw transcript reads) when diagnose
returns `unclassified` or when the operator wants to verify a recommended
action.

---

## Adding a new classification

The enum is sealed by design — new classifications require code changes
to `harness/scripts/diagnose-cli.mts` so they get evidence rules and a
recommended action documented here. Resist the urge to add free-form
classifications; the strict enum is what makes diagnoses comparable
across sessions and operators.
