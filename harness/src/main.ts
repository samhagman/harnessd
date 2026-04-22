#!/usr/bin/env node
/**
 * Harnessd v2 — CLI entry point.
 *
 * Usage:
 *   npx tsx src/main.ts "objective text"                        # Run with objective
 *   npx tsx src/main.ts --plan-only "objective"                  # Plan only, don't build
 *   npx tsx src/main.ts --resume [run-id]                        # Resume a run
 *   npx tsx src/main.ts --status [run-id]                        # Show status
 *   npx tsx src/main.ts --workspace <dir> "objective"             # Agents work in <dir>
 *   npx tsx src/main.ts --context <file.json> "objective"         # Load planning context from file
 *   npx tsx src/main.ts --run-id <name> "objective"               # Use a specific run directory name
 *   npx tsx src/main.ts --env <path> "objective"                  # Load env vars from file
 */

import process from "node:process";
import fs from "node:fs";
import path from "node:path";

import { ClaudeSdkBackend } from "./backend/claude-sdk.js";
import { BackendFactory } from "./backend/backend-factory.js";
import { runOrchestrator } from "./orchestrator.js";
import { getLatestRunId, getRunDir, createRun, loadRun, atomicWriteJson, validateWorkspacePath, getDefaultWorkspacePath, generateRunId } from "./state-store.js";
import type { PlanningContext } from "./schemas.js";
import type { RoleBackendMap } from "./schemas.js";
import { defaultProjectConfig } from "./schemas.js";
import { resolveResearchToolAvailability } from "./research-tools.js";

// ------------------------------------
// .env file loading
// ------------------------------------

/**
 * Load environment variables from a .env file into process.env.
 *
 * Supports: KEY=value, KEY="quoted value", KEY='single quoted',
 * # comments, empty lines. Does NOT override existing env vars
 * (shell environment takes precedence over .env file).
 *
 * No external dependency — standard .env parsing inline.
 */
function loadEnvFile(filePath: string): number {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }

  let loaded = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (double or single)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Don't override existing env vars — shell takes precedence
    if (key && !(key in process.env)) {
      process.env[key] = value;
      loaded++;
    }
  }

  return loaded;
}

