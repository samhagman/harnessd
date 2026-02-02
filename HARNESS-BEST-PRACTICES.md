# Harness Best Practices

A guide for building autonomous agent harnesses using the Wiggum Loop pattern.

---

## Overview

A **harness** is an autonomous agent orchestration system that drives multi-phase software implementation. It uses a builder-verifier feedback loop where a builder agent implements tasks and a verifier agent validates completion, with iterative refinement until all quality gates pass.

---

## Core Philosophy

```
┌─────────────────────────────────────────────────────────────────┐
│                      BUILDER-VERIFIER LOOP                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────┐        ┌─────────────┐        ┌──────────┐   │
│   │   BUILDER   │ ───▶   │  VERIFIER   │ ───▶   │  DONE?   │   │
│   │ (implements)│        │ (validates) │        │          │   │
│   └─────────────┘        └─────────────┘        └────┬─────┘   │
│          ▲                                           │         │
│          │                                           │         │
│          └─────────── NO (feedback loop) ────────────┘         │
│                                                                │
│   YES ──▶ Exit 0 (VERIFIED COMPLETE)                           │
│   MAX LOOPS ──▶ Exit 1 (incomplete - needs human)              │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

**Key principles:**

1. **Never trust, always verify** — Every implementation phase must pass independent verification
2. **Fail forward** — Failed verification feeds back into the next builder iteration
3. **State is truth** — Plan documents are the source of truth for progress
4. **Guardrails, not hand-holding** — Restrict dangerous operations, but let agents work autonomously
5. **Log everything** — Full session transcripts enable post-hoc debugging

---

## Directory Structure

```
harness/
├── wiggum-loop.ts          # Main orchestrator (300-400 lines)
├── prompts.ts              # Builder and verifier prompts (250-350 lines)
├── hooks.ts                # Verifier guardrails (80-110 lines)
├── logger.ts               # JSONL logging utilities (~120 lines)
├── run.sh                  # Launcher script (40-70 lines)
├── tail.sh                 # Log tailing utility (~70 lines)
├── package.json            # Dependencies (Deno or Node)
├── tsconfig.json           # TypeScript config (if using Node)
├── .gitignore              # Ignore node_modules/, logs/
└── logs/                   # Session logs (JSONL format)
    ├── builder_001_*.jsonl
    ├── verifier_001_*.jsonl
    └── wiggum_master.log
```

**File purposes:**

| File             | Purpose                                                    | Lines   |
| ---------------- | ---------------------------------------------------------- | ------- |
| `wiggum-loop.ts` | Session orchestration, loop management, state coordination | 300-400 |
| `prompts.ts`     | System prompts for builder and verifier agents             | 250-350 |
| `hooks.ts`       | PreToolUse hooks to restrict verifier actions              | 80-110  |
| `logger.ts`      | JSONL logging with timestamps and session tracking         | ~120    |
| `run.sh`         | Environment setup, prerequisite checks, launch             | 40-70   |
| `tail.sh`        | Real-time log monitoring with filtering options            | ~70     |

---

## The Orchestrator (wiggum-loop.ts)

### Key Components

```typescript
// 1. Configuration via environment variables
const PLAN_DIR = Deno.env.get("WIGGUM_PLAN_DIR") || "../";
const MAX_LOOPS = parseInt(Deno.env.get("WIGGUM_MAX_LOOPS") || "10");
const COOLDOWN_MS = parseInt(Deno.env.get("WIGGUM_COOLDOWN_MS") || "30000");

// 2. Sanity check mode for quick validation
const SANITY_CHECK = Deno.args.includes("--sanity-check");

// 3. Session runner with timeout and tool restrictions
async function runSession({
  kind,           // 'builder' | 'verifier'
  iteration,      // loop number
  systemPrompt,   // from prompts.ts
  hooks,          // guardrails from hooks.ts
  maxDurationMs   // timeout (e.g., 30 min builder, 10 min verifier)
}): Promise<SessionResult>

