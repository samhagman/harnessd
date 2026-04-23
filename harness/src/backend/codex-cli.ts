/**
 * AgentBackend implementation that spawns `codex exec --json`.
 *
 * Codex CLI outputs JSONL on stdout. Each line is parsed and mapped
 * to the normalized AgentMessage interface. This enables harness roles
 * (evaluator, contract_evaluator, qa_agent, etc.) to run on Codex/OpenAI
 * models while the rest of the system stays model-agnostic.
 *
 * Key properties:
 * - Each runSession() spawns a fresh child process
 * - --sandbox read-only gives OS-level enforcement (superior to hooks)
 * - queueNudge() returns {handled:false} (Phase 1; Phase 3 wires abort+resume)
 * - abortSession() sends SIGTERM to the child process
 *
 * Reference: plan Phase 1, PAL codex parser at inspiration/pal-mcp-server/clink/parsers/codex.py
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentBackend, AgentMessage, AgentSessionOptions, NudgeOutcome } from "./types.js";

// ------------------------------------
// Configuration
// ------------------------------------

export interface CodexCliBackendConfig {
  /** Model to use with Codex (e.g. "o3", "o4-mini"). Passed as --model flag. */
  model?: string;
}

// ------------------------------------
// JSONL event types from `codex exec --json`
// ------------------------------------

/** Minimal shape we expect from Codex JSONL lines. */
interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

// ------------------------------------
// Helpers: parse a single JSONL line into an AgentMessage (or null)
// ------------------------------------

/**
 * Parse a raw JSONL line from codex exec stdout.
 * Returns null for unparseable lines or unknown event types.
 */
export function parseCodexLine(
  line: string,
  outputSchemaActive = false,
): AgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;

  let event: CodexEvent;
  try {
    event = JSON.parse(trimmed) as CodexEvent;
  } catch {
    // Malformed JSON — skip gracefully
    return null;
  }

  if (!event.type || typeof event.type !== "string") return null;

  return mapCodexEvent(event, outputSchemaActive);
}

/**
 * Map a parsed Codex JSONL event to an AgentMessage.
 * Returns null for event types we don't handle.
 *
 * `outputSchemaActive` — when true (i.e. the session was launched with
 * --output-schema), Codex emits the structured JSON payload as an
 * `agent_message` item whose `text` is the JSON string; we wrap it in
 * envelope sentinels so downstream extractEnvelope() works unchanged.
 */
