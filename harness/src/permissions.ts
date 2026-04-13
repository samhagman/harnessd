/**
 * Permission policies for different harness roles.
 *
 * Extracted and generalized from the original hooks.ts.
 * Provides PreToolUse hooks and tool restriction lists per TAD section 15.
 *
 * Roles and their access:
 * - Planner:          read-only (no repo writes, no mutating bash/git)
 * - Contract builder:  read-only
 * - Contract evaluator: read-only
 * - Builder:           full write access, dangerous ops blocked
 * - Evaluator:         read-only (structurally enforced)
 */

import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

// ------------------------------------
// Command classification
// ------------------------------------

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "tag", // read-only when not creating
]);

const BUILDER_ALLOWED_GIT = new Set([
  ...READONLY_GIT_SUBCOMMANDS,
  "add",
  "commit",
  "stash",
  "checkout", // for file restoration
  "restore",
]);

const DANGEROUS_COMMANDS = [
  /\brm\s+-rf?\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+fetch\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+force-push\b/,
  /\bnpm\s+publish\b/,
  /\bdocker\s+push\b/,
  /\bkubectl\s+delete\b/,
  /\baws\s+s3\s+rm\b/,
  /\baws\s+.*--delete\b/,
  /\bdropdb\b/,
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
];

const MUTATING_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bmv\b/,
  /\bcp\b.*>/,  // cp with redirect (overwrite)
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\btee\b/,
  /\bsed\s+-i\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+uninstall\b/,
  /\bnpm\s+publish\b/,
  /\bpip\s+install\b/,
  /\bapt\s+install\b/,
  /\bbrew\s+install\b/,
  />\s*\S/,  // any output redirect
  /\|\s*tee\b/,
];

export interface CommandCheck {
  blocked: boolean;
  reason?: string;
}

/** Check if a bash command is broadly destructive (should be blocked everywhere) */
export function isDangerousCommand(cmd: string): CommandCheck {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(cmd)) {
      return {
        blocked: true,
        reason: `Blocked dangerous command: ${cmd}`,
      };
    }
  }
  return { blocked: false };
}

/** Check if a bash command mutates the filesystem or installs packages */
export function isMutatingCommand(cmd: string): CommandCheck {
  // First check git specifically
  const gitCheck = getGitSubcommand(cmd);
  if (gitCheck && !READONLY_GIT_SUBCOMMANDS.has(gitCheck)) {
    return {
      blocked: true,
      reason: `Blocked mutating git command: git ${gitCheck}. Only read-only git commands allowed.`,
    };
  }

  for (const pattern of MUTATING_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        blocked: true,
        reason: `Blocked mutating command: ${cmd}`,
      };
    }
  }

  return { blocked: false };
}

/** Check if a git command is read-only */
export function isReadOnlyGitCommand(cmd: string): boolean {
  const sub = getGitSubcommand(cmd);
  if (sub === null) return true; // not a git command at all
  return READONLY_GIT_SUBCOMMANDS.has(sub);
}

/** Check if a git command is allowed for the builder role */
export function isBuilderAllowedGitCommand(cmd: string): boolean {
  const sub = getGitSubcommand(cmd);
  if (sub === null) return true; // not a git command
  return BUILDER_ALLOWED_GIT.has(sub);
}

function getGitSubcommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!/^git(\s|$)/.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/);
  return parts[1] ?? null;
}

// ------------------------------------
// PreToolUse hooks
// ------------------------------------

function denyResult(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Read-only hook: blocks ALL repo writes.
 * Used for evaluator, planner, and contract roles.
 */
export function makeReadOnlyHook(): HookCallback {
  return async (input, _toolUseId, _ctx) => {
    if (!input || (input as any).hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;

    // Block write tools entirely
    if (pre.tool_name === "Write" || pre.tool_name === "Edit" || pre.tool_name === "MultiEdit" || pre.tool_name === "NotebookEdit") {
      return denyResult(
        `Blocked: ${pre.tool_name} is not allowed in read-only mode.`,
      );
    }

    // For Bash, block mutating commands
    if (pre.tool_name === "Bash") {
      const cmd = String((pre.tool_input as any)?.command ?? "");
      const mutating = isMutatingCommand(cmd);
      if (mutating.blocked) {
        return denyResult(mutating.reason ?? "Mutating command blocked in read-only mode.");
      }
    }

    return {}; // allow
  };
}

/**
 * Builder hook: allows repo writes but blocks dangerous destructive operations.
 */
export function makeBuilderHook(): HookCallback {
  return async (input, _toolUseId, _ctx) => {
    if (!input || (input as any).hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;

    if (pre.tool_name === "Bash") {
      const cmd = String((pre.tool_input as any)?.command ?? "");

      // Block dangerous commands
      const dangerous = isDangerousCommand(cmd);
      if (dangerous.blocked) {
        return denyResult(dangerous.reason ?? "Dangerous command blocked.");
      }

      // Check git commands against builder allowlist
      const gitSub = getGitSubcommand(cmd);
      if (gitSub && !BUILDER_ALLOWED_GIT.has(gitSub)) {
        return denyResult(
          `Blocked git ${gitSub}. Builder may only use: ${[...BUILDER_ALLOWED_GIT].join(", ")}.`,
        );
      }
    }

    return {}; // allow
  };
}

/** Alias for makeReadOnlyHook with evaluator-specific context */
export const makeEvaluatorHook = makeReadOnlyHook;

/** Alias for makeReadOnlyHook with planner-specific context */
export const makePlannerHook = makeReadOnlyHook;

// ------------------------------------
// Tool restriction lists (for SDK options)
// ------------------------------------

/** Tools allowed for read-only roles (planner, contract builder/evaluator, evaluator) */
export const READ_ONLY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",  // allowed but policed by hook
  "Agent", // read-only subagents
];

/** Tools explicitly denied for read-only roles */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
];

/** Tools explicitly denied for builder role */
export const BUILDER_DISALLOWED_TOOLS: string[] = [
  // Builder can use most tools; dangerous ops handled by hook
];
