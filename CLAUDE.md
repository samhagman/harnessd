# Harnessd

**A harness system for Claude Code to handle long-running autonomous tasks.**

---

## Vision

Harnessd enables AI agents to work autonomously on complex, multi-session tasks that exceed a single context window. The core insight: long-running agent success requires explicit environment management, incremental progress tracking, and state persistence between sessions.

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER                                      │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              OVERSEER / SUPERVISOR                       │    │
│  │  • User-facing interface for building plans              │    │
│  │  • Deep planning with correct architecture               │    │
│  │  • Pre-mortem analysis before execution                  │    │
│  │  • Spawns and monitors builder agents                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   WIGGUM LOOP                            │    │
│  │  ┌─────────┐     ┌──────────┐     ┌─────────┐           │    │
│  │  │ BUILDER │────▶│ VERIFIER │────▶│ REPORT  │           │    │
│  │  └─────────┘     └──────────┘     └────┬────┘           │    │
│  │       ▲                                 │                │    │
│  │       └─────────────────────────────────┘                │    │
│  │                  (feedback loop)                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                MEMORY SYSTEMS                            │    │
│  │  • Short-term: current task context                      │    │
│  │  • Working: active problem state                         │    │
│  │  • Long-term: cross-session learning                     │    │
│  │  • Rolling memories forwarded between sessions           │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Capabilities

### 1. Deep Planning
- Correct architecture BEFORE implementation
- Pre-mortem analysis to identify risks
- Specialized sub-agents for reviewing plans
- User approves plan before builder starts

### 2. Autonomous Execution (Wiggum Loop)
- Builder implements features one at a time
- Verifier validates each completion claim
- Self-healing feedback loops when problems arise
- Explicit completion markers prevent premature victory

### 3. Detailed Verification
- Smoke tests at each step
- Quality gates per phase
- Verifier catches issues builder missed
- Reports feed back into next builder iteration

### 4. Memory & Learning
- Forward propagation of rolling memories
- Skills injection: agent creates own skills, injects into loop
- Learning over time from patterns and outcomes
- Context treated as precious finite resource

### 5. Session Continuity
- Clean state between sessions (git commits, progress files)
- Orientation protocol at session start
- Feature list prevents context exhaustion
- "One feature at a time" discipline

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Wiggum Loop** | Builder→Verifier feedback loop with iterative refinement |
| **Three-Tier Boundaries** | Always do / Ask first / Never do |
| **10-Iteration Rule** | Stop prompt tweaking after 10 tries; it's architectural |
| **Completion Markers** | `===WIGGUM_COMPLETE===`, `===VERIFIER_COMPLETE===` |
| **Progress Tracking** | `[ ]` pending, `[~]` in-progress, `[x]` complete |
| **feature_list.json** | 200+ features all marked passing/failing |
| **claude-progress.txt** | Human-readable session accomplishments |
| **init.sh** | Startup script verifying working state |

---

## Project Structure

```
harnessd/
├── CLAUDE.md                     # This file - project overview
├── HARNESS-BEST-PRACTICES.md     # Core harness building philosophy
│
├── harness/                      # The harness implementation
│   ├── wiggum-loop.ts            # Main orchestrator
│   ├── prompts.ts                # Builder & verifier prompts
│   ├── hooks.ts                  # Guardrails (PreToolUse)
│   ├── logger.ts                 # JSONL logging utilities
│   ├── projects/                 # Plans the harness executes
│   │   └── example-project/
│   │       └── CLAUDE.md         # Project plan template
│   └── logs/                     # Session logs (gitignored)
│
├── plans/                        # Plans for developing Harnessd itself
│   ├── CLAUDE.md                 # Harnessd development tracker
│   └── harness-init/             # Initialization research
│       └── HARNESS-FAQ.md        # 130 design questions to answer
│
└── inspiration/                  # Reference materials
    ├── CLAUDE.md                 # Inspiration source tracker
    ├── ai-agent-harness-research-report.md  # 90+ source synthesis
    └── openclaw-bot/             # Reference implementation
```

---

## Development Approach

1. **Research First**: Answer all 130 questions in `plans/harness-init/HARNESS-FAQ.md`
2. **Design Second**: Create detailed architecture from answered questions
3. **Build Incrementally**: One component at a time with verification
4. **Verify Constantly**: Run the harness on itself (dogfooding)

---

## Commands

```bash
# Run the harness on a project
cd harness && npx tsx wiggum-loop.ts

# Sanity check (proves the loop works)
cd harness && npx tsx wiggum-loop.ts --sanity-check

# Tail a session log
tail -f harness/logs/builder_001_*.jsonl | jq -r 'select(.msg.type=="assistant") | .msg.message.content[]? | select(.type=="text") | .text'
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WIGGUM_REPO_ROOT` | `cwd` | Repository root path |
| `WIGGUM_PLAN_DIR` | `harness/projects/example-project` | Project plan location |
| `WIGGUM_HARNESS_DIR` | `harness` | Harness directory |
| `WIGGUM_LOG_DIR` | `logs` | Log directory (relative to harness) |
| `WIGGUM_MAX_LOOPS` | `15` | Maximum builder→verifier iterations |
| `WIGGUM_COOLDOWN_SECONDS` | `2` | Delay between iterations |

---

## Key Insights from Research

1. **Context is precious** — smallest set of high-signal tokens wins
2. **Specification quality > prompt iteration** — diminishing returns after 5 hours
3. **Two-agent pattern works** — initializer + coding agent for session continuity
4. **"One feature at a time"** — reduces context exhaustion by 71%
5. **10-iteration rule** — if prompts don't fix it, it's architectural
6. **Self-verification is critical** — without browser automation, features get marked done prematurely

---

## References

- `HARNESS-BEST-PRACTICES.md` — Harness building philosophy
- `inspiration/ai-agent-harness-research-report.md` — 90+ source systematic review
- `plans/harness-init/HARNESS-FAQ.md` — 130 questions to answer before building
- Anthropic: [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic: [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
