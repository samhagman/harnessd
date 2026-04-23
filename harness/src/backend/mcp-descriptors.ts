/**
 * Logical MCP server descriptor helpers.
 *
 * This module provides a shared table of which logical MCP servers each role
 * needs, and translates those descriptors to the backend-specific form:
 *
 * - Claude SDK (supportsMcpServers: true, supportsOutputSchema: false):
 *   Callers keep passing the in-process createSdkMcpServer() form directly.
 *   The claude-flavored runner callsites are unchanged.
 *
 * - Codex CLI (supportsMcpServers: true, supportsOutputSchema: true):
 *   Callers call buildCodexMcpServers() which returns LogicalMcpServerDescriptor
 *   objects pointing at the stdio binaries in harness/bin/. These are passed as
 *   opts.mcpServers and translated to `-c mcp_servers.*` flags in buildCodexArgs().
 *
 * Path resolution uses import.meta.url so paths are absolute and survive cwd
 * changes inside the Codex child process.
 *
 * Table of contents:
 * 1. LogicalMcpServerDescriptor re-export
 * 2. Bin path resolution helpers
 * 3. Per-role descriptor builders
 * 4. Backend-dispatch helper used by runner files
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PacketType, ProjectConfig } from "../schemas.js";
import type { AgentBackend } from "./types.js";
import type { RunMemory } from "../memvid.js";
import {
  createValidationMcpServer,
} from "../validation-tool.js";
import {
  createGateCheckMcpServer,
} from "../gate-check-tool.js";
import {
  createMemorySearchMcpServer,
} from "../memory-tool.js";
import {
  createResearchMcpServerRecord,
} from "../research-tools.js";
import type { ResearchToolAvailability } from "../research-tools.js";

export type { LogicalMcpServerDescriptor } from "./codex-cli.js";

// ---------------------------------------------------------------------------
// Bin path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a harness/bin/*.mts script.
 * Uses import.meta.url so this works regardless of cwd at call time.
 *
 * harness/src/backend/mcp-descriptors.ts
 *   → ../../bin/<name>.mts
 *   → harness/bin/<name>.mts
 */
function binPath(name: string): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bin",
    name,
  );
}

const VALIDATE_ENVELOPE_MCP_BIN = binPath("validate-envelope-mcp.mts");
const GATE_CHECK_MCP_BIN = binPath("gate-check-mcp.mts");
const MEMORY_SEARCH_MCP_BIN = binPath("memory-search-mcp.mts");

// ---------------------------------------------------------------------------
// Codex-flavored descriptor builders
// ---------------------------------------------------------------------------

/**
 * Build the validate_envelope MCP descriptor for a Codex session.
 * Optionally restricts to specific criterion IDs (for evaluator roles).
 */
function codexValidationDescriptor(criterionIds?: string[]): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (criterionIds && criterionIds.length > 0) {
    env["HARNESSD_CRITERION_IDS"] = criterionIds.join(",");
  }
  return {
    command: "npx",
    args: ["tsx", VALIDATE_ENVELOPE_MCP_BIN],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * Build the gate_check MCP descriptor for a Codex builder session.
 */
function codexGateCheckDescriptor(
  workspaceDir: string,
  packetType: PacketType,
  config: ProjectConfig,
): Record<string, unknown> {
  return {
    command: "npx",
    args: ["tsx", GATE_CHECK_MCP_BIN],
    env: {
      HARNESSD_WORKSPACE_DIR: workspaceDir,
      HARNESSD_PACKET_TYPE: packetType,
      HARNESSD_GATE_CONFIG: JSON.stringify(config),
    },
  };
}

/**
 * Build the memory_search MCP descriptor for a Codex session.
 */
function codexMemoryDescriptor(memory: RunMemory): Record<string, unknown> {
  const memvidPath = (memory as unknown as { dbPath?: string }).dbPath ?? "";
  return {
    command: "npx",
    args: ["tsx", MEMORY_SEARCH_MCP_BIN],
    env: {
      HARNESSD_MEMVID_PATH: memvidPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Backend-dispatch helper: used by runner files to build opts.mcpServers
// ---------------------------------------------------------------------------

/**
 * Options for building the mcpServers record for a role session.
 */
export interface RoleMcpOptions {
  /** Whether the role needs gate_check (builder only). */
  needsGateCheck?: boolean;
  /** Builder workspace dir + packet type (required when needsGateCheck is true). */
  workspaceDir?: string;
  packetType?: PacketType;
  config?: ProjectConfig;
  /** Whether the role needs memory_search. */
  memory?: RunMemory | null;
  /** Criterion IDs for evaluator validate_envelope cross-check. */
  criterionIds?: string[];
  /** Research tool availability (drives dynamic research tools record). */
  researchTools?: ResearchToolAvailability;
}

/**
 * Build the mcpServers record for a role session, dispatching to the correct
 * form based on the backend's capabilities.
 *
 * For Claude backends (supportsMcpServers: true, supportsOutputSchema: false):
 *   Returns in-process createSdkMcpServer() records — exactly what runners built before.
 *
 * For Codex backends (supportsMcpServers: true, supportsOutputSchema: true):
 *   Returns LogicalMcpServerDescriptor objects pointing at stdio binaries.
 *   These are passed to buildCodexArgs() which emits `-c mcp_servers.*` flags.
 *
 * For backends with supportsMcpServers() === false (FakeBackend):
 *   Returns an empty record — no MCP registration attempted.
 *
 * Note: `supportsMcpServers` is used as the proxy for "Claude-flavored" here.
 * Codex additionally has `supportsOutputSchema: true` which is the discriminator.
 * All current Claude backends have supportsMcpServers=true and supportsOutputSchema=false.
 * All current Codex backends have both true.
 */
export function buildRoleMcpServers(
  backend: AgentBackend,
  opts: RoleMcpOptions,
): Record<string, unknown> {
  if (!backend.supportsMcpServers()) {
    // FakeBackend or no-MCP backend — return empty record
    return {};
  }

  const isCodex = backend.supportsOutputSchema();

  if (isCodex) {
    // Codex: return LogicalMcpServerDescriptor objects → translated to -c flags
    const servers: Record<string, unknown> = {
      "harnessd-validation": codexValidationDescriptor(opts.criterionIds),
    };

    if (opts.needsGateCheck && opts.workspaceDir && opts.packetType && opts.config) {
      servers["harnessd-gate-check"] = codexGateCheckDescriptor(
        opts.workspaceDir,
        opts.packetType,
        opts.config,
      );
    }

    if (opts.memory) {
      servers["harnessd-memory"] = codexMemoryDescriptor(opts.memory);
    }

    // Research tools — Codex uses the same record shape (already descriptors or ignored)
    if (opts.researchTools) {
      const researchRecord = createResearchMcpServerRecord(opts.researchTools);
      Object.assign(servers, researchRecord);
    }

    return servers;
  } else {
    // Claude SDK: return in-process createSdkMcpServer() records (unchanged from before)
    const servers: Record<string, unknown> = {
      "harnessd-validation": createValidationMcpServer(opts.criterionIds),
    };

    if (opts.needsGateCheck && opts.workspaceDir && opts.packetType && opts.config) {
      servers["harnessd-gate-check"] = createGateCheckMcpServer(
        opts.workspaceDir,
        opts.packetType,
        opts.config,
      );
    }

    if (opts.memory) {
      servers["harnessd-memory"] = createMemorySearchMcpServer(opts.memory);
    }

    if (opts.researchTools) {
      const researchRecord = createResearchMcpServerRecord(opts.researchTools);
      Object.assign(servers, researchRecord);
    }

    return servers;
  }
}
