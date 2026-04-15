# harnessd upgrade TAD
## Planner-first, contract-driven, mostly-linear long-running harness

**Date:** 2026-03-25
**Audience:** coding agent implementing the next major version of `harnessd`
**Authoring intent:** this document should be executable as an implementation brief, not just an architecture memo.

---

## 1. Executive summary

This upgrade keeps the spirit of `harnessd` intact:

- an **overseer/orchestrator** remains the user-facing control plane
- the runtime remains **simple and inspectable**
- the harness is optimized for **fast planning**, **clean acceptance criteria**, **long-running resumability**, and **human-monitorable progress**
- the default execution model is **linear**, not project-wide massively parallel
- parallelism is allowed only as **micro-fanout inside the active builder packet**, and only when it speeds up localized work

The core architectural changes are:

1. Add a **planner phase** (implemented as an orchestrator mode, not a separate permanent actor).
2. Replace mutable markdown-only progress tracking with **JSON source-of-truth artifacts** plus rendered markdown views.
3. Add **multi-round contract negotiation** between builder and evaluator before implementation of every packet.
4. Make the **evaluator fully read-only** and structurally separate from implementation.
5. Split the current single loop into a durable **orchestrator + worker** model so status, pokes, and resume behavior remain responsive.
6. Add **packet-level contracts**, **scenario-based acceptance templates**, and **structured result envelopes**.
7. Add **session persistence**, **resume after interruption / rate limit**, and **file-backed status + inbox/outbox** for monitoring from Claude Code and tmux.
8. Add a **fake agent backend** and scenario fixtures so the harness itself can be tested without burning real model quota.

The end state should feel like:

- **simple** enough to understand from a few files
- **lovable** because it is observable and boring to operate
- **complete** enough to run unattended for long stretches and recover from interruptions
- **fast** because planning is lightweight and detailed acceptance is negotiated just-in-time
- **strict** because evaluator-driven acceptance is hard to game

---

## 2. Product goals

### Primary goals

1. **Fast, high-quality planning**
   - Turn a short user request into a clear product/technical spec quickly.
   - Keep planning high level and ambitious.
   - Avoid over-specifying low-level implementation too early.

2. **Strong, scenario-aware acceptance criteria**
   - Every packet must have explicit, testable acceptance.
   - Acceptance must vary by packet type (UI, backend, migration, refactor, long-running job, bugfix, etc.).
   - Acceptance must be machine-parsable and human-readable.

3. **Linear execution with selective speedups**
   - The project should generally move one packet at a time.
   - Parallelism should only exist inside the current packet when the builder can safely use it to go faster.

4. **Long-running resumability**
   - The harness must survive process restarts, session interruptions, and rate limits.
   - The current packet, current contract, and current role session must always be recoverable.

5. **Human-operable monitoring**
   - The user must be able to launch the harness, tail it, inspect status, and poke it from Claude Code or tmux.
   - `/loop` should help babysit the harness, but must not be the durable source of truth.

6. **Implementable and testable**
   - The harness itself must have deterministic tests and live smoke tests.
   - Core orchestration logic must be testable without real model calls.

### Secondary goals

- Keep the implementation understandable by one strong operator.
- Minimize framework complexity.
- Preserve the existing `run.sh` and `tail.sh` ergonomics.
- Keep shell + TypeScript + JSON as the dominant primitives.

---

## 3. Non-goals

These are explicitly out of scope for this upgrade:

- project-wide multi-lane parallel execution
- persistent multi-agent team backbone
- distributed queues / cloud workers / remote orchestration
- vector DB or retrieval memory system
- multi-account failover or account switching
- automatic PR creation
- channels as a required dependency
- full autonomous product management or user interviewing
- replacing the Agent SDK with a different runtime

---

## 4. Architectural decisions

### D1. Keep the orchestrator
The orchestrator remains the top-level control plane. It owns planning, packet selection, contract negotiation orchestration, worker launches, status rendering, pokes, retries, and resume logic.

### D2. Planner is a mode, not a permanent extra actor
To stay aligned with the current harness philosophy, planning is implemented as a **planner mode of the orchestrator**. Internally this may call a distinct prompt/worker role, but architecturally the user still experiences one overseer/orchestrator.

### D3. Execution unit is a packet
A **packet** is the smallest durable implementation unit. It is small enough to verify rigorously and large enough to matter. The run advances packet by packet.

### D4. Multi-round contract negotiation is mandatory
Before coding any packet, the builder and evaluator must negotiate a packet contract until it is accepted or escalated. This is not a single-pass suggestion step; it is a load-bearing control loop.

### D5. The runtime is mostly linear
At any moment there is one active packet in implementation. The harness does not schedule multiple independent packets in parallel.

### D6. Parallelism is only builder-side micro-fanout
The active builder may use:
- background bash tasks
- read-only research subagents
- draft-producing helper subagents
- test/log analysis helpers

But there is still only one canonical packet owner and one canonical repo writer: the main builder.

### D7. Builder is the only repo writer
Planner and evaluator are read-only with respect to the repository. The orchestrator persists their outputs. This sharply separates design, implementation, and judgment.

### D8. JSON is the mutable source of truth
Mutable state lives in JSON/JSONL artifacts. Human-friendly markdown is rendered from those artifacts. This avoids markdown drift and makes state validation straightforward.

### D9. Explicit structured result envelopes replace ad hoc markers
Keep sentinel markers because they are robust in logs, but put validated JSON inside them. This replaces the current done-marker + XML report pattern with a single structured envelope per worker.

