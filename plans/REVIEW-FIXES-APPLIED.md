# Build-Ontology Review Fixes Applied

**Date:** 2026-04-16
**Author:** Claude (Opus 4.7)
**Plan:** `/Users/sam/projects/harnessd/plans/build-ontology-poc.md`
**Packets touched:** PKT-001..PKT-014 (all 14 in `/Users/sam/projects/harnessd/harness/.harnessd/runs/build-ontology/spec/packets/`)

This document records the minimum-fix set applied after the cohesion + ontology-docs review. Strategy: trust the implementer to translate Lisp shapes when given the right pointers; do NOT rewrite every Lisp block to canonical syntax.

---

## 1. Verified validation command

Confirmed via `./apps/bun/dist/ontology --help` and `./apps/bun/dist/ontology vcs --help`:

| Use | Command |
|-----|---------|
| Local typecheck (no server, fastest iteration) | `./bin/ontology vcs typecheck --dir ./ontology` |
| Server-side dry run (full deploy plan, requires DB) | `./bin/ontology vcs deploy plan -d staffing --dir ./ontology` |

`./bin/ontology vcs typecheck` exists as a first-class subcommand; supports `--dir`, `-f/--files`, single-file arg. Output format flag `--format json` available globally. Both commands are referenced in the new "before writing Lisp" pointer paragraphs.

There is no separate `./bin/ontology validate` command.

---

## 2. Per-packet edits

### PKT-001 — Single Entity End-to-End
- **Added pointer paragraph** at top of Implementer notes (full version with all syntax callouts).

### PKT-002 — All Four Tiers Thin + One Constraint
- **Added pointer paragraph** at top of Implementer notes.
- **Fix 5: Added `country-rule-lookup` and `industry-term-definition` queries** to `ontology/queries.md` (after `clients-with-tier-context`). Both are sketched as multi-pattern Datalog with INTENT comments noting the implementer must translate to canonical `(:from EntityName) (:where ...) (:select [...])` syntax and use `define-query-preset` for parameterization.
- Updated "Likely files" sizing for `queries.md` (~50 → ~80 lines).

### PKT-003 — Operational ETL + 3 Skills (minimal)
- **Added pointer paragraph** at top of Implementer notes.
- **Fix 1 + Fix 2: Added `Skill` and `WorkerCertification` entity definitions** into `ontology/schema.md` UPDATED row, immediately after the operational entities. Fields per the customer-constraints plan, downgraded enums to String per platform convention.
- **Updated tree layout** comment for schema.md to mention Skill + WorkerCertification.
- **Updated Out-of-scope** to clarify Skill/WorkerCertification ENTITIES are defined here; only RECORDS deferred to PKT-010.
- **Added Skill 2 SKILL.md update**: explicit "Canonical Lisp authoring" section pointing at the bundled `ontology-author` skill.
- **Added Skill 2 saved-queries.md "Canonical syntax callout" section** describing the `(:from EntityName) ... (:select [...])` shape.
- **Added new `references/builtin-entities.md`** to skill 2 — documents Task / Violation / DocumentInstance + the `create-task!` builtin signature copied from `service-builtins.ts` lines 79-200.
- Updated tree layout to list builtin-entities.md.
- Updated "Likely files" reference count to 4 files in skill 2 references.

### PKT-004 — Agent Invocation End-to-End
- **Added shorter pointer paragraph** at top of Implementer notes (verification packet, no Lisp authoring).
- **Added explicit prompt-4 fallback note**: pass criteria accepts `industry-content` (PKT-008) OR `industry-term-definition` (now defined in PKT-002 per Fix 5) OR ad-hoc Datalog as fallback.

### PKT-005 — Constraint-Driven Proactive Loop
- **Added pointer paragraph** at top of Implementer notes (full version + cross-reference to `references/builtin-entities.md` for `create-task!` signature).
- **Removed inline Task fallback schema**, replaced with strong note "Task is built-in; do NOT redefine. Use task/assigned-to, task/assigned-role, task/violation-id, task/entity-id, etc." Source confirmed at `workspace/preludes/system.lisp` lines 202-237.
- **Replaced actor:agent commented-out block** with explicit note: there is no Actor entity; assignees are free-form strings on `task/assigned-to` / `task/assigned-role`. Use `:assignee-role "agent"` in `create-task!` calls.
- **Fixed line 298 typo**: "until role:forklift-operator is added in PKT-008" → PKT-010.

