/**
 * Backend abstraction layer: types and interfaces.
 *
 * Decouples harness orchestration from the Claude Agent SDK so that:
 *   - Tests can replay deterministic scripts (FakeBackend)
 *   - The real SDK is only imported in one place (ClaudeSdkBackend)
 *   - Future SDK changes are contained to a single adapter
 *
 * Reference: plan Phase 2, TAD sections 8/19
 */

// ------------------------------------
// Normalized message from an agent session
// ------------------------------------

export interface AgentMessage {
  /** Top-level message kind. Maps to SDK system/assistant/result. */
  type: "system" | "assistant" | "result";

  /** Sub-classification (e.g. "init", "success", "error_max_turns"). */
  subtype?: string;

  /** Concatenated text content (from text blocks in assistant messages, or result text). */
  text?: string;

  /** Tool-use blocks extracted from assistant messages. */
  toolUses?: Array<{ name: string; input: unknown }>;

  /** Session ID captured from init or result messages. */
  sessionId?: string;

  /** True when the result indicates an error. */
  isError?: boolean;

  /** Number of turns completed (from result messages). */
  numTurns?: number;

  /** Total cost in USD (from result messages). */
  costUsd?: number;

  /** Raw SDK message preserved for logging and diagnostics. */
  raw?: unknown;
}

// ------------------------------------
// Options for starting an agent session
// ------------------------------------

export interface AgentSessionOptions {
  /** The prompt to send to the agent. */
  prompt: string;

  /** Working directory for the session. */
  cwd: string;

  /** Permission mode controlling tool approvals. */
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";

  /** Tools that execute without permission prompts. */
  allowedTools?: string[];

  /** Tools removed from the model's context entirely. */
  disallowedTools?: string[];

  /** Hook callbacks passed through to the SDK. */
  hooks?: Record<string, unknown>;

  /** Maximum agentic turns before the SDK stops. */
  maxTurns?: number;

  /** Maximum spend in USD before the SDK stops. */
  maxBudgetUsd?: number;

  /** AbortController for cancelling the session. */
  abortController?: AbortController;

  /** Model to use (e.g. "claude-sonnet-4-6"). */
  model?: string;

  /**
   * Hint for backends about filesystem access level.
   * Claude backend ignores this (uses hooks for read-only enforcement).
   * Codex backend maps to --sandbox flag (OS-level enforcement).
   */
  sandboxMode?: "read-only" | "workspace-write";

  /**
   * Additional options passed through to the SDK.
   * Explicitly typed fields above take precedence.
   */
  [key: string]: unknown;
}

// ------------------------------------
// Backend interface
// ------------------------------------

export interface AgentBackend {
  /**
   * Run an agent session, yielding normalized messages.
   *
   * Callers iterate with `for await (const msg of backend.runSession(opts))`.
   * The generator completes when the SDK session ends or an error occurs.
   *
   * Between yielding messages, the backend drains any pending nudges
   * from the nudge queue and injects them via streamInput().
   */
  runSession(options: AgentSessionOptions): AsyncGenerator<AgentMessage>;

  /**
   * Return the session ID captured from the most recent init or result message.
   * Returns null if no session has been run yet.
   */
  getLastSessionId(): string | null;

  /**
   * Queue a user message to be injected into the currently running session.
   * The message will be delivered via streamInput() from within the
   * for-await loop — the correct async context for the SDK.
   *
   * Returns true if a session is active and the message was queued.
   * Returns false if no session is running (caller should use file fallback).
   */
  queueNudge(text: string): boolean;

  /**
   * Abort the currently running query session.
   * The for-await loop will terminate and runSession() will complete.
   * Returns the session ID of the killed session (for resume/fork), or null.
   */
  abortSession(): string | null;
}
