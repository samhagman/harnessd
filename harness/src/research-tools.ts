/**
 * Research tool configuration — resolves availability and creates MCP server configs.
 *
 * Context7: always-on by default, bundled dependency, stdio MCP server.
 * Perplexity: opt-in, requires PERPLEXITY_API_KEY env var, stdio MCP server.
 */

import type { ProjectConfig } from "./schemas.js";

/** Resolved research tool availability (after checking env vars). */
export interface ResearchToolAvailability {
  context7: boolean;
  perplexity: boolean;
}

/** Default availability — matches ProjectConfigSchema.researchTools defaults. */
export const DEFAULT_RESEARCH_TOOLS: ResearchToolAvailability = { context7: true, perplexity: false };

/**
 * Resolve what research tools are actually available at runtime.
 *
 * Rules:
 * - context7: available if config.researchTools.context7 is true (default: true)
 * - perplexity: available if config.researchTools.perplexity is true AND PERPLEXITY_API_KEY is set
 *
 * Logs warnings for misconfigurations. Never throws.
 */
export function resolveResearchToolAvailability(config: ProjectConfig): ResearchToolAvailability {
  const rt = config.researchTools;

  const context7 = rt.context7;
  let perplexity = rt.perplexity;

  if (perplexity && !process.env.PERPLEXITY_API_KEY) {
    console.log("[research-tools] Perplexity enabled but PERPLEXITY_API_KEY not set — disabling");
    perplexity = false;
  }

  console.log(`[research-tools] Context7: ${context7 ? "enabled" : "disabled"} | Perplexity: ${perplexity ? "enabled" : "disabled"}`);

  return { context7, perplexity };
}

/**
 * Create MCP server record entries for available research tools.
 * Spread into the runner's mcpServers Record:
 *   ...createResearchMcpServerRecord(config.researchTools)
 */
export function createResearchMcpServerRecord(
  availability: ResearchToolAvailability,
): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

  if (availability.context7) {
    servers["context7"] = {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    };
  }

  if (availability.perplexity) {
    servers["perplexity"] = {
      command: "npx",
      args: ["-y", "@perplexity-ai/mcp-server"],
      env: {
        PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY!,
      },
    };
  }

  return servers;
}
