/**
 * Verifier PreToolUse hook — guardrails for the verifier agent.
 *
 * The verifier CAN edit any files (code, tests, docs, plan files).
 * The verifier CANNOT:
 *   - Delete files via Bash (rm, rmdir, unlink, git clean)
 *   - Run mutating or network git commands (only status/diff/log/show allowed)
 *   - [TBD: Add domain-specific restrictions]
 */

import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

const READONLY_GIT = new Set(["status", "diff", "log", "show"]);

function isDangerousGit(cmd: string): { deny: boolean; reason?: string } {
  const trimmed = cmd.trim();
  if (!/^git(\s|$)/.test(trimmed)) return { deny: false };

  const parts = trimmed.split(/\s+/);
  const sub = parts[1] ?? "";

  if (READONLY_GIT.has(sub)) return { deny: false };

  return {
    deny: true,
    reason: `Blocked git command: git ${sub || "(unknown)"}. Only git status/diff/log/show are allowed.`,
  };
}

function isDeleteCommand(cmd: string): { deny: boolean; reason?: string } {
  if (/\brm\b/.test(cmd) || /\brmdir\b/.test(cmd) || /\bunlink\b/.test(cmd)) {
    return {
      deny: true,
      reason:
        "Blocked: rm/rmdir/unlink commands are not allowed in verifier mode.",
    };
  }
  if (/\bgit\s+clean\b/.test(cmd)) {
    return {
      deny: true,
      reason:
        "Blocked: git clean (deletes files) is not allowed in verifier mode.",
    };
  }
  return { deny: false };
}

// TBD: Add domain-specific dangerous command detection
function isDangerousDomainCommand(cmd: string): {
  deny: boolean;
  reason?: string;
} {
  // Example: Block commands that could delete cloud resources
  // if (/\baws\s+s3\s+rm\b/.test(cmd)) {
  //   return {
  //     deny: true,
  //     reason: "Blocked: aws s3 rm is not allowed in verifier mode.",
  //   };
  // }

  // Example: Block Modal secret deletion
  // if (/\bmodal\s+secret\s+delete\b/.test(cmd)) {
  //   return {
  //     deny: true,
  //     reason: "Blocked: modal secret delete is not allowed in verifier mode.",
  //   };
  // }

  return { deny: false };
}

export function makeVerifierPreToolUseHook(): HookCallback {
  const hook: HookCallback = async (input, _toolUseId, _ctx) => {
    if (!input || (input as any).hook_event_name !== "PreToolUse") return {};

    const pre = input as PreToolUseHookInput;

    // Only police Bash commands
    if (pre.tool_name !== "Bash") return {};

    const cmd = String((pre.tool_input as any)?.command ?? "");

    const del = isDeleteCommand(cmd);
    if (del.deny) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "deny" as const,
          permissionDecisionReason: del.reason ?? "Delete blocked",
        },
      };
    }

    const git = isDangerousGit(cmd);
    if (git.deny) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "deny" as const,
          permissionDecisionReason: git.reason ?? "Git command blocked",
        },
      };
    }

    const domain = isDangerousDomainCommand(cmd);
    if (domain.deny) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "deny" as const,
          permissionDecisionReason: domain.reason ?? "Domain command blocked",
        },
      };
    }

    return {}; // allow
  };

  return hook;
}
