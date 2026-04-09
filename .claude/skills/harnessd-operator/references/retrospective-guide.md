# Post-Run Retrospective Guide

## Overview

When a harness run completes, this retrospective extracts deferred items and design tradeoffs from ALL transcripts using a swarm of cheap haiku agents, then compiles them into a final report.

The goal: turn 100+ transcript files of scattered observations into one actionable document that tells the operator exactly what was deferred, what tradeoffs were made, and what needs attention next.

```
  Transcripts (100+)         Chunk Reports         Packet Reports        Final Report
  ┌─────────────────┐       ┌─────────────┐       ┌──────────────┐      ┌──────────────┐
  │ builder-*.jsonl  │──┐   │ PKT-001-    │──┐   │ PKT-001-     │──┐  │ FINAL-       │
  │ evaluator-*.jsonl│  │──>│ chunk-1.md  │  │──>│ report.md    │  │  │ DEFERRED-    │
  │ contract-*.jsonl │  │   │ chunk-2.md  │  │   │              │  │──>│ REPORT.md    │
  └─────────────────┘  │   └─────────────┘  │   └──────────────┘  │  │              │
  ┌─────────────────┐  │   ┌─────────────┐  │   ┌──────────────┐  │  │ (categorized,│
  │ builder-*.jsonl  │──┘   │ PKT-002-    │──┘   │ PKT-002-     │──┘  │  verified,   │
  │ evaluator-*.jsonl│──┐──>│ chunk-1.md  │──┐──>│ report.md    │──┐  │  prioritized)│
  │ ...              │  │   │ ...         │  │   │              │  │  └──────────────┘
  └─────────────────┘  │   └─────────────┘  │   └──────────────┘  │
                       │                    │                     │
                       └──── haiku agents ──┘── haiku compile ───┘── operator (you)
```

---

## Phase 1: Haiku Swarm

### Step 1: Partitioning

1. Identify the run directory:
   ```bash
   RUN_DIR=".harnessd/runs/$(ls -1 .harnessd/runs/ | sort | tail -1)"
   RUN_ID=$(basename "$RUN_DIR")
   ```

2. List all transcript files per packet:
   ```bash
   ls "$RUN_DIR/transcripts/PKT-"*/*.jsonl
   ls "$RUN_DIR/transcripts/planner/"*.jsonl
   ```

3. Chunk into groups of ~3 files per agent. Group by packet first -- keep transcripts from the same packet together in the same chunk when possible. If a packet has more than 3 transcripts, split into multiple chunks.

4. Create the output directory:
   ```bash
   mkdir -p "$RUN_DIR/deferred"
   ```

### Step 2: Launch Chunk Agents

Launch one haiku agent per chunk, all in parallel using `run_in_background: true`.

**Model:** Use `"haiku"` -- these are extraction tasks, not reasoning tasks. Cheap and fast.

#### Chunk Agent Prompt Template

Use this prompt for each chunk agent, filling in the bracketed variables:

```
You are reviewing {N} transcript files from packet {PKT_ID} of a harness run.
Your job: find DEFERRED ITEMS and DESIGN TRADEOFFS -- things discovered,
discussed, or worked around but NOT fully resolved in this packet.

Read these files:
{file_list}

Each file is JSONL where each line is a JSON object with fields:
  ts (timestamp), role (builder/evaluator/contract_builder/etc), msg (the message object)
Focus on assistant messages (msg.type == "assistant"). Scan for:

1. Issues the evaluator flagged but the builder worked around (not fixed)
2. Design tradeoffs explicitly discussed ("we chose X because Y, at the cost of Z")
3. nextActions items noted in evaluator reports but not implemented
4. Pre-existing issues discovered but declared out of scope
5. Builder TODOs or "future work" mentions in assistant messages
6. Acceptance criteria the builder skipped or marked advisory
7. Contract gaps that were renegotiated -- what was added vs dropped

Do NOT include:
- Successfully resolved bugs (fixed and verified by evaluator)
- Normal implementation details that are just "how it was built"
- Tool errors, network crashes, or infrastructure issues (transient, not product)
- Items that appear deferred in one transcript but resolved in a later one within the same chunk

Write findings to: {RUN_DIR}/deferred/{PKT_ID}-chunk-{CHUNK_N}.md

Format:
# {PKT_ID} Chunk {CHUNK_N} -- Deferred Items

## Items Found

### [Item title]
- **Source:** [transcript filename, role, approximate location]
- **What:** [what was deferred or worked around]
- **Why:** [why it was deferred -- out of scope, time, complexity, etc.]
- **Impact:** [what is affected if this remains unaddressed]

### [Next item...]

## Design Tradeoffs

### [Tradeoff title]
- **Choice:** [what was chosen]
- **Alternative:** [what was considered but rejected]
- **Rationale:** [why this choice was made]
- **Cost:** [what is lost or risked by this choice]

### [Next tradeoff...]

If nothing found, write: "No deferred items found in this chunk."
```

