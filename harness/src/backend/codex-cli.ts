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
 * - queueNudge() returns false (codex exec is batch, no stdin injection)
 * - abortSession() sends SIGTERM to the child process
 *
 * Reference: plan Phase 1, PAL codex parser at inspiration/pal-mcp-server/clink/parsers/codex.py
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentBackend, AgentMessage, AgentSessionOptions } from "./types.js";

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
export function parseCodexLine(line: string): AgentMessage | null {
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

  return mapCodexEvent(event);
}

/**
 * Map a parsed Codex JSONL event to an AgentMessage.
 * Returns null for event types we don't handle.
 */
function mapCodexEvent(event: CodexEvent): AgentMessage | null {
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

      // Agent message with text content
      if (itemType === "agent_message" || itemType === "message") {
        const text = extractItemText(item);
        const role = item.role as string | undefined;
        // Only capture assistant messages, not tool results
        if (role && role !== "assistant") return null;
        if (!text) return null;
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
        if (output) summaryParts.push(output.length > 2000 ? output.slice(0, 2000) + "...[truncated]" : output);
        if (stderr) summaryParts.push(`stderr: ${stderr.length > 500 ? stderr.slice(0, 500) + "..." : stderr}`);

        return {
          type: "tool_result" as const,
          subtype: "command_execution",
          text: summaryParts.join("\n"),
          toolResults: [{
            toolUseId: (item.id ?? "unknown") as string,
            output: output.length > 4000 ? output.slice(0, 4000) + "...[truncated]" : output,
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
    case "turn.started":
    case "thread.started":
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
 * Build the argument list for `codex exec --json`.
 * Exported for testing.
 */
export function buildCodexArgs(
  opts: AgentSessionOptions,
  config: CodexCliBackendConfig,
): string[] {
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

  // Model override (session option > backend config)
  const model = opts.model ?? config.model;
  if (model) {
    args.push("--model", model);
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
        const msg = parseCodexLine(line);
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
      if (exitCode === 0) {
        yield {
          type: "result",
          subtype: "success",
          isError: false,
          raw: { exitCode, stderr: stderrChunks.join("") },
        };
      } else {
        yield {
          type: "result",
          subtype: "error_max_turns",
          text: `Codex exited with code ${exitCode}. Stderr: ${stderrChunks.join("").slice(0, 1000)}`,
          isError: true,
          raw: { exitCode, stderr: stderrChunks.join("") },
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
   * Codex exec is batch — no stdin injection supported.
   * Returns false so the caller uses file-based fallback.
   */
  queueNudge(_text: string): boolean {
    return false;
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
}
