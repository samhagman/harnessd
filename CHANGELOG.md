# Changelog

All notable changes to Harnessd are documented in this file.

## [v2.2] - 2026-04-08

### Added
- **Session resume**: Native SDK session resume (`resume: sessionId`) for Claude agents — full context on crash recovery
- **Multi-round QA**: Holistic e2e browser testing after all R1 packets complete, with configurable `maxRounds` (default 10)
- **Round 2+ planning**: Targeted fix packets generated from QA findings with root cause verification
- **Tool gates**: Automated quality gates (typecheck, test) between builder and evaluator; custom gates configurable per-project
- **Codex CLI backend**: GPT-5.4 for adversarial evaluator/QA/contract-evaluator roles via `--codex-roles` flag
- **BackendFactory**: Per-role backend selection (Claude vs Codex vs Fake)
- **Plan review**: Adversarial plan review phase (Codex default), multi-round with configurable `maxPlanReviewRounds`
- **Completion summaries**: Cross-packet context propagation for builders and evaluators
- **Recovery agent**: Transcript summary fallback for Codex crash recovery (no session resume)
- **Contract-aware validate_envelope**: MCP tool (Claude) + CLI script (Codex) for pre-emit schema validation
- **nudge.sh**: Operator mid-session steering via JSON inbox
- **validate-envelope.mts**: CLI equivalent of MCP validate tool for Codex agents
- **DevServer config**: Pin frontend/backend ports to avoid collision between builder sessions
- **AGENTS.md**: Codex-equivalent project context file

### Changed
- Evaluator now requires `diagnosticHypothesis`, `filesInvolved`, and `rootCauseLayer` in failure reports
- Anti-rationalization rule prevents evaluator from dismissing unexpected state as "pre-existing"
- Builder receives workspace directory guidance, completion summaries, and context overrides
- Config defaults increased: `maxNegotiationRounds` 6 → 10, `maxFixLoopsPerPacket` 3 → 10
- All prompts updated with mandatory validate_envelope gate (top + bottom)
- Updated CLAUDE.md with full v2.2 architecture, commands, and configuration

### Validated
- Auth-identity run: ~75h, 11/11 R1 packets, 10 QA rounds, 8 harness bugs found and fixed
- Onlang-forms run: multi-packet UI build with QA
- 15+ end-to-end runs across various project types

---

## [v2.0] - 2026-03-27

### Added
- **Operator experience**: Live mid-session nudges via `Query.streamInput()`, hard pivot via `abortSession()`, cold reset
- **Modular orchestrator**: State machine with planning → contract negotiation → build → evaluate → fix loops
- **Contract negotiation**: Multi-round loop with builder, linter, and evaluator roles
- **Planner mode**: Read-only agent with web research, interactive interviews (`--interview`), and plan approval gate
- **Per-packet human review gates**: `requiresHumanReview` flag for sensitive packets
- **Organized transcripts**: Transcripts organized by packet and role
- **Inbox/outbox communication**: JSON-based operator control channel
- **Status rendering**: `status.json` + `status.md` with live updates
- **Shell scripts**: run.sh, status.sh, poke.sh, resume.sh, tmux.sh, tail.sh
- **FakeBackend**: Zero-quota test double for unit testing without API calls
- **Event log**: Append-only JSONL event stream for audit trail

### Architecture
- Orchestrator → Planner → Contract Negotiator → Builder → Evaluator → fix loops
- Result envelope pattern: `===HARNESSD_RESULT_START===` ... JSON ... `===HARNESSD_RESULT_END===`
- Role-based permissions: builders write, everyone else read-only
- `@anthropic-ai/claude-agent-sdk@0.2.83` with `zod@^4.0.0`

---

## [v1.0] - 2026-02-01

### Added
- Initial harness system for long-running Claude Code tasks
- Research report: 90+ source systematic review of AI agent harness patterns
- HARNESS-FAQ: 130 design questions
- HARNESS-BEST-PRACTICES: Core philosophy document