### D10. The harness must be testable with a fake backend
All orchestration logic must be isolated from the live SDK transport behind an `AgentBackend` abstraction.

---

## 5. Source-grounded current-state assessment to guide migration

This section explains what the implementation must preserve and what it must fix.

### Preserve
- The repo already wants an **Overseer / Supervisor** above the implementation loop.
- The repo already wants **deep planning**, **pre-mortems**, **builder/verifier looping**, and **state persistence across sessions**.
- The current UX of **launch + tail** is good and should remain.

### Fix
- The current runtime is still basically **one file loop orchestration**.
- Prompt scaffolding still contains many **project-specific placeholders** and weakly structured quality gates.
- The current verifier/evaluator boundary is inconsistent and must be resolved.
- The current loop does not persist enough structured run state to support strong resume behavior.
- Monitoring is log-centric rather than status-centric.
- Acceptance is still too generic and too markdown-driven.

---

## 6. High-level architecture

### 6.1 Components

#### Orchestrator
Responsibilities:
- create / resume runs
- planner mode
- select next packet
- run contract negotiation loop
- launch builder worker
- launch evaluator worker
- update status artifacts
- handle pokes
- classify failures and retries
- handle resume / rate-limit backoff
- render human-readable status

#### Planner mode
Input:
- user objective
- repo context
- optional project config and prior run context

Output:
- `SPEC.md`
- `packets.json`
- `risk-register.json`
- `plan-summary.md`

#### Contract builder role
Input:
- selected packet
- spec
- risk register
- packet type template
- latest repo context

Output:
- `contract.proposal.rNN.json`

#### Contract evaluator role
Input:
- proposed contract
- spec
- packet type template
- risk register

Output:
- `contract.review.rNN.json`
- decision: `accept | revise | split | escalate`

#### Builder worker
Input:
- final packet contract
- repo
- current run state
- prior evaluator failures for this packet

Output:
- code changes
- packet self-check evidence
- `builder-report.json`
- structured final envelope

#### Evaluator worker
Input:
- final packet contract
- builder report
- repo current state

Output:
- `evaluator-report.json`
- pass/fail + required fixes
- structured final envelope

#### Status renderer
Input:
- run state + event log + worker heartbeats

Output:
- `status.json`
- `status.md`

#### Control channel
File-backed mechanism for:
- `poke`
- `pause`
- `resume`
- `summarize`
- `stop-after-current-packet`

---

## 7. Directory layout

### 7.1 Runtime artifacts

Create this under the project root (gitignored):

```text
.harnessd/
  runs/
    <run-id>/
      run.json
      status.json
      status.md
      events.jsonl
      spec/
        SPEC.md
        packets.json
        risk-register.json
        plan-summary.md
      packets/
        PKT-001/
          packet.json
          contract/
            proposal.r01.json
            review.r01.json
            proposal.r02.json
            review.r02.json
            final.json
          builder/
            session.json
            transcript.jsonl
            heartbeat.json
            builder-report.json
            result.json
            subagents/
              SG-001/
                brief.json
                result.json
              SG-002/
                brief.json
                result.json
            background/
              dev-server.json
              tests.json
          evaluator/
            session.json
            transcript.jsonl
            heartbeat.json
            evaluator-report.json
            result.json
      inbox/
        2026-03-25T10-12-00Z-poke.json
      outbox/
        2026-03-25T10-12-02Z-summary.md
        2026-03-25T11-03-15Z-alert-rate-limited.md
  project/
    config.json
    acceptance-templates/
      bugfix.json
      ui-feature.json
      backend-feature.json
      migration.json
      refactor.json
      long-job.json
      integration.json
```

### 7.2 Source code layout

Refactor the harness TypeScript into a small but real module structure:

```text
harness/
  src/
    main.ts
    orchestrator.ts
    worker.ts
    planner.ts
    contract-negotiator.ts
    packet-runner.ts
    evaluator-runner.ts
    state-store.ts
    status-renderer.ts
    event-log.ts
    schemas.ts
    templates.ts
    prompts.ts
    permissions.ts
    background-jobs.ts
    backend/
      types.ts
      claude-sdk.ts
      fake-backend.ts
    test/
      unit/
      scenarios/
      live/
  run.sh
  tail.sh
  status.sh
  poke.sh
  resume.sh
  tmux.sh
  package.json
```

### 7.3 Compatibility shim

Keep `wiggum-loop.ts` temporarily as a compatibility entry point that calls the new orchestrator and prints a deprecation note. Remove only after the new runtime is stable.

---

## 8. Data model

Use Zod schemas in `schemas.ts`. The JSON artifacts above must all be validated on write and read.

### 8.1 Run state

```ts
type RunPhase =
  | "planning"
  | "selecting_packet"
  | "negotiating_contract"
  | "building_packet"
  | "evaluating_packet"
  | "fixing_packet"
  | "rate_limited"
  | "paused"
  | "needs_human"
  | "completed"
  | "failed";

interface RunState {
  runId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  phase: RunPhase;
  currentPacketId: string | null;
  packetOrder: string[];
  completedPacketIds: string[];
  failedPacketIds: string[];
  blockedPacketIds: string[];
  currentWorkerRole: WorkerRole | null;
  currentWorkerSessionId: string | null;
  lastHeartbeatAt: string | null;
  rateLimitState: {
    status: "ok" | "suspected" | "confirmed";
    retryCount: number;
    nextRetryAt: string | null;
    lastError: string | null;
  };
  operatorFlags: {
    pauseAfterCurrentPacket: boolean;
    stopRequested: boolean;
  };
}
```

### 8.2 Packet