function mapCodexEvent(
  event: CodexEvent,
  outputSchemaActive = false,
): AgentMessage | null {
  switch (event.type) {
    // Session initialization
    case "session.created":
    case "session.start": {
      const sessionId = extractSessionId(event);
      return {
        type: "system",
        subtype: "init",
        sessionId: sessionId ?? undefined,
        raw: event,
      };
    }

    // Completed item — check if it's an agent message
    case "item.completed": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return null;

      const itemType = item.type as string | undefined;

      // Structured final answer — emitted when --output-schema is used.
      // The payload IS the structured result JSON (no envelope sentinels needed from the model).
      // We synthesize an envelope here so downstream extractEnvelope() stays unchanged.
      if (itemType === "final_answer") {
        // The content field holds the structured payload. It may be a parsed object
        // or a JSON string depending on the Codex version.
        const rawPayload = item.content ?? item.output ?? item.result ?? item;
        let payloadStr: string;
        if (typeof rawPayload === "string") {
          payloadStr = rawPayload;
        } else {
          // Serialise the object (stripping our wrapper keys if the whole item was used)
          const cleaned =
            rawPayload === item
              ? { ...(item as Record<string, unknown>) }
              : rawPayload;
          // Remove Codex envelope fields before re-serialising
          if (typeof cleaned === "object" && cleaned !== null) {
            const c = cleaned as Record<string, unknown>;
            delete c.type;
            delete c.id;
          }
          payloadStr = JSON.stringify(cleaned);
        }

        const envelopeText =
          `===HARNESSD_RESULT_START===\n${payloadStr}\n===HARNESSD_RESULT_END===`;
        return {
          type: "assistant",
          subtype: "final_answer_envelope",
          text: envelopeText,
          raw: event,
        };
      }

      // Agent message with text content
      if (itemType === "agent_message" || itemType === "message") {
        const text = extractItemText(item);
        const role = item.role as string | undefined;
        // Only capture assistant messages, not tool results
        if (role && role !== "assistant") return null;
        if (!text) return null;

        // When --output-schema is active, Codex delivers the structured JSON
        // as an agent_message text (not a "final_answer" item). Wrap it in
        // sentinels so downstream extractEnvelope() locates it unchanged.
        if (outputSchemaActive && text.trim().startsWith("{")) {
          const envelopeText =
            `===HARNESSD_RESULT_START===\n${text}\n===HARNESSD_RESULT_END===`;
          return {
            type: "assistant",
            subtype: "final_answer_envelope",
            text: envelopeText,
            raw: event,
          };
        }

        return {
          type: "assistant",
          text,
          raw: event,
        };
      }

      // Tool calls — extract tool use info
      if (itemType === "tool_call" || itemType === "function_call") {
        const name = (item.name ?? item.function_name ?? "unknown") as string;
        const input = item.arguments ?? item.input ?? item.parameters;
        return {
          type: "assistant",
          toolUses: [{ name, input }],
          raw: event,
        };
      }

      // Command execution — extract command, exit code, and output
      if (itemType === "command_execution") {
        const command = (item.command ?? item.cmd ?? "") as string;
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
        const output = (item.output ?? item.stdout ?? "") as string;
        const stderr = (item.stderr ?? "") as string;

        const summaryParts: string[] = [];
        if (command) summaryParts.push(`$ ${command}`);
        if (exitCode !== null) summaryParts.push(`exit: ${exitCode}`);
        if (output) summaryParts.push(output);
        if (stderr) summaryParts.push(`stderr: ${stderr}`);

        return {
          type: "tool_result" as const,
          subtype: "command_execution",
          text: summaryParts.join("\n"),
          toolResults: [{
            toolUseId: (item.id ?? "unknown") as string,
            output: output,
            isError: exitCode !== null && exitCode !== 0,
          }],
          raw: event,
        };
      }

      return null;
    }

    // Turn completed — extract usage stats
    case "turn.completed": {
      const usage = event.usage as Record<string, unknown> | undefined;
      const costUsd =
        typeof usage?.total_cost === "number"
          ? usage.total_cost
          : typeof usage?.cost_usd === "number"
            ? (usage.cost_usd as number)
            : undefined;
      return {
        type: "assistant",
        text: undefined,
        numTurns: 1,
        costUsd: costUsd ?? undefined,
        raw: event,
      };
    }

    // Error events
    case "error": {
      const message = (event.message ?? event.error ?? "Unknown codex error") as string;
      return {
        type: "result",
        subtype: "error_during_execution",
        text: String(message),
        isError: true,
        raw: event,
      };
    }

    // Turn/thread lifecycle boundaries
    case "thread.started": {
      // Codex CLI 0.117+ emits thread.started with thread_id — this IS the
      // resumable session identifier. Treat it as a session init so the
      // orchestrator can resume and queueNudge has a sessionId to target.
      const threadId =
        typeof event.thread_id === "string"
          ? event.thread_id
          : extractSessionId(event);
      return {
        type: "system",
        subtype: "init",
        sessionId: threadId ?? undefined,
        raw: event,
      };
    }

    case "turn.started":
      return { type: "event" as const, subtype: event.type, raw: event };

    case "item.started": {
      const item = event.item as Record<string, unknown> | undefined;
      return {
        type: "event" as const,
        subtype: "item_started",
        text: item ? `Starting ${(item.type as string) ?? "unknown"}` : undefined,
        raw: event,
      };
    }

    default:
      // Preserve all unrecognized events — nothing silently dropped
      return { type: "event" as const, subtype: event.type, raw: event };
  }
}

/**
 * Extract session ID from a session event.
 */
function extractSessionId(event: CodexEvent): string | null {
  if (typeof event.session_id === "string") return event.session_id;
  if (typeof event.id === "string") return event.id;
  const session = event.session as Record<string, unknown> | undefined;
  if (session && typeof session.id === "string") return session.id;
  return null;
}

/**
 * Extract text content from a completed item.
 * Handles multiple content formats Codex may use.
 */
function extractItemText(item: Record<string, unknown>): string | undefined {
  // Direct text field
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text.trim();
  }

  // Content array (OpenAI-style)
  const content = item.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (
        block != null &&
        typeof block === "object" &&
        "type" in block &&
        (block as { type: string }).type === "text" &&
        "text" in block &&
        typeof (block as { text: string }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      } else if (
        block != null &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text: string }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    const joined = parts.join("").trim();
    if (joined) return joined;
  }

  // Content as plain string
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  return undefined;
}

// ------------------------------------
// Build spawn arguments
// ------------------------------------

/**
 * Logical MCP server descriptor — the common intermediate representation that
 * both Claude and Codex backends accept when callers set opts.mcpServers.
 *
 * Claude backend (supportsMcpServers: true): callers pass the in-process
 * createSdkMcpServer() form directly (backward compat). LogicalMcpServerDescriptor
 * objects that appear in the same record are passed to Codex via `-c` flags.
 *
 * Codex backend: only accepts this descriptor form. buildCodexArgs() translates
 * each entry to: `-c mcp_servers.<name>.command="<command>"`,
 * `-c mcp_servers.<name>.args=[...]`, and per-env `-c mcp_servers.<name>.env.KEY="v"`.
 */
