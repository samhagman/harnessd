#!/usr/bin/env npx tsx
/**
 * MCP stdio server exposing the `memory_search` tool.
 *
 * This is the stdio-process counterpart to `createMemorySearchMcpServer()` in
 * harness/src/memory-tool.ts. Codex agents that support MCP server registration
 * use this to search the run's semantic memory (.mv2 file) for context from
 * prior packets, evaluator findings, decisions, and agent sessions.
 *
 * Usage (launched by Codex via -c mcp_servers.<name>.command):
 *   tsx /abs/path/to/harness/bin/memory-search-mcp.mts
 *
 * Environment variables (required):
 *   HARNESSD_MEMVID_PATH     Absolute path to the run's .mv2 memory file.
 *                            e.g. /repo/.harnessd/runs/my-run/memory.mv2
 *
 * When the memory file does not exist (e.g., early in a run) or @memvid/sdk
 * is not installed, search_memory returns an empty result set rather than
 * failing — consistent with RunMemory.search() behavior.
 *
 * Hard requirement: each tool invocation is bounded to 30 seconds.
 * This ensures that a SIGTERM arriving during an in-flight MCP call is
 * not delayed more than 30 s (Phase 3 nudge latency bound).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openRunMemory } from "../src/memvid.js";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const memvidPath = process.env.HARNESSD_MEMVID_PATH;
if (!memvidPath) {
  process.stderr.write("HARNESSD_MEMVID_PATH is required but not set.\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Memory initialization (lazy — we open once, reuse across tool calls)
// ---------------------------------------------------------------------------

// We derive a synthetic repoRoot and runId from the path rather than requiring
// two more env vars. The RunMemory class uses these only for event-log appends,
// which are best-effort and silently ignored on failure. If we can't derive a
// sensible runId, we fall back to "unknown" — it only affects memory.encoded
// event labels, which are decorative in this context.
const memvidPathStr = memvidPath;
const runsMarker = "/.harnessd/runs/";
const runsIdx = memvidPathStr.indexOf(runsMarker);
const repoRoot = runsIdx !== -1 ? memvidPathStr.slice(0, runsIdx) : "/";
const runId = runsIdx !== -1
  ? memvidPathStr.slice(runsIdx + runsMarker.length).split("/")[0] ?? "unknown"
  : "unknown";

// openRunMemory returns null if file doesn't exist or @memvid/sdk is absent
const memoryPromise = openRunMemory(memvidPathStr, repoRoot, runId);

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

const TOOL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool call timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "harnessd-memory",
  version: "1.0.0",
});

server.registerTool(
  "memory_search",
  {
    description:
      "Search the run's semantic memory for information from prior packets, agent sessions, tool calls, decisions, and evaluator findings. " +
      "Use this to understand what happened earlier in the run, find patterns from prior builders, check evaluator findings, and maintain consistency across packets. " +
      "Include role names (builder, evaluator, planner) and packet IDs (PKT-001) in your query for better results.",
    inputSchema: {
      query: z.string().describe(
        "Natural language search query. Include role names (builder, evaluator, planner) and packet IDs (PKT-001) for better results.",
      ),
      k: z.number().optional().default(5).describe(
        "Max results to return (default 5)",
      ),
      mode: z.enum(["auto", "lex"]).optional().default("auto").describe(
        "Search mode: auto=semantic+keyword hybrid, lex=keyword only",
      ),
      role: z.string().optional().describe(
        "Optional role filter bias: builder, evaluator, planner, contract_builder, contract_evaluator, qa_agent. Prepended to query for relevance.",
      ),
      packetId: z.string().optional().describe(
        "Optional packet filter bias: PKT-001, PKT-002, etc. Prepended to query for relevance.",
      ),
    },
  },
  async ({ query, k, mode, role, packetId }) => {
    const handler = async () => {
      const memory = await memoryPromise;

      if (!memory) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                results: [],
                message:
                  "Memory is not available. Either @memvid/sdk is not installed or the memory file has not been created yet.",
              }),
            },
          ],
        };
      }

      // Build augmented query: prepend role/packetId for bias (same as MCP in-process tool)
      const parts = [role, packetId, query].filter(Boolean);
      const augmentedQuery = parts.join(" ");

      const hits = await memory.search(augmentedQuery, {
        k: k ?? 5,
        mode: (mode ?? "auto") as "auto" | "lex",
        snippetChars: 400,
      });

      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                results: [],
                message:
                  "No results found. Try different keywords, a broader query, or remove role/packetId filters.",
              }),
            },
          ],
        };
      }

      const results = hits.map((h) => ({
        score: Math.round(h.score * 100) / 100,
        title: h.title,
        label: h.label,
        snippet: h.snippet,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
      };
    };

    try {
      return await withTimeout(handler(), TOOL_TIMEOUT_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Memory search failed: ${msg}` }),
          },
        ],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