```ts
type PacketType =
  | "bugfix"
  | "ui_feature"
  | "backend_feature"
  | "migration"
  | "refactor"
  | "long_running_job"
  | "integration"
  | "tooling";

interface Packet {
  id: string;
  title: string;
  type: PacketType;
  objective: string;
  whyNow: string;
  dependencies: string[];
  status: "pending" | "negotiating" | "building" | "evaluating" | "fixing" | "done" | "blocked" | "failed";
  priority: number;
  estimatedSize: "S" | "M" | "L";
  risks: string[];
  notes: string[];
}
```

### 8.3 Contract

```ts
type CriterionKind =
  | "command"
  | "scenario"
  | "api"
  | "artifact"
  | "invariant"
  | "negative"
  | "observability"
  | "performance"
  | "rubric";

interface AcceptanceCriterion {
  id: string;
  kind: CriterionKind;
  description: string;
  blocking: boolean;
  threshold?: number;
  command?: string;
  expected?: string;
  scenario?: {
    tool: "playwright" | "bash" | "manual-script";
    steps: string[];
    expects: string[];
  };
  rubric?: {
    scale: "1-5";
    threshold: number;
    dimensions: string[];
  };
  evidenceRequired: string[];
}

interface PacketContract {
  packetId: string;
  round: number;
  status: "proposed" | "accepted" | "revise" | "split" | "escalate";
  title: string;
  packetType: PacketType;
  objective: string;
  inScope: string[];
  outOfScope: string[];
  assumptions: string[];
  risks: Array<{ id: string; description: string; mitigation: string }>;
  likelyFiles: string[];
  implementationPlan: string[];
  backgroundJobs: Array<{
    id: string;
    description: string;
    command: string;
    heartbeatExpected: boolean;
    completionSignal: string;
  }>;
  microFanoutPlan: Array<{
    id: string;
    kind: "research" | "draft" | "validate";
    brief: string;
    maxAgents: number;
    directRepoEditsAllowed: boolean;
  }>;
  acceptance: AcceptanceCriterion[];
  reviewChecklist: string[];
  proposedCommitMessage: string;
}
```

### 8.4 Contract review

```ts
interface ContractReview {
  packetId: string;
  round: number;
  decision: "accept" | "revise" | "split" | "escalate";
  scores: {
    scopeFit: number;
    testability: number;
    riskCoverage: number;
    clarity: number;
    specAlignment: number;
  };
  requiredChanges: string[];
  suggestedCriteriaAdditions: AcceptanceCriterion[];
  missingRisks: string[];
  rationale: string;
}
```

### 8.5 Builder report

```ts
interface BuilderReport {
  packetId: string;
  sessionId: string;
  changedFiles: string[];
  commandsRun: Array<{ command: string; exitCode: number; summary: string }>;
  backgroundJobs: Array<{ id: string; status: "running" | "completed" | "failed"; note: string }>;
  microFanoutUsed: Array<{ id: string; kind: string; summary: string }>;
  selfCheckResults: Array<{ criterionId: string; status: "pass" | "fail" | "unknown"; evidence: string }>;
  remainingConcerns: string[];
  claimsDone: boolean;
}
```

### 8.6 Evaluator report

```ts
interface EvaluatorReport {
  packetId: string;
  sessionId: string;
  overall: "pass" | "fail";
  hardFailures: Array<{
    criterionId: string;
    description: string;
    evidence: string;
    reproduction: string[];
  }>;
  rubricScores: Array<{
    criterionId: string;
    score: number;
    threshold: number;
    rationale: string;
  }>;
  missingEvidence: string[];
  nextActions: string[];
  contractGapDetected: boolean;
}
```

### 8.7 Worker result envelope

Every worker must end with a structured envelope delimited by sentinel markers:

```text
===HARNESSD_RESULT_START===
{ ... json ... }
===HARNESSD_RESULT_END===
```

The orchestrator extracts the JSON and validates it.

---

## 9. Planner design

### 9.1 Purpose

The planner takes a short objective and expands it into:

- a high-level spec
- a linear packet list
- a pre-mortem / risk register
- a first-pass acceptance-template assignment per packet

### 9.2 Important planner constraints

The planner must:

- stay at product + high-level technical design
- be ambitious about completeness
- not dictate overly detailed low-level implementation
- bias toward packets that are:
  - coherent
  - independently verifiable
  - ordered linearly
  - not too large

### 9.3 Planner output artifacts

#### `SPEC.md`

Sections:

1. Goal
2. User-visible outcomes
3. Core flows
4. Technical architecture assumptions
5. Non-goals
6. Risks / pre-mortem
7. Packet summary table

#### `packets.json`

Ordered packet list with packet types, dependencies, and rough size.

#### `risk-register.json`

Risk objects with mitigation suggestions and watchpoints for the evaluator.

#### `plan-summary.md`

Human summary optimized for quick review from Claude Code and `tail.sh`.

### 9.4 Planner prompt structure

The planner prompt must require:

- explicit separation between product outcomes and implementation guesses
- packetization
- risk identification
- suggested packet types
- suggested acceptance template names

### 9.5 Planner runtime configuration

Planner should run with:

- Claude Code system prompt preset
- project settings loaded
- read-only tools only
- no repo writes by the planner itself
- orchestrator writes artifacts based on planner result

---

## 10. Packet selection

The harness is linear, so packet selection should be simple.

### 10.1 Default rule

Pick the first packet in `packets.json` where:

- `status == pending`
- all dependencies are done

### 10.2 If blocked

If the first pending packet is blocked:

