/**
 * Append-only JSONL event stream for harnessd runs.
 *
 * Each run has a single `events.jsonl` file. Events are appended with
 * `appendFileSync` (no atomicWriteJson — we need append, not overwrite).
 * Validated on both write and read boundaries.
 *
 * Reference: TAD section 19 (event log)
 */

import fs from "node:fs";
import path from "node:path";

import {
  type EventEntry,
  EventEntrySchema,
} from "./schemas.js";

import { getRunDir } from "./state-store.js";

// ------------------------------------
// Helpers
// ------------------------------------

/** Absolute path to the events.jsonl file for a run. */
function eventsPath(repoRoot: string, runId: string): string {
  return path.join(getRunDir(repoRoot, runId), "events.jsonl");
}

// ------------------------------------
// Write
// ------------------------------------

/**
 * Append a single event to the run's event stream.
 *
 * The caller provides everything except `ts` — the timestamp is always
 * set at write time so the log reflects wall-clock reality.
 */
export function appendEvent(
  repoRoot: string,
  runId: string,
  event: Omit<EventEntry, "ts">,
): EventEntry {
  const entry: EventEntry = {
    ...event,
    ts: new Date().toISOString(),
  };

  // Validate before writing — fail fast on bad data
  EventEntrySchema.parse(entry);

  const filePath = eventsPath(repoRoot, runId);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");

  return entry;
}

// ------------------------------------
// Read
// ------------------------------------

/**
 * Read and validate all events from the run's event stream.
 * Skips empty lines (e.g. trailing newline). Throws on any invalid line.
 */
export function readEvents(
  repoRoot: string,
  runId: string,
): EventEntry[] {
  const filePath = eventsPath(repoRoot, runId);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  return lines.map((line, i) => {
    try {
      const raw = JSON.parse(line) as unknown;
      return EventEntrySchema.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid event at line ${i + 1} in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Read the last N events from the run's event stream.
 * More efficient than `readEvents` when only the tail matters for large logs,
 * though both read the full file (JSONL isn't seekable). For truly large
 * logs a streaming reader could be added later.
 */
export function tailEvents(
  repoRoot: string,
  runId: string,
  n: number,
): EventEntry[] {
  const all = readEvents(repoRoot, runId);
  if (n >= all.length) return all;
  return all.slice(-n);
}