### Step 3: Per-Packet Compilation

After ALL chunks for a given packet complete, launch one more haiku agent to compile and deduplicate:

#### Per-Packet Compilation Agent Prompt Template

```
Read all chunk reports for packet {PKT_ID}:
  {RUN_DIR}/deferred/{PKT_ID}-chunk-*.md

Your job: compile these into a single deduplicated packet report.

Rules:
- Merge items that describe the same underlying issue (even if worded differently)
- Keep the most specific version when merging (prefer the one with file/line references)
- Preserve all unique design tradeoffs
- Count items after deduplication

Write to: {RUN_DIR}/deferred/{PKT_ID}-report.md

Format:
# {PKT_ID}: {packet_title} -- Deferred Items Report

## Summary
- **Deferred items:** {count}
- **Design tradeoffs:** {count}
- **Source transcripts reviewed:** {count}

## Deferred Items

### [Item title]
- **Source:** [transcript filename, role]
- **What:** [what was deferred]
- **Why:** [why deferred]
- **Impact:** [what is affected]
- **Appears in:** [which chunks mentioned this -- indicates how pervasive]

### [Next item...]

## Design Tradeoffs

### [Tradeoff title]
- **Choice / Alternative / Rationale / Cost**

### [Next tradeoff...]
```

### Estimated Scale

One chunk agent per 3 transcripts, plus one compilation agent per packet.

| Run Size | Transcripts | Chunk Agents | Compile Agents | Total | Wall Time |
|----------|-------------|--------------|----------------|-------|-----------|
| Small (3 packets) | ~30 | ~10 | ~3 | ~13 | 1-2 min |
| Medium (8 packets) | ~80 | ~27 | ~8 | ~35 | 2-3 min |
| Large (8 packets, many retries) | ~166 | ~59 | ~10 | ~69 | 3-5 min |

All chunk agents run in parallel. Compilation agents run after their packet's chunks finish (but different packets' compilations can run in parallel).

### Handling Planner Transcripts

Planner transcripts live in `transcripts/planner/`. Treat them as a pseudo-packet "PLANNER":
- Chunk the same way (groups of 3)
- Use `PLANNER-chunk-{N}.md` for chunk reports
- Use `PLANNER-report.md` for the compiled report
- Focus especially on risks noted but deferred, features considered but cut from scope, and architecture decisions with explicit tradeoffs

---

## Phase 2: Operator Review

After ALL haiku agents complete (both chunk and compilation), you (the operator agent) take over.

### Step 1: Read All Packet Reports

Read every `deferred/{PKT}-report.md` and `deferred/PLANNER-report.md`. Build a mental model of:
- Total deferred items across all packets
- Recurring themes (same issue appearing in multiple packets)
- Items that might have been resolved by later packets

### Step 2: Cross-Reference

This is the critical step that catches false positives:

1. For each deferred item in an early packet (e.g., PKT-001), check if a later packet's builder transcript or evaluator report shows it was resolved
2. Check `spec/packets.json` -- some deferred items may be the explicit objective of a later packet
3. Check `spec/context-overrides.md` -- some items may have been injected as operator context and addressed
4. Mark items as **resolved-later** if they were clearly addressed, and exclude them from the final report

### Step 3: Verify Key Findings

Haiku agents are fast but may hallucinate or misinterpret transcript content. For the most important or suspicious findings:

1. Launch 1-3 Explore agents (use sonnet, NOT haiku -- these need real reasoning)
2. Each agent should:
   - Read the specific transcript section the haiku agent cited
   - Check the actual codebase to see if the deferred item is really unresolved
   - Confirm or refute the finding
