/**
 * BackendFactory: per-role backend selection.
 *
 * The harness orchestrator uses this to get the right AgentBackend
 * for each worker role. By default all roles use the Claude SDK backend.
 * Roles configured as "codex" get a fresh CodexCliBackend instance.
 *
 * Usage:
 *   const claude = new ClaudeSdkBackend();
 *   const factory = new BackendFactory(claude, {
 *     roleBackends: { evaluator: "codex", qa_agent: "codex" },
 *     codexModel: "o3",
 *   });
 *   const backend = factory.forRole("evaluator"); // → CodexCliBackend
 *   const backend2 = factory.forRole("builder");  // → claude
 *
 * Reference: plan Phase 1
 */

import type { AgentBackend } from "./types.js";
import { CodexCliBackend } from "./codex-cli.js";
import type { RoleBackendMap, BackendType } from "../schemas.js";

// ------------------------------------
// Factory configuration
// ------------------------------------

export interface BackendFactoryConfig {
  /** Per-role backend selection. Missing roles default to "claude". */
  roleBackends: RoleBackendMap;
  /** Model for Codex CLI backend (e.g. "o3", "o4-mini"). */
  codexModel?: string;
}

// ------------------------------------
// BackendFactory
// ------------------------------------

export class BackendFactory {
  private claude: AgentBackend;
  private config: BackendFactoryConfig;

  constructor(claude: AgentBackend, config: BackendFactoryConfig) {
    this.claude = claude;
    this.config = config;
  }

  /**
   * Create a factory that returns the same backend for all roles.
   * Used for backward compatibility when callers pass a plain AgentBackend.
   */
  static fromSingleBackend(backend: AgentBackend): BackendFactory {
    return new BackendFactory(backend, { roleBackends: {} });
  }

  /**
   * Get the appropriate backend for a given worker role.
   * Returns the Claude backend by default; returns a fresh CodexCliBackend
   * for roles configured as "codex".
   */
  forRole(role: string): AgentBackend {
    const backendType =
      (this.config.roleBackends as Record<string, BackendType | undefined>)[role] ?? "claude";
    if (backendType === "codex") {
      return new CodexCliBackend({ model: this.config.codexModel });
    }
    return this.claude;
  }

  /**
   * Direct access to the Claude backend.
   * Used for nudge polling (only Claude supports live nudges via streamInput).
   */
  get claudeBackend(): AgentBackend {
    return this.claude;
  }
}
