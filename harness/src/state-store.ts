/**
 * File-backed state management for harnessd runs.
 *
 * Manages the `.harnessd/runs/<run-id>/` directory tree with atomic writes
 * for crash safety. All JSON is validated on both read and write boundaries.
 *
 * Reference: TAD sections 8 (file layout), 19 (state), 23 (config)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

import {
  type RunState,
  type ProjectConfig,
  type AcceptanceCriterion,
  RunStateSchema,
  defaultRunState,
  defaultProjectConfig,
} from "./schemas.js";

// ------------------------------------
// Constants
// ------------------------------------

/** Name of the harnessd data directory at the repo root */
export const HARNESSD_DIR = ".harnessd";

/** Subdirectories created inside every run directory */
const RUN_SUBDIRS = [
  "spec",
  "packets",
  "inbox",
  "outbox",
] as const;

/** Subdirectories created inside every packet directory */
const PACKET_SUBDIRS = [
  "contract",
  "builder",
  "evaluator",
] as const;

// ------------------------------------
// Path helpers
// ------------------------------------

/** Absolute path to the runs directory under the repo root. */
function getRunsDir(repoRoot: string): string {
  return path.join(repoRoot, HARNESSD_DIR, "runs");
}

/** Absolute path to a specific run directory. */
export function getRunDir(repoRoot: string, runId: string): string {
  return path.join(getRunsDir(repoRoot), runId);
}

/**
 * Validate that a workspace path is durable (not in /tmp or other volatile locations).
 * /tmp is cleared by the OS — any work done there WILL be lost.
 */
export function validateWorkspacePath(workspaceDir: string): void {
  const resolved = path.resolve(workspaceDir);
  const volatilePrefixes = ["/tmp", "/private/tmp", "/var/tmp"];
  for (const prefix of volatilePrefixes) {
    if (resolved.startsWith(prefix + "/") || resolved === prefix) {
      throw new Error(
        `REFUSING to use volatile workspace: ${resolved}\n` +
        `Workspaces in ${prefix}/ are cleared by the OS — all agent work will be lost.\n` +
        `Use --workspace with a durable path, or omit it to use <run-dir>/workspace/ automatically.`
      );
    }
  }
}

/**
 * Get the canonical workspace path for a run: <run-dir>/workspace/
 * This is co-located with the run artifacts and survives reboots.
 */
export function getDefaultWorkspacePath(repoRoot: string, runId: string): string {
  return path.join(getRunDir(repoRoot, runId), "workspace");
}

/**
 * Walk up from startDir looking for a .harnessd directory.
 * Returns the directory containing .harnessd, or null if not found.
 */
export function findRepoRoot(startDir?: string): string | null {
  let dir = startDir ?? process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, HARNESSD_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ------------------------------------
// Run ID generation
// ------------------------------------

/**
 * Generate a unique run ID: `run-YYYYMMDD-HHMMSS-XXXX`
 * Timestamp prefix ensures lexicographic sort = chronological order.
 */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString("hex"); // 4 hex chars
  return `run-${date}-${time}-${hex}`;
}

// ------------------------------------
// Atomic write primitive
// ------------------------------------

/**
 * Write JSON to a file atomically: write to `<path>.tmp` then rename.
 * The rename is atomic on POSIX filesystems, so readers never see a
 * partially-written file.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

// ------------------------------------
// Run lifecycle
// ------------------------------------

/**
 * Create a new run with a full directory tree and initial state files.
 *
 * Directory layout:
 *   .harnessd/runs/<run-id>/
 *     run.json        - validated RunState
 *     status.json     - empty initial status placeholder
 *     status.md       - human-readable status placeholder
 *     events.jsonl    - empty event stream
 *     spec/           - spec artifacts
 *     packets/        - per-packet work dirs
 *     inbox/          - operator -> orchestrator messages
 *     outbox/         - orchestrator -> operator messages
 */
