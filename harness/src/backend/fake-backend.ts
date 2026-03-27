/**
 * Deterministic test double for AgentBackend.
 *
 * Zero network calls, zero quota usage. Replays a scripted sequence
 * of AgentMessage objects so tests can exercise the orchestration
 * layer in isolation.
 *
 * Reference: plan Phase 2
 */

import type { AgentBackend, AgentMessage, AgentSessionOptions } from "./types.js";

// ------------------------------------
// Helpers
// ------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------
// FakeBackend
// ------------------------------------

export interface FakeBackendOptions {
  /** Delay in ms between yielding each message (default: 0). */
  delayMs?: number;
}

export class FakeBackend implements AgentBackend {
  private readonly script: AgentMessage[];
  private readonly delayMs: number;
  private lastSessionId: string | null = null;

  /** Record of all runSession calls for test assertions. */
  readonly calls: AgentSessionOptions[] = [];

  private constructor(script: AgentMessage[], options?: FakeBackendOptions) {
    this.script = script;
    this.delayMs = options?.delayMs ?? 0;
  }

  // ------------------------------------
  // Static factories
  // ------------------------------------

  /** Create a FakeBackend that replays the given messages in order. */
  static fromScript(
    messages: AgentMessage[],
    options?: FakeBackendOptions,
  ): FakeBackend {
    return new FakeBackend(messages, options);
  }

  /**
   * Create a FakeBackend from JSONL-like string lines.
   * Each line is parsed as JSON into an AgentMessage.
   * Empty lines and lines starting with // are skipped.
   */
  static fromTranscript(
    lines: string[],
    options?: FakeBackendOptions,
  ): FakeBackend {
    const messages: AgentMessage[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("//")) continue;
      messages.push(JSON.parse(trimmed) as AgentMessage);
    }
    return new FakeBackend(messages, options);
  }

  // ------------------------------------
  // Convenience builders for common test scenarios
  // ------------------------------------

  /** A minimal successful session: init → assistant text → success result. */
  static success(
    text: string,
    sessionId = "fake-session-001",
  ): FakeBackend {
    return FakeBackend.fromScript([
      { type: "system", subtype: "init", sessionId },
      { type: "assistant", text },
      {
        type: "result",
        subtype: "success",
        text,
        isError: false,
        numTurns: 1,
        costUsd: 0,
        sessionId,
      },
    ]);
  }

  /** A session that ends with an error result. */
  static error(
    errorText: string,
    sessionId = "fake-session-err",
  ): FakeBackend {
    return FakeBackend.fromScript([
      { type: "system", subtype: "init", sessionId },
      {
        type: "result",
        subtype: "error_during_execution",
        text: errorText,
        isError: true,
        numTurns: 0,
        sessionId,
      },
    ]);
  }

  // ------------------------------------
  // AgentBackend implementation
  // ------------------------------------

  async *runSession(opts: AgentSessionOptions): AsyncGenerator<AgentMessage> {
    this.calls.push(opts);

    for (const msg of this.script) {
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }

      // Track session ID just like the real backend
      if (msg.sessionId) {
        this.lastSessionId = msg.sessionId;
      }

      yield msg;
    }
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  /** Record of nudge messages queued via queueNudge(). */
  readonly nudgeMessages: string[] = [];

  queueNudge(text: string): boolean {
    this.nudgeMessages.push(text);
    return true;
  }

  abortSession(): string | null {
    return this.lastSessionId;
  }
}