### PKT-006 — CSM Workspace
- **Added pointer paragraph** at top of Implementer notes (compact version).
- **Fix 4: Softened pending-changes UI requirements**:
  - Workspace UI spec updated: PENDING PROPOSALS sidebar shows empty state in PKT-006 with note "(populated after PKT-008 + PKT-011)"
  - Views list reduced from 4 → 3 (csm-pending-changes deferred to PKT-011)
  - Mutations list: removed approve/reject (PKT-011)
  - Tree-layout comment updated
  - Hard gates 5 + 6 explicitly note csm-pending-changes is OUT OF SCOPE for PKT-006

### PKT-007 — Operations Workspace
- **Added pointer paragraph** at top of Implementer notes (covers query/action/view/Violation shapes).
- **Fix 3 partial: Updated governance-tab description** — `pending-changes-queue` now correctly attributed to PKT-008 (was incorrectly "PKT-005"), with empty-state acceptance until both PKT-008 and PKT-011 land.
- **Violation triple shape rewrite**: `all-open-violations` and `violation-trends` query examples rewritten to use canonical attribute names (`:violation/constraint-id`, `:violation/constraint-name`, `:violation/detected-at`). Removed nonexistent `:violation/client-org` attribute and explained client-name must be obtained by joining through `:violation/entity-id`. Both queries are now in `(:from ...) (:where ...) (:select [...])` shape rather than multi-pattern find/where.
- Hard gate 7 strengthened to note dependency on PKT-008 + PKT-011.

### PKT-008 — Industry Workspace
- **Added pointer paragraph** at top of Implementer notes.
- **Fix 3: Added `pending-changes-queue` query** to `ontology/queries.md` UPDATED row (after `pending-vocab-proposals`). Defined in canonical shape returning all open `PendingChange` records.
- **Added `approve-pending-change` action (vocab-term branch only)** to `ontology/actions.md` UPDATED row. PKT-011 will EXTEND this with constraint and client-quirk branches. Tree-layout comment updated.

### PKT-009 — Compliance Workspace
- **Added pointer paragraph** at top of Implementer notes.
- Cross-referenced canonical Violation attribute list (no `:violation/client-org`) for `regional-violation-pattern` query.

### PKT-010 — Full Operational Seed + ETL Re-fire
- **Added pointer paragraph** at top of Implementer notes (covers aggregations, `format`, temporal builtins, `(hours-from-now 24)` rewrite to ms arithmetic).
- **Fix 1 cleanup**: Skill entity NOT redefined here (PKT-003 owns the entity definition); only Skill RECORDS seeded in anchors.md.
- **Fix 2 cleanup**: WorkerCertification entity NOT redefined here (PKT-003 owns it); only rows seeded via ETL.
- **Added missing Role anchors**: `role:forklift-operator`, `role:hgv-driver`, `role:cleaner` added to `ontology/anchors.md` UPDATED row with full define-record blocks. The industrial overlay constraints reference these.
- **Added Skill anchor records section** to anchors.md update with full define-record blocks for `skill:forklift-license`, `skill:food-hygiene-l2`, `skill:hgv-class-1`, `skill:boh-experience`, `skill:foh-experience`.
- Tree-layout comment updated for schema.md and anchors.md.

### PKT-011 — Recursive Mutation Pattern
- **Added pointer paragraph** at top of Implementer notes (compact: only the Lisp surface PKT-011 actually authors — actions + view).
- **Fix 4 follow-through**: PKT-011 now explicitly EXTENDS `approve-pending-change` (vocab branch from PKT-008) with constraint + client-quirk branches, AND adds the `csm-pending-changes` view to the CSM workspace.
- Tree layout updated to include `ontology/workspaces.md` UPDATED with the new view.

### PKT-012 — Skills Content Polish
- **Added compact pointer paragraph** at top of Implementer notes.
- **Added new reference file `canonical-syntax.md`** to skill 2 — the polished, deliverable version of the syntax-divergence callouts. This is what ships to Stephen so his agent has the syntax guidance even without re-reading the bundled platform skill.
- **Polished `builtin-entities.md`** also called out in tree layout.
- Hard gate 1 strengthened to require canonical-syntax.md presence.

### PKT-013 — README + Walkthrough + Demo Script
- **Added compact pointer paragraph** at top of Implementer notes (docs only — call out validation commands for any `./bin/ontology` examples in README/WALKTHROUGH).

### PKT-014 — End-to-End QA Pass
- **Added compact pointer paragraph** at top of Implementer notes (QA only — point at `canonical-syntax.md` for any QA-time Lisp shape errors).

---

## 3. Issues NOT fixed (with rationale)