- mark it `blocked`
- move to the next dependency-satisfied packet
- if none exist, move run to `needs_human`

### 10.3 Replanning trigger

Run planner mode again only if:

- contract negotiation escalates
- evaluator reports repeated structural failures on the same packet
- the packet list is clearly invalidated by discovered repo reality

This preserves quick planning while allowing correction when needed.

---

## 11. Multi-round contract negotiation

This is the most important new feature.

### 11.1 Why it exists

The planner deliberately stays high-level. The contract loop bridges:

- high-level packet intent
- concrete, testable implementation scope
- scenario-specific acceptance criteria

### 11.2 Negotiation loop

For each packet:

1. Orchestrator loads packet + template.
2. Contract builder drafts `proposal.r01.json`.
3. Contract evaluator reviews and emits `review.r01.json`.
4. If accepted:
   - copy proposal to `final.json`
   - packet enters build phase
5. If revise:
   - builder receives the review and drafts `proposal.r02.json`
6. Repeat until:
   - accepted
   - or max rounds hit
   - or evaluator requests split/escalate

### 11.3 Required round behavior

This must be truly multi-round:

- `maxNegotiationRounds` default = 4
- `maxNegotiationRounds` for risky packets (`migration`, `integration`, `long_running_job`) default = 5
- if the evaluator requests `split`, the orchestrator may rewrite the current packet into two smaller packets and restart negotiation
- if the same unresolved issue appears in two consecutive reviews, the orchestrator escalates instead of looping forever

### 11.4 Contract acceptance conditions

A contract is not accepted unless all are true:

1. Objective is aligned with packet + spec.
2. Scope is explicit and bounded.
3. Out-of-scope is explicit.
4. Acceptance is specific and testable.
5. User-visible packets include at least one behavior/scenario criterion.
6. Risky packets include at least one negative/invariant criterion.
7. Long-running packets include heartbeat/completion verification.
8. Rubric criteria have thresholds.
9. Commands and evidence plans are reproducible.
10. The packet is small enough to finish in one builder cycle plus fix loops.

### 11.5 Contract linting

Implement a local contract linter before evaluator review:

- validate schema
- enforce required criterion counts by packet type
- fail missing `outOfScope`
- fail empty acceptance
- fail oversized likelyFiles set if packet size is `S`
- fail if `long_running_job` packet lacks observability criteria

If lint fails:

- do not spend model calls
- auto-return to builder with machine-generated lint errors

### 11.6 Contract negotiation outputs

The evaluator review must be structured. It should include:

- decision
- scores
- required changes
- missing risks
- suggested added criteria
- rationale

This makes the loop explainable and easy to inspect.

---

## 12. Acceptance criteria framework

### 12.1 Philosophy

Acceptance is the heart of this harness. The goal is not generic "looks good" review. The goal is a packet contract that can be judged through a mix of hard gates and selective rubrics.

### 12.2 Criterion classes

#### Hard deterministic

- commands that must pass
- exact exit code / output expectations
- typecheck, lint, unit tests, integration tests, migrations, CLI checks

#### Hard behavioral

- user or system flows
- browser interactions
- API flows
- database/state transitions
- long-running workflow completion

#### Hard invariants

- no TODO/STUB/FIXME in changed lines
- no new console errors
- no broken imports
- no dirty generated artifacts
- no unintended route regressions
- no secrets in git diff

#### Hard negative tests

- invalid input rejected correctly
- auth enforced
- rollback or failure path behaves correctly
- destructive operation guarded

#### Hard observability / operator checks

- heartbeat exists
- logs written
- completion artifact exists
- process can be stopped or resumed safely
- explicit completion signal

#### Rubric / scored criteria

- polish
- design quality
- originality
- code clarity
- operator ergonomics

Rubrics should be advisory unless the template says otherwise.

### 12.3 Packet-type templates

#### `bugfix`

Required:

- repro criterion
- after-fix criterion
- regression test criterion
- root-cause note

Optional:

- negative test
- docs change

#### `ui_feature`

Required:

- at least one interactive scenario
- no console errors invariant
- responsive or state-transition scenario if relevant
- design/polish rubric for user-visible packets

Optional:

- accessibility smoke
- keyboard interaction

#### `backend_feature`

Required:

- route / service command criterion
- integration scenario
- auth/error-path negative test if applicable
- schema / response invariant

Optional:

- performance criterion

#### `migration`

Required:

- forward migration pass
- data integrity check
- rollback or restore plan
- row-count or checksum evidence
- explicit out-of-scope / risk handling

Optional:

- dry-run criterion

#### `refactor`

Required:

- no-behavior-change command suite
- changed-file scope bounded
- performance non-regression if relevant
- code clarity rubric

Optional:

- simplification metric

#### `long_running_job`

Required:

- launch command
- heartbeat check
- artifact completion check
- failure log check
- resume / idempotency criterion

Optional:

- operator UX rubric

#### `integration`

Required:

- multi-component end-to-end scenario
- env/setup proof
- failure-path check
- cleanup check

Optional:

- performance criterion

### 12.4 Acceptance template storage

Store templates in JSON under `.harnessd/project/acceptance-templates/`.
The contract builder starts from the template, then specializes it. The evaluator critiques the specialization, not a blank page.

### 12.5 Example template fragment

