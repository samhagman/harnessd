/**
 * Status renderer — produces human-readable status from run state.
 *
 * Generates both `status.json` (StatusSnapshot) and `status.md` (markdown).
 * Optimized for quick reading from Claude Code, `tail.sh`, and `status.sh`.
 *
 * Reference: TAD section 17
 */

import type {
  RunState,
  Packet,
  EventEntry,
  StatusSnapshot,
  WorkerRole,
} from "./schemas.js";

// ------------------------------------
// Status snapshot generation
// ------------------------------------

export function renderStatus(
  runState: RunState,
  events: EventEntry[],
  packets: Packet[],
): StatusSnapshot {
  const now = new Date();
  const startedAt = new Date(runState.createdAt);
  const elapsed = formatDuration(now.getTime() - startedAt.getTime());

  const currentPacket = runState.currentPacketId
    ? packets.find((p) => p.id === runState.currentPacketId) ?? null
    : null;

  const lastEvent = events.length > 0
    ? events[events.length - 1]!.event
    : null;

  // Detect alerts
  const alerts: string[] = [];
  if (runState.phase === "rate_limited") {
    alerts.push(`Rate limited. Next retry: ${runState.rateLimitState.nextRetryAt ?? "unknown"}`);
  }
  if (runState.phase === "needs_human") {
    alerts.push("Needs human input — check outbox for details.");
  }
  if (runState.operatorFlags.pauseAfterCurrentPacket) {
    alerts.push("Will pause after current packet completes.");
  }
  if (runState.operatorFlags.stopRequested) {
    alerts.push("Stop requested — will halt after current phase.");
  }
  if (runState.lastHeartbeatAt) {
    const heartbeatAge = now.getTime() - new Date(runState.lastHeartbeatAt).getTime();
    if (heartbeatAge > 15 * 60 * 1000) { // 15 minutes
      alerts.push(`Worker heartbeat stale (${formatDuration(heartbeatAge)} ago).`);
    }
  }

  // Determine next action
  const nextAction = describeNextAction(runState);

  // Worker info
  const currentWorker = runState.currentWorkerRole
    ? {
        role: runState.currentWorkerRole,
        sessionId: runState.currentWorkerSessionId,
        heartbeatAge: runState.lastHeartbeatAt
          ? formatDuration(now.getTime() - new Date(runState.lastHeartbeatAt).getTime())
          : null,
      }
    : null;

  return {
    runId: runState.runId,
    phase: runState.phase,
    objective: runState.objective,
    elapsed,
    currentPacket: currentPacket
      ? { id: currentPacket.id, title: currentPacket.title, status: currentPacket.status }
      : null,
    contractRound: null, // populated by orchestrator if in negotiation
    currentWorker,
    packetsComplete: runState.completedPacketIds.length,
    packetsTotal: runState.packetOrder.length,
    lastEvent,
    alerts,
    nextAction,
    updatedAt: now.toISOString(),
  };
}

// ------------------------------------
// Markdown rendering
// ------------------------------------

export function renderStatusMarkdown(snapshot: StatusSnapshot): string {
  const lines: string[] = [];

  lines.push(`# Harnessd Run: ${snapshot.runId}`);
  lines.push("");
  lines.push(`**Objective:** ${snapshot.objective}`);
  lines.push(`**Phase:** \`${snapshot.phase}\``);
  lines.push(`**Elapsed:** ${snapshot.elapsed}`);
  lines.push(`**Progress:** ${snapshot.packetsComplete}/${snapshot.packetsTotal} packets`);
  lines.push("");

  // Current packet
  if (snapshot.currentPacket) {
    lines.push("## Current Packet");
    lines.push(`- **ID:** ${snapshot.currentPacket.id}`);
    lines.push(`- **Title:** ${snapshot.currentPacket.title}`);
    lines.push(`- **Status:** ${snapshot.currentPacket.status}`);
    if (snapshot.contractRound !== null) {
      lines.push(`- **Contract Round:** ${snapshot.contractRound}`);
    }
    lines.push("");
  }

  // Current worker
  if (snapshot.currentWorker) {
    lines.push("## Active Worker");
    lines.push(`- **Role:** ${snapshot.currentWorker.role}`);
    if (snapshot.currentWorker.sessionId) {
      lines.push(`- **Session:** ${snapshot.currentWorker.sessionId}`);
    }
    if (snapshot.currentWorker.heartbeatAge) {
      lines.push(`- **Last heartbeat:** ${snapshot.currentWorker.heartbeatAge} ago`);
    }
    lines.push("");
  }

  // Alerts
  if (snapshot.alerts.length > 0) {
    lines.push("## Alerts");
    for (const alert of snapshot.alerts) {
      lines.push(`- ⚠ ${alert}`);
    }
    lines.push("");
  }

  // Next action
  lines.push("## Next");
  lines.push(snapshot.nextAction);
  lines.push("");

  // Footer
  lines.push(`---`);
  lines.push(`Updated: ${snapshot.updatedAt}`);

  return lines.join("\n");
}

// ------------------------------------
// Helpers
// ------------------------------------

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function describeNextAction(runState: RunState): string {
  switch (runState.phase) {
    case "planning":
      return "Planner is generating SPEC.md and packets.json.";
    case "selecting_packet":
      return "Selecting next packet from the packet list.";
    case "negotiating_contract":
      return `Negotiating contract for ${runState.currentPacketId ?? "unknown packet"}.`;
    case "building_packet":
      return `Builder is implementing ${runState.currentPacketId ?? "unknown packet"}.`;
    case "evaluating_packet":
      return `Evaluator is verifying ${runState.currentPacketId ?? "unknown packet"}.`;
    case "fixing_packet":
      return `Builder is fixing issues found by evaluator for ${runState.currentPacketId ?? "unknown packet"}.`;
    case "rate_limited":
      return `Waiting for rate limit to clear. Retry at ${runState.rateLimitState.nextRetryAt ?? "unknown"}.`;
    case "awaiting_plan_approval":
      return "Plan ready for review. Approve via inbox to continue.";
    case "awaiting_human_review":
      return `Packet ${runState.currentPacketId ?? "unknown"} ready for human review. Approve or reject via inbox.`;
    case "paused":
      return "Run is paused. Use resume.sh to continue.";
    case "needs_human":
      return "Waiting for human input. Check outbox/ for details.";
    case "completed":
      return "Run completed successfully.";
    case "failed":
      return "Run failed. Check events.jsonl and outbox/ for details.";
  }
}
