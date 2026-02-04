# Harnessd Design FAQ

**Purpose:** Answer every critical question needed to build a production-grade AI agent harness.

**Status Legend:**
- `[x]` = Answered
- `[~]` = Partially answered
- `[ ]` = Not yet answered
- `★` = Starred (key question for how the agent works)

---

## Table of Contents

| # | Question | Status |
|---|----------|--------|
| **1. Identity & Purpose** | | |
| 1.1 | What is Harnessd's core mission? | [x] |
| 1.2 | Who is the target user? | [x] |
| 1.3 | What does "long-running" mean? | [x] |
| 1.4 | What types of tasks should Harnessd handle? | [x] |
| 1.5 | What are the non-goals? | [x] |
| **2. Architecture Pattern** | | |
| 2.1 | Single agent vs multi-agent: starting point? | [x] |
| 2.2 | Two-agent vs N-agent pattern? | [x] |
| 2.3 | Manager pattern vs decentralized handoffs? | [x] |
| 2.4 | What framework to use? | [x] |
| 2.5 | How does Overseer relate to Builder? | [x] |
| 2.6 | What's the execution model? | [x] |
| 2.7 | Where does the harness run? | [x] |
| 2.8 | How do we handle nested/sub-agent spawning? | [x] |
| **3. Agent Roles** | | |
| 3.1 | What exactly does the Overseer do? | [x] |
| 3.2 | What exactly does the Builder do? | [x] |
| 3.3 | What does the Verifier do? | [x] |
| 3.4 | Do we need a separate Planner agent? | [x] |
| 3.5 | Do we need a Debugger agent? | [x] |
| 3.6 | Do we need a Researcher agent? | [x] |
| 3.7 | What's each agent's tool access? | [ ] ★ |
| 3.8 | What are each agent's boundaries? | [~] ★ |
| 3.9 | How do agents communicate? | [x] |
| 3.10 | When does control transfer between agents? | [x] |
| **4. Context & Memory** | | |
| 4.1 | How do we treat context as a finite resource? | [ ] ★ |
| 4.2 | What's our compaction strategy? | [~] ★ |
| 4.3 | What's our note-taking system? | [~] ★ |
| 4.4 | How do we implement short-term memory? | [x] ★ |
| 4.5 | How do we implement long-term memory? | [~] ★ |
| 4.6 | How do we implement working memory? | [ ] ★ |
| 4.7 | Do we need a vector database? | [ ] ★ |
| 4.8 | How do we implement RAG? | [ ] ★ |
| 4.9 | Just-in-time context vs pre-retrieval? | [ ] ★ |
| 4.10 | How do we handle progressive disclosure? | [~] ★ |
| 4.11 | What's our memory cleanup policy? | [ ] ★ |
| 4.12 | How do we forward memories between sessions? | [~] ★ |
| **5. State Management** | | |
| 5.1 | What state must persist between sessions? | [~] ★ |
| 5.2 | How do we implement checkpointing? | [~] ★ |
| 5.3 | What does the feature_list.json look like? | [x] |
| 5.4 | What does the progress file look like? | [~] ★ |
| 5.5 | How do we track complete vs incomplete? | [x] |
| 5.6 | How do we ensure clean state between sessions? | [~] ★ |
| 5.7 | How do we detect/recover from dirty state? | [~] ★ |
| 5.8 | What's the git integration strategy? | [~] ★ |
| **6. Tool Design** | | |
| 6.1 | What are our core tools and how do we design them? | [~] ★ |
| 6.5 | Should tools be idempotent? | [ ] |
| 6.6 | What file system tools do we need? | [ ] |
| 6.7 | What browser/web tools do we need? | [ ] |
| 6.8 | What git tools do we need? | [ ] |
| 6.9 | What external service tools do we need? | [ ] |
| 6.10 | How do we handle tool versioning? | [ ] |
| **7. Prompt & Specification** | | |
| 7.1 | What's our system prompt structure? | [ ] |
| 7.2 | What are our six core specification areas? | [ ] |
| 7.3 | What are our three-tier boundaries? | [ ] |
| 7.4 | How do we handle the "right altitude"? | [ ] |
| 7.5 | How many examples (few-shot) do we include? | [ ] |
| 7.6 | How do we modularize large prompts? | [ ] |
| 7.7 | When do we stop iterating on prompts? | [ ] |
| 7.8 | What's the SPEC.md format? | [ ] |
| 7.9 | How do we handle prompt versioning? | [ ] |
| **8. Orchestration** | | |
| 8.1 | What's our main loop structure? | [ ] |
| 8.2 | What are our completion markers? | [ ] |
| 8.3 | How do we handle agent handoffs? | [ ] |
| 8.4 | What's the maximum loop iterations? | [ ] |
| 8.5 | What's the cooldown between iterations? | [ ] |
| 8.6 | How do we handle parallel agent execution? | [ ] |
| 8.7 | What's the escalation path when stuck? | [ ] |
| **9. Testing & Evaluation** | | |
| 9.1 | What's our simulation testing approach? | [ ] |
| 9.2 | What's our adversarial testing approach? | [ ] |
| 9.3 | What's our continuous evaluation approach? | [ ] |
| 9.4 | What's our human-in-the-loop testing? | [ ] |
| 9.5 | What are our key metrics? | [ ] |
| 9.6 | What are our smoke tests? | [ ] |
| 9.7 | What are our quality gates? | [ ] |
| 9.8 | How do we handle non-determinism? | [ ] |
| 9.9 | How do we evaluate agent reasoning quality? | [ ] |
| 9.10 | What's our pre-mortem process? | [ ] |
| **10. Error Handling** | | |
| 10.1 | How do we implement exponential backoff? | [ ] |
| 10.2 | How do we implement jitter? | [ ] |
| 10.3 | How do we implement circuit breakers? | [ ] |
| 10.4 | How do we classify errors? | [ ] |
| 10.5 | How do we implement semantic fallback? | [ ] |
| 10.6 | How do we validate structured outputs? | [ ] |
| 10.7 | How do we resume from failed state? | [ ] |
| 10.8 | What's our self-healing strategy? | [ ] |
| **11. Observability** | | |
| 11.1 | What do we trace? | [ ] |
| 11.2 | What metadata do we track? | [ ] |
| 11.3 | What's our logging strategy? | [ ] |
| 11.4 | How do we monitor costs? | [ ] |
| 11.5 | What tracing framework do we use? | [ ] |
| 11.6 | How do we enable replay for debugging? | [ ] |
| 11.7 | How do we implement rollback? | [ ] |
| **12. Security & Governance** | | |
| 12.1 | How do we implement least-privilege? | [ ] |
| 12.2 | What are our hard security boundaries? | [ ] |
| 12.3 | How do we maintain audit trails? | [ ] |
| 12.4 | When do we require human approval? | [ ] |
| 12.5 | How do we handle sensitive data? | [ ] |
| 12.6 | What compliance requirements apply? | [ ] |
| **13. Session Continuity** | | |
| 13.1 | What does the initializer do? | [ ] |
| 13.2 | What does the orientation phase look like? | [ ] |
| 13.3 | What does the execution phase look like? | [ ] |
| 13.4 | How do we prevent premature victory? | [ ] |
| 13.5 | How do we handle session crashes? | [ ] |
| 13.6 | What makes sessions resumable? | [ ] |
| 13.7 | How does init.sh work? | [ ] |
| 13.8 | What's in claude-progress.txt? | [ ] |
| 13.9 | How do we prevent context exhaustion? | [ ] |
| **14. Skills & Learning** | | |
| 14.1 | What are "skills" in the agent context? | [ ] |
| 14.2 | How do agents create their own skills? | [ ] |
| 14.3 | How do we inject skills into the loop? | [ ] |
| 14.4 | How do agents learn over time? | [ ] |
| 14.5 | How do we implement "desire paths"? | [ ] |
| 14.6 | How do we transfer learning across domains? | [ ] |
| 14.7 | What's "vibe engineering"? | [ ] |
| 14.8 | How do we version and manage skills? | [ ] |
| **15. Human-in-the-Loop** | | |
| 15.1 | When should the human be consulted? | [ ] |
| 15.2 | How do we present information to humans? | [ ] |
| 15.3 | How do humans provide feedback? | [ ] |
| 15.4 | How do we minimize interruptions? | [ ] |
| 15.5 | How do we handle human response delays? | [ ] |
| 15.6 | How do we learn from human interventions? | [ ] |
| **16. Production Operations** | | |
| 16.1 | What's the production readiness checklist? | [ ] |
| 16.2 | How do we handle model selection? | [ ] |
| 16.3 | How do we scale the harness? | [ ] |
| 16.4 | How do we monitor in production? | [ ] |
| 16.5 | How do we handle rate limiting? | [ ] |
| 16.6 | What's the disaster recovery plan? | [ ] |
| 16.7 | How do we deprecate and migrate? | [ ] |

**Progress: 25/130 answered**

---

## Quick Navigation

