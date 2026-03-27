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
import type { AgentBackend, AgentMessage, AgentSessionOptions } from "./types.js";

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

function normalize(msg: SDKMessage): AgentMessage | null {
  switch (msg.type) {
    case "system": {
      if (!("subtype" in msg)) return null;
      const sub = (msg as { subtype?: string }).subtype;
      if (sub !== "init") return null;
      return {
        type: "system",
        subtype: "init",
        sessionId: "session_id" in msg ? String(msg.session_id) : undefined,
        raw: msg,
      };
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

    default:
      return null;
  }
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
      ...rest
    } = opts;

    const options: Options = {
      cwd,
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
        if (normalized == null) continue;

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

  queueNudge(text: string): boolean {
    if (!this.activeQuery || !this.sessionId) {
      return false;
    }
    this.nudgeQueue.push(text);
    return true;
  }

  abortSession(): string | null {
    const sid = this.sessionId;
    if (this.activeQuery) {
      this.activeQuery.close();
      // The for-await loop will terminate, finally block will clean up
    }
    return sid;
  }
}
