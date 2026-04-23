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
// Nudge outcome union — returned by queueNudge()
// ------------------------------------

/**
 * Describes how (or whether) a nudge was handled by the backend.
 *
 * - `{ handled: true; via: "stream" }` — nudge was queued for live streamInput injection (Claude SDK).
 * - `{ handled: true; via: "abort-resume"; sessionId; nudgeText }` — session was aborted; caller should
 *   resume with the nudge text prepended to the next prompt (Codex abort+resume flow).
 * - `{ handled: false }` — no active session; caller should use file-based fallback.
 */
export type NudgeOutcome =
  | { handled: true; via: "stream" }
  | { handled: true; via: "abort-resume"; sessionId: string; nudgeText: string }
  | { handled: false };

// ------------------------------------
// Normalized message from an agent session
// ------------------------------------

export interface AgentMessage {
  /**
   * Top-level message kind.
   * - "system" / "assistant" / "result" — original types (SDK session lifecycle)
   * - "tool_result" — tool outputs returned to the model (what the tool returned)
   * - "event" — lightweight state-change markers (turn boundaries, status events)
   */
  type: "system" | "assistant" | "result" | "tool_result" | "event";

  /** Sub-classification (e.g. "init", "success", "error_max_turns", "command_execution"). */
  subtype?: string;

  /** Concatenated text content (from text blocks in assistant messages, or result text). */
  text?: string;

  /** Tool-use blocks extracted from assistant messages. */
  toolUses?: Array<{ name: string; input: unknown }>;

  /** Tool results returned to the model (output truncated to 4000 chars; full content in raw). */
  toolResults?: Array<{ toolUseId: string; output: string; isError?: boolean }>;

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
   * Session ID to resume. Loads full conversation history from a prior session.
   * - Claude SDK backend: native resume via `resume: sessionId`.
   * - Codex backend: honored via `codex exec resume <sessionId>` (Phase 1).
   */
  resume?: string;

  /**
   * MCP servers to register with the agent session.
   *
   * Shape depends on the backend:
   * - Claude SDK (supportsMcpServers: true, kind: "claude"): accepts both the
   *   in-process createSdkMcpServer() form and the LogicalMcpServerDescriptor form.
   * - Codex CLI (supportsMcpServers: true, kind: "codex"): only accepts the
   *   LogicalMcpServerDescriptor form `{ command, args, env? }`, which is translated
   *   to `-c mcp_servers.<name>.* ` flags in buildCodexArgs().
   *
   * Use LogicalMcpServerDescriptors (from mcp-descriptors.ts) as the common
   * intermediate representation that both backends accept.
   */
  mcpServers?: Record<string, unknown>;

  /**
   * Absolute path to a JSON Schema file for structured output.
   * - Codex backend: passed as `--output-schema <path>` flag.
   *   When set, Codex emits a `final_answer` item whose payload is the structured
   *   JSON. The backend synthesizes this into an envelope-wrapped AgentMessage so
   *   downstream callers (worker.ts:extractEnvelope) stay unchanged.
   * - Claude SDK backend: ignored (Claude uses prompt-level envelope instructions).
   *
   * Gate the pass-through on `backend.supportsOutputSchema()`.
   */
  outputSchemaPath?: string;

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
   *
   * - Claude SDK backend: delivered via streamInput() from within the for-await loop.
   * - Codex backend (Phase 3): aborts the child process and returns an abort-resume handle;
   *   the caller is responsible for resuming with the nudge text prepended to the prompt.
   * - FakeBackend / no active session: returns `{ handled: false }` so callers use file fallback.
   *
   * Returns a NudgeOutcome describing how the nudge was handled.
   */
  queueNudge(text: string): NudgeOutcome;

  /**
   * Abort the currently running query session.
   * The for-await loop will terminate and runSession() will complete.
   * Returns the session ID of the killed session (for resume/fork), or null.
   */
  abortSession(): string | null;

  /**
   * Whether this backend supports native session resume via `opts.resume`.
   * - Claude SDK: true (native `resume: sessionId`).
   * - Codex CLI: true (via `codex exec resume <sessionId>`).
   * - FakeBackend: true (simulates resume by accepting opts.resume without error).
   */
  supportsResume(): boolean;

  /**
   * Whether this backend supports in-process MCP server registration.
   * - Claude SDK: true (mcpServers passed to SDK options).
   * - Codex CLI: true (Phase 2: translated to -c mcp_servers.* flags).
   * - FakeBackend: false (MCP registration is a no-op in tests).
   */
  supportsMcpServers(): boolean;

  /**
   * How nudges are delivered to this backend.
   * - "stream": live streamInput() injection mid-session (Claude SDK).
   * - "abort-resume": abort the child process; caller resumes with nudge text (Codex, Phase 3).
   * - "none": backend does not support live nudges; use file-based fallback.
   */
  nudgeStrategy(): "stream" | "abort-resume" | "none";

  /**
   * Whether this backend supports structured output via an output schema file.
   * - Codex CLI: true (passes --output-schema flag and synthesizes envelope from final_answer).
   * - Claude SDK: false (Claude uses prompt-level envelope instructions instead).
   * - FakeBackend: false (tests use envelope-in-text approach by default).
   */
  supportsOutputSchema(): boolean;
}