```json
{
  "type": "long_running_job",
  "requiredCriterionKinds": [
    "command",
    "artifact",
    "observability",
    "negative"
  ],
  "defaultCriteria": [
    {
      "id": "launch-job",
      "kind": "command",
      "blocking": true,
      "description": "Job launches successfully and returns a PID or task identifier",
      "evidenceRequired": ["launch command", "pid/task id"]
    },
    {
      "id": "heartbeat",
      "kind": "observability",
      "blocking": true,
      "description": "Job emits heartbeat while running",
      "evidenceRequired": ["heartbeat timestamp", "log snippet"]
    },
    {
      "id": "artifact-complete",
      "kind": "artifact",
      "blocking": true,
      "description": "Expected output artifact exists and passes integrity checks",
      "evidenceRequired": ["file path", "size/hash/check"]
    }
  ]
}
```

---

## 13. Builder execution model

### 13.1 Role

The builder is the only repo writer and the owner of packet execution.

### 13.2 Builder inputs

- `contract/final.json`
- `SPEC.md`
- `risk-register.json`
- prior evaluator report for the same packet, if any
- project config

### 13.3 Builder obligations

The builder must:

1. read the final contract before touching code
2. implement only the accepted packet scope
3. use background jobs for long-running commands when useful
4. optionally use micro-fanout for localized speedups
5. run contract hard checks before claiming done
6. write `builder-report.json`
7. emit structured result envelope

### 13.4 Builder self-check

Before marking done, the builder must classify every acceptance criterion:

- `pass`
- `fail`
- `unknown`

If any blocking criterion is `fail` or `unknown`, the builder may not claim done.

### 13.5 Builder micro-fanout (the only parallelism)

#### Principle

Parallelism is local to the active packet. The builder can use it to accelerate localized work without turning the overall harness into a multi-lane scheduler.

#### Allowed micro-fanout modes

##### Research fanout

Use helper subagents to inspect different subsystems in parallel and return concise memos.

##### Draft fanout

Use helper subagents to produce patch proposals or implementation notes for independent files or subproblems.

##### Validation fanout

Use helper subagents to analyze logs, inspect failing tests, or compare outputs.

#### Hard rule

The main builder remains the **only canonical repo writer** in MVP.

That means helper subagents must:

- be read-only, or
- write only to packet-local artifact files under `.harnessd/runs/.../subagents/`

The builder then integrates their outputs into the actual repo serially.

#### Why this rule exists

This preserves:

- one writer
- zero merge-conflict orchestration
- packet-level linearity
- easier replay and debugging

#### Optional future mode (not MVP)

A later version can allow direct-edit helper subagents in isolated scratch trees, but that is intentionally deferred.

#### 13.5.1 Verification fanout mode

The validation-fanout pattern from §13.5 also applies to the four **verification roles** — evaluator, QA runner, plan reviewer, and contract evaluator — not just builders. Builders use fanout to parallelize implementation work; verifiers use it to parallelize independent verification aspects.

Each of the four verification roles receives a **Parallel Verification Fanout** prompt section (via `buildVerificationFanoutSection` in `prompts/shared.ts`) that guides the agent to launch up to 4 read-only `Task` sub-agents with `model="sonnet"` when the verification has distinct, separable facets that can be checked in parallel.

Key properties:
- Sub-agents launched by verifiers are strictly read-only (enforced by the existing `makeReadOnlyHook` and `sandboxMode: "read-only"`).
- The `Task` tool is now enabled for plan reviewer and contract evaluator (unblocked from `disallowedTools` in v5.4).
- **Codex-backed sessions** omit the fanout section entirely — `buildVerificationFanoutSection` returns `""` when `useClaudeBackend === false`, preventing Codex agents from attempting a tool that doesn't exist on their backend.

### 13.6 Background jobs

For long-running commands, the builder should use a background-job helper in the harness runtime.

Track for each job:

- command
- pid / task id
- start time
- log path
- heartbeat timestamp
- completion signal
- exit code

The builder may continue coding while jobs run, but may not mark the packet done without final evidence.

### 13.7 Commits

After evaluator pass, the builder (or orchestrator via a post-pass action) commits with the contract's proposed commit message.

Recommended format:
`harnessd(<packet-id>): <packet title>`

---

## 14. Evaluator design

### 14.1 Role

The evaluator is responsible for disconfirming completion and enforcing the packet contract.

### 14.2 Read-only guarantee

The evaluator must be unable to modify repo code.

Implementation rule:

- the evaluator agent gets only read-only tools
- the orchestrator persists evaluator outputs
- if the evaluator needs to "fix minor issues," that request must go into `nextActions`, not code edits

### 14.3 Evaluator inputs

- final packet contract
- builder report
- repo state
- risk register
- any packet-specific test tools or MCP integrations

### 14.4 Evaluator output

- pass/fail
- hard failures with evidence
- missing evidence
- rubric scores
- next actions
- whether the contract itself was incomplete (`contractGapDetected`)

### 14.5 If contract gap is found

If the evaluator discovers a failure caused by a missing or weak contract criterion:

- set `contractGapDetected = true`
- orchestrator sends the packet back to **contract negotiation**, not just a blind fix loop

This prevents the contract layer from degrading over time.

### 14.6 Fix loop policy

If evaluator fails the packet:

- feed the evaluator report back to the builder
- rerun builder on the same packet
- rerun evaluator
- default `maxFixLoopsPerPacket = 3`

If still failing after max fix loops:

- escalate or split packet

---

## 15. Permissions and tool policy

Implement permissions with a combination of:

- `systemPrompt: { type: "preset", preset: "claude_code" }`
- `tools` / `allowedTools`
- `disallowedTools`
- `canUseTool` for fine-grained bash policy

### 15.1 Planner permissions

Allow:

- `Read`, `Grep`, `Glob`, `LS`

Deny:

- repo writes
- mutating bash
- git mutation

