#!/usr/bin/env npx tsx
/**
 * CLI memory search — equivalent of the search_memory MCP tool for Codex agents.
 * Outputs JSON to stdout for machine consumption.
 *
 * Usage:
 *   npx tsx harness/bin/search-memory.mts --query "auth patterns" --k 5
 *   npx tsx harness/bin/search-memory.mts --query "builder decisions" --role builder
 *   npx tsx harness/bin/search-memory.mts --query "PKT-001 findings" --packet-id PKT-001
 *   npx tsx harness/bin/search-memory.mts --query "evaluator verdict" --run-id my-run
 *
 * Exits 0 with {"results":[...]} on success.
 * Exits 1 with {"error":"message"} on failure.
 */

import fs from "node:fs";
import path from "node:path";
import { openRunMemory, getMemoryPath } from "../src/memvid.js";

// ------------------------------------
// Arg parsing
// ------------------------------------

interface CliArgs {
  query: string;
  k: number;
  mode: "auto" | "lex";
  role?: string;
  packetId?: string;
  runId?: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);
  let query = "";
  let k = 5;
  let mode: "auto" | "lex" = "auto";
  let role: string | undefined;
  let packetId: string | undefined;
  let runId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--query" && args[i + 1]) {
      query = args[++i]!;
    } else if (arg === "--k" && args[i + 1]) {
      const parsed = parseInt(args[++i]!, 10);
      if (!isNaN(parsed) && parsed > 0) k = parsed;
    } else if (arg === "--mode" && args[i + 1]) {
      const m = args[++i]!;
      if (m === "auto" || m === "lex") mode = m;
    } else if (arg === "--role" && args[i + 1]) {
      role = args[++i]!;
    } else if (arg === "--packet-id" && args[i + 1]) {
      packetId = args[++i]!;
    } else if (arg === "--run-id" && args[i + 1]) {
      runId = args[++i]!;
    }
  }

  if (!query.trim()) {
    return null;
  }

  return { query, k, mode, role, packetId, runId };
}

// ------------------------------------
// Repo root + run ID discovery (same pattern as memvid-query.ts)
// ------------------------------------

function findRepoRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".harnessd"))) return dir;
    dir = path.dirname(dir);
  }
  // Fall back to the harness package's parent (project root)
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(scriptDir, "..", "..");
}

function resolveRunId(repoRoot: string, explicit?: string): string | null {
  if (explicit) return explicit;

  const runsDir = path.join(repoRoot, ".harnessd", "runs");
  if (!fs.existsSync(runsDir)) return null;

  const entries = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try {
        return fs.statSync(path.join(runsDir, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const sa = fs.statSync(path.join(runsDir, a));
      const sb = fs.statSync(path.join(runsDir, b));
      return sb.mtimeMs - sa.mtimeMs;
    });

  return entries[0] ?? null;
}

// ------------------------------------
// Main
// ------------------------------------

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  if (!cli) {
    console.log(JSON.stringify({ error: "Missing --query argument. Usage: search-memory.mts --query <text> [--k 5] [--mode auto|lex] [--role <role>] [--packet-id <id>] [--run-id <id>]" }));
    process.exit(1);
  }

  const repoRoot = findRepoRoot();
  const runId = resolveRunId(repoRoot, cli.runId);

  if (!runId) {
    console.log(JSON.stringify({ error: "No runs found in .harnessd/runs/. Memory is populated as the run progresses." }));
    process.exit(1);
  }

  const memoryPath = getMemoryPath(repoRoot, runId);
  if (!fs.existsSync(memoryPath)) {
    console.log(JSON.stringify({ results: [], message: `No memory file found for run: ${runId}. Memory is populated as the run progresses through phases.` }));
    process.exit(0);
  }

  const memory = await openRunMemory(memoryPath, repoRoot, runId);
  if (!memory) {
    console.log(JSON.stringify({ error: "@memvid/sdk is not installed. Run: npm install @memvid/sdk" }));
    process.exit(1);
  }

  // Build augmented query: prepend role/packetId for bias (same logic as MCP tool)
  const parts = [cli.role, cli.packetId, cli.query].filter(Boolean);
  const augmentedQuery = parts.join(" ");

  try {
    const hits = await memory.search(augmentedQuery, {
      k: cli.k,
      mode: cli.mode,
      snippetChars: 400,
    });

    if (hits.length === 0) {
      console.log(JSON.stringify({
        results: [],
        message: "No results found. Try different keywords, a broader query, or remove role/packetId filters.",
      }));
      process.exit(0);
    }

    const results = hits.map((h) => ({
      score: Math.round(h.score * 100) / 100,
      title: h.title,
      label: h.label,
      snippet: h.snippet,
    }));

    console.log(JSON.stringify({ results }, null, 2));
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ error: `Memory search failed: ${msg}` }));
    process.exit(1);
  }
}

main();
