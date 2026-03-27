#!/usr/bin/env node
/**
 * Harnessd v2 — CLI entry point.
 *
 * Usage:
 *   npx tsx src/main.ts "objective text"             # Run with objective
 *   npx tsx src/main.ts --plan-only "objective"       # Plan only, don't build
 *   npx tsx src/main.ts --resume [run-id]             # Resume a run
 *   npx tsx src/main.ts --status [run-id]             # Show status
 *   npx tsx src/main.ts --workspace <dir> "objective"  # Agents work in <dir>
 *   npx tsx src/main.ts --interview "objective"        # Interactive planning context
 */

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { ClaudeSdkBackend } from "./backend/claude-sdk.js";
import { runOrchestrator } from "./orchestrator.js";
import { getLatestRunId, getRunDir, createRun, atomicWriteJson } from "./state-store.js";
import type { PlanningContext } from "./schemas.js";

// ------------------------------------
// Interactive interview
// ------------------------------------

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function collectPlanningContext(): Promise<PlanningContext> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n--- Planning Interview ---\n");

  const vision = await ask(rl, "What's your vision for this project? (high-level goal)\n> ");
  const techRaw = await ask(rl, "Any tech preferences? (e.g., TypeScript, CSS modules, no external UI libs) comma-separated:\n> ");
  const designRaw = await ask(rl, "Design references or inspiration? (URLs or descriptions) comma-separated:\n> ");
  const avoidRaw = await ask(rl, "Anything to avoid? (e.g., no Tailwind, no SSR) comma-separated:\n> ");
  const doneDefinition = await ask(rl, "What does 'done' look like? (acceptance definition)\n> ");
  const customNotes = await ask(rl, "Any other notes for the planner?\n> ");

  rl.close();
  console.log("\n--- Interview complete ---\n");

  return {
    vision: vision || undefined,
    techPreferences: techRaw ? techRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    designReferences: designRaw ? designRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    avoidList: avoidRaw ? avoidRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    doneDefinition: doneDefinition || undefined,
    customNotes: customNotes || undefined,
  };
}

// ------------------------------------
// Main
// ------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
    const backend = new ClaudeSdkBackend();
    await runOrchestrator(backend, { repoRoot, objective: "", resumeRunId });
    return;
  }

  // --plan-only
  const planOnly = args.includes("--plan-only");

  // --interview [file.json]: interactive planning, or load from file
  const interviewIdx = args.indexOf("--interview");
  const interview = interviewIdx !== -1;
  let interviewFile: string | undefined;
  if (interview && args[interviewIdx + 1] && !args[interviewIdx + 1]!.startsWith("--")) {
    interviewFile = path.resolve(args[interviewIdx + 1]!);
  }

  // --workspace <dir>: agents work here instead of repo root
  let workspaceDir: string | undefined;
  const wsIdx = args.indexOf("--workspace");
  if (wsIdx !== -1 && args[wsIdx + 1] && !args[wsIdx + 1]!.startsWith("--")) {
    workspaceDir = path.resolve(args[wsIdx + 1]!);
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  // --model <model>: override the LLM model for all agents
  let model: string | undefined;
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1] && !args[modelIdx + 1]!.startsWith("--")) {
    model = args[modelIdx + 1]!;
  }

  const filteredArgs = args.filter((a, i) =>
    !a.startsWith("--") &&
    (i === 0 || (args[i - 1] !== "--workspace" && args[i - 1] !== "--interview" && args[i - 1] !== "--model")),
  );
  const objective = filteredArgs.join(" ").trim();

  if (!objective) {
    console.log(`Usage:
  npx tsx src/main.ts "your objective"
  npx tsx src/main.ts --plan-only "your objective"
  npx tsx src/main.ts --interview "your objective"
  npx tsx src/main.ts --resume [run-id]
  npx tsx src/main.ts --status [run-id]
  npx tsx src/main.ts --workspace <dir> "your objective"`);
    process.exit(1);
  }

  console.log("============================================================");
  console.log("  HARNESSD v2");
  console.log("============================================================");
  console.log(`Objective: ${objective}`);
  console.log(`Repo root: ${repoRoot}`);
  if (planOnly) console.log("Mode: plan-only");
  if (interview) console.log("Mode: interactive planning");
  console.log("============================================================\n");

  // Collect planning context if --interview flag is set
  let planningContext: PlanningContext | undefined;
  if (interview) {
    if (interviewFile) {
      // Load from file (non-interactive mode)
      const { PlanningContextSchema } = await import("./schemas.js");
      const raw = JSON.parse(fs.readFileSync(interviewFile, "utf-8"));
      planningContext = PlanningContextSchema.parse(raw);
      console.log(`Loaded planning context from ${interviewFile}`);
    } else if (process.stdin.isTTY) {
      // Interactive mode — ask questions
      planningContext = await collectPlanningContext();
    } else {
      console.error("--interview requires a TTY or a file path: --interview context.json");
      process.exit(1);
    }
  }

  const backend = new ClaudeSdkBackend();

  if (planOnly) {
    const { runPlanner } = await import("./planner.js");
    const { appendEvent, readEvents } = await import("./event-log.js");
    const { renderStatus, renderStatusMarkdown } = await import("./status-renderer.js");
    const { defaultProjectConfig } = await import("./schemas.js");

    const config = { ...defaultProjectConfig(), ...(model ? { model } : {}) };
    const runState = createRun(repoRoot, objective);

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

    const result = await runPlanner(backend, objective, {
      repoRoot,
      runId: runState.runId,
      config,
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

      console.log(`\nPlanning complete. ${result.packets.length} packets created.`);
      console.log(`Spec: ${result.specPath}`);
      console.log(`Run dir: ${runDir}`);
    } else {
      appendEvent(repoRoot, runState.runId, {
        event: "planning.failed",
        phase: "planning",
        detail: result.error,
      });
      console.error(`\nPlanning failed: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  const orchConfig = model ? { model } : {};

  // Full run — write planning context first if provided
  if (planningContext) {
    // Create run early to get runId for writing context
    const runState = createRun(repoRoot, objective);
    const specDir = path.join(getRunDir(repoRoot, runState.runId), "spec");
    fs.mkdirSync(specDir, { recursive: true });
    atomicWriteJson(path.join(specDir, "planning-context.json"), planningContext);
    // Resume this run (it starts in "planning" phase)
    await runOrchestrator(backend, { repoRoot, workspaceDir, objective: "", resumeRunId: runState.runId, config: orchConfig });
  } else {
    await runOrchestrator(backend, { repoRoot, workspaceDir, objective, config: orchConfig });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
