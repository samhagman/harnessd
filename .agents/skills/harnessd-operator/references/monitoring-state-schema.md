# monitor-state.json Schema

Persisted between monitoring checks to track what's been seen. Lives alongside the run at `.harnessd/runs/<run-id>/monitor-state.json`.

## Schema

```json
{
  "runId": "auth-identity",
  "lastCheckAt": "2026-04-01T14:00:00Z",
  "lastEventCount": 47,
  "transcriptLinesSeen": {
    "PKT-R6-001/builder-2026-04-01T16-32-11-000Z.jsonl": 226,
    "PKT-R6-001/evaluator-2026-04-01T16-32-56-515Z.jsonl": 180
  },
  "lastPhase": "evaluating_packet",
  "lastPacketId": "PKT-R6-001",
  "nudgesSent": 1,
  "checkCount": 4
}
```

## Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | The run being monitored |
| `lastCheckAt` | ISO string | When the last check completed |
| `lastEventCount` | number | Total lines in events.jsonl at last check. New events = `wc -l events.jsonl` minus this. |
| `transcriptLinesSeen` | object | Map of relative transcript path → line count already read. Keys are relative to `transcripts/` dir (e.g., `PKT-R6-001/builder-2026-04-01T16-32-11-000Z.jsonl`). |
| `lastPhase` | string | Phase at last check. Used to detect phase changes. |
| `lastPacketId` | string | Packet at last check. Used to detect packet transitions. |
| `nudgesSent` | number | Total nudges sent across all checks. Prevents nudge spam. |
| `checkCount` | number | How many checks have run. Incremented each time. |

## Update Rules

### First Check (no state file)
- Read last 100 lines of each active transcript
- Write initial state with current line counts and event count

### Normal Check
- Read only lines beyond stored offset: `tail -n +<offset+1> <file>`
- After analysis, write updated offsets and timestamps

### Defensive: Truncated Files
- If current line count < stored offset (file was truncated/rewritten), reset offset to 0 for that file
- Check: `wc -l <file>` and compare to stored value before computing delta

### Transcript Volume Cap
- Pass at most 500 new lines to the sonnet agent
- If more than 500 new lines: sample — first 100 + last 400
- This prevents drowning the sonnet in context while keeping both early and recent activity

### New Transcript Files
- When a new session starts (retry, new packet), new files appear in `transcripts/`
- Files not in `transcriptLinesSeen` map → offset 0 (read from beginning)
- No special handling needed — the map naturally grows

### Packet Transitions
- When `currentPacketId` changes, new transcript files appear naturally
- Old files stay in the map but have no new lines — sonnet skips them

## Why Not Track Failure Counts

Consecutive failure counts (e.g., "AC-005 has failed 3 rounds") are **derived from events.jsonl at check time**, not stored in this file.

```bash
# Count consecutive failures for current packet
grep "evaluator.failed.*PKT-R6-001" .harnessd/runs/<RUN_ID>/events.jsonl | tail -5
```

Reason: events.jsonl is the authoritative source. Storing failure counts in monitor-state.json creates a second source of truth that can drift if a check is interrupted or the state file is manually edited.

## File Location

`.harnessd/runs/<run-id>/monitor-state.json`

Created by Claude during monitoring — NOT by the harness itself. The harness has no knowledge of this file.