// 4. Main loop with feedback
while (loopCount < MAX_LOOPS) {
  // Run builder
  const builderResult = await runSession({ kind: "builder", ... });

  // Run verifier
  const verifierResult = await runSession({ kind: "verifier", ... });

  // Check completion
  if (verifierResult.report?.complete) {
    logMaster({ event: "VERIFIED_COMPLETE", loopCount });
    Deno.exit(0);
  }

  // Feedback for next iteration
  latestVerifierReport = verifierResult.report;
  loopCount++;
  await sleep(COOLDOWN_MS);
}
```

### Best Practices

1. **Always have a max loops limit** — Prevents infinite loops and runaway costs
2. **Configurable via environment** — All paths, timeouts, and limits should be overridable
3. **Cooldown between loops** — Prevents rate limiting and gives time for external state to settle
4. **Extract structured reports** — Parse XML or JSON from verifier output for programmatic feedback

---

## Prompts (prompts.ts)

### Builder Prompt Structure

```typescript
const BUILDER_PROMPT = `
You are FULLY AUTONOMOUS. You have no user. You are implementing a multi-phase plan.

## Plan Documents
Read these files to understand the full plan:
- ${PLAN_DIR}/CLAUDE.md (or main plan file)
- ${PLAN_DIR}/phase-{N}.md (phase-specific details)

## Progress Tracking
The plan uses markers to track progress:
- [ ] NOT STARTED
- [~] IN PROGRESS
- [x] COMPLETE

Your job:
1. Find the first [ ] or [~] marker
2. Implement that task completely
3. Update the marker to [x] ONLY after verification passes
4. Output ===WIGGUM_COMPLETE=== when ALL markers are [x]

## Long-Running Operations
For operations that take >10 minutes:
1. Start them in detached mode (nohup, Modal detached, etc.)
2. Save PID or job ID to a file
3. Poll for completion every 15-20 minutes
4. Check logs or output artifacts to verify success
5. NEVER wait synchronously for long operations

## Git Hygiene
- Commit after each logical unit of work
- Use descriptive commit messages
- Don't commit secrets, .env files, or large binaries
- Push if remote is configured

## Quality Gates
Each phase has specific pass criteria. Do NOT mark complete until:
- All tests pass
- Metrics meet thresholds
- Artifacts exist in expected locations
- Smoke tests succeed

## When Stuck
- Use MCP tools to explore the codebase
- Search for similar implementations
- Use web search for external dependencies
- After 3 failed attempts, stop and report

Current phase focus: Read the plan files to determine.
${sanityCheck ? "\\nSANITY CHECK MODE: Just output ===WIGGUM_COMPLETE=== immediately." : ""}
`;
```

### Verifier Prompt Structure

```typescript
const VERIFIER_PROMPT = `
You are a VERIFIER. Your job is to independently validate that the builder completed the work correctly.

## Verification Checklist
For the current phase, verify:
1. All [ ] markers from the plan are now [x]
2. Code exists and follows the design
3. Tests pass (run them yourself)
4. Quality gates are met
5. Artifacts exist in expected locations

## Restrictions
You are READ-ONLY. You CANNOT:
- Modify files (write, edit, delete)
- Run git commands that change state (commit, push, etc.)
- Delete resources (rm, rmdir, etc.)
- Run "git clean"

You CAN:
- Read any file
- Run tests and verification commands
- Check git status and logs
- List directories

## Output Format
After verification, output EXACTLY:

<verifier-report>
<phase>{current_phase_number}</phase>
<complete>true/false</complete>
<issues>
- Issue 1 description
- Issue 2 description
</issues>
<next-actions>
- Specific action for builder to fix issue 1
- Specific action for builder to fix issue 2
</next-actions>
</verifier-report>

Then output ===VERIFIER_COMPLETE===

If verification passes (complete=true), the harness will exit successfully.
If verification fails (complete=false), the harness will feed your report back to the builder.
`;
```

### Best Practices

1. **Explicit markers** — Use `[ ]`, `[~]`, `[x]` for clear state tracking
2. **Phase-specific details** — Link to separate phase documents for complex plans
3. **Long-running guidance** — Always include instructions for detached operations with polling
4. **Quality gates** — Define specific, measurable pass criteria
5. **Structured output** — Use XML or JSON for machine-parseable reports

---

## Guardrails (hooks.ts)

### PreToolUse Hooks

```typescript
export function createVerifierHooks(): AgentHooks {
  return {
    async onPreToolUse(toolUse: ToolUse, { approve, deny }) {
      const toolName = toolUse.name;
      const args = toolUse.input;

      // BLOCK: File deletion
      if (["rm", "rmdir", "unlink"].includes(toolName)) {
        return deny("Verifier cannot delete files. Read-only access only.");
      }

      // BLOCK: Git mutations
      if (toolName === "bash" && args.command?.includes("git ")) {
        const allowedGit = ["git status", "git diff", "git log", "git show"];
        const isReadonly = allowedGit.some((cmd) =>
          args.command.startsWith(cmd),
        );
        if (!isReadonly) {
          return deny("Verifier can only run read-only git commands.");
        }
      }

      // BLOCK: Git clean (especially dangerous)
      if (toolName === "bash" && args.command?.includes("git clean")) {
        return deny("git clean is forbidden for verifier.");
      }

      // DOMAIN-SPECIFIC: Block dangerous cloud operations
      if (
        toolName === "bash" &&
        args.command?.includes("modal secret delete")
      ) {
        return deny("Verifier cannot delete Modal secrets.");
      }

      return approve();
    },
  };
}
```

### Best Practices

1. **Deny by default** — Start restrictive, relax as needed
2. **Read-only verifier** — Verifier should never mutate state
3. **Domain-specific protections** — Add hooks for your specific infrastructure (cloud APIs, databases, etc.)
4. **Clear denial messages** — Explain why an action was blocked
5. **Log all denials** — Track when guardrails trigger

---

## Logging (logger.ts)

### JSONL Structure

```typescript
interface LogEntry {
  ts: string; // ISO timestamp
  kind: "builder" | "verifier" | "master";
  iteration: number; // loop number
  msg: unknown; // full message content
}