### 15.2 Contract builder permissions

Allow:

- `Read`, `Grep`, `Glob`, `LS`

Deny:

- repo writes
- mutating bash
- git mutation

### 15.3 Contract evaluator permissions

Allow:

- `Read`, `Grep`, `Glob`, `LS`

Deny:

- repo writes
- mutating bash
- git mutation

### 15.4 Builder permissions

Allow:

- Claude Code default tools
- mutating bash subject to allowlist/denylist policy
- git add/commit for packet commits
- background bash
- subagents

Deny:

- dangerous destructive commands unless explicitly configured
- push/pull/fetch by default
- secret deletion / infrastructure destruction commands via custom denylist

### 15.5 Evaluator permissions

Allow:

- `Read`, `Grep`, `Glob`, `LS`, selected read-only `Bash`
- browser/test tooling as needed

Deny:

- `Write`, `Edit`, `MultiEdit`, `NotebookEdit`
- mutating bash
- mutating git
- package installation
- networked deploy commands

### 15.6 Read-only bash policy

For evaluator and planning roles, `Bash` is optional. If allowed, restrict to commands such as:

- `pwd`
- `ls`
- `find`
- `cat`
- `head`
- `tail`
- `grep`
- `sed -n`
- `awk`
- `jq`
- `git status`
- `git diff`
- `git log`
- `git show`
- test commands
- non-mutating build/test commands

Any command containing obvious mutations should be denied.

---

## 16. Session persistence and resume

### 16.1 Requirements

The harness must resume without re-planning or losing the active packet.

### 16.2 What to persist

Every worker session persists:

- session id
- role
- packet id
- prompt hash
- start/end time
- latest heartbeat
- worker transcript path
- result path
- last known state

### 16.3 How to capture session id

Capture the session id from the SDK init/system messages and write it immediately to `session.json`.

### 16.4 Resume states

A worker may be resumed from:

- process crash
- orchestrator restart
- rate limit
- user-requested pause

### 16.5 Resume strategy

- if the worker has a valid persisted session id, attempt `resume`
- if resume is not possible or the prior session is corrupted, restart the worker from the same packet phase with preserved artifacts
- planner is never rerun unless replanning is explicitly triggered

### 16.6 Rate-limit behavior

When a worker error is classified as a probable rate limit:

1. mark run phase `rate_limited`
2. write alert to `outbox/`
3. record `nextRetryAt`
4. backoff using configured retry schedule
5. retry `resume` on the same session id
6. if retries fail repeatedly, remain resumable and visible in status

### 16.7 Recommended defaults

```json
{
  "resumeBackoffMinutes": [5, 15, 30, 60],
  "maxConsecutiveResumeFailures": 8
}
```

---

## 17. Orchestrator responsiveness, status, pokes, and tmux

### 17.1 Why the orchestrator must be separate

The orchestrator must stay responsive while the active worker runs. Therefore:

- long model work belongs in worker sessions
- the orchestrator monitors them asynchronously
- status rendering continues even while a worker is active

### 17.2 Status files

Update `status.json` and `status.md` on:

- every phase transition
- every worker init
- every worker heartbeat
- every worker completion
- every poke
- every retry / rate-limit event

### 17.3 `status.md` format

Optimize for quick reading by humans and Claude Code.

Suggested sections:

1. run summary
2. current packet
3. current phase
4. contract status / round
5. current worker / session id / heartbeat age
6. background jobs
7. last evaluator result
8. alerts / needs human
9. next expected action

### 17.4 Inbox / outbox

#### Inbox

`poke.sh` writes JSON command objects into `inbox/`:

```json
{
  "type": "poke",
  "createdAt": "2026-03-25T10:12:00Z",
  "message": "Check whether the builder is stale and summarize progress"
}
```

#### Outbox

The orchestrator writes markdown or JSON responses into `outbox/`, such as:

- progress summaries
- stale warnings
- rate limit alerts
- needs-human escalations

### 17.5 `poke.sh`

Behavior:

- append a poke message to inbox
- touch a control timestamp
- print the latest status path

### 17.6 `status.sh`

Behavior:

- print `status.md`
- optionally `--json`
- optionally `--watch`

### 17.7 `tmux.sh`

Create a three-window session:

1. `orchestrator` -> `./run.sh`
2. `status` -> `./status.sh --watch`
3. `logs` -> `./tail.sh --master`

### 17.8 How `/loop` fits

`/loop` is for:

- checking `status.md`
- reading recent `events.jsonl`
- issuing `poke.sh` when stale
- alerting the user if the harness needs attention

`/loop` is not the durable scheduler and not the source of truth.

---

## 18. Prompt and output design

### 18.1 Keep prompts modular

Use one prompt-builder per role:

- planner
- contract builder
- contract evaluator
- builder
- evaluator

Each prompt should be generated from:

- project config
- packet data
- templates
- prior reports

### 18.2 Enforce structured final output

Each role prompt must instruct:

- think/work normally during execution
- final response must contain exactly one result envelope with JSON
- no trailing commentary after the end marker

### 18.3 Builder prompt sections

1. role
2. packet summary
3. final contract
4. repo writer rule
5. micro-fanout allowed patterns
6. background job policy
7. self-check requirements
8. output envelope schema

### 18.4 Evaluator prompt sections

1. role
2. skepticism stance
3. final contract
4. read-only rule
5. contract-gap detection rule
6. output envelope schema

### 18.5 Contract builder prompt sections

1. packet objective
2. packet template
3. spec excerpt
4. required contract fields
5. need to keep packet bounded
6. output envelope schema