3. Update your notes based on verification results

Focus verification on:
- Any finding that claims a security issue was deferred
- Any finding that claims data integrity is affected
- Items with high impact ratings
- Items that seem too specific or too vague (signs of hallucination)

### Step 4: Compile Final Report

Write to: `.harnessd/runs/<run-id>/deferred/FINAL-DEFERRED-REPORT.md`

Use this template:

```markdown
# Deferred Work Report -- {run_id}

**Run objective:** {objective from run.json}
**Packets completed:** {N} of {M}
**Packets failed:** {list or "none"}
**Report generated:** {timestamp}

---

## Executive Summary

- **{N}** deferred items across **{M}** packets
- **{X}** design tradeoffs documented
- **{Y}** items covered by planned future packets or known roadmap
- **{Z}** genuinely open items requiring attention

### Top 3 Items Requiring Attention

1. **[Title]** -- [one-line summary and why it matters]
2. **[Title]** -- [one-line summary and why it matters]
3. **[Title]** -- [one-line summary and why it matters]

---

## Deferred Items by Category

### Security
| Item | Packet | Impact | Priority |
|------|--------|--------|----------|
| [title] | PKT-NNN | [impact] | P0/P1/P2/P3 |

[Detailed description of each item below the table]

### Data Integrity
| Item | Packet | Impact | Priority |
|------|--------|--------|----------|

### UX / Frontend
| Item | Packet | Impact | Priority |
|------|--------|--------|----------|

### Infrastructure / DevOps
| Item | Packet | Impact | Priority |
|------|--------|--------|----------|

### Performance
| Item | Packet | Impact | Priority |
|------|--------|--------|----------|

### Code Quality / Tech Debt
| Item | Packet | Impact | Priority |
|------|--------|--------|----------|

---

## Design Tradeoffs

Decisions made during the run that have ongoing implications.

### [Tradeoff title]
- **Packet:** PKT-NNN
- **Choice:** [what was chosen]
- **Alternative considered:** [what was rejected]
- **Rationale:** [why this path was taken]
- **Ongoing cost:** [what this costs going forward]
- **Revisit when:** [conditions that should trigger reconsideration]

### [Next tradeoff...]

---

## Cross-Packet Patterns

Items that appeared in multiple packets, indicating systemic issues:

- **[Pattern]** -- appeared in PKT-NNN, PKT-NNN, PKT-NNN. [What this suggests]
- **[Pattern]** -- ...

---

## Recommended Next Steps

### P0 -- Address Immediately
1. [Item] -- [why urgent, what to do]
2. ...

### P1 -- Address Soon
1. [Item] -- [why important, what to do]
2. ...

### P2 -- Address Eventually
1. [Item] -- [context, what to do]
2. ...

### P3 -- Nice to Have
1. [Item] -- [context]
2. ...

---

## Methodology

- **Chunk agents:** {N} haiku agents reviewed {M} transcript files in groups of 3
- **Compilation agents:** {N} haiku agents deduplicated per-packet findings
- **Verification:** {N} sonnet explore agents verified key findings against codebase
- **Cross-reference:** Checked {N} items against later packets for resolution
- **False positives removed:** {N} items that were resolved by later packets
```

### Step 5: Report to User

After writing the final report, tell the user:

1. The retrospective is complete
2. Where to find the report: `.harnessd/runs/<run-id>/deferred/FINAL-DEFERRED-REPORT.md`
3. A brief summary: how many items, top 3 priorities, any surprises
4. Whether any items need immediate attention (P0s)

---

## Notes

### When to Run

- **Completed runs:** Always. This is the expected final step.
- **Failed runs:** Also run it. Failed runs often have the most valuable deferred observations.
- **Partial runs (paused/stopped):** Run it if the user asks. Use only the transcripts that exist.

### What NOT to Do

- Don't skip Phase 2 (operator review) -- haiku agents hallucinate. Verification matters.
- Don't include infrastructure noise (network errors, rate limits) as deferred items.
- Don't include things the evaluator caught and the builder fixed -- those are resolved, not deferred.
- Don't create follow-up packets or modify the run -- the retrospective is read-only analysis.
- Don't merge the report with other documents -- it stands alone in the `deferred/` directory.