export interface LogicalMcpServerDescriptor {
  /** The executable to run (e.g. "npx", "/usr/bin/node"). */
  command: string;
  /** Arguments to pass to the command (e.g. ["tsx", "/abs/path/to/server.mts"]). */
  args: string[];
  /** Optional environment variables passed to the MCP server process. */
  env?: Record<string, string>;
}

/**
 * Type guard: distinguish a LogicalMcpServerDescriptor from a Claude SDK
 * in-process MCP server object (which has no `command` field at this level).
 */
export function isLogicalMcpServerDescriptor(
  value: unknown,
): value is LogicalMcpServerDescriptor {
  return (
    value !== null &&
    typeof value === "object" &&
    "command" in value &&
    typeof (value as { command: unknown }).command === "string" &&
    "args" in value &&
    Array.isArray((value as { args: unknown }).args)
  );
}

/**
 * Build the argument list for `codex exec --json`.
 * Exported for testing.
 */
export function buildCodexArgs(
  opts: AgentSessionOptions,
  config: CodexCliBackendConfig,
): string[] {
  // Branch on resume: use `codex exec resume <sessionId>` when resuming a prior session.
  //
  // Flags that DO NOT exist on `codex exec resume` (verified against CLI --help):
  //   --output-schema, --sandbox, --cd
  //   The session carries output schema forward in server-side state; the CWD is restored
  //   from the session record; sandbox is inherited from the original session or global config.
  //
  // Flags that MUST be re-specified on each resume (MCP servers are process-scoped, not
  // session-scoped — Codex spawns fresh MCP child processes on every invocation):
  //   -c mcp_servers.<name>.*  — re-register each MCP server so tools are available again.
  //   -c model_reasoning_effort — re-apply since each invocation is a fresh process.
  //   --model / -m — resume also accepts a model override.
  if (opts.resume) {
    const args: string[] = ["exec", "resume", opts.resume, "--json"];

    // Model override (session option > backend config).
    const sessionModel = opts.model && !opts.model.startsWith("claude-") ? opts.model : undefined;
    const resumeModel = sessionModel ?? config.model;
    if (resumeModel) {
      args.push("--model", resumeModel);
    }

    // Re-apply reasoning effort (process-scoped)
    args.push("-c", "model_reasoning_effort=xhigh");

    // Re-register MCP servers so the tools are available in the resumed session.
    if (opts.mcpServers) {
      for (const [name, cfg] of Object.entries(opts.mcpServers)) {
        if (!isLogicalMcpServerDescriptor(cfg)) continue;
        args.push("-c", `mcp_servers.${name}.command="${cfg.command}"`);
        args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(cfg.args)}`);
        if (cfg.env) {
          for (const [k, v] of Object.entries(cfg.env)) {
            args.push("-c", `mcp_servers.${name}.env.${k}="${v}"`);
          }
        }
      }
    }

    // Prompt is the last positional argument
    args.push(opts.prompt);
    return args;
  }

  const args: string[] = ["exec", "--json"];

  // Prompt is a positional argument (not --prompt flag)
  args.push(opts.prompt);

  // Working directory
  if (opts.cwd) {
    args.push("--cd", opts.cwd);
  }

  // Sandbox mode
  // Evaluators/QA use "workspace-write" but Playwright needs access to ~/Library/Caches/
  // and curl needs to write cookie jars. Use full access for workspace-write roles since
  // the prompt enforces "don't fix bugs" and hooks enforce read-only for Claude.
  const sandboxMode = opts.sandboxMode ?? "workspace-write";
  if (sandboxMode === "read-only") {
    args.push("--sandbox", "read-only");
    args.push("-c", "sandbox_read_only.network_access=true");
  }
  // For workspace-write: don't pass --sandbox flag, inherits global config
  // (which is "danger-full-access" — prompt-enforced restrictions instead)

  // Model override (session option > backend config).
  // Ignore session-level Claude model names — the global --model flag is meant for Claude
  // backends; Codex only accepts GPT models and will error on "claude-*".
  const sessionModel = opts.model && !opts.model.startsWith("claude-") ? opts.model : undefined;
  const model = sessionModel ?? config.model;
  if (model) {
    args.push("--model", model);
  }

  // Force highest reasoning effort for adversarial roles
  args.push("-c", "model_reasoning_effort=xhigh");

  // MCP server registration via per-invocation -c config overrides.
  // Only LogicalMcpServerDescriptor entries are processed here — Claude SDK in-process
  // MCP objects (createSdkMcpServer() form) are silently skipped (they cannot be
  // serialized into Codex -c flags and are not expected in Codex sessions).
  if (opts.mcpServers) {
    for (const [name, cfg] of Object.entries(opts.mcpServers)) {
      if (!isLogicalMcpServerDescriptor(cfg)) continue;
      args.push("-c", `mcp_servers.${name}.command="${cfg.command}"`);
      args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(cfg.args)}`);
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          args.push("-c", `mcp_servers.${name}.env.${k}="${v}"`);
        }
      }
    }
  }

  // Structured output schema — sidesteps envelope-sentinel emission errors by
  // having Codex return a typed final_answer payload instead of free-form text.
  // The runSession() handler synthesizes this into a standard envelope-wrapped
  // AgentMessage so downstream callers (worker.ts:extractEnvelope) stay unchanged.
  if (opts.outputSchemaPath) {
    args.push("--output-schema", opts.outputSchemaPath);
  }

  return args;
}

