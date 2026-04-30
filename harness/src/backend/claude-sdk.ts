/**
 * Real AgentBackend implementation wrapping the Claude Agent SDK.
 *
 * This is the only file that imports from @anthropic-ai/claude-agent-sdk.
 * All SDK types stay contained here; the rest of the harness works with
 * the normalized AgentMessage interface from ./types.ts.
 *
 * Live nudges: the orchestrator calls queueNudge(text), and the for-await
 * loop inside runSession() drains the queue between message yields, calling
 * streamInput() from the correct async context.
 *
 * Reference: plan Phase 2
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentMessage, AgentSessionOptions, NudgeOutcome } from "./types.js";

// ------------------------------------
// Helpers: extract content from SDK assistant messages
// ------------------------------------

function extractText(msg: SDKMessage): string {
  if (msg.type !== "assistant") return "";
  const content = (msg as { message?: { content?: unknown[] } }).message
    ?.content;
  if (!Array.isArray(content)) return "";

  let out = "";
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      out += block.text;
    }
  }
  return out;
}

function extractToolUses(
  msg: SDKMessage,
): Array<{ name: string; input: unknown }> {
  if (msg.type !== "assistant") return [];
  const content = (msg as { message?: { content?: unknown[] } }).message
    ?.content;
  if (!Array.isArray(content)) return [];

  const uses: Array<{ name: string; input: unknown }> = [];
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "tool_use" &&
      "name" in block &&
      typeof block.name === "string"
    ) {
      uses.push({
        name: block.name,
        input: "input" in block ? block.input : undefined,
      });
    }
  }
  return uses;
}

// ------------------------------------
// SDK message → AgentMessage normalizer
// ------------------------------------

function normalize(msg: SDKMessage): AgentMessage {
  switch (msg.type) {
    case "system": {
      if (!("subtype" in msg)) break;
      const sub = (msg as { subtype?: string }).subtype;
      if (sub === "init") {
        return {
          type: "system",
          subtype: "init",
          sessionId: "session_id" in msg ? String(msg.session_id) : undefined,
          raw: msg,
        };
      }
      // Capture useful system subtypes as event markers
      if (sub === "api_retry" || sub === "compact_boundary" || sub === "task_notification") {
        return { type: "event", subtype: sub, raw: msg };
      }
      break;
    }

    case "assistant": {
      const text = extractText(msg);
      const toolUses = extractToolUses(msg);
      return {
        type: "assistant",
        text: text || undefined,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
        sessionId: "session_id" in msg ? String(msg.session_id) : undefined,
        raw: msg,
      };
    }

    case "result": {
      const r = msg as {
        subtype: string;
        is_error: boolean;
        num_turns: number;
        session_id: string;
        result?: string;
        total_cost_usd?: number;
      };
      return {
        type: "result",
        subtype: r.subtype,
        text: r.result ?? undefined,
        isError: r.is_error,
        numTurns: r.num_turns,
        costUsd: r.total_cost_usd,
        sessionId: r.session_id,
        raw: msg,
      };
    }

    case "user": {
      // Extract tool_result content blocks — these are tool outputs returned to the model
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        const toolResults: Array<{ toolUseId: string; output: string; isError?: boolean }> = [];
        for (const block of content) {
          if (
            block != null &&
            typeof block === "object" &&
            "type" in block &&
            block.type === "tool_result" &&
            "tool_use_id" in block &&
            typeof (block as { tool_use_id: unknown }).tool_use_id === "string"
          ) {
            const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            // Extract text output from the content field (may be string or array of blocks)
            let output = "";
            if (typeof b.content === "string") {
              output = b.content;
            } else if (Array.isArray(b.content)) {
              for (const inner of b.content) {
                if (
                  inner != null &&
                  typeof inner === "object" &&
                  "type" in inner &&
                  inner.type === "text" &&
                  "text" in inner &&
                  typeof (inner as { text: unknown }).text === "string"
                ) {
                  output += (inner as { text: string }).text;
                }
              }
            }
            toolResults.push({
              toolUseId: b.tool_use_id,
              output: output.slice(0, 4000),
              ...(b.is_error != null ? { isError: b.is_error } : {}),
            });
          }
        }
        if (toolResults.length > 0) {
          return {
            type: "tool_result",
            toolResults,
            sessionId: "session_id" in msg ? String((msg as { session_id?: unknown }).session_id) : undefined,
            raw: msg,
          };
        }
      }
      break;
    }
  }

  // Catch-all: preserve unknown/unhandled message types as events so nothing is silently dropped
  return { type: "event", subtype: (msg as { subtype?: string }).subtype ?? (msg as { type?: string }).type ?? "unknown", raw: msg };
}

// ------------------------------------
// ClaudeSdkBackend
// ------------------------------------

export class ClaudeSdkBackend implements AgentBackend {
  private lastSessionId: string | null = null;
  private sessionId: string | null = null;
  private activeQuery: Query | null = null;

  /** Pending nudge messages queued by queueNudge(), drained inside the for-await loop. */
  private nudgeQueue: string[] = [];

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    const {
      prompt,
      cwd,
      permissionMode,
      allowedTools,
      disallowedTools,
      hooks,
      maxTurns,
      maxBudgetUsd,
      abortController,
      model,
      effort,
      mcpServers,
      // outputSchemaPath is Codex-only; destructure to prevent it leaking into SDK options.
      outputSchemaPath: _outputSchemaPath,
      ...rest
    } = opts;

    const options: Options = {
      cwd,
      effort: (effort as Options["effort"]) ?? "high",
      ...(permissionMode != null ? { permissionMode } : {}),
      ...(allowedTools != null ? { allowedTools } : {}),
      ...(disallowedTools != null ? { disallowedTools } : {}),
      ...(hooks != null
        ? { hooks: hooks as Options["hooks"] }
        : {}),
      ...(maxTurns != null ? { maxTurns } : {}),
      ...(maxBudgetUsd != null ? { maxBudgetUsd } : {}),
      ...(abortController != null ? { abortController } : {}),
      ...(model != null ? { model } : {}),
      // mcpServers: AgentSessionOptions types this as Record<string, unknown> to accommodate
      // both Claude in-process MCP objects and LogicalMcpServerDescriptors. Claude runners
      // always pass in-process McpServerConfig objects here, so this cast is safe.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(mcpServers != null ? { mcpServers: mcpServers as any } : {}),
      ...rest,
    };

    if (permissionMode === "bypassPermissions") {
      (options as { allowDangerouslySkipPermissions?: boolean })
        .allowDangerouslySkipPermissions = true;
    }

    const q = query({ prompt, options });
    this.activeQuery = q;
    this.sessionId = null;
    this.nudgeQueue = [];

    try {
      for await (const sdkMsg of q) {
        const normalized = normalize(sdkMsg);

        if (normalized.sessionId) {
          this.lastSessionId = normalized.sessionId;
          this.sessionId = normalized.sessionId;
        }

        yield normalized;

        // === DRAIN NUDGE QUEUE ===
        // This runs between message yields — the correct async context for streamInput().
        while (this.nudgeQueue.length > 0 && this.sessionId) {
          const nudgeText = this.nudgeQueue.shift()!;
          try {
            const userMsg: SDKUserMessage = {
              type: "user",
              message: { role: "user", content: nudgeText },
              parent_tool_use_id: null,
              session_id: this.sessionId,
              priority: "next",
              timestamp: new Date().toISOString(),
            };
            await q.streamInput(async function* () {
              yield userMsg;
            }());
          } catch (err: unknown) {
            // streamInput failed — the nudge is lost from the live channel
            // but the file-based fallback already has it
            console.error(`[nudge] streamInput failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err: unknown) {
      const errorText =
        err instanceof Error ? err.message : String(err);
      yield {
        type: "result",
        subtype: "error_during_execution",
        text: errorText,
        isError: true,
        raw: { error: errorText, originalError: err },
      };
    } finally {
      this.activeQuery = null;
      this.sessionId = null;
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  queueNudge(text: string): NudgeOutcome {
    if (!this.activeQuery || !this.sessionId) {
      return { handled: false };
    }
    this.nudgeQueue.push(text);
    return { handled: true, via: "stream" };
  }

  abortSession(): string | null {
    const sid = this.sessionId;
    if (this.activeQuery) {
      this.activeQuery.close();
      // The for-await loop will terminate, finally block will clean up
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
    return "stream";
  }

  supportsOutputSchema(): boolean {
    // Claude uses prompt-level envelope instructions instead of output schemas.
    return false;
  }
}