### 18.6 Contract evaluator prompt sections

1. review stance
2. packet type expectations
3. risk coverage requirements
4. required output review schema
5. accept only if specific and testable

---

## 19. Structured event log

Write orchestrator-level events to `events.jsonl`.

Example events:

- `run.started`
- `planning.started`
- `planning.completed`
- `packet.selected`
- `contract.round.started`
- `contract.round.reviewed`
- `contract.accepted`
- `builder.started`
- `builder.heartbeat`
- `builder.background_job.started`
- `builder.background_job.completed`
- `builder.completed`
- `evaluator.started`
- `evaluator.failed`
- `evaluator.passed`
- `packet.done`
- `worker.rate_limited`
- `run.paused`
- `run.needs_human`
- `run.completed`

This log powers:

- status rendering
- debugging
- test assertions
- `/loop` babysitting

---

## 20. Implementation plan by PR

### PR 1 -- Baseline refactor + schemas

Goal: separate orchestration logic from current monolith and introduce validated state.

#### Changes

- add `src/` module structure
- add `schemas.ts`
- add `state-store.ts`
- add `event-log.ts`
- add `.harnessd/` runtime artifact conventions
- keep current `run.sh` / `tail.sh`

#### Verify

- unit tests for schema validation
- unit tests for read/write idempotence
- `./run.sh --sanity-check` still works via compatibility shim

### PR 2 -- Agent backend abstraction

Goal: make the harness testable without real model calls.

#### Changes

- add `backend/types.ts`
- add `backend/claude-sdk.ts`
- add `backend/fake-backend.ts`
- move raw SDK interaction behind backend interface
- capture session id, transcript path, worker result envelope

#### Verify

- fixture-based tests for normal worker completion
- fixture-based tests for invalid envelope handling
- fixture-based tests for session id capture

### PR 3 -- Planner mode

Goal: add real planning.

#### Changes

- add `planner.ts`
- add planner prompt
- write `SPEC.md`, `packets.json`, `risk-register.json`, `plan-summary.md`
- wire orchestrator startup to plan before packet execution

#### Verify

- fake-backend scenario: short prompt -> plan artifacts
- schema validation of packets and risks
- status shows planning phase then packet selection

### PR 4 -- Contract negotiation loop

Goal: add multi-round contract negotiation.

#### Changes

- add `contract-negotiator.ts`
- add contract builder + evaluator prompts
- add contract linter
- write proposal/review/final artifacts
- support revise/accept/split/escalate decisions

#### Verify

- scenario: accept in round 1
- scenario: revise twice then accept
- scenario: split packet and rewrite packet list
- scenario: escalate after repeated same issue

### PR 5 -- Builder packet runner

Goal: execute one packet against final contract.

#### Changes

- add `packet-runner.ts`
- add builder prompt
- add builder report generation
- add background job tracker
- add micro-fanout artifact plumbing

#### Verify

- fake scenario: build packet and emit builder report
- unit tests for background job state tracking
- unit tests for builder result parsing

### PR 6 -- Read-only evaluator

Goal: enforce strict evaluator boundary and packet pass/fail loop.

#### Changes

- add `evaluator-runner.ts`
- add evaluator prompt
- implement read-only tool policy
- implement contract-gap detection
- implement max fix loops policy

#### Verify

- unit test: evaluator role denied write/edit tools
- scenario: evaluator fails then builder fixes then evaluator passes
- scenario: evaluator flags contract gap and returns to negotiation

### PR 7 -- Status, poke, resume, tmux

Goal: make operation smooth.

#### Changes

- add `status-renderer.ts`
- add `status.sh`, `poke.sh`, `resume.sh`, `tmux.sh`
- add inbox/outbox handling
- add stale detection
- add rate-limit backoff + resume

#### Verify

- scenario: poke generates outbox summary
- scenario: stale worker marked visibly in status
- scenario: restart orchestrator resumes current packet
- manual smoke: tmux layout works

### PR 8 -- Test suite and live smoke

Goal: prove harness correctness.

#### Changes

- add scenario fixtures
- add live smoke tests guarded by env flag
- add npm scripts

#### Verify

- CI deterministic tests pass without model access
- live tests pass when enabled locally

### PR 9 -- Docs and cleanup

Goal: finish migration.

#### Changes

- update repo docs
- update `CLAUDE.md`
- document `/loop` usage
- deprecate old monolithic loop

#### Verify

- operator can follow docs end-to-end on a fresh clone

---

## 21. Harness verification strategy

This section defines how to verify the harness itself, not downstream project work.

### 21.1 Test layers

#### Layer A -- Unit tests

No model calls.
Cover:

- schemas
- event log writing
- status rendering
- contract linter
- permission policies
- background job tracking
- run-state transitions

#### Layer B -- Scenario tests with fake backend

Deterministic transcript fixtures.
Cover:

1. happy path
2. contract revise twice then accept
3. evaluator fail -> fix -> pass
4. contract gap -> renegotiation
5. rate-limit -> retry -> resume
6. stale worker -> poke -> summary
7. invalid worker JSON -> rerun once -> fail visibly

#### Layer C -- Local live smoke tests

Real Agent SDK calls, small budget.
Cover:

1. planner creates a tiny plan
2. one contract negotiation packet runs
3. one trivial builder packet runs
4. evaluator validates it
5. status and transcripts are persisted

### 21.2 Required deterministic scenarios

#### Scenario 1 -- planner-only

Input:

- fake prompt "add a hello-world endpoint and test"

Expected:

- spec files
- packet list
- status phase transitions

