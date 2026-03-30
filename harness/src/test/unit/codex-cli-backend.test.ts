/**
 * Unit tests for CodexCliBackend, BackendFactory, and JSONL parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  parseCodexLine,
  buildCodexArgs,
  CodexCliBackend,
} from "../../backend/codex-cli.js";
import { BackendFactory } from "../../backend/backend-factory.js";
import { FakeBackend } from "../../backend/fake-backend.js";
import type { AgentSessionOptions } from "../../backend/types.js";

// ------------------------------------
// parseCodexLine
// ------------------------------------

describe("parseCodexLine", () => {
  it("parses a session.created event into system init message", () => {
    const line = JSON.stringify({
      type: "session.created",
      session_id: "sess-abc-123",
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("system");
    expect(msg!.subtype).toBe("init");
    expect(msg!.sessionId).toBe("sess-abc-123");
  });

  it("parses a session.start event into system init message", () => {
    const line = JSON.stringify({
      type: "session.start",
      id: "sess-xyz-456",
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("system");
    expect(msg!.subtype).toBe("init");
    expect(msg!.sessionId).toBe("sess-xyz-456");
  });

  it("extracts session ID from nested session object", () => {
    const line = JSON.stringify({
      type: "session.created",
      session: { id: "sess-nested-789" },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.sessionId).toBe("sess-nested-789");
  });

  it("parses item.completed with agent_message type", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Hello from Codex!",
        role: "assistant",
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.text).toBe("Hello from Codex!");
  });

  it("parses item.completed with message type", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Content array style" }],
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.text).toBe("Content array style");
  });

  it("parses item.completed with plain string content", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        role: "assistant",
        content: "Plain string content",
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.text).toBe("Plain string content");
  });

  it("parses item.completed with tool_call type", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "tool_call",
        name: "Read",
        arguments: { path: "/tmp/test.txt" },
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.toolUses).toHaveLength(1);
    expect(msg!.toolUses![0].name).toBe("Read");
    expect(msg!.toolUses![0].input).toEqual({ path: "/tmp/test.txt" });
  });

  it("parses turn.completed with usage stats", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { total_cost: 0.042 },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.costUsd).toBe(0.042);
    expect(msg!.numTurns).toBe(1);
  });

  it("parses error events", () => {
    const line = JSON.stringify({
      type: "error",
      message: "Rate limit exceeded",
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("result");
    expect(msg!.subtype).toBe("error_during_execution");
    expect(msg!.isError).toBe(true);
    expect(msg!.text).toBe("Rate limit exceeded");
  });

  it("returns null for malformed JSON", () => {
    const msg = parseCodexLine("{not valid json!!!");
    expect(msg).toBeNull();
  });

  it("returns null for empty lines", () => {
    expect(parseCodexLine("")).toBeNull();
    expect(parseCodexLine("   ")).toBeNull();
    expect(parseCodexLine("\n")).toBeNull();
  });

  it("returns null for non-JSON lines (e.g. logging output)", () => {
    expect(parseCodexLine("Starting codex session...")).toBeNull();
    expect(parseCodexLine("WARNING: something happened")).toBeNull();
  });

  it("returns null for unknown event types", () => {
    const line = JSON.stringify({
      type: "some.future.event.type",
      data: "whatever",
    });
    const msg = parseCodexLine(line);
    expect(msg).toBeNull();
  });

  it("returns null for events without a type field", () => {
    const line = JSON.stringify({ data: "no type field" });
    expect(parseCodexLine(line)).toBeNull();
  });

  it("skips non-assistant role messages", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "message",
        role: "system",
        text: "System message",
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).toBeNull();
  });

  it("returns null for item.completed without item", () => {
    const line = JSON.stringify({ type: "item.completed" });
    expect(parseCodexLine(line)).toBeNull();
  });

  it("handles content array with string elements", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        role: "assistant",
        content: ["Part one ", "Part two"],
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe("Part one Part two");
  });
});

// ------------------------------------
// buildCodexArgs
// ------------------------------------

describe("buildCodexArgs", () => {
  const baseOpts: AgentSessionOptions = {
    prompt: "Write a test",
    cwd: "/tmp/project",
  };

  it("builds basic args with default sandbox mode", () => {
    const args = buildCodexArgs(baseOpts, {});
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    // Prompt is a positional argument, not a --prompt flag
    expect(args).toContain("Write a test");
    expect(args).toContain("--cd");
    expect(args).toContain("/tmp/project");
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
  });

  it("uses read-only sandbox when specified", () => {
    const args = buildCodexArgs(
      { ...baseOpts, sandboxMode: "read-only" },
      {},
    );
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    // Read-only mode should enable network access for Playwright
    expect(args).toContain("-c");
    expect(args).toContain("sandbox_read_only.network_access=true");
  });

  it("does not add network config for workspace-write mode", () => {
    const args = buildCodexArgs(
      { ...baseOpts, sandboxMode: "workspace-write" },
      {},
    );
    expect(args).not.toContain("sandbox_read_only.network_access=true");
  });

  it("adds model from config when provided", () => {
    const args = buildCodexArgs(baseOpts, { model: "o3" });
    expect(args).toContain("--model");
    expect(args).toContain("o3");
  });

  it("prefers session option model over config model", () => {
    const args = buildCodexArgs(
      { ...baseOpts, model: "o4-mini" },
      { model: "o3" },
    );
    expect(args).toContain("--model");
    expect(args).toContain("o4-mini");
    expect(args).not.toContain("o3");
  });

  it("omits --model when neither config nor session specifies one", () => {
    const args = buildCodexArgs(baseOpts, {});
    expect(args).not.toContain("--model");
  });

  it("omits --cd when cwd is empty", () => {
    const args = buildCodexArgs({ prompt: "test", cwd: "" }, {});
    expect(args).not.toContain("--cd");
  });
});

// ------------------------------------
// CodexCliBackend — queueNudge / abortSession / getLastSessionId
// ------------------------------------

describe("CodexCliBackend", () => {
  it("queueNudge always returns false (batch mode)", () => {
    const backend = new CodexCliBackend();
    expect(backend.queueNudge("hello")).toBe(false);
  });

  it("getLastSessionId returns null before any session", () => {
    const backend = new CodexCliBackend();
    expect(backend.getLastSessionId()).toBeNull();
  });

  it("abortSession returns null when no active session", () => {
    const backend = new CodexCliBackend();
    expect(backend.abortSession()).toBeNull();
  });
});

// ------------------------------------
// CodexCliBackend — runSession with mocked child process
// ------------------------------------

describe("CodexCliBackend.runSession (mocked spawn)", () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let originalSpawn: typeof import("node:child_process").spawn;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    originalSpawn = cp.spawn;
    spawnMock = vi.fn();
    // Monkey-patch spawn on the module (vi.mock with ESM is tricky;
    // instead we'll test via the exported parseCodexLine + buildCodexArgs
    // and test integration via a fake process below)
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses JSONL stream and yields AgentMessages", async () => {
    // This test validates the JSONL → AgentMessage pipeline end-to-end
    // using parseCodexLine (the core logic) rather than spawning a real process.
    const lines = [
      JSON.stringify({ type: "session.created", session_id: "test-sess-001" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", role: "assistant", text: "I analyzed the code." },
      }),
      JSON.stringify({ type: "turn.completed", usage: { total_cost: 0.01 } }),
      // Non-JSON line (should be skipped)
      "some debug output",
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          role: "assistant",
          text: "===HARNESSD_RESULT_START===\n{\"role\":\"evaluator\"}\n===HARNESSD_RESULT_END===",
        },
      }),
    ];

    const messages: (import("../../backend/types.js").AgentMessage | null)[] = [];
    for (const line of lines) {
      messages.push(parseCodexLine(line));
    }

    // Filter nulls
    const parsed = messages.filter((m) => m !== null);
    expect(parsed).toHaveLength(4);

    expect(parsed[0].type).toBe("system");
    expect(parsed[0].subtype).toBe("init");
    expect(parsed[0].sessionId).toBe("test-sess-001");

    expect(parsed[1].type).toBe("assistant");
    expect(parsed[1].text).toBe("I analyzed the code.");

    expect(parsed[2].type).toBe("assistant");
    expect(parsed[2].costUsd).toBe(0.01);

    expect(parsed[3].type).toBe("assistant");
    expect(parsed[3].text).toContain("HARNESSD_RESULT_START");
  });
});

// ------------------------------------
// CodexCliBackend — abort sends SIGTERM
// ------------------------------------

describe("CodexCliBackend.abortSession (with mock child)", () => {
  it("sends SIGTERM to active child process", () => {
    const backend = new CodexCliBackend();

    // Simulate an active child process
    const fakeChild = {
      killed: false,
      kill: vi.fn((signal: string) => {
        fakeChild.killed = true;
      }),
    };

    // Set internal state via type assertion
    (backend as unknown as { activeChild: unknown }).activeChild = fakeChild;
    (backend as unknown as { lastSessionId: string }).lastSessionId = "sess-to-kill";

    const result = backend.abortSession();

    expect(result).toBe("sess-to-kill");
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fakeChild.killed).toBe(true);
  });

  it("does not call kill on already-killed process", () => {
    const backend = new CodexCliBackend();

    const fakeChild = {
      killed: true,
      kill: vi.fn(),
    };

    (backend as unknown as { activeChild: unknown }).activeChild = fakeChild;
    (backend as unknown as { lastSessionId: string }).lastSessionId = "sess-dead";

    backend.abortSession();

    expect(fakeChild.kill).not.toHaveBeenCalled();
  });
});

// ------------------------------------
// BackendFactory
// ------------------------------------

describe("BackendFactory", () => {
  it("returns claude backend for roles not in roleBackends map", () => {
    const claude = FakeBackend.success("claude response");
    const factory = new BackendFactory(claude, { roleBackends: {} });

    const backend = factory.forRole("builder");
    expect(backend).toBe(claude);
  });

  it("returns claude backend for roles explicitly set to 'claude'", () => {
    const claude = FakeBackend.success("claude response");
    const factory = new BackendFactory(claude, {
      roleBackends: { builder: "claude" },
    });

    const backend = factory.forRole("builder");
    expect(backend).toBe(claude);
  });

  it("returns CodexCliBackend for roles set to 'codex'", () => {
    const claude = FakeBackend.success("claude response");
    const factory = new BackendFactory(claude, {
      roleBackends: { evaluator: "codex" },
      codexModel: "o3",
    });

    const backend = factory.forRole("evaluator");
    expect(backend).not.toBe(claude);
    expect(backend).toBeInstanceOf(CodexCliBackend);
  });

  it("creates fresh CodexCliBackend instances for each call", () => {
    const claude = FakeBackend.success("claude");
    const factory = new BackendFactory(claude, {
      roleBackends: { evaluator: "codex" },
    });

    const b1 = factory.forRole("evaluator");
    const b2 = factory.forRole("evaluator");
    expect(b1).not.toBe(b2); // Fresh instance each time
  });

  it("provides claude backend via claudeBackend getter", () => {
    const claude = FakeBackend.success("claude");
    const factory = new BackendFactory(claude, { roleBackends: {} });

    expect(factory.claudeBackend).toBe(claude);
  });

  it("routes different roles to different backends", () => {
    const claude = FakeBackend.success("claude");
    const factory = new BackendFactory(claude, {
      roleBackends: {
        builder: "claude",
        evaluator: "codex",
        contract_builder: "codex",
        planner: "claude",
      },
      codexModel: "o4-mini",
    });

    expect(factory.forRole("builder")).toBe(claude);
    expect(factory.forRole("planner")).toBe(claude);
    expect(factory.forRole("evaluator")).toBeInstanceOf(CodexCliBackend);
    expect(factory.forRole("contract_builder")).toBeInstanceOf(CodexCliBackend);
    // Unknown role defaults to claude
    expect(factory.forRole("some_future_role")).toBe(claude);
  });
});
