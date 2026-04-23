/**
 * Unit tests for CodexCliBackend, BackendFactory, and JSONL parsing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

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

  it("captures unknown event types as 'event' messages (catch-all)", () => {
    const line = JSON.stringify({
      type: "some.future.event.type",
      data: "whatever",
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("event");
    expect(msg!.subtype).toBe("some.future.event.type");
    expect(msg!.raw).toEqual({ type: "some.future.event.type", data: "whatever" });
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
    // workspace-write does not pass --sandbox flag (inherits global config)
    expect(args).not.toContain("--sandbox");
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

  it("uses 'exec resume <sessionId>' form when opts.resume is set", () => {
    const args = buildCodexArgs({ ...baseOpts, resume: "sess-abc-123" }, {});
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("sess-abc-123");
    expect(args[3]).toBe("--json");
    // Prompt is the LAST positional arg (after any flags like -c reasoning, --model)
    expect(args[args.length - 1]).toBe("Write a test");
  });

  it("uses normal 'exec --json' form when opts.resume is not set", () => {
    const args = buildCodexArgs(baseOpts, {});
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("--json");
  });
});

// ------------------------------------
// CodexCliBackend — queueNudge / abortSession / getLastSessionId
// ------------------------------------

describe("CodexCliBackend", () => {
  it("queueNudge returns { handled: false } when no active session", () => {
    const backend = new CodexCliBackend();
    const outcome = backend.queueNudge("hello");
    expect(outcome.handled).toBe(false);
  });

  it("getLastSessionId returns null before any session", () => {
    const backend = new CodexCliBackend();
    expect(backend.getLastSessionId()).toBeNull();
  });

  it("abortSession returns null when no active session", () => {
    const backend = new CodexCliBackend();
    expect(backend.abortSession()).toBeNull();
  });

  it("supportsResume returns true", () => {
    const backend = new CodexCliBackend();
    expect(backend.supportsResume()).toBe(true);
  });

  it("supportsMcpServers returns true", () => {
    const backend = new CodexCliBackend();
    expect(backend.supportsMcpServers()).toBe(true);
  });

  it("nudgeStrategy returns 'abort-resume'", () => {
    const backend = new CodexCliBackend();
    expect(backend.nudgeStrategy()).toBe("abort-resume");
  });
});

// ------------------------------------
// CodexCliBackend — runSession with mocked child process
// ------------------------------------

describe("CodexCliBackend.runSession (mocked spawn)", () => {
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
      kill: vi.fn(() => {
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
// CodexCliBackend — queueNudge abort+resume (Phase 3)
// ------------------------------------

describe("CodexCliBackend.queueNudge (abort+resume)", () => {
  it("sends SIGTERM and returns abort-resume outcome when session is active", () => {
    const backend = new CodexCliBackend();

    const fakeChild = {
      killed: false,
      kill: vi.fn(() => {
        fakeChild.killed = true;
      }),
    };

    (backend as unknown as { activeChild: unknown }).activeChild = fakeChild;
    (backend as unknown as { lastSessionId: string }).lastSessionId = "test-uuid";

    const outcome = backend.queueNudge("add a debug log to line 42");

    // Child should have received SIGTERM
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fakeChild.killed).toBe(true);

    // Outcome should describe the abort+resume handle
    expect(outcome.handled).toBe(true);
    if (outcome.handled && outcome.via === "abort-resume") {
      expect(outcome.sessionId).toBe("test-uuid");
      expect(outcome.nudgeText).toBe("add a debug log to line 42");
    } else {
      // Force the test to fail if we didn't get abort-resume
      expect(outcome.handled && (outcome as { via?: string }).via).toBe("abort-resume");
    }
  });

  it("returns { handled: false } when no active session (no activeChild)", () => {
    const backend = new CodexCliBackend();
    // lastSessionId is set but no activeChild
    (backend as unknown as { lastSessionId: string }).lastSessionId = "test-uuid";

    const outcome = backend.queueNudge("nudge text");
    expect(outcome.handled).toBe(false);
  });

  it("returns { handled: false } when no lastSessionId", () => {
    const backend = new CodexCliBackend();

    const fakeChild = {
      killed: false,
      kill: vi.fn(),
    };
    (backend as unknown as { activeChild: unknown }).activeChild = fakeChild;
    // lastSessionId is null (session ID not yet received from Codex)

    const outcome = backend.queueNudge("nudge text");
    expect(outcome.handled).toBe(false);
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });

  it("includes the full nudge text in the returned outcome", () => {
    const backend = new CodexCliBackend();

    const fakeChild = { killed: false, kill: vi.fn() };
    (backend as unknown as { activeChild: unknown }).activeChild = fakeChild;
    (backend as unknown as { lastSessionId: string }).lastSessionId = "sess-xyz";

    const nudgeText = "OPERATOR NUDGE: please also add error handling for the case where the file is missing";
    const outcome = backend.queueNudge(nudgeText);

    expect(outcome.handled).toBe(true);
    if (outcome.handled && outcome.via === "abort-resume") {
      expect(outcome.nudgeText).toBe(nudgeText);
      expect(outcome.sessionId).toBe("sess-xyz");
    }
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

// ------------------------------------
// buildCodexArgs — MCP flag generation (Phase 2 part 2)
// ------------------------------------

describe("buildCodexArgs — MCP server flag generation", () => {
  const baseOpts: AgentSessionOptions = {
    prompt: "test prompt",
    cwd: "/tmp/project",
  };

  it("emits -c mcp_servers.* flags for LogicalMcpServerDescriptor entries", () => {
    const opts: AgentSessionOptions = {
      ...baseOpts,
      mcpServers: {
        foo: {
          command: "tsx",
          args: ["a.mts", "b.mts"],
          env: { K: "v", X: "y" },
        },
      },
    };
    const args = buildCodexArgs(opts, {});
    // command flag
    expect(args).toContain("-c");
    const commandIdx = args.indexOf(`mcp_servers.foo.command="tsx"`);
    expect(commandIdx).toBeGreaterThan(-1);
    // args flag
    const argsFlag = `mcp_servers.foo.args=${JSON.stringify(["a.mts", "b.mts"])}`;
    expect(args).toContain(argsFlag);
    // env flags
    expect(args).toContain(`mcp_servers.foo.env.K="v"`);
    expect(args).toContain(`mcp_servers.foo.env.X="y"`);
  });

  it("handles multiple MCP servers", () => {
    const opts: AgentSessionOptions = {
      ...baseOpts,
      mcpServers: {
        server1: { command: "npx", args: ["tsx", "/abs/a.mts"] },
        server2: { command: "node", args: ["/abs/b.js"], env: { FOO: "bar" } },
      },
    };
    const args = buildCodexArgs(opts, {});
    expect(args).toContain(`mcp_servers.server1.command="npx"`);
    expect(args).toContain(`mcp_servers.server2.command="node"`);
    expect(args).toContain(`mcp_servers.server2.env.FOO="bar"`);
  });

  it("skips non-LogicalMcpServerDescriptor values (SDK in-process form)", () => {
    // A Claude SDK in-process McpServer object doesn't have a top-level `command` field
    const opts: AgentSessionOptions = {
      ...baseOpts,
      mcpServers: {
        "in-process-server": { tools: [], name: "test", version: "1" } as unknown as Record<string, unknown>,
      },
    };
    const args = buildCodexArgs(opts, {});
    // Should NOT emit any mcp_servers.* flags for this non-descriptor entry
    expect(args.some((a) => a.includes("mcp_servers.in-process-server"))).toBe(false);
  });

  it("re-registers MCP flags on resume branch (MCP servers are process-scoped, not session-scoped)", () => {
    const opts: AgentSessionOptions = {
      ...baseOpts,
      resume: "sess-abc",
      mcpServers: {
        foo: { command: "tsx", args: ["a.mts"] },
      },
    };
    const args = buildCodexArgs(opts, {});
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    // MCP flags MUST re-appear on resume so the child process can spawn the MCP server again.
    expect(args.some((a) => a === 'mcp_servers.foo.command="tsx"')).toBe(true);
    expect(args.some((a) => a === 'mcp_servers.foo.args=["a.mts"]')).toBe(true);
  });
});

// ------------------------------------
// buildCodexArgs — output schema flag (Phase 4 part 2)
// ------------------------------------

describe("buildCodexArgs — output schema flag", () => {
  const baseOpts: AgentSessionOptions = {
    prompt: "test",
    cwd: "/tmp/project",
  };

  it("appends --output-schema flag when outputSchemaPath is set", () => {
    const args = buildCodexArgs({ ...baseOpts, outputSchemaPath: "/tmp/x.json" }, {});
    const schemaIdx = args.indexOf("--output-schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(args[schemaIdx + 1]).toBe("/tmp/x.json");
  });

  it("does not add --output-schema when outputSchemaPath is absent", () => {
    const args = buildCodexArgs(baseOpts, {});
    expect(args).not.toContain("--output-schema");
  });

  it("does not add --output-schema on resume branch", () => {
    const args = buildCodexArgs(
      { ...baseOpts, resume: "sess-abc", outputSchemaPath: "/tmp/x.json" },
      {},
    );
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args).not.toContain("--output-schema");
  });
});

// ------------------------------------
// parseCodexLine — final_answer envelope synthesis (Phase 4 part 2)
// ------------------------------------

describe("parseCodexLine — final_answer item synthesis", () => {
  it("synthesizes envelope sentinels from item.completed with final_answer type", () => {
    const payload = { verdict: "pass", score: 95 };
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "final_answer",
        content: JSON.stringify(payload),
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.subtype).toBe("final_answer_envelope");
    expect(msg!.text).toContain("===HARNESSD_RESULT_START===");
    expect(msg!.text).toContain("===HARNESSD_RESULT_END===");
    // Payload should appear between sentinels
    expect(msg!.text).toContain(JSON.stringify(payload));
  });

  it("handles final_answer with object content (auto-serializes)", () => {
    const payload = { verdict: "fail", issues: ["missing field"] };
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "final_answer",
        content: payload,
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain("===HARNESSD_RESULT_START===");
    // Content should be serialized JSON
    expect(msg!.text).toContain("verdict");
    expect(msg!.text).toContain("missing field");
  });

  it("uses output field when content is absent", () => {
    const payload = { result: "ok" };
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "final_answer",
        output: JSON.stringify(payload),
      },
    });
    const msg = parseCodexLine(line);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain("===HARNESSD_RESULT_START===");
    expect(msg!.text).toContain("result");
  });

  it("wraps agent_message text in envelope when outputSchemaActive is true", () => {
    // Codex CLI 0.117.0 emits structured output as agent_message, not final_answer.
    const payload = { verdict: "pass", hardFailures: [] };
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: JSON.stringify(payload),
      },
    });
    const msg = parseCodexLine(line, true);
    expect(msg).not.toBeNull();
    expect(msg!.subtype).toBe("final_answer_envelope");
    expect(msg!.text).toContain("===HARNESSD_RESULT_START===");
    expect(msg!.text).toContain("===HARNESSD_RESULT_END===");
    expect(msg!.text).toContain(JSON.stringify(payload));
  });

  it("does NOT wrap agent_message when outputSchemaActive is false", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "{\"a\":1}" },
    });
    const msg = parseCodexLine(line, false);
    expect(msg).not.toBeNull();
    expect(msg!.subtype).toBeUndefined();
    expect(msg!.text).not.toContain("===HARNESSD_RESULT_START===");
  });
});

// ------------------------------------
// CodexCliBackend.supportsOutputSchema
// ------------------------------------

describe("CodexCliBackend.supportsOutputSchema", () => {
  it("returns true", () => {
    const backend = new CodexCliBackend();
    expect(backend.supportsOutputSchema()).toBe(true);
  });
});