#### Scenario 2 -- negotiation multi-round

Expected:

- round 1 revise
- round 2 revise
- round 3 accept
- final contract exists

#### Scenario 3 -- builder/evaluator failure recovery

Expected:

- evaluator fail
- packet remains active
- builder reruns with evaluator report
- evaluator pass
- packet marked done

#### Scenario 4 -- contract gap

Expected:

- evaluator sets `contractGapDetected = true`
- packet goes back to contract negotiation
- not blindly back to builder fix loop

#### Scenario 5 -- rate limit

Expected:

- run enters `rate_limited`
- session id persisted
- `nextRetryAt` set
- resume attempted successfully from same packet

#### Scenario 6 -- stale worker and poke

Expected:

- stale flag shown
- poke file consumed
- outbox summary emitted
- status refreshed

### 21.3 Live smoke test policy

Live tests must:

- run against a tiny fixture repo
- set hard `maxTurns`
- use a low budget
- avoid destructive tools
- be opt-in only

Recommended env:

```bash
HARNESSD_LIVE=1 npm run test:live
```

---

## 22. Definition of done for this upgrade

The upgrade is complete only when all are true:

1. A short prompt can produce a valid `SPEC.md`, `packets.json`, and risk register.
2. The active packet cannot begin coding before a `contract/final.json` exists.
3. Contract negotiation supports at least 3 rounds in tests.
4. The evaluator is fully read-only in both prompt semantics and tool restrictions.
5. The runtime is mostly linear: only one packet is active in implementation at a time.
6. Builder micro-fanout exists only inside the active packet and the main builder remains the sole repo writer.
7. `status.md` and `status.json` are updated throughout the run.
8. `poke.sh` and `resume.sh` work.
9. A rate-limit/interruption scenario is resumable.
10. Deterministic scenario tests pass.
11. Live smoke tests pass locally.
12. Existing `run.sh` + `tail.sh` workflows still function.

---

## 23. Concrete defaults

Use these defaults unless the coding agent finds a strong reason not to.

```json
{
  "maxNegotiationRounds": 4,
  "maxNegotiationRoundsRisky": 5,
  "maxFixLoopsPerPacket": 3,
  "staleWorkerMinutes": 15,
  "heartbeatWriteSeconds": 20,
  "resumeBackoffMinutes": [5, 15, 30, 60],
  "allowBuilderMicroFanout": true,
  "maxBuilderMicroFanoutAgents": 3,
  "allowDirectEditSubagents": false,
  "renderStatusOnEveryEvent": true
}
```

---

## 24. Exact shell interfaces to add

### `./harness/run.sh`

Starts or resumes the orchestrator.

### `./harness/tail.sh`

Enhance current modes to support:

- `--master`
- `--status`
- `--packet PKT-001`
- `--builder`
- `--evaluator`
- `--events`

### `./harness/status.sh`

Print machine or human status.

Examples:

```bash
./harness/status.sh
./harness/status.sh --json
./harness/status.sh --watch
```

### `./harness/poke.sh`

Examples:

```bash
./harness/poke.sh "summarize current packet"
./harness/poke.sh "investigate stale heartbeat"
```

### `./harness/resume.sh`

Examples:

```bash
./harness/resume.sh
./harness/resume.sh --run-id <run-id>
```

### `./harness/tmux.sh`

Create the operator tmux layout.

---

## 25. Example `/loop` recipes for the operator

These are not part of harness code, but they should be documented in the repo.

### Progress babysitter

```text
/loop 5m Read .harnessd/runs/current/status.md and the latest events.jsonl entries.
Summarize progress in 5 bullets.
If the worker heartbeat is stale, run ./harness/poke.sh "check stale worker and summarize current blocker".
If the run is rate-limited or needs human input, tell me immediately.
```

### Log watcher

```text
/loop 10m Read status.md and the latest master/event logs.
Tell me whether the run is making forward progress, oscillating, or stuck.
```

### Completion watcher

```text
/loop 3m Check whether the current run phase is completed or failed.
If yes, summarize outcome and stop looping.
```

---

## 26. Implementation notes the coding agent should follow

1. **Prefer small files over giant files**, but do not explode into dozens of tiny abstractions.
2. **Keep all mutable state validated** with Zod.
3. **Write tests while introducing each module**, not at the end.
4. **Do not add project-wide parallel schedulers**.
5. **Do not let evaluator write repo code**.
6. **Do not let planner or contract roles mutate repo state**.
7. **Do not rely on markdown checkboxes as the canonical state**.
8. **Do not rely on `/loop` for durability**.
9. **Use compatibility shims** so current ergonomics keep working during migration.
10. **Bias for inspectability** over cleverness.

---

## 27. First implementation slice (recommended order inside PR 1)

If the coding agent wants an even smaller starting point, begin here:

1. Introduce `.harnessd/runs/<run-id>/run.json`, `status.json`, `events.jsonl`.
2. Add `AgentBackend` abstraction.
3. Capture `sessionId` from SDK init message and persist it.
4. Add structured result envelope extraction helper.
5. Add `status.sh`.
6. Refactor current verifier into a truly read-only evaluator.
7. Add planner mode.
8. Only after that, add full contract negotiation.

This order de-risks the whole upgrade.

---

## 28. Final recommendation

Build this upgrade around one simple truth:

> `harnessd` should not try to become a distributed agent system.
> It should become a disciplined, linear, contract-driven long-running coding harness with excellent state, excellent acceptance, and excellent operator ergonomics.

That is the version most likely to be:

- fast enough
- understandable enough
- recoverable enough
- pleasant enough to keep using
