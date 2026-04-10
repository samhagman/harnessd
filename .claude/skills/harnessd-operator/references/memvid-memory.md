# Memvid Memory — Run Memory Search Reference

Harnessd builds a semantic memory file (`.mv2`) for every run. Each phase transition encodes its artifacts — transcripts, reports, contracts, events, specs — into this file. The result is a single searchable index covering everything that happened in the run.

---

## What Gets Encoded (and When)

Memory is populated incrementally as the run progresses. Each phase encodes its own output when it completes — not the full run history:

| Phase completion | What is encoded |
|-----------------|-----------------|
| `planning.completed` | SPEC.md, packets.json, risk register, evaluator guide |
| `contract.accepted` | Final negotiated contract for the packet |
| `builder.completed` | Builder transcript turns + builder self-check report |
| `evaluator.passed` | Evaluator transcript + eval report + completion summary |
| `evaluator.failed` | Evaluator transcript + eval report (failures captured too) |
| `qa.passed / qa.failed` | QA report for the round |

**Limitation:** Memory only contains data from completed phases. If the builder is currently active, its transcript is not yet in the memory file. Use raw transcript reading for real-time insight into an ongoing session.

The memory file lives at:
```
.harnessd/runs/<run-id>/memory.mv2
```

---

## Querying Memory

### Shell wrapper (preferred)

```bash
./harness/memory.sh "your query"
```

### Direct CLI

```bash
cd harness && npx tsx src/memvid-query.ts "your query"
```

Both are equivalent. The shell wrapper is shorter.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--run-id <id>` | most recent run | Target a specific run |
| `--k <n>` | 5 | Number of results to return |
| `--mode <auto\|lex\|sem>` | auto | Search mode (see below) |
| `--timeline` | — | Chronological view instead of relevance |
| `--since <dur>` | — | Timeline start: `1h`, `30m`, `2d`, `1s` |
| `--help` | — | Usage information |

### Search modes

- **auto** (default) — Hybrid keyword + semantic. Best for most queries. Finds exact phrases and conceptual matches.
- **lex** — Keyword-only. Use when you know exact text appears in the transcript (error messages, variable names, function names).
- **sem** — Semantic-only. Use for conceptual questions ("what was the auth strategy?") when keyword matching is too narrow.

---

## Common Operator Queries

### Why did the evaluator fail a criterion?

```bash
./harness/memory.sh "evaluator failed AC-005"
./harness/memory.sh --k 8 "hard failures PKT-003 evaluator"
./harness/memory.sh --mode lex "AC-005"   # if you know the exact text
```

The evaluator's hard failure messages are indexed from `evaluator-report.json`. Results include the `diagnosticHypothesis`, `filesInvolved`, and `rootCauseLayer` fields.

### Did the builder acknowledge a nudge about X?

```bash
./harness/memory.sh "nudge CSS modules builder acknowledged"
./harness/memory.sh "builder PKT-002 operator instructions"
```

Nudge delivery and the builder's response are captured in transcripts. A hit showing the builder referencing "nudge file says..." or "operator says..." confirms acknowledgement.

### What patterns or decisions were established in PKT-001?

```bash
./harness/memory.sh "PKT-001 completion summary"
./harness/memory.sh "pattern convention decision PKT-001"
./harness/memory.sh --mode sem "authentication middleware design decisions"
```

Completion summaries are indexed after each packet. They capture key decisions, patterns, and conventions established by the builder.

### What errors occurred in the last hour?

```bash
./harness/memory.sh --timeline --since 1h
./harness/memory.sh --timeline --since 30m --k 20
```

Timeline mode returns results in chronological order (oldest first), filtered by the `--since` cutoff. Useful for auditing recent activity without a specific search term.

### What did the planner decide about file structure?

```bash
./harness/memory.sh "file structure architecture plan"
./harness/memory.sh --mode sem "project organization decisions"
```

The SPEC.md and packets.json are encoded after planning. Semantic search works well for architectural questions.

### Was a specific function mentioned in builder work?

```bash
./harness/memory.sh --mode lex "validateSession"
./harness/memory.sh --mode lex "AuthService.ts"
```

Lexical mode finds exact function names, file names, and error strings that appear verbatim in transcripts.

### What did the QA round find?

```bash
./harness/memory.sh "QA round critical major issues"
./harness/memory.sh --k 3 "qa report failures"
```

QA reports are indexed after each QA round. Results show the issue list, severity levels, and diagnostic hypotheses.

---

## Output Format

### Relevance search output

```
[0.92] Builder turn 12 — PKT-003  (transcript, builder)
  2026-04-09T14:23:00Z
  Chose express-session with Redis store because the contract requires
  session persistence across restarts. Evaluated connect-mongo but...

[0.87] Completion summary — PKT-001  (summary)
  2026-04-09T12:15:00Z
  Key decisions: Used passport.js with JWT strategy for auth middleware...
```

The score is a relevance measure (0–1, higher is better). The label indicates what artifact type the result came from: `transcript`, `event`, `report`, `summary`, `contract`, `spec`, etc.

### Timeline output

```
2026-04-09T14:23:00Z [PKT-003] builder — Builder turn 12 — PKT-003
  Chose express-session with Redis store because the contract requires...

2026-04-09T14:35:00Z [PKT-003] evaluator — Evaluator report — PKT-003
  hard failures: 0 | verdict: pass
```

---

## When to Use Memvid vs Raw Transcript Reading

| Situation | Use |
|-----------|-----|
| Finding information when you don't know which file to read | Memvid first |
| "Why did X fail?" | Memvid first |
| "Did the builder acknowledge Y?" | Memvid first |
| "What pattern was established?" | Memvid first |
| Auditing recent activity | Memvid timeline |
| Verifying exact wording (audit, evidence) | Raw transcript |
| Following a real-time builder session | Raw transcript |
| Reading line N through line M of a specific file | Raw transcript |
| Memvid returns zero or low-quality results | Raw transcript |

**Rule of thumb:** Use memvid for discovery and orientation. Once you know *where* to look, use raw transcript reading for exact line-level detail.

---

## Troubleshooting

### "No memory file found for run X"

The run hasn't encoded any artifacts yet, or it started before memvid was enabled. Options:
- Wait until the planning phase completes (the first encoding happens at `planning.completed`)
- Read raw files directly: `cat .harnessd/runs/<run-id>/spec/SPEC.md`

### "No results found"

- Rephrase the query — try `--mode sem` for conceptual queries or `--mode lex` for exact terms
- Increase `--k`: `./harness/memory.sh --k 15 "your query"`
- The phase that contains the answer may not have completed yet

### "@memvid/sdk is not installed"

```bash
cd harness && npm install @memvid/sdk
```

Memvid is an optional dependency. The harness runs normally without it — memory features are simply unavailable.