The following issues from the reviews were intentionally NOT fixed in this pass, per the Option B "trust the implementer" strategy:

- **Per-packet Lisp blocks were not rewritten to canonical syntax.** The pointer paragraph + bundled skill + canonical staffing examples are sufficient context for the implementer to translate. Rewriting ~14 packets' worth of illustrative Lisp would be high-risk and would re-encode any mistakes I made into the spec.
- **`:assigns-task-to` slot occurrences in PKT-005 / PKT-008 / PKT-010 / PKT-011 constraint examples** were left as-is. The pointer paragraph explicitly flags this is wishful syntax and directs the implementer to the canonical `:resolution → :action → (create-task!)` pattern.
- **`:in` / `:order-by` / `:limit` / `(:component table)` shape errors** in many query/view examples were left as-is. Pointer paragraph flags these.
- **Aggregation syntax** (`(count ?x)`, `(sum ?x)`, `(query workers-booked-for-shift ?shift)`) in PKT-003, PKT-007, PKT-010 left as illustrative INTENT — the pointer paragraph notes aggregations are most cleanly expressed inside `:violation-query` (which supports multi-pattern Datalog) or inside `define-query-preset`.
- **`(format "{} {}" ?fn ?ln)` calls in constraint :find clauses** left as-is. Pointer flags these to verify; PKT-010 specifically says "fall back to client-side formatting" if `format` doesn't compile inside `:violation-query`.
- **`define-relation` syntax in PKT-010** for `shift-allocated-to-agency` left untouched — the bundled `ontology-author` SKILL.md shows the canonical form (`(define-relation reports-to Employee Employee (:field [reports-to/since Number]))`) and the implementer can pattern-match.
- **Workspace UI rendering specifics** (whether `(:component table)` works, whether markdown editors render, whether mutations wire up to UI buttons) left to per-packet exploration. Multiple packets already note "verify against bundled examples."
- **Plan section 12 Lisp blocks** — the user explicitly said "only edit if Category 1 affects it." None of the Category 1 fixes required plan edits; plan section 12 references that I checked don't contain `:assigns-task-to` or other Category 2 errors at the level that would block implementation.
- **Cohesion review's note about constraint :resolution wiring** — the pointer paragraph documents the canonical pattern; per-packet rewrites would explode scope.

---

## 4. Pointer paragraph rollout — confirmation

| Packet | Pointer paragraph added | Variant |
|--------|-------------------------|---------|
| PKT-001 | Yes | Full (Lisp authoring) |
| PKT-002 | Yes | Full |
| PKT-003 | Yes | Full |
| PKT-004 | Yes | Verification (shorter; no Lisp authoring) |
| PKT-005 | Yes | Full |
| PKT-006 | Yes | Compact full |
| PKT-007 | Yes | Compact full + Violation-specific notes |
| PKT-008 | Yes | Compact full |
| PKT-009 | Yes | Compact full |
| PKT-010 | Yes | Full + scenario-specific notes |
| PKT-011 | Yes | Compact (actions + view only) |
| PKT-012 | Yes | Polish (skill-specific) |
| PKT-013 | Yes | Docs (compact) |
| PKT-014 | Yes | QA (compact) |

**All 14 packets received a pointer paragraph.**

---

## 5. Skill 2 (`staffing-marketplace-ontology`) updates — confirmation

### PKT-003 (initial bundle)
- ✅ Main `SKILL.md` got a "Canonical Lisp authoring" section pointing at the bundled `ontology-author` skill
- ✅ `references/saved-queries.md` got a "Canonical query syntax (read first)" section near the top
- ✅ New `references/builtin-entities.md` documenting Task/Violation/DocumentInstance + `create-task!` builtin signature
- ✅ Tree layout + "Likely files" updated to reflect 4 reference files (was 3)

### PKT-012 (deliverable polish)
- ✅ New `references/canonical-syntax.md` listed in tree, with description specifying coverage (`define-query`, `define-constraint`, `define-action`, `define-view`, built-in entities, temporal builtins, format, enum vs string)
- ✅ Tree layout calls out `builtin-entities.md` POLISHED
- ✅ Hard gate 1 strengthened to require canonical-syntax.md presence

---

## 6. Validation pointer in pointer paragraphs — confirmation

Every pointer paragraph references both:
- `./bin/ontology vcs typecheck --dir ./ontology` (local, no server)
- `./bin/ontology vcs deploy plan -d staffing --dir ./ontology` (server-side dry run)

These are the actual binary subcommands (verified via `--help`). No fictional `validate` command is referenced.
