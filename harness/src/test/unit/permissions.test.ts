/**
 * Unit tests for permissions.ts — role-based permission hooks.
 */

import { describe, it, expect } from "vitest";

import {
  makeReadOnlyHook,
  makeBuilderHook,
  isDangerousCommand,
  isMutatingCommand,
} from "../../permissions.js";

// ------------------------------------
// Helpers
// ------------------------------------

/** Simulate a PreToolUse hook call and return the result */
async function callHook(
  hookFn: ReturnType<typeof makeReadOnlyHook>,
  toolName: string,
  toolInput: Record<string, unknown> = {},
) {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  };
  return hookFn(input as any, "tool-use-id-1", {} as any);
}

function isDenied(result: any): boolean {
  return result?.hookSpecificOutput?.permissionDecision === "deny";
}

function isAllowed(result: any): boolean {
  return !isDenied(result);
}

// ------------------------------------
// makeReadOnlyHook
// ------------------------------------

describe("makeReadOnlyHook", () => {
  const hook = makeReadOnlyHook();

  it("blocks Write tool", async () => {
    const result = await callHook(hook, "Write", { file_path: "/tmp/foo.txt", content: "bar" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks Edit tool", async () => {
    const result = await callHook(hook, "Edit", { file_path: "/tmp/foo.txt", old_string: "a", new_string: "b" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks rm -rf /tmp/foo", async () => {
    const result = await callHook(hook, "Bash", { command: "rm -rf /tmp/foo" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks git commit", async () => {
    const result = await callHook(hook, "Bash", { command: "git commit -m 'test'" });
    expect(isDenied(result)).toBe(true);
  });

  it("allows git status", async () => {
    const result = await callHook(hook, "Bash", { command: "git status" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows git diff", async () => {
    const result = await callHook(hook, "Bash", { command: "git diff HEAD" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows ls -la", async () => {
    const result = await callHook(hook, "Bash", { command: "ls -la" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows Read tool", async () => {
    const result = await callHook(hook, "Read", { file_path: "/tmp/foo.txt" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows Grep tool", async () => {
    const result = await callHook(hook, "Grep", { pattern: "foo" });
    expect(isAllowed(result)).toBe(true);
  });

  it("blocks npm install", async () => {
    const result = await callHook(hook, "Bash", { command: "npm install express" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks git push", async () => {
    const result = await callHook(hook, "Bash", { command: "git push origin main" });
    expect(isDenied(result)).toBe(true);
  });
});

// ------------------------------------
// makeBuilderHook
// ------------------------------------

describe("makeBuilderHook", () => {
  const hook = makeBuilderHook();

  it("allows Write tool (no check on Write for builder)", async () => {
    const result = await callHook(hook, "Write", { file_path: "/tmp/foo.txt", content: "bar" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows Edit tool", async () => {
    const result = await callHook(hook, "Edit", { file_path: "/tmp/foo.txt", old_string: "a", new_string: "b" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows git add", async () => {
    const result = await callHook(hook, "Bash", { command: "git add src/foo.ts" });
    expect(isAllowed(result)).toBe(true);
  });

  it("allows git commit", async () => {
    const result = await callHook(hook, "Bash", { command: "git commit -m 'implement feature'" });
    expect(isAllowed(result)).toBe(true);
  });

  it("blocks git push", async () => {
    const result = await callHook(hook, "Bash", { command: "git push origin main" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks rm -rf", async () => {
    const result = await callHook(hook, "Bash", { command: "rm -rf /" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks git clean", async () => {
    const result = await callHook(hook, "Bash", { command: "git clean -fd" });
    expect(isDenied(result)).toBe(true);
  });

  it("blocks git reset --hard", async () => {
    const result = await callHook(hook, "Bash", { command: "git reset --hard HEAD~1" });
    expect(isDenied(result)).toBe(true);
  });

  it("allows ls and cat commands", async () => {
    const lsResult = await callHook(hook, "Bash", { command: "ls -la" });
    expect(isAllowed(lsResult)).toBe(true);

    const catResult = await callHook(hook, "Bash", { command: "cat package.json" });
    expect(isAllowed(catResult)).toBe(true);
  });

  it("allows git status and git diff", async () => {
    const statusResult = await callHook(hook, "Bash", { command: "git status" });
    expect(isAllowed(statusResult)).toBe(true);

    const diffResult = await callHook(hook, "Bash", { command: "git diff" });
    expect(isAllowed(diffResult)).toBe(true);
  });
});

// ------------------------------------
// isDangerousCommand (exported utility)
// ------------------------------------

describe("isDangerousCommand", () => {
  it("flags rm -rf", () => {
    expect(isDangerousCommand("rm -rf /").blocked).toBe(true);
  });

  it("flags git push", () => {
    expect(isDangerousCommand("git push origin main").blocked).toBe(true);
  });

  it("flags npm publish", () => {
    expect(isDangerousCommand("npm publish").blocked).toBe(true);
  });

  it("does not flag ls", () => {
    expect(isDangerousCommand("ls -la").blocked).toBe(false);
  });

  it("does not flag git status", () => {
    expect(isDangerousCommand("git status").blocked).toBe(false);
  });
});

// ------------------------------------
// isMutatingCommand (exported utility)
// ------------------------------------

describe("isMutatingCommand", () => {
  it("flags rm", () => {
    expect(isMutatingCommand("rm foo.txt").blocked).toBe(true);
  });

  it("flags git add (mutating git)", () => {
    expect(isMutatingCommand("git add .").blocked).toBe(true);
  });

  it("does not flag git log", () => {
    expect(isMutatingCommand("git log --oneline").blocked).toBe(false);
  });

  it("does not flag cat", () => {
    expect(isMutatingCommand("cat README.md").blocked).toBe(false);
  });
});