// Master log entries
interface MasterLogEntry {
  ts: string;
  event:
    | "LOOP_START"
    | "BUILDER_DONE"
    | "VERIFIER_DONE"
    | "VERIFIED_COMPLETE"
    | "MAX_LOOPS";
  loopCount: number;
  hadError?: boolean;
  complete?: boolean;
  report?: VerifierReport;
}
```

### Best Practices

1. **One file per session** — `builder_001_2026-01-30T12-00-00.jsonl`
2. **Master log for summaries** — High-level loop events separate from detailed transcripts
3. **Completion markers** — Parse for `===WIGGUM_COMPLETE===` and `===VERIFIER_COMPLETE===`
4. **Pretty-print for humans** — Terminal output with colors and tool call hints
5. **Archive, don't delete** — Keep logs for post-hoc analysis

---

## State Management

### File-Based State (Plan Documents)

```markdown
<!-- CLAUDE.md or phase document -->

# Phase 3: Model Training

## Progress

| Task                    | Status |
| ----------------------- | ------ |
| Setup data pipeline     | [x]    |
| Configure training loop | [x]    |
| Run training            | [~]    |
| Export to ONNX          | [ ]    |

## Details...
```

### Best Practices

1. **Single source of truth** — Plan documents are the canonical state
2. **Atomic updates** — Update one marker at a time with clear commit messages
3. **Never skip states** — `[ ]` → `[~]` → `[x]`, never jump directly
4. **Readable without tools** — Humans should understand state from raw markdown

---

## Long-Running Operations

### Pattern: Detached with Polling

```bash
# Start detached operation
nohup python train.py > training.log 2>&1 &
echo $! > training.pid