export function createRun(
  repoRoot: string,
  objective: string,
  config?: ProjectConfig,
  customRunId?: string,
  workspaceDir?: string,
): RunState {
  const runId = customRunId ?? generateRunId();
  const runDir = getRunDir(repoRoot, runId);

  // Create run directory and all subdirectories (no-ops if they already exist)
  for (const sub of RUN_SUBDIRS) {
    fs.mkdirSync(path.join(runDir, sub), { recursive: true });
  }

  // Build and validate initial state
  const state = defaultRunState(runId, objective);
  if (workspaceDir) {
    state.workspaceDir = workspaceDir;
  }
  RunStateSchema.parse(state);

  // Write initial files (only if they don't already exist — preserves pre-seeded content)
  atomicWriteJson(path.join(runDir, "run.json"), state);
  if (!fs.existsSync(path.join(runDir, "status.json"))) {
    atomicWriteJson(path.join(runDir, "status.json"), {});
  }
  if (!fs.existsSync(path.join(runDir, "status.md"))) {
    fs.writeFileSync(path.join(runDir, "status.md"), `# Run ${runId}\n\nPhase: planning\n`, "utf-8");
  }
  if (!fs.existsSync(path.join(runDir, "events.jsonl"))) {
    fs.writeFileSync(path.join(runDir, "events.jsonl"), "", "utf-8");
  }

  // Persist config if provided (otherwise defaults will be used on read)
  const resolvedConfig = config ?? defaultProjectConfig();
  atomicWriteJson(path.join(runDir, "config.json"), resolvedConfig);

  // Auto-generate workspace path note in context-overrides.md when using a separate workspace
  if (workspaceDir && workspaceDir !== repoRoot) {
    const overridePath = path.join(runDir, "spec", "context-overrides.md");
    if (!fs.existsSync(overridePath)) {
      const workspaceNote = `## WORKSPACE PATH\n\nAll builder file operations must use paths within: ${workspaceDir}\nDo NOT write to paths outside this directory.\n`;
      fs.writeFileSync(overridePath, workspaceNote, "utf-8");
    } else {
      // Append workspace note to existing overrides
      const existing = fs.readFileSync(overridePath, "utf-8");
      if (!existing.includes("WORKSPACE PATH")) {
        const workspaceNote = `\n\n## WORKSPACE PATH\n\nAll builder file operations must use paths within: ${workspaceDir}\nDo NOT write to paths outside this directory.\n`;
        fs.appendFileSync(overridePath, workspaceNote, "utf-8");
      }
    }
  }

  return state;
}

/**
 * Load and validate a run's state from disk.
 * Throws if the run directory or run.json doesn't exist or fails validation.
 */
export function loadRun(repoRoot: string, runId: string): RunState {
  const filePath = path.join(getRunDir(repoRoot, runId), "run.json");
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Run state not found: ${filePath}`);
  }
  return RunStateSchema.parse(JSON.parse(content));
}

/**
 * Atomic read-modify-write of run.json.
 * Reads current state, merges the patch, updates `updatedAt`, validates,
 * then writes atomically.
 */
export function updateRun(
  repoRoot: string,
  runId: string,
  patch: Partial<RunState>,
): RunState {
  const current = loadRun(repoRoot, runId);
  const updated: RunState = {
    ...current,
    ...patch,
    // Always refresh updatedAt; never let caller accidentally freeze it
    updatedAt: new Date().toISOString(),
    // Never allow overwriting immutable identity fields
    runId: current.runId,
    createdAt: current.createdAt,
  };
  RunStateSchema.parse(updated);

  const filePath = path.join(getRunDir(repoRoot, runId), "run.json");
  atomicWriteJson(filePath, updated);
  return updated;
}

// ------------------------------------
// Artifact I/O
// ------------------------------------

/**
 * Write a JSON artifact to a relative path within the run directory.
 * Creates parent directories as needed.
 */
export function writeArtifact(
  repoRoot: string,
  runId: string,
  relPath: string,
  data: unknown,
): void {
  const filePath = path.join(getRunDir(repoRoot, runId), relPath);
  atomicWriteJson(filePath, data);
}

/**
 * Read and validate a JSON artifact from a relative path within the run directory.
 * The caller supplies a Zod schema for validation.
 */
export function readArtifact<T>(
  repoRoot: string,
  runId: string,
  relPath: string,
  schema: z.ZodType<T>,
): T {
  const filePath = path.join(getRunDir(repoRoot, runId), relPath);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Artifact not found: ${filePath}`);
  }
  return schema.parse(JSON.parse(content));
}

