# Build-Ontology PoC — Plan

**Run ID:** `build-ontology`
**Workspace:** `/Users/sam/projects/harnessd/harness/.harnessd/runs/build-ontology/workspace`
**Source repo:** fresh clone of `bjacobso/open-ontology` @ `main` (commit `1ac12833`)
**Customer:** Stephen Wentling's team (two-sided staffing marketplace, US + UK)
**Customer doc:** `customer-vision.md` (in workspace)
**Date:** 2026-04-16

---

## 1. Situation

Stephen's team runs a temp/flex shift staffing marketplace (Workers, Shifts, Bookings, Organizations, Locations, Rate Cards, Demands — operating in US + UK across hospitality, industrial, and other verticals). They have an AI agent in production that handles support cases via tool calls into their Rust source system (exposed as an MCP server). The agent functions but **underperforms vs. experienced human operators** because it lacks accumulated contextual knowledge: domain shape, regional regulation, industry vocabulary, per-client quirks, per-user preferences.

Stephen wrote a 5-tier knowledge architecture proposal positioning open-ontology as **Tier 0 only** — the auto-generated domain schema that teaches the agent what a Shift is, what relates to what, what statuses mean. Tiers 1-4 (country, industry, client, user) he assumes belong to other systems (static docs, DB tables, LLM-summarized memory). He asked us for a PoC.

## 2. PoC Mission

Build a working, runnable proof-of-concept that **demonstrates open-ontology as the foundation for Stephen's full knowledge architecture** — not just the narrow Tier 0 he scoped, but a meaningful subset of all five tiers, all queryable through one consistent surface, all maintainable by humans-in-the-loop. Ship it as a GitHub repo Stephen can clone, run with four commands, explore in the browser, AND drop into his existing local AI coding agent (Codex CLI is his likely choice) via three skills that make his agent immediately domain-aware.

**We do NOT build an agent.** Stephen brings his own. We give him the knowledge artifacts that make his agent useful in this domain: the ontology + the operational source-system stand-in + three skills. The agent itself is whatever Stephen already runs (Codex, Claude Code, Cursor, whatever). This sidesteps his stated stack constraint (OpenAI-only) without us picking his framework for him, and it puts the focus squarely on the *knowledge architecture* rather than agent plumbing.

The artifact has three jobs:

- **Validate his thesis.** The reactive → proactive transition he wrote about must visibly work: a constraint fires, a violation appears, a task lands in the agent's queue, his agent reads it, the agent takes action.
- **Expand his thesis.** Show him that Tiers 1-3 (country rules, industry vocab, client profiles) belong in the ontology too, and that operational instance data does too — not as an afterthought, but as the substrate the constraint engine evaluates against natively.
- **Prove agent-platform symbiosis.** The agent doesn't just *consume* the ontology — it *helps maintain* it. When the agent spots a pattern in operational data that suggests a new constraint or a client-specific rule, it proposes an update to the ontology with reasoning. Humans approve. The ontology grows.

## 3. Strategic Positioning

We're going beyond Stephen's stated Tier 0 scope. The reasoning:

- The Tier 0 demo alone is undifferentiated — a triple store + Datalog is interesting but not surprising.
- The strategic prize Stephen named — *constraint-driven proactive agent behavior* — is **the same loop open-ontology already runs natively**, *as long as the operational data is in the ontology*. We accept the cost (operational instances live in the ontology, populated via ETL) to get the benefit (the platform's native constraint→violation→task→agent loop just works, no bespoke evaluation script).
- Open-ontology's primitives (entities, constraints, queries, mutations, processes, workspaces, Markdown+Lisp authoring, time travel) were built for exactly this kind of layered domain knowledge. Limiting it to Tier 0 throws away most of the platform's leverage.
- Stephen's proposal is vague about *how his team would maintain* Tiers 1-4. We aren't just demonstrating that the knowledge fits — we're shipping the **operator workspaces his team would use day-to-day** to keep it updated. That reframes open-ontology from "a place to put data" to "a full platform for the knowledge stack his agent depends on."
- We honor his proposal by building Tier 0 + the proactive loop exactly as he described, and we extend it by adding Tiers 1-3 records, the workspaces to maintain them, and the recursive moment where the agent itself proposes ontology updates. He gets what he asked for AND a clear preview of where it could go.

## 4. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  SOURCE-SYSTEM STAND-IN                                          │
│  operational.db  (local SQLite, NOT in git)                      │
│  Stand-in for Stephen's Rust source system. Holds raw            │
│  operational rows: Workers, Shifts, Bookings, RateCards, Orgs.   │
│  Editable. Re-seedable.                                          │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 │  pnpm sync  (./scripts/sync-operational-to-ontology.ts)
                                 │  Idempotent ETL — upserts triples for synced entities
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  ONTOLOGY  (single runtime store of truth)                       │
│                                                                  │
│  Authored content (git-tracked .md files in ontology/):          │
│  • Entity type definitions (Tier 0 schemas)                      │
│  • Knowledge anchor instances (Country, Industry, Roles, Skills) │
│  • Tier 1 records: CountryRules                                  │
│  • Tier 2 records: IndustryTerms, IndustryNorms                  │
│  • Tier 3 records: ClientProfiles, Quirks, Contacts, Escalation  │
│  • Saved queries (Datalog)                                       │
│  • Constraints                                                   │
│  • Mutations / Actions                                           │
│  • Workspaces                                                    │
│                                                                  │
│  Runtime data (in the ontology's SQLite triple store):           │
│  • Synced operational instances (Workers, Shifts, Bookings, …)   │
│  • Tasks (generated when constraints fire)                       │
│  • Violations (generated)                                        │
│  • Pending changes (proposed by agent or human)                  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 │  open-ontology binary
                                 │  • CLI (query, status, discover, vcs deploy)
                                 │  • HTTP API + Web UI
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
    ┌───────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │ HUMANS in 4   │  │ AGENT processes  │  │ AGENT proposes   │
    │ workspaces    │  │ tasks from queue │  │ ontology updates │
    │ (web UI)      │  │ (proactive loop) │  │ (recursive loop) │
    └───────────────┘  └──────────────────┘  └──────────────────┘
                            (agent = Stephen's own coding agent
                             with our 3 skills installed)
```

**Key architectural choices:**

- **Single runtime store of truth.** All instance data lives in the ontology at runtime. Operational source data is synced *into* the ontology, not queried out-of-band.
- **operational.db is a stand-in for Stephen's source system.** In production, ETL runs against his Rust system. For the demo, it runs against a local SQLite. Same shape.
- **Constraints fire natively.** The platform's own constraint engine evaluates against the ontology — no bespoke "evaluate-constraints" bridge. This is honest to how Stephen would deploy in production.
- **The agent is Stephen's, not ours.** We ship knowledge artifacts (the ontology + skills + operational stand-in). Stephen's coding agent provides the brain.

## 5. What Stephen Receives

A single GitHub repository, cloneable and runnable in under 10 minutes:

```
staffing-marketplace-poc/
├── README.md                              # 4-command setup + skill installation
│
├── ontology/                              # TRACKED — the authored knowledge layer
│   ├── ontology.md                        #   manifest (lists files in deploy order)
│   ├── schema.md                          #   Tier 0 entity definitions
│   ├── anchors.md                         #   Knowledge anchor instances
│   │                                      #     (Country, Industry, Roles, Skills,
│   │                                      #      and the 3 demo client orgs)
│   ├── countries/                         #   Tier 1 records by country
│   │   ├── us.md
│   │   └── uk.md
│   ├── industries/                        #   Tier 2 records by industry
│   │   ├── hospitality.md
│   │   └── industrial.md                  #     (stub — proves overlay pattern works)
│   ├── clients/                           #   Tier 3 records by client
│   │   ├── hilton-hotels-london.md
│   │   ├── acme-warehouse-ltd.md
│   │   └── brewdog-brewery-co.md
│   ├── queries.md                         #   saved Datalog queries
│   ├── constraints.md                     #   core domain constraints
│   ├── industry-overlays.md               #   industry-tagged overlay constraints
│   ├── client-overlays.md                 #   client-specific constraints
│   ├── actions.md                         #   mutations (set-X for forms,
│   │                                      #     granular for queue actions)
│   ├── processes.md                       #   HITL approval workflows
│   └── workspaces.md                      #   4 persona workspaces
│
├── skills/                                # TRACKED — three skills for agent enablement
│   ├── open-ontology/                     #   Skill 1: pre-bundled platform skill
│   │   └── SKILL.md                       #     (extracted via `ontology skill show`)
│   ├── staffing-marketplace-ontology/     #   Skill 2: bespoke for THIS ontology
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── tier-map.md
│   │       ├── entity-overview.md
│   │       ├── saved-queries.md
│   │       ├── client-profiles.md
│   │       ├── constraints-and-overlays.md
│   │       └── proposing-changes.md
│   └── operational-source-system/         #   Skill 3: ETL + source inspection
│       ├── SKILL.md                       #     (focused on running the sync)
│       └── references/
│           ├── etl-workflow.md            #     how + when to run sync
│           ├── operational-schema.md      #     SQL table reference
│           └── exploration-recipes.md     #     SQL recipes for raw inspection
│
├── scripts/
│   ├── seed-operational.ts                # generates operational.db (synthetic data)
│   ├── sync-operational-to-ontology.ts    # the ETL — runs idempotently
│   ├── install-skills-codex.sh            # copies skills/* to Codex's skill dir
│   ├── install-skills-claude.sh           # copies skills/* to Claude Code's skill dir
│   └── setup.sh                           # one-shot first-time setup
│
├── bin/ontology                           # TRACKED — built single binary (130MB)
├── operational.db                         # NOT TRACKED — generated by seed
├── data/                                  # NOT TRACKED — ontology SQLite + meta
└── .gitignore                             # excludes data/, operational.db, .env
```

**Stephen's clone-to-running flow:**

```bash
git clone <repo> staffing-marketplace-poc
cd staffing-marketplace-poc

./scripts/setup.sh
# → creates ontology DB, deploys ontology/, runs seed-operational, runs initial sync.
# → first violation tasks already queued.

./bin/ontology server start --port 3000 --db ./data/staffing.db
# → web UI live at http://localhost:3000

# In a separate terminal — drop the skills into his coding agent
./scripts/install-skills-codex.sh    # OR install-skills-claude.sh

# Launch his own agent in the repo dir; all three skills auto-loaded
codex     # OR claude
```

Within 10 minutes of clone he should:
- See the web UI rendering all 4 workspaces with live data
- Have his own coding agent loaded with all three skills
- Be able to ask his agent a tier-aware question and see it work the proactive loop

## 6. The Demo Experience

The first 30 minutes Stephen spends with the deliverable:

- **Step 1 — Browser at `localhost:3000`.** Lands on a workspace selector. Four workspaces shown: CSM, Operations, Industry Lead, Compliance.
- **Step 2 — CSM Workspace.** Lands on a dashboard of his book of clients (Hilton Hotels London, Acme Warehouse Ltd, Brewdog Brewery Co). Click any client → markdown profile editor (SLA, escalation chain, naming conventions, known quirks). Beside it: a feed of recent agent activity for that client.
- **Step 3 — Operations Workspace.** Live violations stream. He sees real violations from the seeded operational data, queued as tasks for `:agent`. The governance queue shows agent-proposed ontology changes awaiting CSM approval.
- **Step 4 — Industry Workspace (Hospitality).** Vocabulary terms (covers, turn, BoH, FoH...) with an inbox of LLM-proposed new terms. Approve/reject buttons.
- **Step 5 — Compliance Workspace.** `CountryRule` editor (US + UK in one workspace, two tabs). An impact view: "if you change this rule, here are the constraints that depend on it."
- **Step 6 — His own agent terminal.** Stephen runs `./scripts/install-skills-codex.sh`, then launches `codex` in the repo dir. With the three skills loaded, his agent already knows: how to invoke the ontology binary, what's in our specific ontology, and how to run + interpret the operational ETL. He asks "what needs my attention right now?" and watches the agent process the task queue.

## 7. The Wow Moments

Five demo beats the PoC must produce. Together they tell a complete arc: it works → it's smart → it grows → it's maintainable → it integrates with his real source system.

### Wow 1 — His own agent gets domain-aware in 30 seconds

- Stephen launches Codex (or Claude Code) in the repo. The three skills auto-load.
- He asks "what's our worst staffing situation tomorrow morning?"
- The agent calls a saved Datalog query by name (skill 2 told it about it), runs it via `./bin/ontology query` (skill 1 told it how), returns a ranked list with reasoning that cites Hilton's SLA tier (Tier 3) and UK overtime context (Tier 1).
- **Why it matters:** proves the deliverable works in his actual stack with no plumbing.

### Wow 2 — Constraints drive the agent, not the user

- Constraints fire continuously. Violations land as tasks assigned to `:agent`. Two understaffed-shift violations queue at the same time: Hilton Soho (UK + hospitality + premium SLA) and Acme Phoenix (US + industrial + standard SLA).
- Stephen runs his agent: "process your task queue."
- His agent picks up both violations. Hilton → "page on-call NOW, agency notification queued." Acme → "queue for tomorrow's batch review."
- Same constraint definition. Different actions. The agent's reasoning trace shows the tier lookups that drove the divergence.
- **Why it matters:** Stephen's "future state: constraint-driven proactive agent" working in his coding agent. The user wrote zero prompts about Hilton or Acme — the constraints did.

### Wow 3 — The agent proposes ontology updates (recursive loop)

- The agent runs SQL on `operational.db` (skill 3), notices Hilton's no-show rate is 3× other hospitality clients.
- Calls `propose-constraint` (skill 2 taught the pattern) with reasoning: "Hilton has 3× the hospitality average no-show rate over 6 weeks. Propose client-specific reliability check."
- The proposal lands in the Operations workspace inbox. CSM clicks Approve. Ontology now has a Hilton-specific rule.
- Next constraint evaluation includes the new rule.
- **Why it matters:** the platform's own constraint→violation→task loop applies to its own knowledge maintenance. Recursive proof.

### Wow 4 — Workspaces are real maintenance apps, not dashboards

- Stephen's proposal is vague about *how* his team would maintain Tiers 1-4 ("domain experts," "ops-maintained," "LLM-extracted").
- We hand him **four working persona workspaces** where his actual humans do the actual work:
  - A CSM browses clients → opens Hilton Hotels London → edits SLA tier from "premium" to "platinum" inline → saves → live edit round-trips through the running ontology.
  - An industry lead reviews a proposed term ("turnover" suggested by agent) → approves.
  - A compliance lead clicks UK Working Time Regs → sees the constraints that depend on it → tweaks the threshold.
- These are functional UIs his real org could use Monday morning, not mockups. Each persona's flow works end-to-end.
- **Why it matters:** reframes open-ontology from "a place to put knowledge" to "the platform on which his team operates."

### Wow 5 — Operational changes flow through the ETL and re-fire constraints

- Stephen edits a row in `operational.db` (e.g., adds a new under-booked Shift, or changes a Worker's no-show count) — using the SQL recipes skill 3 taught him.
- Runs `pnpm sync`.
- Within seconds the ontology reflects the change. The constraint engine re-evaluates. A new violation appears in the Operations workspace. A new task lands for `:agent`. His agent picks it up on the next invocation.
- **Why it matters:** this is exactly Stephen's production architecture (Rust source → ETL → ontology). We're showing him end-to-end that pattern works, with his actual coding agent on the receiving end.

## 8. Success Criteria

| Bar | Standard |
|-----|----------|
| **Setup time** | From `git clone` to first working agent invocation: **under 10 minutes** (assuming bun + an AI coding agent installed) |
| **Wow demonstrability** | All 5 wow moments reproducible on demand by anyone who clones the repo and reads `WALKTHROUGH.md` |
| **Honesty to Stephen's vision** | Wow 2 (constraint-driven proactive loop) implements his "future state" exactly as his document describes — same scenarios, same flow shape |
| **Workspace QA** | Each of the 4 workspaces verified end-to-end for its primary persona flow. Live edits round-trip. No mocked or "looks-right-but-doesn't-work" UI |
| **Skill quality** | Each of the three skills loadable in both Codex and Claude Code, and demonstrably enables a fresh agent to use the ontology meaningfully on first invocation |
| **ETL correctness** | `pnpm sync` is idempotent (running it twice produces no diff). Edit operational → re-sync → ontology reflects change → constraint re-evaluates. Verified in QA |
| **Constraint-loop coverage** | All 5 of Stephen's named scenarios (his "Reactive to Proactive" table) implemented as native ontology constraints that fire against seeded operational data |
| **Repo hygiene** | Operational data NOT in git; ontology source IS in git; `.env.example` documents required keys |

## 9. Audience Considerations

Who will see this and what they'll judge:

- **Stephen** (proposal author). Does it match what he envisioned? Is the proactive loop real? Does it extend his thinking in a useful direction or feel like overreach?
- **Stephen's tech leads.** Is the integration story plausible? Could the ETL pattern run against their actual Rust source? What's the operational footprint?
- **Stephen's domain experts** (CSMs, industry leads, compliance leads). Can they imagine themselves using these workspaces daily? Is the markdown-editing approachable? Does the seeded scenario data feel like *their* data?
- **Stephen's product leadership.** Is this differentiated from "RAG + a vector DB + Notion + Retool"? What's the strategic moat?

The demo content (client names, scenarios, agent traces) must be plausible enough that Stephen's domain experts nod, not cringe. We anchor on his document's exact examples (hospitality understaffing, agency confirmation gaps, no-show clusters, expired rate cards, overtime-vs-baseline) so nothing feels invented.

## 10. Non-Goals

These are deliberate departures from what one might expect, called out so reviewers don't ask:

- **No agent build.** Stephen brings his own (Codex, Claude Code, etc.). We ship skills. This sidesteps the OpenAI-vs-Anthropic SDK debate entirely and shows the deliverable is portable.
- **Ontology is NOT schema-only.** Stephen's proposal said "schema only, instance data stays in source system." We deliberately put operational instances in the ontology so the platform's native constraint engine fires against them. Operational SQLite is the source-system stand-in, synced via ETL — same shape as his production architecture would be.
- **No real CRM / source-system connection.** All operational data is synthetic, generated by `seed-operational.ts`. ETL runs against the local SQLite stand-in.
- **No bundled staffing example reuse.** Open-ontology ships an `examples/staffing/` (permanent staffing / agency placements). Stephen's domain is temp/flex shift marketplace. We hand-author from scratch, learning from the bundled example's structure but not reusing entities.
- **No production hardening.** No auth, no multi-tenancy, no Cloudflare deploy. Single-user, localhost only.

## 11. Deliverables — Detailed

### 11.1 The ontology source

Hand-authored Markdown + fenced Lisp under `ontology/`. Tracked in git. Loaded via `ontology db seed --file ./ontology <db-name>` on setup. Defines:

- **All Tier 0 entity types** with field shapes (see Section 12 for the blueprint).
- **Knowledge anchor instances** as `define-record` blocks: Countries (US, UK), Industries (Hospitality, Industrial), the 3 demo client Organizations, Roles, Skills.
- **All Tier 1-3 records** as `define-record` blocks, organized by directory.
- **Saved queries** as `define-query` blocks (Datalog, parameterized, named).
- **Constraints** as `define-constraint` blocks. Native to the platform; fire on ontology data.
- **Mutations** as `define-action` blocks. Drive workspace buttons + agent proposals.
- **Workspaces** as `define-workspace` blocks. Each persona-targeted, each with views + mutation hooks.

### 11.2 The operational source-system stand-in

A local SQLite (`operational.db`) representing what Stephen's Rust source system would hold:

- ~3 client Organizations (Hilton London, Acme, Brewdog) + a handful of Agencies + 1 MSP
- ~6 Locations (2 per client)
- ~50 Workers across the orgs
- ~20 Roles, ~15 Skills
- ~100 WorkerCertifications
- ~50 Jobs (role × location × client)
- ~150 Shifts (mix of upcoming/current/in_review/complete)
- ~300 Bookings
- ~10 RateCards
- Several `shift-allocated-to-agency` rows
- Planted patterns to make the constraint scenarios fire (Hilton Soho understaffed tomorrow, high no-show worker cluster, expired rate card, etc.)

Generated by `scripts/seed-operational.ts` — re-runnable, deterministic. Stephen can re-seed, or edit individual rows by SQL to demonstrate the ETL re-fire flow.

### 11.3 The ETL sync

`scripts/sync-operational-to-ontology.ts` — single-shot sync, re-runnable.

- Reads operational.db
- Asserts/upserts triples into the ontology for synced entities
- Idempotent: running twice = no diff
- Triggers ontology constraint re-evaluation as a side effect

For the demo, runs explicitly via `pnpm sync` (not on a cron — keeps the demo controllable). In production, this would be a cron, webhook, or change-data-capture stream against Stephen's Rust system.

**See Section 13 (Knowledge anchors) for what ETL touches vs leaves alone.**

### 11.4 The 3 skills

#### Skill 1 — `open-ontology` (the platform skill)

- **Source:** Pre-bundled inside the open-ontology binary; we extract via `./bin/ontology skill show open-ontology` and commit the result.
- **Teaches:** How to invoke the binary (server, query, status, discover, vcs deploy, db seed). Lisp DSL syntax. Datalog query patterns. The repl. The discover gateway.
- **Trigger:** Whenever the agent encounters an `ontology` CLI invocation or a `.lisp` / fenced-Lisp markdown file.
- **Why we ship it (vs. let Stephen install it himself):** Convenience and version-pinning. He doesn't need to think about whether his locally-installed open-ontology version matches the demo's.

#### Skill 2 — `staffing-marketplace-ontology` (the bespoke knowledge skill)

- **Source:** Hand-authored by us.
- **Teaches:** This specific ontology — the entities, what each tier contains, how to find things, how to propose changes. A high-level map plus the saved-query catalog with usage examples.
- **Trigger:** When the agent is working with anything in `./ontology/` or invoking ontology queries against the staffing database.
- **Centerpiece reference:** `proposing-changes.md` — the *full pattern* for when to propose a constraint, what reasoning to include, how to parameterize the mutation. This is what unlocks Wow 3.

#### Skill 3 — `operational-source-system` (the ETL + inspection skill)

- **Source:** Hand-authored by us.
- **Teaches:** How to run the ETL sync (`pnpm sync`), what it does, when to re-run it, how to verify it worked. Plus a pocket SQL reference for the operational schema and a few exploration recipes for raw inspection / debugging.
- **Trigger:** When the agent needs to validate the ETL flow, inspect raw operational data, or check fields not synced into the ontology.
- **Scope discipline:** This skill is intentionally smaller than Skill 2. The agent's primary job is in the ontology; this skill exists for the cases where the ontology layer doesn't have what the agent needs (yet).

### 11.5 The 4 workspaces (apps, not dashboards)

Each workspace is a real maintenance app: views + mutation buttons + queries. Mutation pattern: **`set-X` for form/profile editing, granular per-item for queue/inbox actions.** Layouts and behavior below.

#### CSM Workspace

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CSM Workspace                                              [sarah-johnson]│
├─────────────────────┬────────────────────────────────────────────────────┤
│  MY CLIENTS         │  Hilton Hotels (London)                            │
│  ─────────────────  │  Premium SLA · 1h · UK · Hospitality              │
│  ▶ Hilton Hotels    │                                                   │
│      Premium · UK   │  [ Profile ] [ Quirks(3) ] [ Contacts(3) ]        │
│      ⚠ 2 violations │  [ Escalation(4) ] [ History(3) ] [ Activity ]    │
│      🔔 1 proposal  │  ─────────────────────────────────────────────    │
│                     │                                                   │
│    Acme Warehouse   │  PROFILE                                          │
│      Standard · US  │  ┌─────────────────────────────────────────────┐ │
│      0 violations   │  │ SLA tier:        [premium ▼]                │ │
│                     │  │ Response hours:  [1]                        │ │
│    Brewdog Brewery  │  │ Owner CSM:       [sarah-johnson]            │ │
│      Scrappy · UK   │  │ Baseline OT/wk:  [12]                       │ │
│      ⚠ 1 violation  │  │                                             │ │
│                     │  │ Naming conventions (markdown):              │ │
│  ─────────────────  │  │ ┌─────────────────────────────────────────┐ │ │
│  [+ New profile]    │  │ │ - Workers are 'team members' not 'staff'│ │ │
│                     │  │ │ - 'Front desk' = reception              │ │ │
│  RECENT ACTIVITY    │  │ │ - Senior managers are 'Heads'           │ │ │
│  • agent acted on   │  │ └─────────────────────────────────────────┘ │ │
│    Hilton-Soho 14h  │  │                                             │ │
│  • Sarah edited     │  │ Communication preferences:                  │ │
│    Brewdog SLA 2d   │  │ ┌─────────────────────────────────────────┐ │ │
│                     │  │ │ Sarah Johnson: Slack DM non-urgent...   │ │ │
│  PENDING PROPOSALS  │  │ └─────────────────────────────────────────┘ │ │
│  ┌─────────────────┐│  │                                             │ │
│  │ Hilton: add     ││  │ Notes:                                      │ │
│  │ "no-show       ││  │ ┌─────────────────────────────────────────┐ │ │
│  │ reliability    ││  │ │ Long-standing client (since 2019). 2    │ │ │
│  │ rule" [Approve]││  │ │ venues we staff: Hilton Soho and Hilton │ │ │
│  │           [Rej]││  │ │ Mayfair. Both 24/7 full-service hotels..│ │ │
│  └─────────────────┘│  │ └─────────────────────────────────────────┘ │ │
│                     │  │                                             │ │
│                     │  │                       [Cancel]   [Save 💾]  │ │
│                     │  └─────────────────────────────────────────────┘ │
└─────────────────────┴────────────────────────────────────────────────────┘
```

- **Sidebar:** "My clients" — list of profiles owned by the current CSM, with violation counts and proposal flags
- **Main pane:** when a client is selected, tabs for Profile / Quirks / Contacts / Escalation / History / Activity
  - **Profile tab:** form for the ClientProfile (set-client-profile mutation on save)
  - **Quirks tab:** list with [Edit] [Remove] per item, [+ Add quirk] → set-client-quirks
  - **Contacts tab:** list with [Edit] [Remove], [+ Add contact] → set-client-contacts
  - **Escalation tab:** ordered list of EscalationSteps, drag to reorder, [+ Add step] → set-escalation-chain
  - **History tab:** ClientHistoricalNote entries, chronological, [+ Add note]
  - **Activity tab:** read-only feed of agent activity for this client (skill 1 query, real-time)
- **Sidebar bottom:** Pending proposals affecting this CSM's clients — approve/reject inline (granular mutations)

#### Operations Workspace

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Operations Workspace                                       [ops-lead]    │
├──────────────────────────────────────────────────────────────────────────┤
│  [ Violations(7) ] [ Tasks(5) ] [ Activity ] [ Governance(2) ] [ Trends ]│
├──────────────────────────────────────────────────────────────────────────┤
│  LIVE VIOLATIONS                                                         │
│  ──────────────                                          🟢 sync 12s ago │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 🔴 HIGH    hospitality/urgent-understaffed                         │  │
│  │   Hilton Soho shift starts in 22h: 4/8 booked                      │  │
│  │   Client: Hilton Hotels (London) · Premium SLA                     │  │
│  │   Task assigned to :agent — pending pickup                         │  │
│  │                            [Acknowledge] [Trigger agent now]       │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 🟡 MED     client-overtime-above-baseline                          │  │
│  │   Hilton Hotels (London) at 17.4h vs baseline 12h (+45%)           │  │
│  │   Task assigned to :agent                                          │  │
│  │                            [Acknowledge] [Trigger agent now]       │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 🟡 MED     worker-reliability-risk-imminent                        │  │
│  │   Worker:John Doe — 2 no-shows this week, next shift in 18h        │  │
│  │   Client: Brewdog Camden                                           │  │
│  │                            [Acknowledge] [Trigger agent now]       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ... 4 more violations                                                   │
│                                                                          │
│  GOVERNANCE QUEUE (2 pending changes)                                    │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 🤖 Agent proposes: NEW CONSTRAINT                                  │  │
│  │    "Hilton no-show buffer for Friday shifts"                       │  │
│  │    Reasoning: Hilton no-show rate is 3× hospitality avg over 6wks  │  │
│  │    Source data: query result attached, 47 bookings analyzed        │  │
│  │    Reviewer: CSM (sarah-johnson)         [Approve] [Reject]        │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 🧑 sarah-johnson proposes: UPDATE CLIENT PROFILE                   │  │
│  │    Brewdog Camden: SLA change scrappy → standard                   │  │
│  │    Reviewer: ops-lead                    [Approve] [Reject]        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Tabs:** Violations / Tasks / Activity / Governance / Trends
- **Violations tab (default):** live violations stream, sorted by severity, with per-violation [Acknowledge] [Trigger agent now] buttons (granular mutations). Shows ETL sync status (last sync timestamp).
- **Tasks tab:** the raw task queue, grouped by assignee
- **Activity tab:** scrolling log of agent actions across all clients
- **Governance tab:** pending-changes from agent OR human, [Approve] [Reject] per item with optional reason
- **Trends tab:** charts (violations by severity over time, by client, by industry)

#### Industry Lead Workspace (Hospitality)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Industry Workspace — Hospitality                       [industry-lead]   │
├──────────────────────────────────────────────────────────────────────────┤
│  [ Vocabulary(7) ] [ Norms(3) ] [ Playbooks(2) ] [ Constraints(2) ]      │
│  [ Inbox(3) ] [ Clients(2) ]                                             │
├──────────────────────────────────────────────────────────────────────────┤
│  VOCABULARY                                                              │
│  ──────────                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ covers                                                             │  │
│  │ Number of meals served / guests dined in a service period.         │  │
│  │ Aliases: (none)                            [Edit] [Remove]         │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ venue                                                              │  │
│  │ A specific physical site where hospitality work happens.           │  │
│  │ Aliases-entity: Location                   [Edit] [Remove]         │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ BoH / FoH                                                          │  │
│  │ Back-of-House (kitchen, prep) vs Front-of-House (server, host).    │  │
│  │ Aliases: (none)                            [Edit] [Remove]         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ... 4 more terms                              [+ New term]              │
│                                                                          │
│  INBOX (3 pending vocabulary proposals from agent)                       │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 🤖 propose-vocab-term: "turnover"                                  │  │
│  │    "Rate at which tables are cleared and re-seated in a service    │  │
│  │     period. Higher turnover = more revenue per seat per night."    │  │
│  │    Seen in 12 cases. Confidence: high.   [Approve] [Reject] [Edit] │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 🤖 propose-vocab-term: "covers per cover"                          │  │
│  │    Apparent typo or odd phrasing — review before approving.        │  │
│  │    Seen in 2 cases. Confidence: low.     [Approve] [Reject] [Edit] │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Tabs:** Vocabulary / Norms / Playbooks / Constraints / Inbox / Clients
- **Vocabulary tab:** list of IndustryTerms, [+ New term], per-item [Edit] [Remove] (set-industry-term, remove-industry-term)
- **Norms tab:** IndustryNorms, similar
- **Playbooks tab:** IndustryPlaybooks, similar (long-form markdown editing)
- **Constraints tab:** read-only list of overlay constraints (`industry-overlays.md`); shows which clients have triggered them
- **Inbox tab:** agent-proposed terms / norms / playbooks awaiting approval (granular approve/reject)
- **Clients tab:** read-only list of clients tagged hospitality (links to CSM workspace)

#### Compliance Workspace (US + UK in two tabs)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Compliance Workspace                                  [compliance-lead]  │
├──────────────────────────────────────────────────────────────────────────┤
│  [ 🇺🇸 US (5) ] [ 🇬🇧 UK (5) ] [ Inbox(1) ] [ Region trends ]              │
├──────────────────────────────────────────────────────────────────────────┤
│  UK COUNTRY RULES                                                        │
│  ────────────────                                                        │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ ▶ Working Time Regulations — 48h/week opt-out               WTR   │  │
│  │   Topic: working-time · Effective: 1998-10-01                      │  │
│  │   ⚠ 2 constraints depend on this rule                              │  │
│  │                                            [View detail] [Edit]    │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ ▶ National Minimum Wage — age tiers                          NMW   │  │
│  │   Topic: minimum-wage · Effective: 2025-04-01                      │  │
│  │   1 constraint depends on this rule                                │  │
│  │                                            [View detail] [Edit]    │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ ▶ Statutory holiday entitlement                                    │  │
│  │   Topic: holiday · Effective: 2009-04-01                           │  │
│  │   0 constraints depend                                             │  │
│  │                                            [View detail] [Edit]    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  TERMINOLOGY ALIASES                                                     │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ "holiday" (UK) ↔ "PTO" / "vacation" (US)            [Edit] [Remove]│  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  NARRATIVES                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ "Why UK workers commonly opt out of WTR..."     [View] [Edit]      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                       [+ New rule] [+ New narrative]     │
└──────────────────────────────────────────────────────────────────────────┘
```

When a rule is selected (Detail view):

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ◀ Back to UK rules                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│  Working Time Regulations — 48h/week opt-out                             │
│                                                                          │
│  Title:        [Working Time Regulations — 48h/week opt-out          ]   │
│  Country:      [🇬🇧 UK ▼]                                                 │
│  Topic:        [working-time ▼]                                          │
│  Effective:    [1998-10-01]                                              │
│  Source:       [https://www.gov.uk/maximum-weekly-working-hours      ]   │
│                                                                          │
│  Rule text (markdown):                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Workers are entitled to a maximum of 48 hours per week, averaged   │  │
│  │ over 17 weeks. Workers may opt out by signing a written agreement..│  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  IMPACT — constraints that depend on this rule:                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ • client-overtime-above-baseline (uses WTR for UK clients)         │  │
│  │ • worker-overtime-cap-approaching (UK-specific threshold)          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Last 30 days: 3 violations triggered by these constraints.              │
│                                                                          │
│                                          [Cancel] [Save changes 💾]      │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Tabs:** US / UK / Inbox / Region trends
- Each region tab shows: list of CountryRules + TerminologyAliases + CountryNarratives for that region
- **Per-rule detail view:** form to edit the rule + an "Impact" panel showing which constraints depend on it + recent violation count
- **Inbox tab:** agent-proposed rule changes awaiting approval (rare, but supported)
- **Region trends tab:** violations grouped by country over time

---

All four workspaces share a common interaction pattern:
- **List + detail.** Lists on the left or top, detail view in the main area.
- **Inline mutations on lists.** Per-item buttons for queue actions (approve, reject, acknowledge, trigger).
- **Form-based mutations on detail views.** Save button sends `set-X` with the full new state.
- **Real-time updates via the platform's reactive layer.** When a constraint fires, the violation appears in Operations workspace within seconds. When a CSM saves a profile change, the agent's next query reflects it.

### 11.6 The closed loop (constraint → task → agent → resolution)

```
Operational change (seeded or edited)
        │
        ▼
ETL sync writes triples into ontology
        │
        ▼
Constraint engine re-evaluates (native, automatic)
        │
        ▼
Violation detected → Task created, assigned to :agent
        │
        ▼
Agent invocation (Stephen runs his agent + asks for the queue)
        │
        ▼
Agent reads task, queries ontology for context (Tier 1-3),
optionally inspects operational.db (skill 3) for raw detail
        │
        ▼
Agent takes action:
  • Notify (logs to ontology activity stream)
  • Propose ontology update (new constraint, client quirk, vocab term)
  • Mark task resolved + log action
        │
        ▼
On next ETL re-fire OR human approval, system state updates.
Constraint re-evaluates. If clean, violation closes.
```

Three concrete scenarios from Stephen's document are wired end-to-end:
- "Shifts at a venue tomorrow are 50% understaffed" (hospitality + premium-tier client)
- "Worker has 2 no-shows this week — next shift is tomorrow" (cross-tier, US client)
- "Rate card for warehouse roles at a location expired" (Tier 0 + operational data)

The other two from his document (agency-unconfirmed, overtime-above-baseline) are also implemented as constraints — same loop, same flow.

## 12. The Ontology Blueprint

This section commits to the structural shape. **Field lists are not exhaustive** — packets may add fields, relations, even small entities as they discover what's needed. The blueprint stays in sync as packets land.

**Type-system note:** Stephen's Lisp examples use `DateTime`. The platform's bundled examples use `Number` (Unix epoch ms). We use `Number` at implementation but write `DateTime` in the blueprint for readability.

### 12.1 Tier 0 — Domain entities

Mirrors Stephen's exact `Organization` (with type enum) + `Shift` + `Booking` from his Lisp. Adds entities his Domain table listed but he didn't show in Lisp.

| Entity | Purpose |
|--------|---------|
| `Country` | First-class country (US, UK, …) |
| `Industry` | First-class industry (Hospitality, Industrial, …) |
| `Organization` | Polymorphic — type ∈ {client, agency, msp}. Refs Country + Industry |
| `Address` | Postal addresses |
| `Location` | Physical work sites; can nest (`parent-location`); operated by a client org. "Venue" in hospitality vocab aliases to this |
| `Worker` | Workers; multi-country authorizations |
| `Role` | Position type (bartender, forklift operator, …) |
| `Skill` | Cert / competency |
| `WorkerCertification` | Worker × Skill, with issue/expire dates |
| `Job` | Persistent role-at-location-for-client identity |
| `Shift` | Concrete time instance of a Job; mirrors Stephen's exact Lisp |
| `Booking` | Worker × Shift assignment + timekeeping; `break-minutes` added per his Domain table |
| `RateCard` | Pay configuration; supports time-of-day tier |

**Cross-entity relationships (`define-relation`):**
- `client-uses-agency` (Organization × Organization)
- `client-managed-by-msp` (Organization × Organization)
- `agency-subcontracts` (Organization × Organization)
- `shift-allocated-to-agency` (Shift × Organization, with confirmed-at) — drives the agency-confirmation constraint

**Computed:**
- `workers-booked` is *derived* via Datalog aggregation (`COUNT bookings WHERE no-show=false`), not stored. Lives in `queries.md`.

**Country queryability:**
- Worker → `home-country` + `work-authorizations [Ref Country]` (multi)
- Organization → `country`
- Shift → Country: transitively via `Shift → Job → Location → Address → Country` (Datalog joins; no denormalized field)

**On Demand:** Stephen's Domain table lists Demand. We compress it into Job + seeded Shifts (no scheduler). Documented in schema with a "production would have this" note.

### 12.2 Tier 1 — Country context

**The point of this tier:** rich, narrative knowledge that *explains how a country's labor market actually works* — regulations, terminology aliases, market norms, common patterns. Not just rules. The agent reads this to reason like a human who's worked in that country for years.

Three meta-entities:

- **`CountryRule`** — structured regulatory rules. `country`, `topic` (Enum: overtime, breaks, minimum-wage, working-time, holiday), `title`, `rule-text` (long-form, multi-paragraph), `effective-from`, `source-reference`
- **`CountryTerminologyAlias`** — explicit term-equivalence entries. `country`, `local-term` (e.g. "holiday" UK), `equivalent-term` (e.g. "PTO" US), `notes`
- **`CountryNarrative`** — long-form contextual explanations the agent reads. `country`, `topic` (free text, e.g. "How tipping works", "Common reasons for billing disputes"), `body` (long markdown), `last-reviewed`

**Minimum seeded records (~10):**
- US: 3 CountryRules (FLSA overtime, California meal-break, federal minimum wage), 1 alias (PTO), 1 narrative ("How US overtime is enforced and what triggers wage-and-hour disputes")
- UK: 3 CountryRules (WTR 48h opt-out, statutory holiday entitlement, National Minimum Wage age tiers), 1 alias (holiday → vacation), 1 narrative ("Why UK workers commonly opt out of WTR and what that means for staffing")

### 12.3 Tier 2 — Industry context

**The point of this tier:** the vocabulary, common patterns, and operational quirks of an industry — what makes hospitality different from industrial. Templates the agent uses to interpret what it sees.

Three meta-entities:

- **`IndustryTerm`** — vocabulary. `industry`, `term`, `definition`, `aliases-entity` (e.g. "venue" → Location), `examples` (multi-paragraph)
- **`IndustryNorm`** — common patterns and expectations. `industry`, `title`, `description` (long-form), `applies-when` (free-text condition)
- **`IndustryPlaybook`** — multi-paragraph "how to handle X" notes. `industry`, `scenario` (free text, e.g. "Last-minute no-show on a Friday hospitality shift"), `body` (long markdown), `recommended-actions` (list of strings)

**Seeded records:**
- **Hospitality (in depth):** ~6 IndustryTerms (covers, turn, BoH, FoH, skeleton crew, on-call, venue), ~3 IndustryNorms (Fri/Sat peak, seasonal events spike, last-minute swap acceptance), ~2 IndustryPlaybooks ("Handling no-shows on high-stakes evening shifts", "Managing seasonal demand spikes for events")
- **Industrial (stub):** 2-3 IndustryTerms (HGV, forklift cert), 1 IndustryNorm (shift handover strictness) — proves overlay pattern works for >1 industry

Industry overlay constraints live in `ontology/industry-overlays.md`.

### 12.4 Tier 3 — Client context

**The point of this tier:** everything a senior CSM has learned about a specific client over months — quirks, history, naming conventions, escalation chains, communication preferences, baseline metrics. The accumulated tribal knowledge that current agents can't access. This is the most demo-visible tier because it's where Stephen's "client-specific knowledge" gap lives.

Five meta-entities:

- **`ClientProfile`** — root profile. `client-org (Ref Organization)`, `sla-tier`, `sla-response-hours`, `baseline-overtime-hours-weekly` (powers the overtime-above-baseline constraint), `owner-csm`, `naming-conventions` (long-form markdown), `communication-preferences` (long-form), `notes` (long-form)
- **`ClientQuirk`** — specific learned things to watch for. `profile (Ref)`, `title`, `description` (long-form, with examples and incident references), `since-date`, `severity` (Enum: info / watch / always-handle)
- **`ClientContact`** — people. `profile (Ref)`, `name`, `role` (free text, e.g. "Operations Manager"), `email`, `phone`
- **`EscalationStep`** — ordered escalation chain. `profile (Ref)`, `step-number`, `contact (Ref)`, `trigger-condition` (free text), `wait-minutes`
- **`ClientHistoricalNote`** — log of past incidents and decisions that shaped the current quirks. `profile (Ref)`, `date`, `title`, `body` (long markdown), `linked-quirks (multi-Ref ClientQuirk)`

**Seeded clients (3 full profiles, each with 2 Locations under the Org-plus-Locations model):**

| Client Org | Locations | Country | Industry | SLA | Quirks | Contacts | Escalation | Historical notes |
|-----------|-----------|---------|----------|-----|--------|----------|------------|-------------------|
| Hilton Hotels (London) | Hilton Soho, Hilton Mayfair | UK | Hospitality | premium / 1h | 3 | 3 | 4 | 3 |
| Acme Warehouse Ltd | Acme Phoenix, Acme Dallas | US | Industrial | standard / 8h | 2 | 2 | 3 | 2 |
| Brewdog Brewery Co | Brewdog Camden, Brewdog Shoreditch | UK | Hospitality | scrappy / 4h | 2 | 2 | 2 | 1 |

Client-specific constraints live in `ontology/client-overlays.md`.

**Concrete example of what a Tier 3 record looks like in practice** — `ontology/clients/hilton-hotels-london.md`:

```lisp
;; ====================================
;; Hilton Hotels (London) — Tier 3 context
;; ====================================

(define-record "client-profile:hilton-hotels-london" ClientProfile
  (:field [clientprofile/client-org "org:hilton-hotels-london"])
  (:field [clientprofile/sla-tier "premium"])
  (:field [clientprofile/sla-response-hours 1])
  (:field [clientprofile/baseline-overtime-hours-weekly 12])
  (:field [clientprofile/owner-csm "sarah-johnson"])
  (:field [clientprofile/naming-conventions "
- Workers are called 'team members' (NOT 'staff' — they consider that demeaning)
- Bookings are called 'allocations' in their internal docs
- 'Front desk' = reception, 'Pass' = back-of-house pass-through area
- Senior managers are 'Heads' (Head of F&B, Head of Housekeeping)
"])
  (:field [clientprofile/communication-preferences "
- Account Manager Sarah Johnson: prefers Slack DM for non-urgent, phone for urgent
- GM David Park: email only, never phone outside business hours unless P0
- All written communication should use 'team members' not 'staff'
"])
  (:field [clientprofile/notes "
Long-standing client (since 2019). 2 venues we staff: Hilton Soho and Hilton Mayfair.
Both 24/7 full-service hotels. High-volume relationship — typical week is 80-100 shifts.
Premium SLA: 1-hour response on urgent staffing issues. Overtime monitored carefully —
weekly baseline ~12h; consistent +30% draws scrutiny from finance.
"]))

(define-record "quirk:hilton-friday-peak" ClientQuirk
  (:field [clientquirk/profile "client-profile:hilton-hotels-london"])
  (:field [clientquirk/title "Friday-Saturday peak buffer"])
  (:field [clientquirk/description "
Hilton consistently runs +20-30% staffing demand on Fri/Sat nights due to weekend
leisure bookings and event hosting. They expect us to PROACTIVELY suggest +20% headcount
over baseline for these shifts. Failure triggers a next-Monday account-review escalation.

Last incident: 2026-02-14 Friday — staffed at baseline, ran short, GM personally complained.
See historical-note:hilton-2026-02-14.
"])
  (:field [clientquirk/severity "always-handle"])
  (:field [clientquirk/since-date 1707955200000]))

(define-record "quirk:hilton-no-agency-sundays" ClientQuirk
  (:field [clientquirk/profile "client-profile:hilton-hotels-london"])
  (:field [clientquirk/title "No agency workers on Sundays"])
  (:field [clientquirk/description "
Hilton Soho's GM (David Park) doesn't allow agency-cascade workers on Sunday shifts —
preference for direct W-2 staff. Always staff Sunday shifts from the direct worker pool.
This is a hard rule, not a preference. Last violated 2025-11-23, account at risk for 2 weeks.
"])
  (:field [clientquirk/severity "always-handle"])
  (:field [clientquirk/since-date 1697155200000]))

(define-record "historical-note:hilton-2026-02-14" ClientHistoricalNote
  (:field [historical-note/profile "client-profile:hilton-hotels-london"])
  (:field [historical-note/date 1707955200000])
  (:field [historical-note/title "Friday under-staffing incident — Hilton Soho"])
  (:field [historical-note/body "
On Fri 2026-02-14 we staffed Hilton Soho's evening shift at baseline (5 team members).
Demand was 8 due to a Valentine's Day event we should have anticipated.

GM David Park called Sarah Johnson at 22:30 directly. Account-review meeting scheduled
the following Monday. We avoided escalation by:
1. Comping 4 hours of management oversight
2. Committing to the Friday-peak buffer rule (now codified as quirk:hilton-friday-peak)
3. Adding a Hilton-specific constraint: client/hilton-friday-peak-buffer

Lesson: client-specific quirks emerge from real incidents. Codify quickly.
"])
  (:field [historical-note/linked-quirks ["quirk:hilton-friday-peak"]]))

;; ... contacts and escalation steps follow similar pattern ...
```

This is the texture Tier 3 needs to have — narrative, specific, incident-grounded. The agent reads this to understand "how Hilton works" the way a senior CSM does.

### 12.5 Where each entity lives — and what the ETL does

**Two stores, no mirroring.** Operational and ontology are disjoint at the entity level. The ETL is unidirectional: operational → ontology. Workspaces edit ontology context only — they never write back to operational.

| Entity | In ontology? | In operational.db? | Notes |
|--------|--------------|---------------------|-------|
| **Knowledge anchors** (Country, Industry, Role, Skill) | ✅ ontology only | ❌ | Hand-authored as `define-record` blocks in `ontology/anchors.md`. Stable, rarely-changing. |
| **Operational entities** (Organization, Address, Location, Worker, WorkerCertification, Job, Shift, Booking, RateCard, plus the org-org relations) | ✅ synced from operational | ✅ source of truth | Operational seed creates them. ETL upserts triples into ontology. |
| **Tier 1 records** (CountryRule, CountryNarrative, …) | ✅ ontology only | ❌ | Hand-authored as `define-record` blocks. Edited by Compliance Workspace. |
| **Tier 2 records** (IndustryTerm, IndustryNorm, IndustryPlaybook, …) | ✅ ontology only | ❌ | Hand-authored. Edited by Industry Workspace. |
| **Tier 3 records** (ClientProfile, ClientQuirk, ClientContact, EscalationStep, ClientHistoricalNote, …) | ✅ ontology only | ❌ | Hand-authored. Edited by CSM Workspace. References operational client orgs by canonical ID. |
| **Tasks, Violations** | ✅ runtime-generated | ❌ | Created by ontology constraint engine. |
| **Pending changes** (proposals) | ✅ runtime-generated | ❌ | Written by `propose-*` mutations from agent or via workspace forms. |

**ID alignment — critical for constraint correctness.** Operational entities reference knowledge anchors by canonical string IDs. This is what makes constraints traversable across the operational/anchor boundary.

The anchor IDs are defined ONCE in `ontology/anchors.md`:

```lisp
(define-record "country:uk" Country (:field [country/code "GB"]) (:field [country/name "United Kingdom"]) ...)
(define-record "country:us" Country (:field [country/code "US"]) (:field [country/name "United States"]) ...)
(define-record "industry:hospitality" Industry (:field [industry/slug "hospitality"]) (:field [industry/name "Hospitality"]) ...)
(define-record "industry:industrial" Industry (:field [industry/slug "industrial"]) ...)
(define-record "role:bartender" Role (:field [role/name "Bartender"]) ...)
(define-record "skill:forklift-license" Skill (:field [skill/name "Forklift License"]) ...)
;; ... etc
```

The operational seed uses these EXACT IDs as foreign-key-like string columns:

```sql
-- operational.db
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, type TEXT,
                            country_id TEXT, industry_id TEXT, ...);
INSERT INTO organizations VALUES
  ('org:hilton-hotels-london', 'Hilton Hotels (London)', 'client',
   'country:uk', 'industry:hospitality', ...);

CREATE TABLE workers (id TEXT PRIMARY KEY, ..., home_country_id TEXT, ...);
INSERT INTO workers VALUES ('worker:alice', ..., 'country:uk', ...);

CREATE TABLE worker_certifications (..., skill_id TEXT, ...);
INSERT INTO worker_certifications VALUES (..., 'skill:forklift-license', ...);
```

The ETL preserves these references when asserting triples:

```
[org:hilton-hotels-london :org/country country:uk]
[org:hilton-hotels-london :org/industry industry:hospitality]
[worker:alice :worker/home-country country:uk]
[workercert:alice-forklift :workercert/skill skill:forklift-license]
```

Because `country:uk`, `industry:hospitality`, and `skill:forklift-license` already exist in ontology (from the anchor define-records), these triples are valid refs and constraints can traverse them:

```
Shift → Job → Location → ...  (operational entities, synced in)
                ↓
         Organization → Industry → IndustryNorm / IndustryPlaybook  (ontology anchor + Tier 2)
                ↓
              Country → CountryRule / CountryNarrative  (ontology anchor + Tier 1)
                ↓
         ClientProfile → ClientQuirk / EscalationStep  (Tier 3, references org by ID)
```

This is what makes Stephen's "hospitality/urgent-understaffed" constraint actually fire — every join in his Datalog finds a real triple, because the ETL sync produced them.

**Tier 3 → operational org link.** ClientProfile records also reference orgs by canonical ID:
```lisp
(define-record "client-profile:hilton-hotels-london" ClientProfile
  (:field [clientprofile/client-org "org:hilton-hotels-london"]) ...)
```
So once the ETL syncs the org in, the ClientProfile reference is live.

**ETL semantics.**
- One-way: operational → ontology
- Idempotent: re-running with no operational changes produces zero diff
- Upsert: existing entities update in place; new entities are added; entities deleted from operational are tombstoned in ontology (TBD per packet)
- Triggered manually for the demo (`pnpm sync`); cron/CDC in production

**What's NOT synced and has no operational counterpart:** Knowledge anchor RECORDS (Country/Industry/Role/Skill rows themselves) and Tier 1-3 records. Operational only stores the anchor IDs as strings on synced entities, never the anchor records themselves.

**What workspaces edit:** Tier 1, 2, 3 records only. Workspaces never edit operational entities — those come from the source system. (In production, workspaces would view client org info but edit only the ClientProfile / Tier 3 layer.)

### 12.6 Saved queries (~22 ontology Datalog + a few SQL recipes)

**Ontology queries (`define-query`)** — agent + workspace use:

`client-context-bundle`, `country-rule-lookup`, `industry-content`, `industry-term-definition`, `tasks-for-agent`, `pending-tasks-by-assignee`, `pending-changes-queue`, `pending-vocab-proposals`, `clients-list`, `clients-in-industry`, `country-rules-with-impact`, `violations-for-client`, `regional-violation-pattern`, `cross-tier-context-for-shift`, `find-understaffed-shifts`, `find-expiring-rate-cards`, `find-no-show-cluster-workers`, `client-overtime-trend`, `agency-confirmation-gaps`, `worker-reliability-score`, `expiring-worker-certifications`, `workers-booked-for-shift` (the aggregation that backs the derived `workers-booked`).

**Operational SQL recipes (in skill 3)** — for raw inspection / ETL validation, not primary agent work:
- `inspect-operational-shift` (drilldown on one shift's raw row)
- `validate-etl-sync-counts` (compare row counts before/after sync)
- `find-recent-edits-since` (what changed in operational since last sync)

### 12.7 Constraints (~10, native ontology)

**Stephen's 5 from his document, all implemented natively:**

1. `hospitality/urgent-understaffed` — upcoming shift <24h, workers-booked < workers-required, hospitality client
2. `agency-unconfirmed-soon` — `shift-allocated-to-agency` with `confirmed-at` null, shift starts <48h
3. `client-overtime-above-baseline` — weekly overtime > `baseline-overtime-hours-weekly` × 1.3, joins client profile
4. `worker-reliability-risk-imminent` — worker with ≥2 no-shows in 7 days has upcoming shift <24h
5. `rate-card-expired-with-active-shifts` — RateCard `effective-to` past, but active upcoming shifts use it

**Additional core constraints:**

6. `shift-understaffed` — generic, slower fuse (48h) for non-hospitality
7. `shift-missing-required-skill` — booking on a shift where the worker lacks a required skill
8. `worker-certification-expiring-soon` — cert expires in <14 days, worker has upcoming shifts needing it
9. `booking-needs-approval-stale` — completed >7 days ago, still needs_approval
10. `client/hilton-friday-peak-buffer` — seeded client-specific starter (more added via Wow 3 recursive flow)

Each constraint:
- Lives in `ontology/constraints.md`, `industry-overlays.md`, or `client-overlays.md`
- Generates tasks assigned to `:agent` when violated
- Has a `:message` template referencing tier context
- Has tier-aware joins (where applicable)

### 12.8 Mutations (~20, mixed style)

**Mutation style:**
- **`set-X`** for form/profile editing (whole replacement on save). Used by CSM, Industry, Compliance.
- **Granular per-item** for queue/inbox actions (per-item buttons). Used by Operations and the proposal-approval flows.

| Category | Mutations |
|----------|-----------|
| Agent-driven | `propose-constraint`, `propose-client-quirk`, `propose-vocab-term`, `resolve-agent-task` |
| CSM workspace | `create-client-org`, `set-client-profile`, `set-client-quirks`, `set-client-contacts`, `set-escalation-chain`, `archive-client-org` |
| Operations workspace | `approve-pending-change`, `reject-pending-change`, `acknowledge-violation`, `trigger-agent-on-violation` |
| Industry workspace | `set-industry-term`, `remove-industry-term` (approve/reject of vocab uses generic approve/reject) |
| Compliance workspace | `set-country-rule`, `remove-country-rule` (approve/reject of rule changes uses generic approve/reject) |

### 12.9 Workspaces, processes, tasks (summary)

- **Workspaces (4):** `csm`, `operations`, `industry-hospitality`, `compliance` (US + UK in two tabs)
- **Views (~17):** ~4 per workspace, each backed by saved queries, each wiring its action buttons to mutations
- **Processes (1-2):** `proposed-change-approval` (proposal → routed reviewer → approved → deployed via vcs OR rejected → notify), `agent-task-resolution` (task → agent processes → action logged → resolved → constraint re-evaluates)
- **Task types (4):** `agent-action-required`, `csm-review-required`, `industry-lead-review-required`, `compliance-review-required`

## 13. Packet Plan

14 packets across 4 phases. Phase A is fully vertical (each packet touches every layer thinly); later phases expand horizontally.

> **Note:** the original "PKT-001 walking skeleton" was completed during planning (repo at `workspace/indeed-agent-example/`, GitHub Release for the binary, smoke check verified). The numbering below picks up from there — what's listed as PKT-001 is the first packet that needs implementation work.

### Phase A — Vertical Foundation (5 packets)

Each touches every architectural layer. By PKT-005 the full pipeline works with toy content + the proactive loop.

- **PKT-001 — Single entity end-to-end.** One entity, one knowledge-anchor record, one saved query, one workspace, all wired through the running platform. Proves the ontology source → deploy → workspace pipeline works.
- **PKT-002 — All four tiers thin + one constraint.** One record per tier, one constraint that joins them.
- **PKT-003 — Operational DB + ETL + 3 skills (minimal).** `seed-operational.ts`, `sync-operational-to-ontology.ts`, all three skill bundles minimally populated.
- **PKT-004 — Agent invocation end-to-end (validates Wow 1).** Live test in fresh Codex/Claude Code session. Verify the agent chains skills correctly.
- **PKT-005 — Constraint-driven proactive loop (validates Wow 2).** First proactive scenario fires natively, agent processes task end-to-end.

### Phase B — Workspace Feature-Verticals (4 packets)

One per workspace — each packet builds the workspace + all its dependent ontology content (more entities, queries, constraints, records).

- **PKT-006 — CSM Workspace (full)** + 3 client profiles + Tier 3 fleshout
- **PKT-007 — Operations Workspace (full)** + governance queue + violation trend views
- **PKT-008 — Industry Lead Workspace (full)** + Hospitality depth + Industrial stub + overlay constraints
- **PKT-009 — Compliance Workspace (full)** + US + UK Tier 1 depth + impact views

### Phase C — Cross-Cutting (2 packets)

- **PKT-010 — Full operational seed + planted demo patterns** + ETL re-fire wow (validates Wow 5)
- **PKT-011 — Recursive mutation pattern** (agent proposes ontology updates, validates Wow 3)

### Phase D — Polish + Deliverable (3 packets)

- **PKT-012 — Skills content polish** (full references for skills 2 + 3, verify in both Codex and Claude Code)
- **PKT-013 — README + walkthrough** + 5-wow demo script
- **PKT-014 — End-to-end QA pass** (fresh-clone simulation, all wow moments reproduced, all workspace flows verified)

(Detailed packet specs in `harness/.harnessd/runs/build-ontology/spec/packets/`. Authored one at a time.)