| Section | Questions | Status |
|---------|-----------|--------|
| [1. Identity & Purpose](#1-identity--purpose) | 5 | [ ] |
| [2. Architecture Pattern](#2-architecture-pattern) | 8 | [ ] |
| [3. Agent Roles](#3-agent-roles) | 10 | [ ] |
| [4. Context & Memory](#4-context--memory) | 12 | [ ] |
| [5. State Management](#5-state-management) | 8 | [ ] |
| [6. Tool Design](#6-tool-design) | 10 | [ ] |
| [7. Prompt & Specification](#7-prompt--specification) | 9 | [ ] |
| [8. Orchestration](#8-orchestration) | 7 | [ ] |
| [9. Testing & Evaluation](#9-testing--evaluation) | 10 | [ ] |
| [10. Error Handling](#10-error-handling) | 8 | [ ] |
| [11. Observability](#11-observability) | 7 | [ ] |
| [12. Security & Governance](#12-security--governance) | 6 | [ ] |
| [13. Session Continuity](#13-session-continuity) | 9 | [ ] |
| [14. Skills & Learning](#14-skills--learning) | 8 | [ ] |
| [15. Human-in-the-Loop](#15-human-in-the-loop) | 6 | [ ] |
| [16. Production Operations](#16-production-operations) | 7 | [ ] |

**Total Questions: 130**

---

## 1. Identity & Purpose

### 1.1 What is Harnessd's core mission? [x]
_What problem does Harnessd solve that existing tools don't?_

**Answer:**

Harnessd enables Claude Code to autonomously complete complex tasks that require long-running code sessions spanning multiple days and context windows.

Current AI coding tools (Claude Code, Cursor, Copilot) excel at single-session tasks but fail at long-running work because:

1. **Sessions are amnesiac** — Each new context window starts fresh with no memory of previous work
2. **No verification loop** — Agents declare victory without proper validation
3. **No state continuity** — Progress is lost between sessions; resumption requires manual context restoration
4. **No learning** — Same mistakes repeat; no skill accumulation over time
5. **No guardrails** — Unchecked autonomy leads to runaway errors

**One-liner:** Harnessd turns a brilliant-but-forgetful single-session tool into a reliable multi-day autonomous worker that verifies its own work and thinks two steps ahead.

**Research Links:**
- Anthropic: "The core challenge of long-running agents is that they must work in discrete sessions, and each new session begins with no memory of what came before."

---

### 1.2 Who is the target user? [x]
_Developer? Team? What skill level? What use cases?_

**Answer:**

**Primary user:** Developers who use Claude Code and want to delegate complex, multi-day coding tasks while maintaining oversight.

**Profile:**
- Comfortable with CLI tools and Claude Code
- Has projects too large for a single session
- Wants to "set direction and check back" rather than babysit every step
- Values verification and correctness over speed

**Skill level:** Intermediate to advanced. The user needs to:
- Write clear project plans (CLAUDE.md format)
- Understand when the harness needs guidance vs. can run autonomously
- Debug when things go wrong (read logs, interpret verifier reports)

**Use cases:**
- Building full-stack applications from a spec
- Large refactoring across many files
- Multi-phase projects with dependencies between phases
- Any task where "I wish I could tell Claude to do this overnight and check in tomorrow"

**Not the target user:**
- Beginners who need hand-holding through code
- Quick one-off tasks (just use Claude Code directly)
- Teams needing real-time collaboration (this is async/autonomous)

**Research Links:**
- Anthropic two-agent pattern targets "building web applications from high-level prompts"

---

### 1.3 What does "long-running" mean for Harnessd? [x]
_Hours? Days? Weeks? What's the target duration?_

**Answer:**

**"Long-running" = exceeds a single context window.**

The defining characteristic isn't wall-clock time — it's that the task cannot complete before the agent loses context and must start a fresh session.

**Practical ranges:**

| Duration | Example | Harnessd Role |
|----------|---------|---------------|
| < 1 hour | Fix a bug, add a feature | Overkill — just use Claude Code |
| 1-8 hours | Build a component, refactor a module | Sweet spot — multiple sessions, same day |
| 1-3 days | Full-stack app from spec, major migration | Primary target — overnight runs, check in morning |
| 1+ weeks | Large system build, multi-phase project | Supported — phased execution with persistent state |

**The real metric:** Number of context windows required, not hours.

A fast typist with a simple task might hit context limits in 2 hours. A complex reasoning task might exhaust context in 30 minutes. Harnessd cares about session boundaries, not the clock.

**Target sweet spot:** Tasks that take 2-10 sessions to complete (roughly 1-3 days of autonomous work).

**Research Links:**
- Anthropic: "tasks spanning hours or days"
- Two-agent pattern designed for tasks that can't complete in a single session

---

### 1.4 What types of tasks should Harnessd handle? [x]
_Full-stack apps? Data pipelines? Research? All of the above?_

**Answer:**

**Tasks with verifiable outputs and decomposable phases.**

The Builder→Verifier loop requires concrete completion criteria. If the verifier can't objectively check "is this done?", the feedback loop breaks.

**Well-suited tasks:**

| Task Type | Why It Works |
|-----------|--------------|
| **Full-stack apps** | Tests pass, UI renders, endpoints respond — all verifiable |
| **Data pipelines** | Outputs exist, schemas match, transformations validate |
| **Large refactoring** | Tests still pass, types check, behavior unchanged |
| **API integrations** | Endpoints callable, responses match expected format |
| **Migration projects** | Old→new works, data integrity checks pass |
| **Test suite creation** | Coverage metrics, tests execute, assertions meaningful |

**Poorly-suited tasks:**

| Task Type | Why It Struggles |
|-----------|------------------|
| **Pure research** | No concrete "done" — verifier can't validate insights |
| **Creative writing** | Subjective quality — no objective completion criteria |
| **Exploratory prototyping** | Goals shift mid-task — hard to write stable quality gates |
| **Highly interactive work** | Requires constant human feedback — defeats autonomy |

**The litmus test:** Can you write a smoke test for it? If yes, Harnessd can handle it. If no, it's probably not a good fit.

**Primary focus:** Code-producing tasks with testable outputs.

**Research Links:**
- Anthropic used Puppeteer for browser automation to verify features actually work
- "Without explicit prompting to test as a human user would, Claude tended to mark features complete without proper validation"

---

### 1.5 What are the non-goals? [x]
_What should Harnessd explicitly NOT try to do?_

**Answer:**

**Harnessd is deliberately narrow. These are explicit non-goals:**

| Non-Goal | Why Not |
|----------|---------|
| **Replace Claude Code** | We wrap it, not replace it. Claude Code is the engine; Harnessd is the chassis. |
| **Real-time collaboration** | This is async/autonomous. If you need live pairing, just use Claude Code directly. |
| **100% hands-off autonomy** | User writes plans, reviews verifier reports, intervenes when stuck. It's supervised autonomy, not AGI. |
| **GUI or visual interface** | CLI-first. Logs are tail-able JSONL. No dashboards, no web UI. |
| **Team coordination** | Single developer, single harness. No multi-user state, no shared sessions. |
| **Quick tasks** | If it fits in one session, Harnessd adds overhead without benefit. |
| **General AI assistant** | This is for code-producing tasks. Not chat, not research, not creative writing. |
| **Model training/fine-tuning** | We use Claude as-is. No custom models, no LoRA, no fine-tuning. |
| **Guaranteeing success** | Harnessd improves reliability, not perfection. Complex tasks still fail sometimes. |

**The philosophy:** Do one thing well. Harnessd handles long-running autonomous coding with verification. Everything else is out of scope.

**Research Links:**
- Research report warns against over-engineering
- "Maximize single-agent before multi-agent" = stay focused

---

## 2. Architecture Pattern

### 2.1 Single agent vs multi-agent: What's our starting point? [x]
_Research says "maximize single-agent before multi-agent." When do we cross that line?_

**Answer:**

**Three agents from the start: Overseer + Builder + Verifier.**

This isn't optional complexity — it's the minimum architecture for supervised autonomy with self-verification.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│    USER                                                         │
│      ▲                                                          │
│      │                                                          │
│      ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐    │
│  │                    OVERSEER                             │    │
│  │  • Interviews user to extract project details           │    │
│  │  • Drafts & refines project plan                        │    │
│  │  • Ensures plan is complete enough for execution        │    │
│  │  • Monitors builder/verifier loop                       │    │
│  │  • Adjusts prompts, memory, skills if loop struggles    │    │
│  │  • Answers "how's progress?" / "what decisions?"        │    │
│  │  • Thinks ahead to ensure project success               │    │
│  └────────────────────────┬───────────────────────────────┘    │
│                           │                                     │
│                           ▼                                     │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              HARNESS (autonomous)                       │    │
│  │                                                         │    │
│  │      ┌──────────┐         ┌──────────┐                 │    │
│  │      │ BUILDER  │────────▶│ VERIFIER │                 │    │
│  │      └──────────┘         └────┬─────┘                 │    │
│  │           ▲                    │                        │    │
│  │           └────────────────────┘                        │    │
│  │                                                         │    │
│  │      Human doesn't touch this. Overseer controls it.    │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Two loops:**

| Loop | Participants | Nature |
|------|--------------|--------|
| **Outer loop** | User ↔ Overseer | Interactive chat. User talks to Overseer to plan, monitor, adjust. |
| **Inner loop** | Builder ↔ Verifier | Autonomous execution. Overseer controls; human doesn't touch directly. |

**Overseer responsibilities:**
1. Interview user → extract project requirements
2. Draft project plan detailed enough for Builder/Verifier
3. Start and monitor the inner loop
4. Adjust loop parameters if it's not converging (prompts, memory, skills)
5. Report progress and decisions to user
6. Think two steps ahead to ensure success

**Research Links:**
- Anthropic two-agent pattern: initializer + coding agent
- Existing wiggum-loop: builder + verifier
- User's architecture adds Overseer as supervisory layer

---

### 2.2 Two-agent vs N-agent pattern? [x]
_Anthropic uses initializer+coding. Do we need more roles (verifier, planner, debugger)?_

**Answer:**

**Three agents. Overseer + Builder + Verifier. No more.**

Anthropic's two-agent pattern (initializer + coding) solves session continuity. Harnessd extends this with a third agent (Overseer) for supervision and plan management. But we stop at three.

```
┌────────────────────────────────────────────────────────────────┐
│  ROLE CONSOLIDATION                                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Planner?     → Overseer handles this (interviews, drafts)     │
│  Debugger?    → Builder handles this (fix and retry)           │
│  Researcher?  → Builder handles this (uses tools to explore)   │
│  Reviewer?    → Verifier handles this (validates work)         │
│                                                                │
│  Three agents cover all roles. More agents = more overhead.    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Why three is the right number:**

| Agent | Primary Role | Also Handles |
|-------|--------------|--------------|
| **Overseer** | Supervision, plan management | Planning, user communication, loop adjustment |
| **Builder** | Implementation | Debugging, research, problem-solving |
| **Verifier** | Validation | Review, quality checks, report generation |

**What we're NOT adding:**
- Separate Planner agent — Overseer does planning
- Separate Debugger agent — Builder debugs its own failures
- Separate Researcher agent — Builder uses tools to find information
- Separate Reviewer agent — Verifier is the reviewer

**The principle:** Each agent should be capable within its domain. Specialization through separate agents adds coordination overhead. Keep it simple.

**Research Links:**
- Anthropic two-agent pattern: initializer + coding agent
- Research warns against over-splitting: coordination overhead is real

---

### 2.3 Manager pattern vs decentralized handoffs? [x]
_Central coordinator or peer-to-peer agent handoffs?_

**Answer:**

**Manager pattern. Overseer is the central coordinator.**

The research describes two orchestration patterns:
- **Manager**: Central agent coordinates others via tool calls, synthesizes outputs
- **Decentralized**: Agents hand off control directly to peers

Harnessd uses Manager pattern because Overseer needs to maintain control and visibility over the entire system.

```
┌────────────────────────────────────────────────────────────────┐
│  MANAGER PATTERN (What Harnessd Uses)                          │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│                      OVERSEER                                  │
│                    (coordinator)                               │
│                    /          \                                │
│                   ▼            ▼                               │
│              BUILDER ──────▶ VERIFIER                          │
│                   ▲            │                               │
│                   └────────────┘                               │
│                                                                │
│  Overseer controls who runs, when, with what parameters.       │
│  Builder and Verifier don't decide to hand off to each other.  │
│  The harness loop (controlled by Overseer) manages transitions.│
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Why Manager pattern:**

| Benefit | How It Helps |
|---------|--------------|
| **Central visibility** | Overseer sees everything — can report to user, detect problems |
| **Controlled transitions** | Overseer decides when Builder→Verifier happens, not the agents |
| **Adjustability** | Overseer can change prompts, skills, parameters without agents knowing |
| **User interface** | Single point of contact (Overseer) for user queries |

**Builder and Verifier are NOT peers.** They don't negotiate handoffs. The harness loop runs them in sequence, and Overseer controls that loop.

**Research Links:**
- OpenAI: Manager pattern "for workflows requiring unified control and response synthesis"
- Decentralized pattern better for domain transitions where specialists take over completely

---

### 2.4 What framework should Harnessd use (or build on)? [x]
_CrewAI, LangGraph, AutoGen, Swarm, or custom?_

**Answer:**

**Custom, built on `@anthropic-ai/claude-agent-sdk`.**

We don't adopt a heavy framework. We build our own orchestration using Claude's official SDK as the foundation.

```
┌────────────────────────────────────────────────────────────────┐
│  FRAMEWORK DECISION                                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  @anthropic-ai/claude-agent-sdk                          │ │
│  │  (Foundation - direct Claude access, hooks, streaming)   │ │
│  └──────────────────────────────────────────────────────────┘ │
│                           │                                    │
│                           ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Harnessd Custom Orchestration                           │ │
│  │  (Overseer, Builder, Verifier, memory, skills)           │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  We own the orchestration layer. SDK handles Claude comms.     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

With the claude-agent-sdk, we get full control over the harness and the agents.

**What we build ourselves:**
- Overseer agent and its control logic
- Memory systems (short-term, long-term, working)
- Skills injection mechanism
- Loop monitoring and adjustment
- State persistence between sessions

**Research Links:**
- Existing wiggum-loop.ts already uses claude-agent-sdk successfully
- SDK provides hooks system for guardrails (PreToolUse)

---

### 2.5 How does the Overseer relate to the Builder? [x]
_What's the communication protocol? Shared memory? Message passing?_

**Answer:**

**Overseer steers by pointing, not by chatting.**

Overseer controls Builder primarily through the plan, prompts, and workspace setup. During execution, Overseer can interrupt or alert — but these are one-way signals, not conversations.

```
┌────────────────────────────────────────────────────────────────┐
│  OVERSEER → BUILDER RELATIONSHIP                               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  BEFORE EXECUTION:                                             │
│  ┌──────────┐                                                  │
│  │ Overseer │──writes──▶ Project plan                          │
│  └──────────┘──sets────▶ Builder prompt                        │
│              ──sets────▶ Skills to inject                      │
│              ──sets────▶ Memory context to forward             │
│              ──sets────▶ Workspace environment                 │
│                                                                │
│  Goal: Remove all obstacles so Builder can just execute.       │
│                                                                │
│  DURING EXECUTION:                                             │
│  ┌──────────┐                                                  │
│  │ Overseer │──alerts──▶ "New info saved" (one-way push)       │
│  └──────────┘──can────▶ Stop/restart to pick up changes        │
│              ──can────▶ Interrupt on user's behalf             │
│                                                                │
│  NOT chatting. NOT micromanaging. Pointing, alerting.          │
│                                                                │
│  ┌──────────┐                                                  │
│  │ Builder  │──reads───▶ Project plan                          │
│  └──────────┘──reads───▶ Forwarded memories                    │
│              ──writes──▶ Progress, git commits                 │
│                                                                │
│  Builder doesn't respond to alerts. Just absorbs and continues.│
│                                                                │
│  AFTER EXECUTION:                                              │
│  ┌──────────┐                                                  │
│  │ Overseer │──reads───▶ Progress file                         │
│  └──────────┘──reads───▶ Verifier reports                      │
│              ──reads───▶ Git log / diffs                       │
│              ──decides─▶ Adjust and re-run, or done            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Steering mechanisms:**

| Method | When | Purpose |
|--------|------|---------|
| **Shared files** | Primary | Written decisions Builder reads on next iteration |
| **One-way alerts** | During run | Notify Builder of new info without expecting response |
| **Stop/restart** | When needed | Force Builder to pick up file changes |
| **Interrupt** | On user request | User asks Overseer to steer, Overseer intervenes |

**The principle:** Overseer's job is to set up the workspace so perfectly that Builder can just execute. Steering happens by pointing it in a new direction or alerting it to new information — not by having a dialogue.

**Research Links:**
- Manager pattern: coordinator controls through configuration, not conversation

---

### 2.6 What's the execution model? [x]
_Synchronous? Async? Event-driven? Polling?_

**Answer:**

**Async with event-driven Overseer monitoring.**

The inner loop (Builder→Verifier) runs asynchronously. Overseer monitors via events and can intervene when needed.

```
┌────────────────────────────────────────────────────────────────┐
│  EXECUTION MODEL                                               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  USER ◄─────────────────────────────────────────────────────┐  │
│    │                                                        │  │
│    ▼                                                        │  │
│  OVERSEER (event-driven)                                    │  │
│    │  • Receives events from harness                        │  │
│    │  • Monitors progress                                   │  │
│    │  • Can intervene (alert, stop, restart)                │  │
│    │  • Responds to user queries                            │  │
│    │                                                        │  │
│    ▼                                                        │  │
│  HARNESS (async loop)                                       │  │
│    │                                                        │  │
│    │    ┌────────────────────────────────┐                  │  │
│    │    │  Builder runs... (async)       │──events──────────┘  │
│    │    │  Verifier runs... (async)      │                     │
│    │    │  Loop continues or exits       │                     │
│    │    └────────────────────────────────┘                     │
│    │                                                           │
│    └───▶ Writes progress, logs, artifacts                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Three layers, three models:**

| Layer | Model | Why |
|-------|-------|-----|
| **User ↔ Overseer** | Interactive | User chats, expects responses |
| **Overseer ↔ Harness** | Event-driven | Overseer receives updates, can push alerts |
| **Builder ↔ Verifier** | Async loop | Runs autonomously until done or max iterations |

**Events Overseer monitors:**
- Builder session started/ended
- Verifier session started/ended
- Completion markers detected
- Errors or crashes
- Loop iteration count
- Progress file updates

**Not polling:** Overseer doesn't check "are we done yet?" repeatedly. It subscribes to events and reacts.

**Research Links:**
- Current wiggum-loop uses async streaming: `for await (const msg of query(...))`

---

### 2.7 Where does the harness run? [x]
_Local CLI? Cloud? Docker? Hybrid?_

**Answer:**

**Harness runs where you run it.**

It's self-contained within a project folder. Could be local, could be a cloud container, could be anywhere you can boot the CLI.

```
┌────────────────────────────────────────────────────────────────┐
│  DEPLOYMENT                                                    │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  your-project/                                                 │
│  ├── harnessd/           ◄── The harness lives here            │
│  │   ├── overseer/                                             │
│  │   ├── harness/                                              │
│  │   └── projects/                                             │
│  └── (your code)                                               │
│                                                                │
│  Run it locally → works                                        │
│  Deploy to cloud container → works                             │
│  It's just a CLI. Not complicated.                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Typical path:**
- Start with local (most developers)
- Deploy to cloud when you want it running without your laptop open

**Research Links:**
- Self-contained design enables portability

---

### 2.8 How do we handle nested/sub-agent spawning? [x]
_Can agents spawn other agents? What's the hierarchy limit?_

**Answer:**

**No limits. Builder and Verifier can spawn whatever agents they need.**

```
┌────────────────────────────────────────────────────────────────┐
│  SPAWNING                                                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  OVERSEER                                                      │
│     │                                                          │
│     ├──spawns──▶ Builder ──can spawn──▶ sub-agents             │
│     │                                                          │
│     └──spawns──▶ Verifier ──can spawn──▶ sub-agents            │
│                                                                │
│  No hierarchy limit. Agents spawn as needed.                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Builder might spawn sub-agents for:
- Parallel implementation of independent components
- Research tasks while continuing main work
- Specialized operations (database migrations, test generation)

Verifier might spawn sub-agents for:
- Parallel validation across different areas
- Deep investigation of specific issues

**Research Links:**
- Sub-agents explore with 10K+ tokens, return 1-2K summaries
- Parallel agents accelerate development when tasks are independent

---

## 3. Agent Roles

### 3.1 What exactly does the Overseer/Supervisor do? [x]
_Plan creation? Monitoring? Intervention? All three?_

**Answer:**

**All three. Plus user communication and loop adjustment.**

The Overseer is the user's interface to the entire system. It handles everything except direct implementation and validation.

```
┌────────────────────────────────────────────────────────────────┐
│  OVERSEER RESPONSIBILITIES                                     │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  PLANNING                                                      │
│  • Interview user to extract project requirements              │
│  • Draft and refine the project plan                           │
│  • Ensure plan is detailed enough for Builder/Verifier         │
│  • Break work into phases with quality gates                   │
│                                                                │
│  MONITORING                                                    │
│  • Watch Builder/Verifier loop progress                        │
│  • Track completion markers, errors, iterations                │
│  • Read progress files and verifier reports                    │
│  • Detect when loop is stuck or not converging                 │
│                                                                │
│  INTERVENTION                                                  │
│  • Alert Builder to new information                            │
│  • Stop/restart to pick up changes                             │
│  • Adjust prompts, skills, memory if loop struggles            │
│  • Intervene on user's behalf when requested                   │
│                                                                │
│  USER COMMUNICATION                                            │
│  • Answer "how's progress?" / "what decisions?"                │
│  • Report issues and recommend actions                         │
│  • Take direction from user on steering                        │
│                                                                │
│  THINKING AHEAD                                                │
│  • Anticipate problems before they derail execution            │
│  • Pre-mortem analysis before starting                         │
│  • Adjust approach based on patterns observed                  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**What Overseer does NOT do:**
- Write code (Builder does this)
- Validate work (Verifier does this)
- Execute inside the harness loop

**The principle:** Overseer thinks. Builder and Verifier do.

**Research Links:**
- Manager pattern: coordinator handles planning, monitoring, adjustment
- Two-agent pattern extended with supervisory layer

---

### 3.2 What exactly does the Builder do? [x]
_Implementation only? Or also planning within its scope?_

**Answer:**

**Implementation, with tactical planning for how to build each feature.**

Builder doesn't plan the project (Overseer does), but it does figure out how to implement what's in front of it.

```
┌────────────────────────────────────────────────────────────────┐
│  BUILDER RESPONSIBILITIES                                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  CORE: IMPLEMENTATION                                          │
│  • Read the project plan and feature_list.json (read-only)     │
│  • Pick the next incomplete feature/task                       │
│  • Write code, tests, configuration                            │
│  • Commit progress with descriptive messages                   │
│  • Update claude-progress.txt and plan checkboxes              │
│  • CANNOT edit feature_list.json (Verifier-only)               │
│                                                                │
│  TACTICAL PLANNING (within scope)                              │
│  • Figure out how to implement the current feature             │
│  • Break a feature into steps if needed                        │
│  • Decide which files to modify                                │
│  • Choose implementation approach                              │
│                                                                │
│  PROBLEM SOLVING                                               │
│  • Debug failures (fix and retry)                              │
│  • Research using tools when stuck                             │
│  • Spawn sub-agents for parallel/specialized work              │
│  • Adapt to verifier feedback from previous iteration          │
│                                                                │
│  DISCIPLINE                                                    │
│  • One feature at a time                                       │
│  • Don't proceed until current work passes smoke tests         │
│  • Leave clean state (committed, documented)                   │
│  • Output completion marker only when truly done               │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**What Builder does NOT do:**
- Define project scope or phases (Overseer does this)
- Validate its own work as complete (Verifier does this)
- Talk to user (Overseer does this)

**The principle:** Builder is a skilled executor. Give it a clear task, it figures out how to build it.

**Research Links:**
- "One feature at a time" reduces context exhaustion by 71%
- Anthropic: "leave a clean state" — commits, progress updates

---

### 3.3 What does the Verifier do? [x]
_Just validation? Or can it fix minor issues?_

**Answer:**

**Validation only. No fixes. Report problems, Builder fixes them.**

Verifier's job is to navigate through requirements and verify they're actually met. It catches problems and reports them — nothing more.

```
┌────────────────────────────────────────────────────────────────┐
│  VERIFIER RESPONSIBILITIES                                     │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  VALIDATION                                                    │
│  • Navigate the suite of requirements                          │
│  • Verify each claim made by Builder                           │
│  • Run smoke tests and quality gate checks                     │
│  • Check that artifacts exist and work                         │
│  • Be skeptical — disconfirm "done"                            │
│                                                                │
│  FEATURE_LIST.JSON (exclusive ownership)                       │
│  • ONLY agent that can edit feature_list.json                  │
│  • Updates passes field:                                       │
│    - 0 = not attempted                                         │
│    - -1 = attempted but failed                                 │
│    - 1 = verified complete                                     │
│  • Can add verifier_notes with observations                    │
│                                                                │
│  REPORTING                                                     │
│  • If everything passes: output completion marker              │
│  • If issues found: output detailed verifier report            │
│    - What was claimed done but isn't                           │
│    - What doesn't work the way it should                       │
│    - Specific failures observed                                │
│                                                                │
│  DOES NOT                                                      │
│  • Fix anything (Builder does all fixing)                      │
│  • Suggest solutions                                           │
│  • Implement features                                          │
│  • Make changes to code                                        │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** Verifier is quality control. Catch problems, report them, update feature_list.json status. Builder fixes everything.

**Research Links:**
- Separation of concerns: validator should not also be implementer
- Clear role boundaries prevent confusion

---

### 3.4 Do we need a separate Planner agent? [x]
_Or is planning a mode of the Overseer/Builder?_

**Answer:**

**No separate Planner. Overseer handles all planning.**

```
┌────────────────────────────────────────────────────────────────┐
│  PLANNING RESPONSIBILITY                                       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  PROJECT-LEVEL PLANNING → Overseer                             │
│  • Interview user                                              │
│  • Draft project plan                                          │
│  • Define phases and quality gates                             │
│  • Refine based on progress/feedback                           │
│                                                                │
│  TACTICAL PLANNING → Builder                                   │
│  • How to implement current feature                            │
│  • Which files to modify                                       │
│  • Implementation approach                                     │
│                                                                │
│  Separate Planner agent? No.                                   │
│  Would just be Overseer with a different name.                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Research Links:**
- Role consolidation: 3 agents cover all functions

---

### 3.5 Do we need a Debugger agent? [x]
_Specialized for root cause analysis?_

**Answer:**

**No separate Debugger. Builder handles debugging.**

When Builder encounters an error, it debugs and fixes as part of its problem-solving. No handoff to a specialist.

```
┌────────────────────────────────────────────────────────────────┐
│  DEBUGGING RESPONSIBILITY                                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Builder encounters error                                      │
│       │                                                        │
│       ▼                                                        │
│  Builder debugs (root cause analysis)                          │
│       │                                                        │
│       ▼                                                        │
│  Builder fixes and retries                                     │
│                                                                │
│  Separate Debugger agent? No.                                  │
│  Builder is capable. Context loss from handoff hurts more      │
│  than any benefit from specialization.                         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Builder can spawn sub-agents if it needs help on a particularly complex debug, but that's Builder's choice — not a separate Debugger role in the architecture.

**Research Links:**
- Role consolidation: 3 agents cover all functions

---

### 3.6 Do we need a Researcher agent? [x]
_For gathering external information, docs, examples?_

**Answer:**

**No separate Researcher. Builder uses tools to research.**

Builder has access to web search, documentation, file reading. When it needs information, it gathers it as part of implementation.

```
┌────────────────────────────────────────────────────────────────┐
│  RESEARCH RESPONSIBILITY                                       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Builder needs information                                     │
│       │                                                        │
│       ▼                                                        │
│  Builder uses tools (web search, docs, files)                  │
│       │                                                        │
│       ▼                                                        │
│  Builder continues with implementation                         │
│                                                                │
│  Separate Researcher agent? No.                                │
│  Research is part of implementation, not a separate phase.     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Builder can spawn sub-agents for deep research tasks if needed, but that's Builder's decision — not a standing Researcher role.

**Research Links:**
- Role consolidation: 3 agents cover all functions

---

### 3.7 What's each agent's tool access? [ ] ★
_Should all agents have same tools or specialized toolsets?_

**Answer:** TBD — depends on memory system design, research tools, and other system details we haven't defined yet.

**Research Links:**
- Common failure: bloated toolsets, ambiguous decision points
- Role-based tool assignment (CrewAI pattern)

---

### 3.8 What are each agent's boundaries? [~] ★
_Three-tier: Always do / Ask first / Never do_

**Answer:**

**Each agent has its own three-tier boundary set based on its role.**

```
┌────────────────────────────────────────────────────────────────┐
│  OVERSEER BOUNDARIES                                           │
├────────────────────────────────────────────────────────────────┤
│  ALWAYS DO                                                     │
│  • Monitor loop progress                                       │
│  • Report status when user asks                                │
│  • Update plans based on verifier feedback                     │
│                                                                │
│  ASK FIRST                                                     │
│  • Major plan changes                                          │
│  • Stopping/restarting the loop                                │
│  • Changing project scope                                      │
│                                                                │
│  NEVER DO                                                      │
│  • Write code directly                                         │
│  • Bypass Builder to make changes                              │
│  • Hide problems from user                                     │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  BUILDER BOUNDARIES                                            │
├────────────────────────────────────────────────────────────────┤
│  ALWAYS DO                                                     │
│  • Follow the project plan                                     │
│  • Commit after completing work                                │
│  • Update progress files                                       │
│  • Run smoke tests before claiming done                        │
│                                                                │
│  ASK FIRST                                                     │
│  • (Builder doesn't ask — works autonomously)                  │
│                                                                │
│  NEVER DO                                                      │
│  • Commit secrets or credentials                               │
│  • Skip tests to move faster                                   │
│  • Claim done without verification                             │
│  • Force push or destructive git operations                    │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  VERIFIER BOUNDARIES                                           │
├────────────────────────────────────────────────────────────────┤
│  ALWAYS DO                                                     │
│  • Check every claimed completion                              │
│  • Run smoke tests                                             │
│  • Report all issues found                                     │
│                                                                │
│  ASK FIRST                                                     │
│  • (Verifier doesn't ask — validates and reports)              │
│                                                                │
│  NEVER DO                                                      │
│  • Fix issues (report only)                                    │
│  • Delete files                                                │
│  • Mutate git history                                          │
│  • Mark complete if any issue exists                           │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** Boundaries are enforced through prompts AND tool access. "Never do" items should be impossible, not just discouraged.

**Research Links:**
- GitHub analysis: 2,500+ agent configs use three-tier
- "Never commit secrets" = most common helpful constraint

---

### 3.9 How do agents communicate? [x]
_Shared files? Message queue? Direct calls?_

**Answer:**

**Shared files for persistent state. Injected messages for real-time alerts.**

Agents don't have conversations, but Overseer can inject messages into a running Builder session.

```
┌────────────────────────────────────────────────────────────────┐
│  AGENT COMMUNICATION                                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  PERSISTENT (shared files)                                     │
│  • Project plan                                                │
│  • Progress files                                              │
│  • Verifier reports                                            │
│  • Git commits                                                 │
│  • Memory state                                                │
│                                                                │
│  REAL-TIME (injected messages)                                 │
│  • Overseer can inject a message into running Builder          │
│  • One-way: Builder receives, doesn't reply to Overseer        │
│  • Used for: "new info available", "user wants X", alerts      │
│                                                                │
│  CONTROL SIGNALS                                               │
│  • Overseer → Harness: stop/start commands                     │
│  • Harness → Overseer: events (started, completed, error)      │
│                                                                │
│  NOT USED                                                      │
│  • Back-and-forth conversations between agents                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** Overseer can push information to Builder while it's running, but Builder doesn't reply. It's alerts, not dialogue.

**Research Links:**
- Shared files for persistence, injected messages for real-time

---

### 3.10 When does control transfer between agents? [x]
_Explicit markers? Conditions? Time-based?_

**Answer:**

**Explicit markers for Builder→Verifier. Overseer controls all other transitions.**

```
┌────────────────────────────────────────────────────────────────┐
│  CONTROL TRANSFER                                              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  BUILDER → VERIFIER                                            │
│  Trigger: Builder outputs completion marker                    │
│  The harness detects the marker and starts Verifier            │
│                                                                │
│  VERIFIER → BUILDER (next iteration)                           │
│  Trigger: Verifier outputs report (not completion marker)      │
│  Report is passed to next Builder iteration                    │
│                                                                │
│  VERIFIER → DONE                                               │
│  Trigger: Verifier outputs completion marker                   │
│  Loop exits successfully                                       │
│                                                                │
│  OVERSEER → BUILDER/VERIFIER                                   │
│  Trigger: Overseer decides to start/restart loop               │
│  Overseer initiates, monitors, can interrupt                   │
│                                                                │
│  MAX ITERATIONS → STOP                                         │
│  Trigger: Loop hits maximum iterations                         │
│  Loop exits with failure, Overseer reports to user             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Markers used:**
- `===WIGGUM_COMPLETE===` — Builder claims done, triggers Verifier
- `===VERIFIER_COMPLETE===` — Verifier confirms done, loop exits

**Not time-based:** Transitions happen on completion, not after X minutes.

**Research Links:**
- Explicit markers prevent premature victory declaration
- Verifier report as feedback loop to next Builder

---

## 4. Context & Memory

### 4.1 How do we treat context as a finite resource? [ ] ★
_What's our context budget strategy?_

**Answer:** TBD — need to define specific strategies, not just principles.

**Research Links:**
- "Good context engineering finds smallest possible set of high-signal tokens"
- Models lose focus at scale despite 200K+ context windows

---

### 4.2 What's our compaction strategy? [~] ★
_When to compact? What to preserve? What to discard?_

**Answer:**

**MVP: Rely on auto-compaction from claude-agent-sdk.**

The SDK handles compaction automatically. For MVP, we don't build custom compaction logic — we let the framework manage it.

Future iterations may add custom strategies for:
- What to preserve vs discard
- When to trigger compaction
- How to summarize effectively

**Research Links:**
- Trigger at 80% capacity
- Preserve: architectural decisions, unresolved bugs, implementation specifics
- Discard: redundant tool outputs

---

### 4.3 What's our note-taking system? [~] ★
_How do agents maintain persistent memory outside context?_

**Answer:**

**Agents write to files that persist across sessions.**

When an agent learns something important, it writes it down. Next session reads those notes.

```
┌────────────────────────────────────────────────────────────────┐
│  NOTE-TAKING SYSTEM                                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  WHAT GETS WRITTEN                                             │
│  • Progress: what was accomplished this session                │
│  • Decisions: architectural choices, why they were made        │
│  • Blockers: issues encountered, how they were resolved        │
│  • Learnings: patterns discovered, things to remember          │
│                                                                │
│  WHERE IT LIVES                                                │
│  • Progress file: session-by-session accomplishments           │
│  • Memory files: structured notes agents can query             │
│  • Git commits: implicit notes via commit messages             │
│                                                                │
│  HOW IT'S USED                                                 │
│  • Builder reads notes at session start (orientation phase)    │
│  • Overseer reads notes to report progress to user             │
│  • Verifier reads notes to understand what was attempted       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** If it's important enough to remember, write it to a file. Context resets; files don't.

**Research Links:**
- Anthropic Pokemon demo: agent maintains precise tallies across 1000s of steps by writing notes
- claude-progress.txt for human-readable logs

---

### 4.4 How do we implement short-term memory? [x] ★
_Current conversation, current task, temporary variables_

**Answer:**

**Short-term memory = what's in the current context window.**

This is the simplest memory tier. It's whatever the agent can "see" right now.

```
┌────────────────────────────────────────────────────────────────┐
│  SHORT-TERM MEMORY                                             │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  WHAT IT CONTAINS                                              │
│  • Current session's conversation                              │
│  • Active task being worked on                                 │
│  • Recent tool outputs (file reads, command results)           │
│  • Immediate context from verifier report (if any)             │
│                                                                │
│  LIFESPAN                                                      │
│  • Lives only within current session                           │
│  • Lost on session end or compaction                           │
│  • Important bits should be written to notes before lost       │
│                                                                │
│  IMPLEMENTATION                                                │
│  • Handled by claude-agent-sdk automatically                   │
│  • No custom code needed                                       │
│  • Compaction managed by SDK when limits approached            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** Short-term memory is the context window. We use it wisely and offload to files before it's lost.

**Research Links:**
- Microsoft Research: appropriate short-term context = 40% user satisfaction increase

---

### 4.5 How do we implement long-term memory? [~] ★
_Cross-session persistence, learned preferences_

**Answer:**

**Long-term memory = files that persist across all sessions.**

Unlike short-term (context window), long-term survives session boundaries. It's the accumulated knowledge of the project.

```
┌────────────────────────────────────────────────────────────────┐
│  LONG-TERM MEMORY                                              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  WHAT IT CONTAINS                                              │
│  • Project plan and its evolution                              │
│  • All progress across all sessions                            │
│  • Architectural decisions and rationale                       │
│  • Patterns learned (what worked, what didn't)                 │
│  • Git history (implicit memory)                               │
│                                                                │
│  WHERE IT LIVES                                                │
│  • Plan files                                                  │
│  • Progress files                                              │
│  • Memory/notes files                                          │
│  • Git commits and history                                     │
│                                                                │
│  HOW IT'S ACCESSED                                             │
│  • Read at session start (orientation phase)                   │
│  • Queried as needed during work                               │
│  • Updated at session end or after significant work            │
│                                                                │
│  MVP IMPLEMENTATION                                            │
│  • Simple files in the project                                 │
│  • No vector database for MVP                                  │
│  • Structured formats (markdown, JSON) for easy parsing        │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** Long-term memory is the file system. Git-tracked, human-readable, persistent.

**Research Links:**
- 78% improvement in multi-session task completion with robust long-term memory
- Vector databases for semantic retrieval (future enhancement)

---

### 4.6 How do we implement working memory? [ ] ★
_Active task state, current focus, temporary working set_

**Answer:** TBD — the notes below are a guiding concept, not how we'll actually implement it.

**Conceptual notes:**

```
┌────────────────────────────────────────────────────────────────┐
│  WORKING MEMORY (conceptual)                                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  WHAT IT CONTAINS                                              │
│  • Current feature being implemented                           │
│  • Files currently being modified                              │
│  • Active hypothesis or approach                               │
│  • Immediate next steps                                        │
│                                                                │
│  HOW IT DIFFERS                                                │
│  • Short-term: everything in context window                    │
│  • Working: the focused subset agent is using now              │
│  • Long-term: files that persist across sessions               │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Research Links:**
<!-- TBD -->

---

### 4.7 Do we need a vector database? Which one? [ ] ★
_Pinecone, ChromaDB, Weaviate, Milvus?_

**Answer:** TBD — depends on memory system design decisions.

**Research Links:**
- Hybrid pattern: SQL for structured data + vectors for experiential
- HNSW or IVF for ANN indexing

---

### 4.8 How do we implement RAG? [ ] ★
_Simple, Agentic, or Agent Memory pattern?_

**Answer:** TBD — depends on memory system design decisions.

**Research Links:**
- Simple RAG: read-only single-pass
- Agentic RAG: strategic retrieval decisions
- Agent Memory: write operations during inference

---

### 4.9 Just-in-time context loading vs pre-retrieval? [ ] ★
_When to load context dynamically vs upfront?_

**Answer:** TBD — depends on memory system design decisions.

**Research Links:**
- Field-wide shift toward just-in-time
- Pre-retrieval for static content (legal docs)
- Agentic exploration for dynamic environments

---

### 4.10 How do we handle progressive disclosure? [~] ★
_Letting agents navigate and discover context layer by layer?_

**Answer:**

**Multiple mechanisms for progressive disclosure:**

```
┌────────────────────────────────────────────────────────────────┐
│  PROGRESSIVE DISCLOSURE STRATEGIES                             │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  PLAN STRUCTURE                                                │
│  • Project CLAUDE.md is concise, not giant                     │
│  • Links out to broken-up plan files                           │
│  • Agent reads summary, drills into details as needed          │
│                                                                │
│  SKILLS                                                        │
│  • Well-written skills offer progressive disclosure by default │
│  • Key information always at fingertips                        │
│  • Agent invokes skill when it needs that knowledge            │
│                                                                │
│  MEMORY SYSTEM                                                 │
│  • Memory also provides progressive disclosure                 │
│  • Details retrieved when relevant                             │
│                                                                │
│  MCP TOOLS                                                     │
│  • Tools have descriptions                                     │
│  • Agent reads description, runs tool for more info            │
│  • Information on-demand, not upfront                          │
│                                                                │
│  SUB-AGENT SPAWNING                                            │
│  • Spawn sub-agents to do deep work                            │
│  • Preserves main context window                               │
│  • Only gets what it needs when it reads things                │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Note:** There's probably more we should be doing here.

**Research Links:**
- File sizes suggest complexity
- Naming conventions hint at purpose
- Timestamps proxy relevance

---

### 4.11 What's our memory cleanup policy? [ ] ★
_Expiration? Summarization? Importance ranking?_

**Answer:** TBD — depends on memory system design. Likely inspiration from OpenClaw and other reference implementations.

**Research Links:**
- Memory leakage risk: irrelevant context = poor decisions
- Hierarchical memory with automatic summarization
- OpenClaw (inspiration/openclaw-bot/) for patterns

---

### 4.12 How do we forward memories between sessions? [~] ★
_Rolling memories, summaries, key facts?_

**Answer:**

**Combination of skills, tools, and prompt editing:**

```
┌────────────────────────────────────────────────────────────────┐
│  MEMORY FORWARDING MECHANISMS                                  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  SKILLS                                                        │
│  • Skills contain key memories of how to act                   │
│  • Always available to the agent                               │
│  • Encapsulate learned behaviors and patterns                  │
│                                                                │
│  TOOLS                                                         │
│  • Tools that can be called to access more complex info        │
│  • On-demand memory retrieval                                  │
│                                                                │
│  PROMPT EDITING                                                │
│  • Overseer can edit Builder prompt when iteration restarts    │
│  • Inject relevant memories into next run's context            │
│                                                                │
│  Skills + Tools + Prompt editing = Memory forwarding           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Research Links:**
- Core to original vision: "forward propagation of rolling memories"

---

## 5. State Management

### 5.1 What state must persist between sessions? [~] ★
_Progress, features, environment, memories?_

**Answer:**

**Everything. Our goal is to persist everything.**

Don't remove context — use progressive disclosure so the model finds what it needs.

```
┌────────────────────────────────────────────────────────────────┐
│  PERSISTENT STATE                                              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  IMMEDIATE ACCESS (in prompt/files)                            │
│  • Project plan (current version)                              │
│  • Progress tracking (what's done, what's not)                 │
│  • Git history (implicit state via commits)                    │
│  • Verifier reports (feedback for next iteration)              │
│  • Memory files (learnings, decisions, patterns)               │
│                                                                │
│  SEARCHABLE STORAGE (e.g., memvid - append-only, searchable)   │
│  • Session logs                                                │
│  • Metrics (iteration count, time spent)                       │
│  • Full conversation history                                   │
│  • Raw tool outputs                                            │
│                                                                │
│  Nothing is deleted. Model can search for what it needs.       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**The principle:** Don't remove context, just control accessibility. Progressive disclosure, not deletion.

**Research Links:**
- memvid: append-only searchable storage (potential solution)
- feature_list.json, claude-progress.txt patterns from research

---

### 5.2 How do we implement checkpointing? [~] ★
_When to checkpoint? What format? How to resume?_

**Answer:**

**Multiple checkpointing mechanisms:**

```
┌────────────────────────────────────────────────────────────────┐
│  CHECKPOINTING                                                 │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  GIT COMMITS (constant)                                        │
│  • Use superpowers "execute plans" skill                       │
│  • Commits constantly after any change                         │
│  • Natural checkpoints via git history                         │
│                                                                │
│  SDK CHECKPOINTING                                             │
│  • Claude agent SDK supports checkpointing                     │
│  • Overseer can stop and rewind when needed                    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Research Links:**
- Microsoft: save at specific execution points
- Enables pause/resume, failure recovery
- superpowers execute plans skill for constant commits

---

### 5.3 What does the feature_list.json look like? [x]
_Schema? Categories? Status tracking?_

**Answer:**

**Purpose:** Anthropic describes this as "a structured JSON file with a list of end-to-end feature descriptions" created to address premature project completion. By having 200+ features all initially marked failing, agents have a clear outline of what full functionality looks like.

**Anthropic's base format (from their long-running agents research):**

```json
{
  "category": "functional",
  "description": "New chat button creates a fresh conversation",
  "steps": [
    "Navigate to main interface",
    "Click the 'New Chat' button",
    "Verify a new conversation is created",
    "Check that chat area shows welcome state",
    "Verify conversation appears in sidebar"
  ],
  "passes": false
}
```

**Harnessd extension — tri-state passes + verifier notes:**

```json
{
  "category": "functional",
  "description": "New chat button creates a fresh conversation",
  "steps": [
    "Navigate to main interface",
    "Click the 'New Chat' button",
    "Verify a new conversation is created",
    "Check that chat area shows welcome state",
    "Verify conversation appears in sidebar"
  ],
  "passes": 0,
  "verifier_notes": null
}
```

**Key fields:**
- `category`: functional (other categories not enumerated in source)
- `description`: what the feature does
- `steps`: array of verification steps
- `passes`: integer tri-state:
  - `0` = not attempted yet
  - `-1` = attempted but failed
  - `1` = verified complete
- `verifier_notes`: string or null — Verifier can add observations about what it saw, what failed, etc.

**Critical rules:**
- **ONLY the Verifier can edit feature_list.json** — Builder cannot touch it
- Initializer creates 200+ features, all marked `"passes": 0`
- Builder reads list to understand what to work on, but cannot modify it
- Verifier updates `passes` and optionally adds `verifier_notes` after validation
- "It is unacceptable to remove or edit tests because this could lead to missing or buggy functionality" (Anthropic)
- JSON format chosen because "the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files" (Anthropic)

**Research Links:**
- Source: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

---

### 5.4 What does the progress file look like? [~] ★
_Format? Update frequency? Content structure?_

**Answer:**

**From Anthropic's source:**
- Called `claude-progress.txt`
- "A human-readable log where each session documents what it accomplished"
- Combined with git commit history, enables rapid understanding of project state
- Updated at session end
- Exact format not specified (left to implementers)

**Our format (append-only plain text):**

```
## Session 3 - 2026-02-01 14:30
Completed: User authentication flow, login form validation
In progress: Password reset feature
Blockers: None
Next: Finish password reset, start email verification

## Session 2 - 2026-02-01 10:15
Completed: Database schema, user model
In progress: Authentication flow
Blockers: None
Next: Complete auth, add login form
```

**Why this approach:**
- "Human-readable" suggests markdown/text, not JSON (unlike feature_list.json)
- Append-only preserves history across sessions
- Simple structure = less creative drift risk
- Complements git log (git shows code changes, this shows intent/status)

**Update frequency:** End of each session (before context exhaustion).

**Research Links:**
- Source: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

---

### 5.5 How do we track what's complete vs incomplete? [x]
_Progress markers: [ ], [~], [x]?_

**Answer:**

**Three complementary tracking systems with clear ownership:**

```
┌─────────────────────────────────────────────────────────────────┐
│  COMPLETION TRACKING LAYERS                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. feature_list.json (VERIFIER-ONLY, authoritative)            │
│     └── passes: 0 = not attempted                               │
│     └── passes: -1 = attempted but failed                       │
│     └── passes: 1 = verified complete                           │
│     └── verifier_notes: observations about what was seen        │
│     └── Builder CANNOT edit. Only Verifier updates this.        │
│                                                                 │
│  2. Plan file CLAUDE.md (Builder-editable, phase-level)         │
│     └── [ ] = not started                                       │
│     └── [~] = in progress                                       │
│     └── [x] = quality gate passed                               │
│     └── Updated by Builder after each phase completes           │
│                                                                 │
│  3. claude-progress.txt (Builder-editable, session log)         │
│     └── Append-only narrative log                               │
│     └── "Completed: X" / "In progress: Y"                       │
│     └── Human context, not machine state                        │
│                                                                 │
│  4. Git commits (immutable, code-level)                         │
│     └── Each commit = atomic completed work                     │
│     └── Commit message = what was done                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Which system is authoritative?**
- `feature_list.json` = source of truth for feature completion (Verifier-controlled)
- Plan file = source of truth for phase completion (Builder-controlled)
- Git = source of truth for what code exists

**Why this separation?**
- Builder can't mark its own work as complete — prevents premature victory
- Verifier is the gatekeeper of "actually done"
- Tri-state (-1/0/1) gives visibility into what was attempted vs untouched

**Research Links:**
- Anthropic: "It is unacceptable to remove or edit tests"
- Separation of builder/verifier prevents self-certification
- Current: Progress Tracking table in plan
- Each phase: Narrative, Goals, Tasks, Smoke Tests, Quality Gate

---

### 5.6 How do we ensure clean state between sessions? [~] ★
_Git commit required? File validation?_

**Answer:**

**The loop handles this:** Builder can exit for many reasons (completed, stuck, needs to ask question, crashed). Verifier checks everything and reports what's wrong. When Builder restarts, it reads Verifier's report, cleans up first, then continues building.

**What Verifier checks (candidates for clean state):**

```
┌─────────────────────────────────────────────────────────────────┐
│  VERIFIER CLEAN STATE CHECKLIST                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CODE STATE                                                     │
│  • Are all changes committed with descriptive message?          │
│  • Is working directory clean (git status)?                     │
│  • Any uncommitted work left behind?                            │
│                                                                 │
│  PROGRESS STATE                                                 │
│  • Is claude-progress.txt updated with session summary?         │
│  • Are plan checkboxes accurate for completed phases?           │
│                                                                 │
│  RUNTIME STATE                                                  │
│  • Is dev server running (or init.sh documented)?               │
│  • Are tests passing?                                           │
│  • Is environment in known-good state?                          │
│                                                                 │
│  CONTEXT STATE                                                  │
│  • Are next steps documented?                                   │
│  • Are blockers noted?                                          │
│  • Can next session orient from files alone?                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**TBD:** Specific items to include in Builder prompt vs Verifier checklist.

**Research Links:**
- Commit changes with descriptive message
- Update progress file before session end
- "Leave clean state" = critical principle

---

### 5.7 How do we detect and recover from dirty state? [~] ★
_What if a session crashed mid-work?_

**Answer:**

This flows from 5.6 — Verifier handles detection, Builder handles recovery on restart.

```
┌─────────────────────────────────────────────────────────────────┐
│  DIRTY STATE: DETECTION → RECOVERY FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  VERIFIER DETECTS (after any Builder exit):                     │
│  • git status shows uncommitted changes                         │
│  • Smoke tests failing                                          │
│  • Progress file inconsistent with actual state                 │
│  • Feature marked attempted but code incomplete                 │
│  • Dev server not running / broken environment                  │
│                                                                 │
│  VERIFIER REPORTS:                                              │
│  <verifier-report>                                              │
│  ## Dirty state found                                           │
│  - Uncommitted changes in src/auth.ts                           │
│  - Smoke test `npm test` fails: "Cannot find module..."         │
│  - feature_list.json shows auth attempted (-1) but broken       │
│                                                                 │
│  ## Recovery required before continuing                         │
│  1. Commit or stash uncommitted changes                         │
│  2. Fix broken import in src/auth.ts                            │
│  3. Re-run smoke tests to verify clean state                    │
│  </verifier-report>                                             │
│                                                                 │
│  BUILDER RECOVERS (on restart):                                 │
│  1. Read verifier report                                        │
│  2. Clean up dirty state first (before new work)                │
│  3. Run smoke tests to confirm recovery                         │
│  4. Then continue from where it left off                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**The principle:** Verifier is the "state inspector" — Builder never starts work on a dirty foundation. Clean up first, then build.

**Research Links:**
- Run smoke test at session start
- Check for uncommitted changes
- State-based resumption from last checkpoint

---

### 5.8 What's the git integration strategy? [~] ★
_Commit frequency? Branch strategy? What to never commit?_

**Answer:**

**TBD — draft below:**

```
┌─────────────────────────────────────────────────────────────────┐
│  GIT INTEGRATION STRATEGY                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  COMMIT FREQUENCY                                               │
│  • After each completed feature (atomic units)                  │
│  • Before session exit (capture in-progress work)               │
│  • After fixing dirty state (recovery commits)                  │
│  • Descriptive messages: what was done + why                    │
│                                                                 │
│  BRANCH STRATEGY                                                │
│  • TBD: Single branch (main) vs feature branches?               │
│  • Consideration: Feature branches add complexity               │
│  • Consideration: Main-only risks breaking trunk                │
│                                                                 │
│  NEVER COMMIT                                                   │
│  • Secrets, credentials, API keys                               │
│  • .env files with real values                                  │
│  • Large binaries (images, videos, models)                      │
│  • node_modules, .venv, build artifacts                         │
│  • Anything in .gitignore                                       │
│                                                                 │
│  INITIAL SETUP (Initializer does this)                          │
│  • Create .gitignore with standard exclusions                   │
│  • Initial commit with project skeleton                         │
│  • Ensure repo is in clean state for Builder                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Open question:** Branch strategy — do we want Builder working on `main` directly, or should it create feature branches?

**Research Links:**
- Commit after each completed feature
- Never commit secrets, credentials, large binaries
- Initial commit from initializer agent

---

## 6. Tool Design

### 6.1 What are our core tools and how do we design them? [~] ★
_Minimal viable toolset where each tool's purpose is crystal clear_

**Answer:**

```
┌─────────────────────────────────────────────────────────────────┐
│  CORE TOOLS BY AGENT                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  BUILDER (full implementation access)                           │
│  ├── Claude Code Default Toolset (Read, Write, Edit, etc.)      │
│  ├── Perplexity MCP (search, research, reason)                  │
│  ├── Pal MCP (chat, thinkdeep, debug, codereview, etc.)         │
│  └── Task: Can spawn sub-agents                                 │
│                                                                 │
│  VERIFIER (read-heavy, limited writes)                          │
│  ├── Claude Code Default Toolset (restricted via hooks)         │
│  │   └── No file deletion, no mutating git commands             │
│  ├── Edit feature_list.json ONLY                                │
│  ├── Perplexity MCP (for research during verification)          │
│  ├── Pal MCP (for analysis)                                     │
│  └── Task: Can spawn sub-agents for parallel verification       │
│                                                                 │
│  OVERSEER (orchestration + monitoring)                          │
│  ├── File: Read logs, progress files, plans                     │
│  ├── Agent: Spawn/restart Builder and Verifier                  │
│  ├── Agent: Inject messages into running sessions               │
│  └── User: Ask questions, present options                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TOOL DESCRIPTION PRINCIPLES (for custom tools)                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NAMING                                                         │
│  • Self-explanatory: search_customer_database > srch_cust_db    │
│  • Verb-noun pattern: read_file, create_commit, run_tests       │
│                                                                 │
│  DESCRIPTIONS                                                   │
│  • Docstring = primary guide for model                          │
│  • What it does, when to use it, what it returns                │
│                                                                 │
│  PARAMETERS                                                     │
│  • JSON Schema with types and constraints                       │
│  • Required vs optional clearly marked                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key constraint:** Verifier's tool restrictions are enforced via hooks (PreToolUse), not just prompt instructions.

**Error handling:** Tools return structured error messages the model can reason about (not exceptions that crash). Claude Code already handles this well — agent sees error and can retry or adapt.

**Research Links:**
- Data tools: context retrieval
- Action tools: state modification
- Orchestration tools: agent coordination
- Self-explanatory names (search_customer_database > srch_cust_db)
- Docstring = primary guide for model
- JSON Schema for parameter types/constraints
- Return structured error messages model can reason about
- Don't throw exceptions that crash execution

---

### 6.5 Should tools be idempotent? [ ]
_Same inputs = same outputs?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Idempotency makes retry logic safer
- Design for repeated calls

---

### 6.6 What file system tools do we need? [ ]
_Read, write, search, navigate?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Claude Code: grep, find, read, head, tail
- Targeted queries, store results
- Don't load entire contents into context

---

### 6.7 What browser/web tools do we need? [ ]
_Puppeteer MCP? Web fetch?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Puppeteer MCP for end-to-end testing
- Without browser automation: features marked complete without proper validation

---

### 6.8 What git tools do we need? [ ]
_Status, commit, diff, log?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Verifier: git status, diff, log, show (read-only)
- Builder: add, commit (no push/force)

---

### 6.9 What external service tools do we need? [ ]
_APIs, databases, cloud services?_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

### 6.10 How do we handle tool versioning? [ ]
_What happens when tool behavior changes?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Version control tools like prompts and policies
- Rollback capability

---

## 7. Prompt & Specification

### 7.1 What's our system prompt structure? [ ]
_Sections, organization, format (XML, Markdown)?_

**Answer:**
<!-- TBD -->

**Research Links:**
- XML tags or Markdown headers
- Sections: BACKGROUND, INSTRUCTIONS, TOOLS, OUTPUT
- Clear organization aids both humans and AI

---

### 7.2 What are our six core specification areas? [ ]
_Commands, testing, structure, style, git, boundaries_

**Answer:**
<!-- TBD -->

**Research Links:**
- GitHub analysis of 2,500+ files
- Each area provides concrete signals

---

### 7.3 What are our three-tier boundaries? [ ]
_Always do, Ask first, Never do_

**Answer:**
<!-- TBD -->

**Research Links:**
- Always: run tests before commits
- Ask: modify database schemas
- Never: commit secrets or API keys

---

### 7.4 How do we handle the "right altitude"? [ ]
_Not too brittle, not too vague_

**Answer:**
<!-- TBD -->

**Research Links:**
- Specific enough to guide effectively
- Flexible enough for strong heuristics
- Avoid hardcoded conditional logic

---

### 7.5 How many examples (few-shot) do we include? [ ]
_Quality over quantity. When do examples stop helping?_

**Answer:**
<!-- TBD -->

**Research Links:**
- 1-6 well-chosen examples covering main patterns
- Past 5-10: token cost without accuracy gain
- Examples are "pictures worth 1000 words"

---

### 7.6 How do we modularize large prompts? [ ]
_Extended TOC, sub-agents, skills?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Extended TOC: hierarchical summary with references
- Sub-agents: domain-specific portions
- "Map" stays in context, details retrievable on demand

---

### 7.7 When do we stop iterating on prompts? [ ]
_The 10-iteration rule_

**Answer:**
<!-- TBD -->

**Research Links:**
- 10 focused iterations fail to fix specific failure mode = stop
- The issue is architectural, not prompt-related
- Accuracy plateau below 85% = problem is not the prompt

---

### 7.8 What's the SPEC.md format? [ ]
_Persistent specification file structure_

**Answer:**
<!-- TBD -->

**Research Links:**
- Version-controlled reference
- Anchors AI when work resumes
- Same function as PRD in human teams

---

### 7.9 How do we handle prompt versioning? [ ]
_Track changes, compare performance, rollback?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Treat prompts as versioned artifacts
- Approval and change history
- Enable rollback to trusted configurations

---

## 8. Orchestration

### 8.1 What's our main loop structure? [ ]
_Builder → Verifier → (repeat or exit)_

**Answer:**
<!-- TBD -->

**Research Links:**
- Current: wiggum-loop (builder claims done → verifier checks → report or exit)
- Ralph Wiggum pattern: run tests → encounter errors → fix → iterate → completion tag

---

### 8.2 What are our completion markers? [ ]
_How do agents signal done, failed, blocked?_

**Answer:**
<!-- TBD -->

**Research Links:**
- BUILDER_DONE, VERIFIER_DONE
- Verifier report in <verifier-report> tags
- Explicit markers prevent premature victory declaration

---

### 8.3 How do we handle agent handoffs? [ ]
_State transfer, context passing, control flow_

**Answer:**
<!-- TBD -->

**Research Links:**
- Manager: delegates via tool calls, synthesizes outputs
- Decentralized: one-way transfer of control and conversation state
- Handoff = seamless transition between contexts

---

### 8.4 What's the maximum loop iterations? [ ]
_When do we give up?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Current: MAX_LOOPS = 15
- Hit maximum = check master log, exit 1

---

### 8.5 What's the cooldown between iterations? [ ]
_Prevent rate limiting, allow state to settle?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Current: COOLDOWN_SECONDS = 2
- Avoid overwhelming services

---

### 8.6 How do we handle parallel agent execution? [ ]
_When are tasks independent? Max parallelism?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Ensure genuine independence
- Don't have agents simultaneously edit same file
- Start with 2-3 parallel agents maximum
- "Surprisingly effective, if mentally exhausting"

---

### 8.7 What's the escalation path when agents get stuck? [ ]
_Ask human? Try different approach? Give up?_

**Answer:**
<!-- TBD -->

**Research Links:**
- Timeouts, retries, clear escalation paths
- Human-in-the-loop checkpoints for high-stakes

---

## 9. Testing & Evaluation

### 9.1 What's our simulation testing approach? [ ]
_Synthetic environments, edge case generation_

**Answer:**
<!-- TBD -->

**Research Links:**
- 3-5x more scenario variations than monthly production volume
- Behavioral consistency: <15% variance between complexity buckets
- Essential for compliance-critical systems

---

### 9.2 What's our adversarial testing approach? [ ]
_Prompt injection, overflow, encoding attacks_

**Answer:**
<!-- TBD -->

**Research Links:**
- Attack success rate target: <5%
- Build catalog: prompt injection, context overflow, encoding manipulation
- Capture complete reasoning chains

---

### 9.3 What's our continuous evaluation approach? [ ]
_Production monitoring, drift detection_

**Answer:**
<!-- TBD -->

**Research Links:**
- Track performance in production
- Measure drift over time
- Pre-deployment testing ≠ real-world performance

---

### 9.4 What's our human-in-the-loop testing approach? [ ]
_Expert validation, quality rubrics_

**Answer:**
<!-- TBD -->

**Research Links:**
- Human-AI agreement rate target: >85%
- 50-100 evaluations per category
- Calibration training using pre-scored examples

---

### 9.5 What are our key metrics? [ ]
_Token usage, completion time, success rate, tool correctness_

**Answer:**
<!-- TBD -->

**Research Links:**
- System efficiency: tokens, time, tool call frequency
- Agent quality: success rate, trajectory analysis, tool correctness
- Session level + node level measurement

---

### 9.6 What are our smoke tests? [ ]
_Quick validation that core functionality works_

**Answer:**
<!-- TBD -->

**Research Links:**
- Each phase has smoke tests
- Run every smoke test after completing implementation
- Start session by running init.sh

---

### 9.7 What are our quality gates? [ ]
_Criteria that must pass before proceeding_

**Answer:**
<!-- TBD -->

**Research Links:**
- Each phase has explicit quality gate criteria
- Do NOT proceed until ALL criteria pass
- If gate fails: understand why, fix root cause, re-run

---

### 9.8 How do we handle non-determinism? [ ]
_Agents produce probabilistic outputs_

**Answer:**
<!-- TBD -->

**Research Links:**
- Unit tests rely on exact matching = fail for agents
- Agents operate in probability spaces
- Need frameworks designed for non-deterministic outputs

---

### 9.9 How do we evaluate agent reasoning quality? [ ]
_Not just "did it work" but "did it reason well"_

**Answer:**
<!-- TBD -->

**Research Links:**
- Trajectory analysis: decision quality at each step
- Not just final output but path taken

---

### 9.10 What's our pre-mortem process? [ ]
_Identify risks before execution_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

## 10. Error Handling

### 10.1 How do we implement exponential backoff? [ ]
_Wait progressively longer between retries_

**Answer:**
<!-- TBD -->

**Research Links:**
- Attempt 1 → 1s, 2 → 2s, 3 → 4s
- Prevent overwhelming struggling services

---

### 10.2 How do we implement jitter? [ ]
_Randomization to prevent synchronized retries_

**Answer:**
<!-- TBD -->

**Research Links:**
- Many agents retry on same schedule = retry storms
- Add randomness to wait times

---

### 10.3 How do we implement circuit breakers? [ ]
_Stop attempting after threshold failures_

**Answer:**
<!-- TBD -->

**Research Links:**
- Cooldown period after threshold failures
- Prevent system thrashing
- Give systems time to recover

---

### 10.4 How do we classify errors? [ ]
_Transient (retry) vs permanent (don't retry) vs dependency (capped backoff)_

**Answer:**
<!-- TBD -->

**Research Links:**
- Transient: network hiccups, temp rate limiting
- Permanent: auth failures, invalid inputs
- Dependency: external outages

---

### 10.5 How do we implement semantic fallback? [ ]
_Alternative prompt formulations when output fails_

**Answer:**
<!-- TBD -->

**Research Links:**
- LLM outputs fail validation → try alternative formulation
- Address non-deterministic semantic failures

---

### 10.6 How do we validate structured outputs? [ ]
_Schema validation, routing based on validity_

**Answer:**
<!-- TBD -->

**Research Links:**
- Validate against predefined schemas
- Route based on validation results
- Trigger fallback if invalid

---

### 10.7 How do we resume from failed state? [ ]
_State-based resumption from last checkpoint_

**Answer:**
<!-- TBD -->

**Research Links:**
- Avoid restarting from scratch
- Check for required artifacts, trigger replan if missing

---

### 10.8 What's our self-healing strategy? [ ]
_Autonomous error resolution_

**Answer:**
<!-- TBD -->

**Research Links:**
- Automated resource scaling
- Service restarts
- Alternative approach attempts
- ML models to predict and preempt failures

---

## 11. Observability

### 11.1 What do we trace? [ ]
_Prompts, tool calls, outputs, decisions, costs, handoffs_

**Answer:**
<!-- TBD -->

**Research Links:**
- Without complete traces: debugging impossible
- Track: prompts → tool calls → results → decisions → costs → handoffs

---

### 11.2 What metadata do we track? [ ]
_Timestamps, origins, permissions, tool lineage_

**Answer:**
<!-- TBD -->

**Research Links:**
- Audit trails: who accessed, how processed, which tools, what results
- Clear separation: transient memory vs persistent memory

---

### 11.3 What's our logging strategy? [ ]
_JSONL per session, master log, structured format_

**Answer:**
<!-- TBD -->

**Research Links:**
- Current: JSONL per session (tail-able)
- Master log with summaries
- Timestamps for every event

---

### 11.4 How do we monitor costs? [ ]
_Token usage, API calls, alerts on anomalies_

**Answer:**
<!-- TBD -->

**Research Links:**
- Track costs per session
- Alert on anomalies
- Cost monitoring prevents runaway usage (10x+ budget exceedances)

---

### 11.5 What tracing framework do we use? [ ]
_OpenTelemetry? Custom?_

**Answer:**
<!-- TBD -->

**Research Links:**
- OpenTelemetry: standardized framework
- Distributed tracing reduces debugging time by 8x

---

### 11.6 How do we enable replay for debugging? [ ]
_Every run produces clear traces_

**Answer:**
<!-- TBD -->

**Research Links:**
- Enable replay of any session
- Schedule red-team tests for failure modes

---

### 11.7 How do we implement rollback? [ ]
_Version control everything, automated triggers_

**Answer:**
<!-- TBD -->

**Research Links:**
- Version prompts, tools, policies, datasets
- Define clear rollback trigger conditions
- Error rates, cost spikes, quality drops

---

## 12. Security & Governance

### 12.1 How do we implement least-privilege? [ ]
_Each tool accesses only essential data/operations_

**Answer:**
<!-- TBD -->

**Research Links:**
- Scope all tool calls to minimum necessary
- Production readiness: tools validated and permission-scoped

---

### 12.2 What are our hard security boundaries? [ ]
_Never commit secrets, never delete production data, etc._

**Answer:**
<!-- TBD -->

**Research Links:**
- "Never commit secrets" = most common helpful constraint
- Current verifier: cannot rm/rmdir/unlink, cannot mutate git

---

### 12.3 How do we maintain audit trails? [ ]
_Log every action, explainable decisions_

**Answer:**
<!-- TBD -->

**Research Links:**
- For regulated industries: mandatory
- Decisions must be explainable
- Traceable logs showing why each action was taken

---

### 12.4 When do we require human approval? [ ]
_Irreversible actions, high-stakes decisions_

**Answer:**
<!-- TBD -->

**Research Links:**
- Compact summaries: what, why, evidence, rollback
- One-click rollback for safety

---

### 12.5 How do we handle sensitive data? [ ]
_PII, credentials, API keys_

**Answer:**
<!-- TBD -->

**Research Links:**
- Never commit secrets or API keys
- Adversarial test for PII extraction

---

### 12.6 What compliance requirements apply? [ ]
_Industry regulations, internal policies_

**Answer:**
<!-- TBD -->

**Research Links:**
- Comprehensive audit trails for compliance
- Explainable decisions for regulatory audits

---

## 13. Session Continuity

### 13.1 What does the initializer do? [ ]
_First session only: set up foundation for all subsequent sessions_

**Answer:**
<!-- TBD -->

**Research Links:**
- Create feature_list.json (200+ features marked failing)
- Write init.sh (startup script)
- Establish claude-progress.txt
- Make initial git commit

---

### 13.2 What does the coding agent orientation phase look like? [ ]
_How does each session start?_

**Answer:**
<!-- TBD -->

**Research Links:**
- pwd → read progress/features/git → start server → smoke test
- Prevents rediscovering context, breaking existing functionality

---

### 13.3 What does the coding agent execution phase look like? [ ]
_Select one feature, implement, test, commit, update progress_

**Answer:**
<!-- TBD -->

**Research Links:**
- ONE highest-priority incomplete feature
- Implement incrementally
- Test thoroughly (browser automation)
- Only mark passing after verification
- Commit with descriptive message
- Update progress file

---

### 13.4 How do we prevent premature victory declaration? [ ]
_Feature list ensures exhaustive validation_

**Answer:**
<!-- TBD -->

**Research Links:**
- 200+ specific features prevents "try to do too much"
- Self-verify thoroughly
- Only mark passing after testing

---

### 13.5 How do we handle session crashes? [ ]
_Dirty state detection, recovery protocol_

**Answer:**
<!-- TBD -->

**Research Links:**
- Read progress tracking section
- Find last [x] completed, first [ ] incomplete
- Continue from that phase's first incomplete step
- Never restart completed phases

---

### 13.6 What makes sessions resumable? [ ]
_Clean commits, progress files, feature tracking_

**Answer:**
<!-- TBD -->

**Research Links:**
- "Leave a clean state"
- Commit progress to git
- Update progress file
- Subsequent sessions seamlessly continue

---

### 13.7 How does init.sh work? [ ]
_Startup script that verifies working state_

**Answer:**
<!-- TBD -->

**Research Links:**
- Start development server
- Run basic smoke tests
- Every session begins by running this

---

### 13.8 What's in claude-progress.txt? [ ]
_Human-readable log of session accomplishments_

**Answer:**
<!-- TBD -->

**Research Links:**
- Each session documents what it accomplished
- Combined with git log = rapid understanding
- Human-readable format

---

### 13.9 How do we prevent context exhaustion mid-implementation? [ ]
_One feature at a time discipline_

**Answer:**
<!-- TBD -->

**Research Links:**
- "One feature at a time" reduces context exhaustion by 71%
- Incomplete feature states reduced by 84%
- Work incrementally, avoid half-complete undocumented work

---

## 14. Skills & Learning

### 14.1 What are "skills" in the agent context? [ ]
_Portable expertise, installable like npm packages_

**Answer:**
<!-- TBD -->

**Research Links:**
- Skills package domain expertise in reusable formats
- Examples: Vercel perf rules, accessibility guidelines, OWASP security

---

### 14.2 How do agents create their own skills? [ ]
_Self-improvement, pattern extraction_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

### 14.3 How do we inject skills into the loop? [ ]
_Dynamic skill loading, skill composition_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

### 14.4 How do agents learn over time? [ ]
_Accumulated improvements, pattern recognition_

**Answer:**
<!-- TBD -->

**Research Links:**
- Current agents learn within sessions but not across user bases
- Future: federated learning from aggregated interactions

---

### 14.5 How do we implement the "desire paths" pattern? [ ]
_Implement what agents try to do (their hallucinations)_

**Answer:**
<!-- TBD -->

**Research Links:**
- Steve Yegge's Beads: 100+ subcommands from agent attempts
- Interface optimized for agents, not humans
- Nearly every agent guess becomes correct

---

### 14.6 How do we transfer learning across domains? [ ]
_Communication styles, problem-solving approaches_

**Answer:**
<!-- TBD -->

**Research Links:**
- Current: agents start fresh in new domains
- Research frontier: transfer without negative transfer

---

### 14.7 What's "vibe engineering"? [ ]
_Curating context, rules, structure for autonomous operation_

**Answer:**
<!-- TBD -->

**Research Links:**
- Simon Willison's term
- Not writing code directly
- Designing environments where agents run autonomously for hours
- Skill: environment design, guardrails, tool provision

---

### 14.8 How do we version and manage skills? [ ]
_Skill updates, backward compatibility, deprecation_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

## 15. Human-in-the-Loop

### 15.1 When should the human be consulted? [ ]
_Irreversible actions, ambiguous requirements, high-stakes decisions_

**Answer:**
<!-- TBD -->

**Research Links:**
- Three-tier: Ask first tier
- High-impact changes requiring approval
- Modify database schemas

---

### 15.2 How do we present information to humans? [ ]
_Compact summaries, evidence, one-click actions_

**Answer:**
<!-- TBD -->

**Research Links:**
- Compact, well-structured summaries
- What agent intends to do
- Why it's taking this action
- Link to supporting evidence
- One-click rollback

---

### 15.3 How do humans provide feedback? [ ]
_Approve/reject, edit, redirect_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

### 15.4 How do we minimize interruptions? [ ]
_Batch decisions, clear criteria, autonomous within boundaries_

**Answer:**
<!-- TBD -->

**Research Links:**
- Three-tier: Always do tier = autonomous
- Only escalate Ask first tier items

---

### 15.5 How do we handle human response delays? [ ]
_Queue, timeout, fallback actions_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

### 15.6 How do we learn from human interventions? [ ]
_Update boundaries, refine prompts, expand Always tier_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

## 16. Production Operations

### 16.1 What's the production readiness checklist? [ ]
_All items that must be true before production_

**Answer:**
<!-- TBD -->

**Research Links:**
- Tool calls validated and permission-scoped
- System can point to sources
- Timeouts, retries, escalation paths
- State in structured form
- End-to-end tracing
- Test suite runs before every release

---

### 16.2 How do we handle model selection? [ ]
_Frontier for capability, optimize down for cost_

**Answer:**
<!-- TBD -->

**Research Links:**
- Establish capability first, optimize cost second
- Build with top-tier, then swap in smaller where acceptable
- Not every task demands smartest model

---

### 16.3 How do we scale the harness? [ ]
_Parallel projects, resource limits, queue management_

**Answer:**
<!-- TBD -->

**Research Links:**
<!-- TBD -->

---

### 16.4 How do we monitor the harness in production? [ ]
_Dashboards, alerts, SLOs_

**Answer:**
<!-- TBD -->

**Research Links:**
- Distributed tracing
- Cost monitoring
- Error rate monitoring
- Automated rollback triggers

---

### 16.5 How do we handle rate limiting? [ ]
_Backoff, quotas, multiple providers_

**Answer:**
<!-- TBD -->

**Research Links:**
- Exponential backoff with jitter
- Temporary rate limiting = transient error (retry)

---

### 16.6 What's the disaster recovery plan? [ ]
_Complete failure, data loss, security incident_

**Answer:**
<!-- TBD -->

**Research Links:**
- Version control everything
- Rollback to trusted configurations
- Clear audit trails

---

### 16.7 How do we deprecate and migrate? [ ]
_Tool changes, prompt updates, breaking changes_

**Answer:**
<!-- TBD -->

**Research Links:**
- Version all prompts, tools, policies
- Enable rollback
- Compare performance across versions

---

_Last updated: TBD_
_Research tracker: 0/130 questions answered_
