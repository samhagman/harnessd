#!/usr/bin/env tsx
/**
 * CLI utility for querying harnessd run memory.
 * Operator-facing — prints results to stdout.
 *
 * Usage:
 *   npx tsx src/memvid-query.ts "why did evaluator fail AC-005?"
 *   npx tsx src/memvid-query.ts --run-id my-run "CSS modules decision"
 *   npx tsx src/memvid-query.ts --timeline --since 1h
 *   npx tsx src/memvid-query.ts --k 10 --mode sem "authentication patterns"
 *   npx tsx src/memvid-query.ts --help
 */
import fs from 'node:fs';
import { openRunMemory, getMemoryPath } from './memvid.js';
import type { SearchHit, SearchOptions } from './memvid.js';
import { findRepoRoot, getLatestRunId } from './state-store.js';

// ── Arg parsing ────────────────────────────────────────────────────────────────

interface CliArgs {
  runId?: string;
  timeline: boolean;
  since?: number;      // unix timestamp
  k: number;
  mode: 'auto' | 'lex' | 'sem';
  query: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let runId: string | undefined;
  let timeline = false;
  let since: number | undefined;
  let k = 5;
  let mode: 'auto' | 'lex' | 'sem' = 'auto';
  let help = false;
  const queryParts: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--run-id' && i + 1 < args.length) {
      runId = args[++i]!;
    } else if (arg === '--timeline') {
      timeline = true;
    } else if (arg === '--since' && i + 1 < args.length) {
      since = parseDuration(args[++i]!);
    } else if (arg === '--k' && i + 1 < args.length) {
      k = parseInt(args[++i]!, 10);
      if (isNaN(k) || k < 1) {
        console.error('Error: --k must be a positive integer');
        process.exit(1);
      }
    } else if (arg === '--mode' && i + 1 < args.length) {
      const m = args[++i]!;
      if (m !== 'auto' && m !== 'lex' && m !== 'sem') {
        console.error(`Error: --mode must be one of: auto, lex, sem`);
        process.exit(1);
      }
      mode = m;
    } else if (arg.startsWith('--')) {
      console.error(`Error: Unknown option: ${arg}`);
      process.exit(1);
    } else {
      queryParts.push(arg);
    }
    i++;
  }

  return {
    runId,
    timeline,
    since,
    k,
    mode,
    query: queryParts.join(' '),
    help,
  };
}

function printHelp(): void {
  console.log(`
memvid-query — Query harnessd run memory

Usage:
  npx tsx src/memvid-query.ts [options] "query string"

Options:
  --run-id <id>      Run ID to query (default: most recent run)
  --timeline         Show events in chronological order
  --since <dur>      Timeline start (e.g. 1h, 30m, 2d, 1s)
  --k <number>       Number of results to return (default: 5)
  --mode <mode>      Search mode: auto | lex | sem (default: auto)
  --help, -h         Show this help

Examples:
  npx tsx src/memvid-query.ts "why did evaluator fail AC-005?"
  npx tsx src/memvid-query.ts --run-id my-run "CSS modules decision"
  npx tsx src/memvid-query.ts --timeline --since 1h
  npx tsx src/memvid-query.ts --k 10 --mode sem "authentication patterns"
  npx tsx src/memvid-query.ts --timeline --since 30m --k 20

Search modes:
  auto  Hybrid keyword + semantic (default, usually best)
  lex   Keyword-only (exact matches, faster)
  sem   Semantic-only (conceptual similarity, slower)
`.trim());
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration: "${duration}". Use format like 1h, 30m, 2d, 1s`);
  }
  const [, numStr, unit] = match;
  const num = parseInt(numStr!, 10);
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = num * (multipliers[unit!] ?? 1);
  return Math.floor(Date.now() / 1000) - seconds;
}

// ── Output formatting ──────────────────────────────────────────────────────────

function printResults(results: SearchHit[]): void {
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }
  for (const hit of results) {
    const labelParts = [hit.label];
    if (hit.metadata['role']) labelParts.push(String(hit.metadata['role']));
    const labelStr = labelParts.join(', ');

    console.log(`[${hit.score.toFixed(2)}] ${hit.title}  (${labelStr})`);

    const createdAt = hit.metadata['created_at'] ?? hit.metadata['ts'];
    if (createdAt) {
      console.log(`  ${createdAt}`);
    }

    // Wrap snippet at ~80 chars with 2-space indent
    const snippet = hit.snippet.trim();
    if (snippet) {
      const lines = snippet.split('\n');
      for (const line of lines) {
        if (line.length <= 78) {
          console.log(`  ${line}`);
        } else {
          // Soft-wrap long lines
          let remaining = line;
          while (remaining.length > 78) {
            const breakAt = remaining.lastIndexOf(' ', 78);
            const cutAt = breakAt > 20 ? breakAt : 78;
            console.log(`  ${remaining.slice(0, cutAt)}`);
            remaining = remaining.slice(cutAt).trimStart();
          }
          if (remaining.length > 0) console.log(`  ${remaining}`);
        }
      }
    }
    console.log();
  }
}

function printTimeline(results: SearchHit[]): void {
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }
  for (const hit of results) {
    const ts = hit.metadata['created_at'] ?? hit.metadata['ts'] ?? '?';
    const pkt = hit.metadata['packetId'] ? ` [${hit.metadata['packetId']}]` : '';
    const role = hit.metadata['role'] ? ` ${hit.metadata['role']}` : '';
    console.log(`${ts}${pkt}${role} — ${hit.title}`);
    const snippet = hit.snippet.trim();
    if (snippet) {
      // First line only for timeline, truncated to ~120 chars
      const firstLine = snippet.split('\n')[0] ?? '';
      const display = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
      if (display) console.log(`  ${display}`);
    }
    console.log();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  if (cli.help) {
    printHelp();
    return;
  }

  if (!cli.timeline && !cli.query.trim()) {
    console.error('Error: Provide a query string, or use --timeline for chronological view');
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  const repoRoot = findRepoRoot() ?? process.cwd();
  const runId = cli.runId ?? getLatestRunId(repoRoot);

  if (!runId) {
    console.error('No runs found in .harnessd/runs/');
    process.exit(1);
  }

  const memoryPath = getMemoryPath(repoRoot, runId);
  if (!fs.existsSync(memoryPath)) {
    console.error(`No memory file found for run: ${runId}`);
    console.error(`  Expected: ${memoryPath}`);
    console.error('');
    console.error('Memory is populated automatically as the run progresses through phases.');
    console.error('If the run just started, wait until after the planning phase completes.');
    process.exit(1);
  }

  const memory = await openRunMemory(memoryPath, repoRoot, runId);
  if (!memory) {
    console.error('memory backend not installed.');
    console.error('Run: npm install (better-sqlite3, sqlite-vec, @huggingface/transformers are optional deps)');
    process.exit(1);
  }

  if (cli.timeline) {
    const opts: { since?: number; limit?: number } = { limit: cli.k };
    if (cli.since !== undefined) opts.since = cli.since;
    const results = await memory.timeline(opts);
    printTimeline(results);
  } else {
    const searchOpts: SearchOptions = {
      k: cli.k,
      mode: cli.mode,
      snippetChars: 300,
    };
    const results = await memory.search(cli.query, searchOpts);
    printResults(results);
  }
}

main().catch(err => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
