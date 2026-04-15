---
name: contributing-to-harnessd
description: "Architecture, development workflow, testing patterns, CI/CD, and coding standards for contributing to the harnessd codebase itself. Use this skill whenever working on harnessd's own source — adding features, fixing bugs, writing or modifying tests in harness/test/, touching harness/src/, modifying prompts in prompts/, extending the orchestrator state machine, adding a new agent role, changing Zod schemas, working with FakeBackend, editing contract linter rules, or adjusting backend implementations (claude-sdk, codex-cli). Also trigger when the user asks how harnessd is built, how a particular harnessd module works internally, or how to add something to harnessd. Do NOT use this skill for operating harnessd runs as a user — that is the harnessd-operator skill. This skill is for developers modifying harnessd itself."
---

# Contributing to Harnessd

## What Harnessd Is

Harnessd is a contract-driven orchestrator for long-running autonomous AI agent tasks. It breaks complex objectives into small, verifiable packets — each with a negotiated contract, independent builder, adversarial evaluator, and automated quality gates.

```
USER OBJECTIVE
      |
      v
  PLANNER ──> PLAN REVIEWER (adversarial)
      |
      v  (operator approves)
  CONTRACT NEGOTIATOR (per packet)
      |  builder proposes, linter validates, evaluator reviews
      v
  BUILDER ──> TOOL GATES ──> EVALUATOR
      |           |               |
      |       fail: back      fail: back to builder
      |       to builder      contract gap: re-negotiate
      v
  QA RUNNER (holistic e2e)
      |
      v  fail: round 2+ fix packets
  COMPLETE
```

### Core design principles

1. **Contracts before code.** Every packet starts with explicit acceptance criteria negotiated before the builder writes a line.
2. **Adversarial verification.** The evaluator is a separate agent that disconfirms the builder's claims. It cannot write code.
3. **Runtime evidence > code review.** Scenario criteria require actual execution (curl, browser, dev server), not just reading source.
4. **Durable state.** Everything persists to `.harnessd/runs/`. Survives crashes, rate limits, machine restarts.
5. **Linear execution.** One packet at a time. Parallelism happens inside the builder via sub-agents.

---

## Development Setup

```bash
cd harness
npm install

# Run tests (281 tests, zero API calls)
npx vitest run

# Typecheck
npx tsc --noEmit

# Run a real harness (requires ANTHROPIC_API_KEY)
npx tsx src/main.ts --workspace /path/to/project "your objective"
```

### Key directories

```
harness/src/
  orchestrator.ts        # The main state machine (~2500 lines)
  schemas.ts             # All Zod schemas and types
  worker.ts              # Generic agent session runner
  state-store.ts         # .harnessd/ file management
  event-log.ts           # Append-only JSONL events

  planner.ts             # Planner mode
  plan-reviewer.ts       # Adversarial plan review
  contract-negotiator.ts # Multi-round negotiation
  contract-linter.ts     # Structural contract validation
  packet-runner.ts       # Builder execution
  evaluator-runner.ts    # Read-only evaluator
  tool-gates.ts          # Automated quality gates
  qa-runner.ts           # Holistic e2e QA
  round2-planner.ts      # Fix packets from QA findings

  prompts/               # Prompt builders per role (9 files)
  backend/               # AgentBackend abstraction
    types.ts             # AgentBackend + AgentSession interfaces
    claude-sdk.ts        # Real Claude SDK backend
    codex-cli.ts         # Codex CLI backend (GPT-5.4)
    backend-factory.ts   # Per-role backend selection
    fake-backend.ts      # Test double (zero quota)

  test/
    unit/                # 13 unit test files
    scenarios/           # 2 scenario test files
```

---

## Testing Patterns

All tests use `FakeBackend` — a deterministic test double that replays scripted messages with zero API calls. This is the backbone of the test suite.

### FakeBackend factory methods

```typescript
// Agent runs and emits a valid result envelope
const backend = FakeBackend.success(JSON.stringify({
  verdict: "pass",
  hardFailures: [],
}));

// Agent crashes with an error
const backend = FakeBackend.error("Rate limit exceeded");

// Full control over message sequence
const backend = FakeBackend.fromScript([
  { type: "text", text: "Working on it..." },
  { type: "text", text: "===HARNESSD_RESULT_START==={...}===HARNESSD_RESULT_END===" },
]);
```

### Asserting what was passed to agents

```typescript
expect(backend.calls).toHaveLength(1);
expect(backend.calls[0].prompt).toContain("acceptance criteria");
expect(backend.nudgeMessages).toHaveLength(0);
```

### Writing new tests

1. Identify the module you're testing (e.g., `evaluator-runner.ts`)
2. Create a `FakeBackend` with the scripted response
3. Call the runner function with the fake backend
4. Assert on the result AND on `backend.calls` (what the agent received)

Example from `contract-linter.test.ts`:
```typescript
it("scenario criterion with no runtime evidence fails", () => {
  const contract = makeContract({
    acceptance: [{
      id: "AC-001",
      kind: "scenario",
      evidenceRequired: ["code review"],  // no runtime evidence
    }],
  }, "backend_feature");

  const result = lintContract(contract, "backend_feature");
  expect(result.valid).toBe(false);
});
```

### Test utilities

- `makeContract(overrides, packetType)` — builds a valid contract with sensible defaults
- `makePacket(overrides)` — builds a valid packet
- `makeRunState(overrides)` — builds orchestrator run state
- `FakeBackend.success/error/fromScript` — agent simulation

---

## Architecture Deep Dive

### The orchestrator state machine

The orchestrator (`orchestrator.ts`) is a resilient phase machine. It loops forever, advancing through phases:

```
planning → plan_review → awaiting_plan_approval → selecting_packet →
negotiating_contract → building_packet → running_gates →
evaluating_packet → fixing_packet → qa_review → round2_planning →
completed / failed
```

Each phase reads `run.json`, does its work, writes updated state, and emits events. If the process crashes, it resumes from the persisted phase.

### The result envelope pattern

Every agent communicates via a structured JSON envelope wrapped in sentinel markers:

```
===HARNESSD_RESULT_START===
{ "verdict": "pass", "hardFailures": [], ... }
===HARNESSD_RESULT_END===
```

The `worker.ts` module extracts the envelope from agent output, parses it with the appropriate Zod schema, and returns a typed result. If parsing fails, the agent is retried.

### Backend abstraction

```typescript
interface AgentBackend {
  runSession(config: SessionConfig): AgentSession;
}

interface AgentSession {
  stream(): AsyncIterable<AgentMessage>;
  queueNudge(text: string): void;
  close(): void;
}
```

Three implementations:
- **ClaudeSdkBackend** — real Claude API via `@anthropic-ai/claude-agent-sdk`. Supports session resume, MCP tools.
- **CodexCliBackend** — shells out to `codex` CLI. Used for adversarial roles. No session resume.
- **FakeBackend** — deterministic replay for tests. Zero API calls.

### Contract linter

The contract linter (`contract-linter.ts`) validates contracts before burning evaluator model calls. It enforces structural rules:

1. Schema validates
2. Required criterion counts per packet type
3. outOfScope not empty
4. User-visible packets have behavior/scenario criteria
5. Risky packets have negative/invariant criteria
6. Reasonable likelyFiles count for packet size
7. Long-running jobs have observability criteria
8. Rubric criteria have proper thresholds
9. UX quality criteria for ui_feature packets
10. Runtime evidence required for scenario/api criteria

### Prompt architecture

Each role has a dedicated prompt builder in `prompts/`. Prompts are assembled from sections pushed onto an array, then joined. This makes them composable and testable.

Common patterns:
- `AUTONOMOUS_PREAMBLE` — shared "you are autonomous" instructions
- `buildValidateEnvelopeSection()` — mandatory envelope validation gate
- `buildDevServerSetupSection()` — dev server startup instructions
- Role-specific critical rules at the TOP of the prompt

---

## Git Workflow & CI

### Branch protection

`main` is protected:
- **Require PR** with passing status checks (typecheck + test)
- **Maintainers can bypass** for hotfixes
- **No force pushes** or branch deletion

### Version tags

Every merge to `main` is automatically tagged with a semver version:
- Default bump: `patch` (e.g., v2.3.1 → v2.3.2)
- Include `#minor` in PR title for minor bump (e.g., v2.3.2 → v2.4.0)
- Include `#major` in PR title for major bump (e.g., v2.4.0 → v3.0.0)

Tags are protected — no deletion or overwriting of `v*` tags.

### PR workflow

1. Create a feature branch from `main`
2. Make changes, ensure `npx vitest run` and `npx tsc --noEmit` pass locally
3. Push branch, open PR against `main`
4. CI runs automatically (typecheck + test)
5. Squash merge when CI passes
6. Auto-tag creates the version tag
7. Delete the feature branch

### Commit message style

Follow the existing pattern:
```
<type>: <short description>

<optional body with context>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

For version bumps, use the PR title:
- `feat: add parallel packet execution #minor`
- `fix: devServer nullish schema` (defaults to patch)
- `feat!: redesign contract schema #major`

---

## Coding Standards

### TypeScript

- Strict mode, no `any` unless absolutely necessary
- Zod schemas for all structured data (contracts, reports, events, config)
- Explicit return types on exported functions
- Prefer `readonly` arrays in type signatures

### Error handling

- Use try/catch at real boundaries (file I/O, API calls, JSON parsing)
- Use `readArtifact()` from `state-store.ts` for reading typed JSON files
- Agents must call `validate_envelope` before emitting results

### Prompts

- Each role has its own prompt file in `prompts/`
- Sections are pushed onto an array, joined at the end
- Critical rules go at the TOP of the prompt (agents pay most attention to the beginning)
- Always include the `AUTONOMOUS_PREAMBLE` and `buildValidateEnvelopeSection()`
- Never reference specific MCP tool names — describe WHAT to verify, not which tool to use

### Adding a new agent role

1. Define the result schema in `schemas.ts`
2. Create the runner in `src/` (follow `evaluator-runner.ts` as a template)
3. Create the prompt builder in `prompts/`
4. Add the role to `BackendFactory.forRole()` in `backend/backend-factory.ts`
5. Wire it into the orchestrator phase machine
6. Add `FakeBackend` tests

---

## Known Gotchas

1. **Inbox only reads `*.json`** — `.md` files in `inbox/` are silently ignored. Use `nudge.sh`.
2. **`permissionMode: "plan"` blocks ALL tools** — for read-only agents that need Read/Grep/Bash, use `"bypassPermissions"` with `disallowedTools`.
3. **`streamInput()` hangs from `setInterval`** — must be called from within the `for-await` loop consuming messages. Use `backend.queueNudge()` instead.
4. **Read-only agents try to write** — without explicit CRITICAL RULES saying "no writes, envelope only", agents default to using Write/Edit.
5. **All agents must `validate_envelope`** — Claude uses MCP tool, Codex uses `bin/validate-envelope.mts`. Without this, agents emit malformed JSON.
6. **Dirty data across QA rounds** — builders leave test artifacts. Multi-round QA can fail on stale data, not real bugs.
7. **`tsc --noEmit` at root gives false green** — use `tsc -b` for monorepo typechecks, or run from within the `harness/` directory.
