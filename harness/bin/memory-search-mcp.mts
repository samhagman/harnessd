#!/usr/bin/env npx tsx
/**
 * MCP stdio server exposing the `memory_search` tool.
 *
 * Codex agents that support MCP server registration use this to search the
 * run's semantic memory (.mv2 file) for context from prior packets, evaluator
 * findings, decisions, and agent sessions.
 *
 * Usage (launched by Codex via -c mcp_servers.<name>.command):
 *   tsx /abs/path/to/harness/bin/memory-search-mcp.mts
 *
 * Environment variables (required):
 *   HARNESSD_MEMVID_PATH     Absolute path to the run's .mv2 memory file.
 *                            e.g. /repo/.harnessd/runs/my-run/memory.mv2
 *
 * When the memory file does not exist or @memvid/sdk is not installed,
 * memory_search returns an empty result set rather than failing.
 *
 * Each tool invocation is bounded to 30 seconds (Phase 3 nudge latency bound).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openRunMemory } from "../src/memvid.js";
import { TOOL_TIMEOUT_MS, withTimeout } from "../src/mcp-server-helpers.js";

const memvidPath = process.env.HARNESSD_MEMVID_PATH;
if (!memvidPath) {
  process.stderr.write("HARNESSD_MEMVID_PATH is required but not set.\n");
  process.exit(1);
}

// Derive repoRoot and runId from the path rather than requiring two more env vars.
// RunMemory uses these only for event-log appends (best-effort, silently ignored on failure).
const runsMarker = "/.harnessd/runs/";
const runsIdx = memvidPath.indexOf(runsMarker);
const repoRoot = runsIdx !== -1 ? memvidPath.slice(0, runsIdx) : "/";
const runId = runsIdx !== -1
  ? memvidPath.slice(runsIdx + runsMarker.length).split("/")[0] ?? "unknown"
  : "unknown";

const memoryPromise = openRunMemory(memvidPath, repoRoot, runId);

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
                message: "Memory is not available. Either @memvid/sdk is not installed or the memory file has not been created yet.",
              }),
            },
          ],
        };
      }

      const augmentedQuery = [role, packetId, query].filter(Boolean).join(" ");

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
                message: "No results found. Try different keywords, a broader query, or remove role/packetId filters.",
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
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Memory search failed: ${msg}` }) }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