// ------------------------------------
// CodexCliBackend
// ------------------------------------

export class CodexCliBackend implements AgentBackend {
  private config: CodexCliBackendConfig;
  private lastSessionId: string | null = null;
  private activeChild: ChildProcess | null = null;

  constructor(config?: CodexCliBackendConfig) {
    this.config = config ?? {};
  }

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    const args = buildCodexArgs(opts, this.config);
    this.lastSessionId = null;

    const child = spawn("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.activeChild = child;

    // Collect stderr for diagnostics
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // Parse stdout line-by-line as JSONL
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        const msg = parseCodexLine(line, !!opts.outputSchemaPath);
        if (!msg) continue;

        // Track session ID
        if (msg.sessionId) {
          this.lastSessionId = msg.sessionId;
        }

        yield msg;
      }

      // Wait for process exit
      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
        } else {
          child.on("exit", (code) => resolve(code));
        }
      });

      // Emit final result message based on exit code
      const stderr = stderrChunks.join("");
      if (exitCode === 0) {
        yield {
          type: "result",
          subtype: "success",
          isError: false,
          raw: { exitCode, stderr },
        };
      } else if (
        opts.resume &&
        exitCode !== 0 &&
        (stderr.toLowerCase().includes("session not found") ||
          stderr.toLowerCase().includes("session expired") ||
          stderr.toLowerCase().includes("unknown session") ||
          stderr.toLowerCase().includes("no such session"))
      ) {
        // Distinct error path: `codex exec resume` failed because the session is missing/expired.
        // Orchestrator catches this subtype and falls back to a fresh session via recovery-agent.
        yield {
          type: "result",
          subtype: "error_resume_failed",
          text: `Codex session resume failed (session: ${opts.resume}). Stderr: ${stderr}`,
          isError: true,
          raw: { exitCode, stderr, resumeSessionId: opts.resume },
        };
      } else {
        yield {
          type: "result",
          subtype: "error_max_turns",
          text: `Codex exited with code ${exitCode}. Stderr: ${stderr}`,
          isError: true,
          raw: { exitCode, stderr },
        };
      }
    } catch (err: unknown) {
      const errorText = err instanceof Error ? err.message : String(err);
      yield {
        type: "result",
        subtype: "error_during_execution",
        text: errorText,
        isError: true,
        raw: { error: errorText, originalError: err },
      };
    } finally {
      this.activeChild = null;
      rl.close();
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  /**
   * Deliver a nudge via abort+resume: kill the active child process so the
   * orchestrator's next builder invocation can resume the session with the
   * nudge text prepended to the prompt.
   *
   * Returns `{ handled: false }` when no session is active (orchestrator falls
   * back to file-based nudges). Once the child is killed the caller must:
   *   1. Emit a `builder.aborted-for-nudge` event.
   *   2. On the next builder invocation, pass `resume: sessionId` and prepend
   *      `"OPERATOR NUDGE:\n{nudgeText}\n\n"` to the prompt.
   */
  queueNudge(text: string): NudgeOutcome {
    if (!this.activeChild || !this.lastSessionId) {
      return { handled: false };
    }
    const sessionId = this.lastSessionId;
    this.activeChild.kill("SIGTERM");
    return {
      handled: true,
      via: "abort-resume",
      sessionId,
      nudgeText: text,
    };
  }

  /**
   * Abort the running codex exec process via SIGTERM.
   * Returns the session ID of the killed session, or null.
   */
  abortSession(): string | null {
    const sid = this.lastSessionId;
    if (this.activeChild && !this.activeChild.killed) {
      this.activeChild.kill("SIGTERM");
    }
    return sid;
  }

  supportsResume(): boolean {
    return true;
  }

  supportsMcpServers(): boolean {
    return true;
  }

  nudgeStrategy(): "stream" | "abort-resume" | "none" {
    return "abort-resume";
  }

  supportsOutputSchema(): boolean {
    return true;
  }
}
