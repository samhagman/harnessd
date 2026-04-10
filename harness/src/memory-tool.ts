/**
 * MCP tool that agents can call to search the run's semantic memory.
 *
 * Gives every agent on-demand access to prior packets, agent sessions,
 * tool calls, decisions, and evaluator findings — without waiting for
 * the orchestrator to inject context.
 *
 * Follows the same pattern as validation-tool.ts.
 * CLI fallback for Codex agents: bin/search-memory.mts
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { RunMemory } from "./memvid.js";

/**
 * Create an MCP server config with a `search_memory` tool.
 * Pass the returned config into the session's mcpServers option.
 *
 * When memory is not available (memvid not installed, empty run), callers
 * should pass null and skip adding this server to mcpServers entirely —
 * use the spread pattern: ...(memory ? [createMemorySearchMcpServer(memory)] : [])
 */
export function createMemorySearchMcpServer(memory: RunMemory) {
  return createSdkMcpServer({
    name: "harnessd-memory",
    version: "1.0.0",
    tools: [
      tool(
        "search_memory",
        "Search the run's semantic memory for information from prior packets, agent sessions, tool calls, decisions, and evaluator findings. " +
        "Use this to understand what happened earlier in the run, find patterns from prior builders, check evaluator findings, and maintain consistency across packets. " +
        "Include role names (builder, evaluator, planner) and packet IDs (PKT-001) in your query for better results.",
        {
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
        async (args) => {
          try {
            // Build augmented query: prepend role/packetId for bias.
            // These words appear in document titles so prepending them
            // steers semantic search toward that role/packet without true filtering.
            const parts = [args.role, args.packetId, args.query].filter(Boolean);
            const augmentedQuery = parts.join(" ");

            const hits = await memory.search(augmentedQuery, {
              k: args.k,
              mode: args.mode as "auto" | "lex",
              snippetChars: 400,
            });

            if (hits.length === 0) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    results: [],
                    message: "No results found. Try different keywords, a broader query, or remove role/packetId filters.",
                  }),
                }],
              };
            }

            const results = hits.map(h => ({
              score: Math.round(h.score * 100) / 100,
              title: h.title,
              label: h.label,
              snippet: h.snippet,
            }));

            return {
              content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Memory search failed: ${msg}` }) }],
            };
          }
        },
      ),
    ],
  });
}
