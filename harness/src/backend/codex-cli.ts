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
 * - queueNudge() sends SIGTERM and returns an abort-resume handle
 * - abortSession() sends SIGTERM to the child process
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
 * Logical MCP server descriptor — the common intermediate representation for
 * registering MCP servers with Codex via `-c mcp_servers.*` flags.
 *
 * buildCodexArgs() translates each entry to:
 *   -c mcp_servers.<name>.command="<command>"
 *   -c mcp_servers.<name>.args=[...]
 *   -c mcp_servers.<name>.env.KEY="v"   (per env var)
 *
 * Re-exported by mcp-descriptors.ts for callers outside the backend layer.
 */
export interface LogicalMcpServerDescriptor {
  command: string;
  args: string[];
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
 * Push -c mcp_servers.* flags for each LogicalMcpServerDescriptor in opts.mcpServers.
 * MCP servers are process-scoped, so these flags must be re-specified on every
 * invocation — including `codex exec resume`.
 *
 * Claude SDK in-process MCP objects (createSdkMcpServer() form) have no top-level
 * `command` field and are silently skipped by isLogicalMcpServerDescriptor().
 */
function pushMcpServerFlags(args: string[], mcpServers: Record<string, unknown>): void {
  for (const [name, cfg] of Object.entries(mcpServers)) {
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

/**
 * Build the argument list for `codex exec --json`.
 * Exported for testing.
 *
 * Resume branch uses `codex exec resume <sessionId>` instead of `codex exec`.
 * Flags unavailable on resume (--output-schema, --sandbox, --cd) are omitted —
 * the session carries them in server-side state. Flags that are process-scoped
 * (-c mcp_servers.*, -c model_reasoning_effort) must be re-specified on every
 * invocation including resume.
 */
export function buildCodexArgs(
  opts: AgentSessionOptions,
  config: CodexCliBackendConfig,
): string[] {
  // Session model: ignore Claude model names — Codex only accepts GPT models.
  const sessionModel = opts.model && !opts.model.startsWith("claude-") ? opts.model : undefined;
  const resolvedModel = sessionModel ?? config.model;

  if (opts.resume) {
    const args: string[] = ["exec", "resume", opts.resume, "--json"];

    if (resolvedModel) {
      args.push("--model", resolvedModel);
    }

    // Re-apply process-scoped config on every resume invocation.
    args.push("-c", "model_reasoning_effort=xhigh");
    if (opts.mcpServers) {
      pushMcpServerFlags(args, opts.mcpServers);
    }

    // Prompt is the last positional argument on resume.
    args.push(opts.prompt);
    return args;
  }

  const args: string[] = ["exec", "--json"];

  args.push(opts.prompt);

  if (opts.cwd) {
    args.push("--cd", opts.cwd);
  }

  // Evaluators/QA use "workspace-write" but need access to ~/Library/Caches/ for
  // Playwright and curl cookie jars — so no --sandbox flag for workspace-write.
  // Prompt-enforced restrictions + hooks cover read-only enforcement for Claude roles.
  if ((opts.sandboxMode ?? "workspace-write") === "read-only") {
    args.push("--sandbox", "read-only");
    args.push("-c", "sandbox_read_only.network_access=true");
  }

  if (resolvedModel) {
    args.push("--model", resolvedModel);
  }

  args.push("-c", "model_reasoning_effort=xhigh");

  if (opts.mcpServers) {
    pushMcpServerFlags(args, opts.mcpServers);
  }

  // Structured output schema — Codex emits a final_answer payload instead of free-form
  // text; runSession() synthesizes it into an envelope-wrapped AgentMessage so
  // downstream callers (worker.ts:extractEnvelope) stay unchanged.
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
      child.stderr?.removeAllListeners("data");
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

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