# Poll for completion
while kill -0 $(cat training.pid) 2>/dev/null; do
    sleep 1200  # 20 minutes
    tail -50 training.log
    # Check for error patterns
    if grep -q "ERROR\|FATAL" training.log; then
        echo "Training failed"
        exit 1
    fi
done

# Verify outputs exist
if [[ ! -f outputs/model.onnx ]]; then
    echo "Missing output artifact"
    exit 1
fi
```

### Best Practices

1. **Never block synchronously** — Always detach and poll
2. **Save PID/job ID** — Write to file for status checking
3. **Poll every 15-20 minutes** — Balance responsiveness with API costs
4. **Check logs for errors** — Don't just wait for process exit
5. **Verify artifacts** — Check output files exist and have content

---

## Monitoring

### Real-Time Tailing (tail.sh)

```bash
#!/bin/bash
# tail.sh - Real-time log monitoring

MODE="${1:-pretty}"  # pretty | raw | master

get_latest_log() {
    ls -t logs/builder_*.jsonl 2>/dev/null | head -1
}

case "$MODE" in
    --raw)
        tail -f "$(get_latest_log)"
        ;;
    --master)
        tail -f logs/wiggum_master.log
        ;;
    --tools)
        # Show only tool calls
        tail -f "$(get_latest_log)" | jq -r 'select(.msg.role == "assistant") | .msg.content[] | select(.type == "tool_use") | "\\(.name): \\(.input)'\'''\''
        ;;
    *)
        # Pretty-printed with colors
        tail -f "$(get_latest_log)" | while read line; do
            echo "$line" | jq -r '[.ts, .kind, .msg.role] | @tsv'
        done
        ;;
esac
```

### Key Monitoring Commands

```bash
# Check if harness is running
ps aux | grep wiggum | grep -v grep

# Tail latest builder session
./tail.sh

# View master log only
./tail.sh --master

# Check specific phase progress
grep -E "^\\s*- \\[.*\\]" ../CLAUDE.md

# Check for errors in logs
grep -i "error\|fail\|exception" logs/builder_*.jsonl
```

---

## Quality Gates

### Gate Failure Protocol

```
┌─────────────────────────────────────────────────────────────┐
│                    GATE FAILURE PROTOCOL                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. DIAGNOSE                                                │
│     ├─ Read error messages and logs                         │
│     ├─ Classify failure type:                               │
│     │   ├─ Type A: Transient (network, resource limit)      │
│     │   ├─ Type B: Config (wrong parameters, paths)         │
│     │   ├─ Type C: Code bug (logic error, missing impl)     │
│     │   └─ Type D: Infrastructure (service down, quota)     │
│     └─ Document findings in plan or issue tracker           │
│                                                             │
│  2. RESPOND                                                 │
│     ├─ Type A: Retry up to 3x with exponential backoff      │
│     ├─ Type B: Fix config, re-run smoke tests               │
│     ├─ Type C: Debug, fix code, do NOT proceed until fixed  │
│     └─ Type D: Stop harness, alert human operator           │
│                                                             │
│  3. VERIFY                                                  │
│     ├─ Re-run full smoke test suite                         │
│     ├─ Check all quality metrics                            │
│     └─ Gate must fully pass before marking [x]              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Best Practices

1. **Specific thresholds** — "Top-1 accuracy > 90%" not "good accuracy"
2. **Automated verification** — Verifier should run tests, not just check markers
3. **Smoke tests per phase** — Quick validation that phase is working
4. **Full integration tests** — End-to-end validation before final completion

---

## Adaptation Guidelines

### When to Create a Harness

| Scenario                                 | Harness? | Notes                                |
| ---------------------------------------- | -------- | ------------------------------------ |
| Multi-phase implementation (>3 phases)   | Yes      | Complexity justifies automation      |
| Long-running operations (>1 hour total)  | Yes      | Need polling and resume capability   |
| Quality gates with measurable thresholds | Yes      | Verifier can validate objectively    |
| Single task or bug fix                   | No       | Direct implementation is faster      |
| Exploratory/spike work                   | No       | Requirements too fluid               |
| Human-in-the-loop decisions required     | No       | Blocking on humans breaks automation |

### Domain-Specific Adaptations

| Domain                       | Adaptation                                                     |
| ---------------------------- | -------------------------------------------------------------- |
| **Cloud ML Training**        | Modal/R2 integration, GPU monitoring, checkpoint polling       |
| **Local ML Training**        | PID tracking, MPS/CUDA monitoring, local artifact verification |
| **Infrastructure/Terraform** | State file locking, plan-before-apply, drift detection         |
| **Data Pipelines**           | Batch job polling, data quality checks, lineage validation     |
| **API Development**          | Contract testing, load testing gates, OpenAPI validation       |

### Scaling Considerations

| Scale                      | Adjustment                                           |
| -------------------------- | ---------------------------------------------------- |
| More phases (>10)          | Split into sub-harnesses or milestone checkpoints    |
| Longer operations (>24h)   | Add heartbeat mechanism, external health checks      |
| Higher stakes (production) | Add human approval gates between phases              |
| Multiple environments      | Parameterize environment config, run harness per env |

---

## Example: Minimal Harness

```typescript
// wiggum-loop.ts (minimal version)
import { Agent, AgentHooks } from "@anthropic-ai/claude-agent-sdk";

const MAX_LOOPS = 5;
const PLAN_FILE = "../plan.md";

const builderPrompt = `
Read ${PLAN_FILE} and implement the next uncompleted task.
Use [ ], [~], [x] markers to track progress.
Output ===WIGGUM_COMPLETE=== when all tasks are [x].
`;

const verifierPrompt = `
Verify all tasks in ${PLAN_FILE} are marked [x].
Run tests to confirm.
Output <verifier-report><complete>true/false</complete></verifier-report>
then ===VERIFIER_COMPLETE===.
`;

// Main loop
for (let i = 1; i <= MAX_LOOPS; i++) {
  // Builder
  const builder = new Agent({ systemPrompt: builderPrompt });
  const builderResult = await builder.run("Implement the plan");
  const builderDone = builderResult.output.includes("===WIGGUM_COMPLETE===");

  if (builderDone) {
    // Verifier
    const verifier = new Agent({ systemPrompt: verifierPrompt });
    const verifierResult = await verifier.run("Verify completion");
    const report = parseReport(verifierResult.output);

    if (report.complete) {
      console.log("✓ Verified complete");
      Deno.exit(0);
    }
  }
}

console.log("✗ Max loops reached");
Deno.exit(1);
```

---

## Checklist: Creating a New Harness

- [ ] Directory structure matches standard layout
- [ ] `wiggum-loop.ts` has configurable paths, max loops, cooldown
- [ ] `prompts.ts` references correct plan documents
- [ ] `hooks.ts` restricts file deletion and git mutations
- [ ] `logger.ts` writes JSONL with timestamps
- [ ] `run.sh` checks prerequisites before launching
- [ ] `tail.sh` provides real-time monitoring
- [ ] Plan documents use `[ ]`, `[~]`, `[x]` markers
- [ ] Quality gates are specific and measurable
- [ ] Long-running operations use detach + poll pattern
- [ ] Verifier is strictly read-only
- [ ] Master log tracks loop-level events
- [ ] `.gitignore` excludes `node_modules/` and `logs/`

---

## References

| Harness                    | Location                                                          | Domain              |
| -------------------------- | ----------------------------------------------------------------- | ------------------- |
| Custom MTG Embedding Model | `docs/plans/card-recognition/custom-mtg-embedding-model/harness/` | Local ML training   |
| Cloud Model Training       | `docs/cloud-model-training/harness/`                              | Cloud ML (Modal/R2) |

---

_Last updated: 2026-01-30_