// ------------------------------------
// Main
// ------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --env <path>: load env vars from a .env file (before anything else)
  // Also auto-loads .env from cwd if it exists (standard convention)
  const envIdx = args.indexOf("--env");
  if (envIdx !== -1 && args[envIdx + 1] && !args[envIdx + 1]!.startsWith("--")) {
    const envPath = path.resolve(args[envIdx + 1]!);
    const count = loadEnvFile(envPath);
    if (count > 0) console.log(`[env] Loaded ${count} vars from ${envPath}`);
    else console.log(`[env] No vars loaded from ${envPath} (file missing or empty)`);
  } else {
    // Auto-load .env from harness directory (standard convention)
    const defaultEnv = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env");
    const count = loadEnvFile(defaultEnv);
    if (count > 0) console.log(`[env] Loaded ${count} vars from .env`);
  }

  const repoRoot = process.env.WIGGUM_REPO_ROOT ?? process.cwd();

  // --status
  if (args.includes("--status")) {
    const runIdArg = args[args.indexOf("--status") + 1];
    const runId = runIdArg && !runIdArg.startsWith("--") ? runIdArg : getLatestRunId(repoRoot);
    if (!runId) {
      console.error("No runs found. Start a run first.");
      process.exit(1);
    }
    const statusPath = path.join(getRunDir(repoRoot, runId), "status.md");
    try {
      console.log(fs.readFileSync(statusPath, "utf-8"));
    } catch {
      console.error(`No status file for run ${runId}`);
    }
    return;
  }

  // --resume
  if (args.includes("--resume")) {
    const runIdArg = args[args.indexOf("--resume") + 1];
    const resumeRunId = runIdArg && !runIdArg.startsWith("--") ? runIdArg : getLatestRunId(repoRoot);
    if (!resumeRunId) {
      console.error("No runs found to resume.");
      process.exit(1);
    }
    // Restore workspaceDir and backend config from persisted run state + config
    const runState = loadRun(repoRoot, resumeRunId);
    const resumeWorkspaceDir = runState.workspaceDir ?? undefined;

    // Restore full config from persisted config.json (includes roleBackends, devServer, etc.)
    let savedConfig: Record<string, unknown> = {};
    try {
      const configPath = path.join(getRunDir(repoRoot, resumeRunId), "config.json");
      if (fs.existsSync(configPath)) {
        savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      }
    } catch { /* use defaults */ }

    const resumeRoleBackends = (savedConfig.roleBackends ?? {}) as RoleBackendMap;
    const resumeCodexModel = savedConfig.codexModel as string | undefined;

    const claudeBackend = new ClaudeSdkBackend();
    const resumeFactory = new BackendFactory(claudeBackend, { roleBackends: resumeRoleBackends, codexModel: resumeCodexModel });
    await runOrchestrator(resumeFactory, { repoRoot, objective: "", resumeRunId, workspaceDir: resumeWorkspaceDir, config: savedConfig });
    return;
  }

  // --plan-only
  const planOnly = args.includes("--plan-only");

  // --context <file.json>: load planning context from a JSON file
  const contextIdx = args.indexOf("--context");
  let contextFile: string | undefined;
  if (contextIdx !== -1 && args[contextIdx + 1] && !args[contextIdx + 1]!.startsWith("--")) {
    contextFile = path.resolve(args[contextIdx + 1]!);
  }

  // --model <model>: override the LLM model for all agents
  let model: string | undefined;
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1] && !args[modelIdx + 1]!.startsWith("--")) {
    model = args[modelIdx + 1]!;
  }

  // --effort <level>: override the reasoning effort for Claude Code sessions
  // Valid values: low | medium | high | xhigh | max  (default: "high")
  const VALID_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
  type EffortLevel = (typeof VALID_EFFORT_LEVELS)[number];
  let effort: EffortLevel | undefined;
  const effortIdx = args.indexOf("--effort");
  if (effortIdx !== -1 && args[effortIdx + 1] && !args[effortIdx + 1]!.startsWith("--")) {
    const raw = args[effortIdx + 1]!;
    if (!(VALID_EFFORT_LEVELS as readonly string[]).includes(raw)) {
      console.error(`Error: --effort must be one of: ${VALID_EFFORT_LEVELS.join(", ")}. Got: "${raw}"`);
      process.exit(1);
    }
    effort = raw as EffortLevel;
  }

  // --run-id <name>: use a specific run directory name instead of auto-generated
  // Parsed before workspace so that the default workspace path can reference the run ID.
  let customRunId: string | undefined;
  const runIdIdx = args.indexOf("--run-id");
  if (runIdIdx !== -1 && args[runIdIdx + 1] && !args[runIdIdx + 1]!.startsWith("--")) {
    customRunId = args[runIdIdx + 1]!;
  }

  // Effective run ID: the one we will use for this run (or resume).
  // Generated here so that the default workspace path can reference it.
  const effectiveRunId = customRunId ?? generateRunId();

  // --workspace <dir>: agents work here instead of repo root.
  // When not specified, default to <run-dir>/workspace/ — a durable, co-located
  // path that survives reboots and avoids the /tmp data loss scenario.
  let workspaceDir: string;
  const wsIdx = args.indexOf("--workspace");
  if (wsIdx !== -1 && args[wsIdx + 1] && !args[wsIdx + 1]!.startsWith("--")) {
    workspaceDir = path.resolve(args[wsIdx + 1]!);
  } else {
    workspaceDir = getDefaultWorkspacePath(repoRoot, effectiveRunId);
  }
  validateWorkspacePath(workspaceDir);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // --codex-roles <roles>: comma-separated list of roles to run with Codex
  let roleBackends: RoleBackendMap = {};
  const codexRolesIdx = args.indexOf("--codex-roles");
  if (codexRolesIdx !== -1 && args[codexRolesIdx + 1] && !args[codexRolesIdx + 1]!.startsWith("--")) {
    const roles = args[codexRolesIdx + 1]!.split(",").map((r) => r.trim());
    const rb: Record<string, "codex"> = {};
    for (const role of roles) rb[role] = "codex";
    roleBackends = rb as RoleBackendMap;
  }

  // --codex-model <model>: model for Codex CLI backend (e.g. "o3", "o4-mini")
  let codexModel: string | undefined;
  const codexModelIdx = args.indexOf("--codex-model");
  if (codexModelIdx !== -1 && args[codexModelIdx + 1] && !args[codexModelIdx + 1]!.startsWith("--")) {
    codexModel = args[codexModelIdx + 1]!;
  }

  // --perplexity: enable Perplexity research tools (requires PERPLEXITY_API_KEY)
  const enablePerplexity = args.includes("--perplexity");

  // --no-memory: disable run memory (no .mv2 file, no search_memory tool)
  const disableMemory = args.includes("--no-memory");

  // --no-context7: disable Context7 research tool
  const disableContext7 = args.includes("--no-context7");

  const filteredArgs = args.filter((a, i) =>
    !a.startsWith("--") &&
    (i === 0 || (args[i - 1] !== "--workspace" && args[i - 1] !== "--context" && args[i - 1] !== "--model" && args[i - 1] !== "--effort" && args[i - 1] !== "--run-id" && args[i - 1] !== "--codex-roles" && args[i - 1] !== "--codex-model" && args[i - 1] !== "--env")),
  );
  const objective = filteredArgs.join(" ").trim();

  if (!objective) {
    console.log(`Usage:
  npx tsx src/main.ts "your objective"
  npx tsx src/main.ts --plan-only "your objective"
  npx tsx src/main.ts --context planning-context.json "your objective"
  npx tsx src/main.ts --resume [run-id]
  npx tsx src/main.ts --status [run-id]
  npx tsx src/main.ts --workspace <dir> "your objective"
  npx tsx src/main.ts --run-id <name> "your objective"
  npx tsx src/main.ts --perplexity "your objective"
  npx tsx src/main.ts --no-memory "your objective"
  npx tsx src/main.ts --no-context7 "your objective"
  npx tsx src/main.ts --env .env.local "your objective"
  npx tsx src/main.ts --effort xhigh "your objective"  # effort: low|medium|high|xhigh|max`);
    process.exit(1);
  }

  console.log("============================================================");
  console.log("  HARNESSD v2");
  console.log("============================================================");
  console.log(`Objective: ${objective}`);
  console.log(`Repo root: ${repoRoot}`);
  if (planOnly) console.log("Mode: plan-only");
  if (contextFile) console.log(`Planning context: ${contextFile}`);
  console.log("============================================================\n");

  // Load planning context from file if --context was provided
  let planningContext: PlanningContext | undefined;
  if (contextFile) {
    const { PlanningContextSchema } = await import("./schemas.js");
    const raw = JSON.parse(fs.readFileSync(contextFile, "utf-8"));
    planningContext = PlanningContextSchema.parse(raw);
    console.log(`Loaded planning context from ${contextFile}`);
  }

  const claudeBackend = new ClaudeSdkBackend();
  const factory = new BackendFactory(claudeBackend, { roleBackends, codexModel });

  if (planOnly) {
    const { runPlanner } = await import("./planner.js");
    const { appendEvent, readEvents } = await import("./event-log.js");
    const { renderStatus, renderStatusMarkdown } = await import("./status-renderer.js");
    const { createRunMemory, getMemoryPath, specToDocuments } = await import("./memvid.js");

    const researchTools = {
      context7: !disableContext7,
      perplexity: enablePerplexity,
    };
    const config = {
      ...defaultProjectConfig(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      roleBackends,
      codexModel,
      researchTools,
      ...(disableMemory ? { enableMemory: false } : {}),
      ...(planningContext?.toolGates ? { toolGates: planningContext.toolGates } : {}),
      ...(planningContext?.enableDefaultGates !== undefined ? { enableDefaultGates: planningContext.enableDefaultGates } : {}),
    };
    // Resolve research tool availability (check env vars, log summary)
    config.researchTools = resolveResearchToolAvailability(config);
    const runState = createRun(repoRoot, objective, config, effectiveRunId, workspaceDir);

    // Initialize run memory for plan-only mode (skip if disabled)
    let memory: import("./memvid.js").RunMemory | null = null;
    if (config.enableMemory) {
      try {
        const memoryPath = getMemoryPath(repoRoot, runState.runId);
        memory = await createRunMemory(memoryPath, repoRoot, runState.runId);
        if (memory) console.log("[memvid] Memory initialized");
      } catch { /* non-fatal */ }
    }

    // Write planning context if provided
    if (planningContext) {
      const specDir = path.join(getRunDir(repoRoot, runState.runId), "spec");
      fs.mkdirSync(specDir, { recursive: true });
      atomicWriteJson(path.join(specDir, "planning-context.json"), planningContext);
    }

    appendEvent(repoRoot, runState.runId, {
      event: "run.started",
      phase: "planning",
      detail: objective,
    });
    appendEvent(repoRoot, runState.runId, {
      event: "planning.started",
      phase: "planning",
    });

    const result = await runPlanner(factory.forRole("planner"), objective, {
      repoRoot,
      workspaceDir,
      runId: runState.runId,
      config,
      memory,
    }, undefined, undefined, planningContext);

    if (result.success) {
      appendEvent(repoRoot, runState.runId, {
        event: "planning.completed",
        phase: "planning",
        detail: `${result.packets.length} packets planned`,
      });

      // Write proper status files
      const events = readEvents(repoRoot, runState.runId);
      const snapshot = renderStatus({ ...runState, phase: "completed", packetOrder: result.packets.map(p => p.id) }, events, result.packets);
      const runDir = getRunDir(repoRoot, runState.runId);
      atomicWriteJson(path.join(runDir, "status.json"), snapshot);
      fs.writeFileSync(path.join(runDir, "status.md"), renderStatusMarkdown(snapshot));

      // Encode spec artifacts into memory
      if (memory) {
        memory.encodeInBackground(specToDocuments(runDir));
        try {
          await Promise.race([
            memory.waitForPendingWrites(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 10_000),
            ),
          ]);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "timeout") {
            console.log("[memvid] Warning: pending writes did not flush in 10s — some memory may be lost");
          }
          // non-fatal either way
        }
        console.log("[memvid] Planning artifacts encoded into memory");
      }

      console.log(`\nPlanning complete. ${result.packets.length} packets created.`);
      console.log(`Spec: ${result.specPath}`);
      console.log(`Run dir: ${runDir}`);
    } else {
      appendEvent(repoRoot, runState.runId, {
        event: "planning.failed",
        phase: "planning",
        detail: result.error,
      });
      // Wait for any buffered memory writes
      if (memory) {
        try {
          await Promise.race([
            memory.waitForPendingWrites(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 10_000),
            ),
          ]);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "timeout") {
            console.log("[memvid] Warning: pending writes did not flush in 10s — some memory may be lost");
          }
          // non-fatal either way
        }
      }
      console.error(`\nPlanning failed: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  const researchTools = {
    context7: !disableContext7,
    perplexity: enablePerplexity,
  };
  const orchConfig = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    roleBackends,
    codexModel,
    researchTools,
    ...(disableMemory ? { enableMemory: false } : {}),
    ...(planningContext?.toolGates ? { toolGates: planningContext.toolGates } : {}),
    ...(planningContext?.enableDefaultGates !== undefined ? { enableDefaultGates: planningContext.enableDefaultGates } : {}),
  };

  // Full run — always pre-create the run with effectiveRunId so the workspace
  // path (which references the run ID) is consistent, then resume it.
  {
    const fullConfig = { ...defaultProjectConfig(), ...orchConfig };
    const runState = createRun(repoRoot, objective, fullConfig, effectiveRunId, workspaceDir);
    const specDir = path.join(getRunDir(repoRoot, runState.runId), "spec");
    fs.mkdirSync(specDir, { recursive: true });
    if (planningContext) {
      atomicWriteJson(path.join(specDir, "planning-context.json"), planningContext);
    }
    // Resume this run (it starts in "planning" phase)
    await runOrchestrator(factory, { repoRoot, workspaceDir, objective: "", resumeRunId: runState.runId, config: orchConfig });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
