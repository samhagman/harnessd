/**
 * Background job tracker for builder long-running commands.
 *
 * Also provides DevServerManager for starting/stopping dev servers
 * during QA and evaluation phases.
 *
 * Tracks command lifecycle: register → heartbeat → complete/fail.
 * Persists state to builder/background/ directory.
 *
 * Reference: TAD section 13.6
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { atomicWriteJson } from "./state-store.js";
import type { DevServerConfig } from "./schemas.js";

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

// ------------------------------------
// Dev server lifecycle management
// ------------------------------------

export interface DevServerHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Check if a port is currently in use.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Start a dev server and wait for it to be ready.
 *
 * Parses stdout for the readyPattern to determine when the server is
 * accepting connections. Returns a handle with the URL and a stop function.
 */
export async function startDevServer(
  config: DevServerConfig,
  cwd: string,
): Promise<DevServerHandle> {
  const portInUse = await isPortInUse(config.port);
  if (portInUse) {
    // Server might already be running — return handle for it
    console.log(`[dev-server] Port ${config.port} already in use — assuming server is running`);
    return {
      url: `http://localhost:${config.port}`,
      port: config.port,
      stop: async () => { /* not our process to stop */ },
    };
  }

  return new Promise<DevServerHandle>((resolve, reject) => {
    const timeoutMs = 30 * 1000;
    let resolved = false;

    // Split command for spawn
    const parts = config.command.split(/\s+/);
    const cmd = parts[0]!;
    const args = parts.slice(1);

    const proc: ChildProcess = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      shell: true,
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Dev server did not become ready within 30s`));
      }
    }, timeoutMs);

    const checkOutput = (data: Buffer) => {
      const text = data.toString();
      if (!resolved && text.includes(config.readyPattern)) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          url: `http://localhost:${config.port}`,
          port: config.port,
          stop: async () => {
            proc.kill("SIGTERM");
            // Give it a moment to shut down gracefully
            await new Promise((r) => setTimeout(r, 500));
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          },
        });
      }
    };

    proc.stdout?.on("data", checkOutput);
    proc.stderr?.on("data", checkOutput);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`Dev server failed to start: ${err.message}`));
      }
    });

    proc.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`Dev server exited with code ${code} before becoming ready`));
      }
    });
  });
}

/**
 * DevServerManager — manages a dev server across multiple phases.
 *
 * The server is started once and kept running until explicitly stopped.
 * Multiple phases (QA, evaluation) can share the same server.
 */
export class DevServerManager {
  private handle: DevServerHandle | null = null;
  private config: DevServerConfig;
  private cwd: string;

  constructor(config: DevServerConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
  }

  /** Start the dev server if not already running. */
  async ensureRunning(): Promise<DevServerHandle> {
    if (this.handle) return this.handle;
    this.handle = await startDevServer(this.config, this.cwd);
    console.log(`[dev-server] Started at ${this.handle.url}`);
    return this.handle;
  }

  /** Get the URL if the server is running. */
  getUrl(): string | undefined {
    return this.handle?.url;
  }

  /** Stop the dev server. */
  async stop(): Promise<void> {
    if (this.handle) {
      await this.handle.stop();
      console.log(`[dev-server] Stopped`);
      this.handle = null;
    }
  }
}