// ------------------------------------
// Packet directory
// ------------------------------------

/**
 * Ensure the packet directory exists with standard subdirectories.
 * Idempotent — safe to call multiple times.
 *
 * Creates:
 *   packets/<packetId>/contract/
 *   packets/<packetId>/builder/
 *   packets/<packetId>/evaluator/
 */
export function ensurePacketDir(
  repoRoot: string,
  runId: string,
  packetId: string,
): string {
  const packetDir = path.join(getRunDir(repoRoot, runId), "packets", packetId);
  for (const sub of PACKET_SUBDIRS) {
    fs.mkdirSync(path.join(packetDir, sub), { recursive: true });
  }
  return packetDir;
}

// ------------------------------------
// Run discovery
// ------------------------------------

/**
 * Find the most recent run ID by lexicographic sort of directory names.
 * Since run IDs are timestamp-prefixed (`run-YYYYMMDD-HHMMSS-XXXX`),
 * the last entry in sorted order is the most recent.
 *
 * Returns `null` if no runs exist.
 */
export function getLatestRunId(repoRoot: string): string | null {
  const runsDir = getRunsDir(repoRoot);
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("run-"))
    .map((d) => d.name)
    .sort();

  return entries.length > 0 ? entries[entries.length - 1]! : null;
}

// ------------------------------------
// Atomic array push
// ------------------------------------

/**
 * Atomic push to an array field in run.json.
 * Reads current state from disk (not stale memory), appends value if not present,
 * merges any additional patch fields, validates, and writes atomically.
 */
export function pushToRunArray(
  repoRoot: string,
  runId: string,
  field: 'completedPacketIds' | 'round2CompletedPacketIds' | 'failedPacketIds' | 'blockedPacketIds',
  value: string,
  additionalPatch?: Partial<RunState>,
): RunState {
  const current = loadRun(repoRoot, runId);
  const arr = current[field] as string[];
  const updated: RunState = {
    ...current,
    ...(additionalPatch ?? {}),
    [field]: arr.includes(value) ? arr : [...arr, value],
    updatedAt: new Date().toISOString(),
    runId: current.runId,
    createdAt: current.createdAt,
  };
  RunStateSchema.parse(updated);
  const filePath = path.join(getRunDir(repoRoot, runId), "run.json");
  atomicWriteJson(filePath, updated);
  return updated;
}

// ------------------------------------
// Evaluator-added criteria
// ------------------------------------

/**
 * Append evaluator-proposed acceptance criteria to the per-packet
 * `evaluator-additions.json` ledger. Each entry records the eval round
 * and timestamp so the orchestrator can trace provenance.
 */
export function appendEvaluatorAdditions(
  repoRoot: string,
  runId: string,
  packetId: string,
  additions: AcceptanceCriterion[],
  evalRound: number,
): void {
  const filePath = path.join(
    getRunDir(repoRoot, runId), "packets", packetId, "contract", "evaluator-additions.json"
  );
  let existing: unknown[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!Array.isArray(raw)) {
        console.warn(
          `[${runId}] appendEvaluatorAdditions(${packetId}): existing evaluator-additions.json is not an array (got ${typeof raw}). ` +
          `Refusing to overwrite — keeping existing file untouched. New criteria for evalRound ${evalRound} will NOT be persisted.`,
        );
        return;
      }
      existing = raw;
    } catch (err) {
      console.warn(
        `[${runId}] appendEvaluatorAdditions(${packetId}): failed to parse existing evaluator-additions.json — ` +
        `prior entries will be lost on overwrite. Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const entry = {
    timestamp: new Date().toISOString(),
    evalRound,
    criteria: additions,
  };
  atomicWriteJson(filePath, [...existing, entry]);
}
