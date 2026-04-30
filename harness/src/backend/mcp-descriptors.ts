/**
 * MCP server descriptor helpers.
 *
 * buildRoleMcpServers() dispatches to the correct MCP form based on the backend:
 *
 * - Claude SDK (supportsMcpServers: true, supportsOutputSchema: false):
 *   Returns in-process createSdkMcpServer() records passed directly to SDK options.
 *
 * - Codex CLI (supportsMcpServers: true, supportsOutputSchema: true):
 *   Returns LogicalMcpServerDescriptor objects pointing at stdio binaries in
 *   harness/bin/. buildCodexArgs() translates these to `-c mcp_servers.*` flags.
 *
 * - FakeBackend (supportsMcpServers: false):
 *   Returns an empty record — no MCP registration in tests.
 *
 * Path resolution uses import.meta.url so paths are absolute and survive cwd
 * changes inside the Codex child process.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PacketType, ProjectConfig } from "../schemas.js";
import type { AgentBackend } from "./types.js";
import type { RunMemory } from "../memvid.js";
import { createValidationMcpServer } from "../validation-tool.js";
import { createGateCheckMcpServer } from "../gate-check-tool.js";
import { createMemorySearchMcpServer } from "../memory-tool.js";
import { createResearchMcpServerRecord } from "../research-tools.js";
import type { ResearchToolAvailability } from "../research-tools.js";

export type { LogicalMcpServerDescriptor } from "./codex-cli.js";

// ---------------------------------------------------------------------------
// Bin path resolution
// ---------------------------------------------------------------------------

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

function codexValidationDescriptor(criterionIds?: string[]): Record<string, unknown> {
  const descriptor: Record<string, unknown> = {
    command: "npx",
    args: ["tsx", VALIDATE_ENVELOPE_MCP_BIN],
  };
  if (criterionIds && criterionIds.length > 0) {
    descriptor.env = { HARNESSD_CRITERION_IDS: criterionIds.join(",") };
  }
  return descriptor;
}

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
// Backend-dispatch helper
// ---------------------------------------------------------------------------

export interface RoleMcpOptions {
  /** Whether the role needs gate_check (builder only). */
  needsGateCheck?: boolean;
  /** Required when needsGateCheck is true. */
  workspaceDir?: string;
  packetType?: PacketType;
  config?: ProjectConfig;
  memory?: RunMemory | null;
  /** Criterion IDs for evaluator validate_envelope cross-check. */
  criterionIds?: string[];
  researchTools?: ResearchToolAvailability;
}

/**
 * Build the mcpServers record for a role session.
 *
 * Dispatches to the Codex form (LogicalMcpServerDescriptor objects → stdio binaries)
 * or the Claude SDK form (in-process createSdkMcpServer() objects) based on
 * backend.supportsOutputSchema(). Returns an empty record for backends where
 * supportsMcpServers() is false (FakeBackend).
 */
export function buildRoleMcpServers(
  backend: AgentBackend,
  opts: RoleMcpOptions,
): Record<string, unknown> {
  if (!backend.supportsMcpServers()) {
    return {};
  }

  const isCodex = backend.supportsOutputSchema();

  if (isCodex) {
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

    if (opts.researchTools) {
      Object.assign(servers, createResearchMcpServerRecord(opts.researchTools));
    }

    return servers;
  } else {
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
      Object.assign(servers, createResearchMcpServerRecord(opts.researchTools));
    }

    return servers;
  }
}
