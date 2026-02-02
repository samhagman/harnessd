# Inspiration Sources

Reference materials and projects informing Harnessd design.

---

## Projects

### openclaw-bot/
OpenClaw - autonomous AI agent. Cloned from https://github.com/openclaw/openclaw

Explore for:
- Agent loop implementation
- Tool/function calling patterns
- State management
- Memory systems

### pal-mcp-server/
PAL MCP - Provider Abstraction Layer for multi-model orchestration. Cloned from https://github.com/BeehiveInnovations/pal-mcp-server

Explore for:
- **Tool architecture** (`tools/`) - Well-structured MCP tool implementations (chat, debug, codereview, consensus, planner, thinkdeep, precommit, etc.)
- **Workflow patterns** - Multi-step guided workflows with step tracking, confidence levels, hypothesis testing
- **Conversation continuity** - `continuation_id` threading across tools, context preservation
- **Multi-model coordination** - Consensus building, model-specific thinking configs, stance steering
- **Provider abstraction** (`providers/`) - Clean separation of model providers (OpenAI, Gemini, Ollama, etc.)
- **CLI-to-CLI bridge** (`clink/`) - Spawning subagent CLIs for isolated context execution

Key files:
- `server.py` - Main MCP server implementation
- `tools/*.py` - Individual tool implementations with excellent parameter schemas
- `utils/conversation_memory.py` - Conversation threading system
- `systemprompts/` - System prompt definitions per tool
- `conf/` - Configuration for CLI clients and roles

---

## Articles

### ai-agent-harness-research-report.md
**"Building Harnesses for Long-Running AI Coding Agents: A Comprehensive Systematic Review"**

90+ sources synthesized. Key sections:

| Section | What It Covers |
|---------|----------------|
| II. Foundational Architecture | Three-component model (Model, Tools, Instructions) |
| III. Orchestration Patterns | Single vs multi-agent, Manager vs Decentralized patterns |
| IV. Specification-Driven Dev | Prompt engineering plateau, 10-iteration rule, 3-tier boundaries |
| V. Long-Running Agents | **Anthropic's two-agent pattern** (initializer + coding agent) |
| VI. Context Engineering | Compaction, note-taking, sub-agent architectures |
| VII. Memory Systems | Short-term, long-term, RAG evolution, checkpointing |
| VIII. Testing | 4 frameworks: simulation, adversarial, continuous, HITL |
| IX. Error Recovery | Exponential backoff, circuit breakers, semantic fallback |
| X. Observability | Distributed tracing, audit trails, rollback mechanisms |
| XII. 2026 Trends | Ralph Wiggum pattern, skills, vibe engineering |
| XIII. Reference Architecture | 8-layer stack for production agents |

**Critical insights for Harnessd:**
1. Context is precious - smallest set of high-signal tokens
2. Specification quality > prompt iteration (diminishing returns after 5 hours)
3. Two-agent pattern: initializer sets up env, coding agent does incremental work
4. "One feature at a time" reduces context exhaustion by 71%
5. 10-iteration rule: if 10 prompt tweaks don't fix it, it's architectural
6. Three-tier boundaries: Always do / Ask first / Never do
7. feature_list.json + claude-progress.txt + init.sh = session continuity

**Framework comparison (Section XIV):**
- CrewAI: role-based, low learning curve
- LangGraph: graph-based, max control
- AutoGen: conversational, HITL focus
- Swarm: minimal, max observability

---

_Update this file when adding new inspiration sources._
