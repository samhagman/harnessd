/**
 * Background job tracker for builder long-running commands.
 *
 * Tracks command lifecycle: register → heartbeat → complete/fail.
 * Persists state to builder/background/ directory.
 *
 * Reference: TAD section 13.6
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state-store.js";

export interface BackgroundJob {
  id: string;
  command: string;
  pid?: number;
  startedAt: string;
  logPath?: string;
  lastHeartbeatAt: string | null;
  completionSignal?: string;
  exitCode: number | null;
  status: "running" | "completed" | "failed";
  note: string;
}

export class BackgroundJobTracker {
  private jobs: Map<string, BackgroundJob> = new Map();
  private persistDir: string;

  constructor(persistDir: string) {
    this.persistDir = persistDir;
    fs.mkdirSync(persistDir, { recursive: true });
  }

  register(id: string, command: string, opts?: { pid?: number; logPath?: string; completionSignal?: string }): BackgroundJob {
    const job: BackgroundJob = {
      id,
      command,
      pid: opts?.pid,
      startedAt: new Date().toISOString(),
      logPath: opts?.logPath,
      lastHeartbeatAt: null,
      completionSignal: opts?.completionSignal,
      exitCode: null,
      status: "running",
      note: "",
    };
    this.jobs.set(id, job);
    this.persist(job);
    return job;
  }

  heartbeat(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lastHeartbeatAt = new Date().toISOString();
    this.persist(job);
  }

  complete(id: string, exitCode: number, note?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = exitCode === 0 ? "completed" : "failed";
    job.exitCode = exitCode;
    job.note = note ?? "";
    this.persist(job);
  }

  fail(id: string, note: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "failed";
    job.note = note;
    this.persist(job);
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  getAll(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  isAllComplete(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === "running") return false;
    }
    return true;
  }

  hasFailures(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === "failed") return true;
    }
    return false;
  }

  private persist(job: BackgroundJob): void {
    atomicWriteJson(path.join(this.persistDir, `${job.id}.json`), job);
  }

  /** Load previously persisted jobs from disk */
  static load(persistDir: string): BackgroundJobTracker {
    const tracker = new BackgroundJobTracker(persistDir);
    if (!fs.existsSync(persistDir)) return tracker;

    for (const file of fs.readdirSync(persistDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(persistDir, file), "utf-8"));
        tracker.jobs.set(data.id, data as BackgroundJob);
      } catch {
        // Skip corrupt files
      }
    }
    return tracker;
  }
}
