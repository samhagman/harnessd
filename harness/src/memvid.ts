/**
 * Anti-corruption layer (ACL) over @memvid/sdk.
 *
 * This is the ONLY file in the harness that imports from @memvid/sdk.
 * All other modules import our domain types: MemvidDocument, SearchHit, etc.
 *
 * Responsibilities:
 *   - Translate MemvidDocument ↔ SDK PutManyInput/FindHit/TimelineEntry
 *   - Manage background write serialization via a single writeQueue
 *   - Gracefully degrade when @memvid/sdk is not installed (returns null)
 *   - Emit memory.encoded / memory.error events into the event log
 *
 * Reference: plans/iterative-waddling-pumpkin.md — Phase 1 & Phase 2
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  EventEntry,
  PacketContract,
  BuilderReport,
  EvaluatorReport,
  QAReport,
} from './schemas.js';

import type { AgentMessage } from './backend/types.js';

import { appendEvent } from './event-log.js';

// ------------------------------------
// Table of contents
//   1. Domain types (our ACL boundary)
//   2. SDK loader (dynamic import, graceful null on missing)
//   3. ACL translation helpers
//   4. RunMemory class
//   5. MemvidBuffer class (micro-batch buffer for real-time encoding)
//   6. Factory functions
//   7. Document preparation functions
//   8. Real-time encoding helpers (agentMessageToDocuments, promptToDocuments, etc.)
// ------------------------------------

// ============================================================
// 1. Domain types — exported, used by orchestrator and callers
// ============================================================

export type DocumentCategory =
  | 'event'
  | 'transcript'
  | 'spec'
  | 'contract'
  | 'builder-report'
  | 'eval-report'
  | 'qa-report'
  | 'summary'
  | 'nudge'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'prompt'
  | 'session'
  | 'agent-event'
  | 'operator'
  | 'contract-round'
  | 'plan-review';

/**
 * Our domain representation of a document to store in run memory.
 * Never contains @memvid/sdk types.
 */
export interface MemvidDocument {
  title: string;
  label: string;
  text: string;
  metadata: {
    ts: string;
    packetId?: string;
    role?: string;
    phase?: string;
    category: DocumentCategory;
    [key: string]: unknown;
  };
  tags: string[];
}

/**
 * Our domain representation of a search result.
 * Never contains @memvid/sdk types.
 */
export interface SearchHit {
  score: number;
  title: string;
  label: string;
  text: string;
  snippet: string;
  metadata: Record<string, unknown>;
}

/**
 * Our domain search options.
 */
export interface SearchOptions {
  k?: number;
  mode?: 'auto' | 'lex' | 'sem';
  snippetChars?: number;
}

// ============================================================
// 2. SDK loader — dynamic import with graceful null
// ============================================================

interface SdkModule {
  create(filename: string, kind?: string, options?: { readOnly?: boolean }): Promise<import('@memvid/sdk').Memvid>;
  open(filename: string, kind?: string, options?: { readOnly?: boolean }): Promise<import('@memvid/sdk').Memvid>;
}

let _sdkPromise: Promise<SdkModule | null> | null = null;

async function loadSdk(): Promise<SdkModule | null> {
  if (!_sdkPromise) {
    _sdkPromise = import('@memvid/sdk')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((mod: any) => ({
        create: mod.create ?? mod.default?.create,
        open: mod.open ?? mod.default?.open,
      }) as SdkModule)
      .catch(() => null);
  }
  return _sdkPromise;
}

// ============================================================
// 3. ACL translation helpers (our types ↔ vendor types)
// ============================================================

/** Translate our MemvidDocument to the SDK's PutManyInput format. */
function toPutManyInput(doc: MemvidDocument): { title: string; text: string; labels?: string[]; tags?: string[]; metadata?: Record<string, unknown> } {
  return {
    title: doc.title,
    text: doc.text,
    labels: [doc.label],
    tags: doc.tags,
    metadata: doc.metadata,
  };
}

/** Translate an SDK FindHit to our SearchHit domain type. */
function fromFindHit(h: {
  frame_id: number;
  uri: string;
  title: string;
  snippet: string;
  score: number;
  rank: number;
  tags: string[];
  labels: string[];
  created_at: string;
}): SearchHit {
  return {
    score: h.score,
    title: h.title,
    label: h.labels?.[0] ?? '',
    text: '', // find() does not return full text; caller uses snippet
    snippet: h.snippet,
    metadata: {
      frame_id: h.frame_id,
      created_at: h.created_at,
      tags: h.tags,
    },
  };
}

/** Translate an SDK TimelineEntry to our SearchHit domain type. */
function fromTimelineEntry(e: {
  frame_id: number;
  uri: string;
  timestamp: number;
  preview: string;
}): SearchHit {
  return {
    score: 0,
    title: e.uri ?? `frame-${e.frame_id}`,
    label: 'timeline',
    text: e.preview,
    snippet: e.preview,
    metadata: {
      frame_id: e.frame_id,
      timestamp: e.timestamp,
      uri: e.uri,
    },
  };
}

// ============================================================
// 4. RunMemory class — the ACL implementation
// ============================================================

/**
 * RunMemory manages the run's searchable memory (.mv2 file).
 *
 * Write operations are serialized via writeQueue — multiple rapid
 * encodeInBackground() calls queue up and execute one after another.
 * This prevents concurrent write conflicts on the .mv2 file.
 */
export class RunMemory {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly memoryPath: string;
  private readonly repoRoot: string;
  private readonly runId: string;

  constructor(memoryPath: string, repoRoot: string, runId: string) {
    this.memoryPath = memoryPath;
    this.repoRoot = repoRoot;
    this.runId = runId;
  }

  /**
   * Encode documents into the memory file in the background (fire-and-forget).
   * Errors are caught, logged, and emitted as memory.error events.
   * The run is never affected by encoding failures.
   */
  encodeInBackground(docs: MemvidDocument[]): void {
    this.writeQueue = this.writeQueue
      .then(() => this.encode(docs))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[memvid] Warning: background encoding failed: ${msg}`);
        try {
          appendEvent(this.repoRoot, this.runId, {
            event: 'memory.error',
            detail: msg,
          });
        } catch {
          // If event log is also unavailable, silently ignore — don't cascade
        }
      });
  }

  /**
   * Encode documents into the memory file (awaitable).
   * Opens the .mv2 file, appends documents, and seals.
   */
  async encode(docs: MemvidDocument[]): Promise<void> {
    if (docs.length === 0) return;

    const sdk = await loadSdk();
    if (!sdk) return;

    const requests = docs.map(toPutManyInput);
    const options = {
      enableEmbedding: true,
      embeddingModel: 'bge-small',
    };

    const mem = await sdk.open(this.memoryPath, 'basic', { readOnly: false });
    try {
      await mem.putMany(requests, options);
      await mem.seal();
    } catch (err) {
      // Attempt seal on error so the file is not left in an inconsistent state
      try { await mem.seal(); } catch { /* ignore seal error */ }
      throw err;
    }

    try {
      appendEvent(this.repoRoot, this.runId, {
        event: 'memory.encoded',
        detail: `${docs.length} document(s) encoded into memory`,
      });
    } catch {
      // Event log failure should not abort encoding
    }
  }

  /**
   * Search the memory for documents matching a query.
   * Returns empty array if the .mv2 file does not exist or search fails.
   */
  async search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    if (!fs.existsSync(this.memoryPath)) return [];

    const sdk = await loadSdk();
    if (!sdk) return [];

    const mem = await sdk.open(this.memoryPath, 'basic', { readOnly: true });

    // SDK mode mapping: our 'auto' and 'sem' both use SDK's 'sem' mode which
    // gives hybrid search (lexical + semantic reranking) when queryEmbeddingModel
    // is provided. SDK's 'auto' mode only does lexical search despite the name.
    const preferSem = opts?.mode !== 'lex';
    try {
      const result = await mem.find(query, {
        mode: preferSem ? 'sem' : 'lex',
        k: opts?.k ?? 5,
        snippetChars: opts?.snippetChars ?? 300,
        queryEmbeddingModel: preferSem ? 'bge-small' : undefined,
      });
      return result.hits.map(fromFindHit);
    } catch (err) {
      // Vec index may not exist yet (empty memory or only lex-indexed data).
      // Fall back to lexical search before giving up.
      if (preferSem && String(err).includes('index')) {
        try {
          const lexResult = await mem.find(query, {
            mode: 'lex',
            k: opts?.k ?? 5,
            snippetChars: opts?.snippetChars ?? 300,
          });
          return lexResult.hits.map(fromFindHit);
        } catch {
          return [];
        }
      }
      return [];
    }
  }

  /**
   * Return a chronological slice of the memory timeline.
   * Useful for time-range queries ("what happened in the last 2h?").
   */
  async timeline(opts?: {
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<SearchHit[]> {
    if (!fs.existsSync(this.memoryPath)) return [];

    const sdk = await loadSdk();
    if (!sdk) return [];

    const mem = await sdk.open(this.memoryPath, 'basic', { readOnly: true });
    const entries = await mem.timeline({
      since: opts?.since,
      until: opts?.until,
      limit: opts?.limit ?? 50,
    });

    return entries.map(fromTimelineEntry);
  }

  /**
   * Wait for all pending background writes to complete.
   * Call this at run end to ensure no data is lost.
   */
  async waitForPendingWrites(): Promise<void> {
    await this.writeQueue;
  }
}

// ============================================================
// 5. MemvidBuffer class — micro-batch buffer for real-time encoding
// ============================================================

/**
 * Accumulates MemvidDocuments and flushes them to RunMemory in micro-batches.
 *
 * Flushes when either:
 *   - The buffer reaches maxBufferSize (default 5) docs, OR
 *   - The flush timer fires (default every 5 seconds)
 *
 * The timer uses .unref() so it never prevents process exit.
 * Call stop() in worker finally blocks for non-blocking flush.
 * Call drain() at run end to await all pending writes.
 */
export class MemvidBuffer {
  private buffer: MemvidDocument[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly memory: RunMemory;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;

  constructor(memory: RunMemory, opts?: { maxBufferSize?: number; flushIntervalMs?: number }) {
    this.memory = memory;
    this.maxBufferSize = opts?.maxBufferSize ?? 5;
    this.flushIntervalMs = opts?.flushIntervalMs ?? 5_000;
    this.startFlushTimer();
  }

  /** Add a single document. Triggers immediate flush if buffer is full. */
  add(doc: MemvidDocument): void {
    this.buffer.push(doc);
    if (this.buffer.length >= this.maxBufferSize) this.triggerFlush();
  }

  /** Add multiple documents. Triggers immediate flush if buffer is full. */
  addMany(docs: MemvidDocument[]): void {
    this.buffer.push(...docs);
    if (this.buffer.length >= this.maxBufferSize) this.triggerFlush();
  }

  /**
   * Flush remaining buffer and stop the timer (non-blocking).
   * Call this in worker finally blocks.
   */
  stop(): void {
    this.stopFlushTimer();
    this.triggerFlush();
  }

  /**
   * Flush remaining buffer and await all pending writes.
   * Call this at run end to ensure no data is lost.
   */
  async drain(): Promise<void> {
    this.stopFlushTimer();
    this.triggerFlush();
    await this.memory.waitForPendingWrites();
  }

  private triggerFlush(): void {
    if (this.buffer.length === 0) return;
    const docs = this.buffer.splice(0);
    this.memory.encodeInBackground(docs);
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.triggerFlush(), this.flushIntervalMs);
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ============================================================
// 6. Factory functions
// ============================================================

/**
 * Derive the canonical .mv2 path for a run.
 *
 * @example
 * getMemoryPath('/repo', 'my-run')
 * // → /repo/.harnessd/runs/my-run/memory.mv2
 */
export function getMemoryPath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, '.harnessd', 'runs', runId, 'memory.mv2');
}

/**
 * Create a new memory file for a run.
 * Overwrites any existing file at the path.
 * Returns null if @memvid/sdk is not installed.
 */
export async function createRunMemory(
  memoryPath: string,
  repoRoot: string,
  runId: string,
): Promise<RunMemory | null> {
  const sdk = await loadSdk();
  if (!sdk) {
    console.log('[memvid] @memvid/sdk not installed, memory features disabled');
    return null;
  }

  // create() initializes a fresh .mv2 file (overwrites if exists)
  const mem = await sdk.create(memoryPath, 'basic');
  await mem.enableLex();
  await mem.seal();

  return new RunMemory(memoryPath, repoRoot, runId);
}

/**
 * Open an existing memory file for a run (e.g., on resume).
 * Returns null if the file doesn't exist or @memvid/sdk is not installed.
 */
export async function openRunMemory(
  memoryPath: string,
  repoRoot: string,
  runId: string,
): Promise<RunMemory | null> {
  const sdk = await loadSdk();
  if (!sdk) {
    console.log('[memvid] @memvid/sdk not installed, memory features disabled');
    return null;
  }

  if (!fs.existsSync(memoryPath)) {
    return null;
  }

  try {
    // Verify the file is openable before returning the RunMemory instance
    await sdk.open(memoryPath, 'basic', { readOnly: true });
    return new RunMemory(memoryPath, repoRoot, runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[memvid] Warning: could not open existing memory file: ${msg}`);
    return null;
  }
}

// ============================================================
// 7. Document preparation functions
//    One per artifact type. Each returns MemvidDocument(s) with
//    rich titles, tags, and metadata for retrieval quality.
// ============================================================

/**
 * Convert run event entries into memory documents.
 * One document per event (short, metadata-rich).
 */
export function eventsToDocuments(events: EventEntry[]): MemvidDocument[] {
  return events.map((e) => ({
    title: `Event: ${e.event}${e.packetId ? ` — ${e.packetId}` : ''}`,
    label: 'event',
    text: [
      `[${e.ts}] ${e.event}`,
      e.phase ? `(phase: ${e.phase})` : null,
      e.detail ? `: ${e.detail}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    metadata: {
      ts: e.ts,
      packetId: e.packetId,
      phase: e.phase,
      category: 'event' as const,
    },
    tags: ['event', e.event, e.phase, e.packetId].filter((t): t is string => Boolean(t)),
  }));
}

/** Maximum character count before a transcript turn is chunked. */
const TRANSCRIPT_CHUNK_MAX = 2000;
/** Character count for each chunk. */
const TRANSCRIPT_CHUNK_SIZE = 1500;
/** Overlap between adjacent chunks. */
const TRANSCRIPT_CHUNK_OVERLAP = 200;

/**
 * Split a long text into overlapping chunks for better retrieval coverage.
 * Chunks of ~TRANSCRIPT_CHUNK_SIZE chars with TRANSCRIPT_CHUNK_OVERLAP overlap.
 */
function chunkText(text: string): string[] {
  if (text.length <= TRANSCRIPT_CHUNK_MAX) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + TRANSCRIPT_CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - TRANSCRIPT_CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Convert a transcript JSONL file into memory documents.
 * One document per assistant turn (atomic unit of agent reasoning).
 * Long turns are split into overlapping chunks.
 *
 * Expected JSONL line format: { ts: string, role: string, msg: { type: string, text?: string, ... } }
 */
export function transcriptToDocuments(
  transcriptPath: string,
  packetId: string,
  role: string,
): MemvidDocument[] {
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const docs: MemvidDocument[] = [];
  let turnIndex = 0;

  for (const line of lines) {
    let entry: { ts?: string; role?: string; msg?: { type?: string; text?: string } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }

    // Only include assistant turns — those contain agent reasoning
    if (entry.msg?.type !== 'assistant' && entry.role !== 'assistant') continue;

    const text = entry.msg?.text ?? '';
    if (!text.trim()) continue;

    const ts = entry.ts ?? new Date().toISOString();
    turnIndex++;

    const chunks = chunkText(text);
    chunks.forEach((chunk, ci) => {
      const chunkSuffix = chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : '';
      docs.push({
        title: `${role} turn ${turnIndex}${chunkSuffix} — ${packetId}`,
        label: 'transcript',
        text: chunk,
        metadata: {
          ts,
          packetId,
          role,
          category: 'transcript' as const,
          turnIndex,
          chunkIndex: ci,
          chunkTotal: chunks.length,
        },
        tags: ['transcript', role, packetId],
      });
    });
  }

  return docs;
}

/**
 * Convert spec directory artifacts into memory documents.
 * Reads SPEC.md, packets.json, risk-register.json, evaluator-guide.json.
 * Each file becomes one document.
 */
export function specToDocuments(runDir: string): MemvidDocument[] {
  const specDir = path.join(runDir, 'spec');
  const ts = new Date().toISOString();
  const docs: MemvidDocument[] = [];

  const files: Array<{ file: string; title: string; label: string }> = [
    { file: 'SPEC.md', title: 'Specification (SPEC.md)', label: 'spec' },
    { file: 'packets.json', title: 'Packet list (packets.json)', label: 'spec' },
    { file: 'risk-register.json', title: 'Risk register', label: 'spec' },
    { file: 'evaluator-guide.json', title: 'Evaluator guide', label: 'spec' },
  ];

  for (const { file, title, label } of files) {
    const filePath = path.join(specDir, file);
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;

    docs.push({
      title,
      label,
      text,
      metadata: {
        ts,
        category: 'spec' as const,
        file,
      },
      tags: ['spec', 'planning', label],
    });
  }

  return docs;
}

/**
 * Convert a finalized contract into a memory document.
 * Includes objective, scope, acceptance criteria, and implementation plan.
 */
export function contractToDocument(
  contract: PacketContract,
  packetId: string,
): MemvidDocument {
  const ts = new Date().toISOString();

  // Render contract as structured text for retrieval
  const lines: string[] = [
    `# Contract: ${contract.title} (${packetId})`,
    '',
    `**Objective**: ${contract.objective}`,
    '',
    '## In Scope',
    ...contract.inScope.map((s) => `- ${s}`),
    '',
    '## Out of Scope',
    ...contract.outOfScope.map((s) => `- ${s}`),
    '',
    '## Implementation Plan',
    ...contract.implementationPlan.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Acceptance Criteria',
    ...contract.acceptance.map(
      (ac) => `- [${ac.id}] (${ac.kind}) ${ac.description}${ac.blocking ? ' [BLOCKING]' : ''}`,
    ),
  ];

  if (contract.assumptions.length > 0) {
    lines.push('', '## Assumptions', ...contract.assumptions.map((a) => `- ${a}`));
  }

  return {
    title: `Contract: ${contract.title} — ${packetId}`,
    label: 'contract',
    text: lines.join('\n'),
    metadata: {
      ts,
      packetId,
      category: 'contract' as const,
      contractStatus: contract.status,
      packetType: contract.packetType,
      acceptanceCriteriaCount: contract.acceptance.length,
    },
    tags: ['contract', packetId, contract.packetType],
  };
}

/**
 * Convert a builder report into a memory document.
 * Includes changed files, self-check results, and remaining concerns.
 */
export function builderReportToDocument(
  report: BuilderReport,
  packetId: string,
): MemvidDocument {
  const ts = new Date().toISOString();

  const passCount = report.selfCheckResults.filter((r) => r.status === 'pass').length;
  const failCount = report.selfCheckResults.filter((r) => r.status === 'fail').length;

  const lines: string[] = [
    `# Builder Report — ${packetId}`,
    '',
    `**Claims done**: ${report.claimsDone ? 'Yes' : 'No'}`,
    `**Self-check**: ${passCount} pass, ${failCount} fail (of ${report.selfCheckResults.length})`,
    '',
    '## Changed Files',
    ...report.changedFiles.map((f) => `- ${f}`),
  ];

  if (report.selfCheckResults.length > 0) {
    lines.push('', '## Self-Check Results');
    for (const r of report.selfCheckResults) {
      lines.push(`- [${r.criterionId}] ${r.status}: ${r.evidence}`);
    }
  }

  if (report.remainingConcerns.length > 0) {
    lines.push('', '## Remaining Concerns', ...report.remainingConcerns.map((c) => `- ${c}`));
  }

  return {
    title: `Builder report — ${packetId}`,
    label: 'builder-report',
    text: lines.join('\n'),
    metadata: {
      ts,
      packetId,
      category: 'builder-report' as const,
      claimsDone: report.claimsDone,
      changedFileCount: report.changedFiles.length,
      selfCheckPass: passCount,
      selfCheckFail: failCount,
    },
    tags: ['report', 'builder', packetId],
  };
}

/**
 * Convert an evaluator report into a memory document.
 * Includes overall verdict, hard failures with diagnostic hypotheses, and criterion verdicts.
 */
export function evalReportToDocument(
  report: EvaluatorReport,
  packetId: string,
): MemvidDocument {
  const ts = new Date().toISOString();

  const lines: string[] = [
    `# Evaluator Report — ${packetId}`,
    '',
    `**Overall verdict**: ${report.overall.toUpperCase()}`,
    `**Hard failures**: ${report.hardFailures.length}`,
    `**Contract gap detected**: ${report.contractGapDetected ? 'Yes' : 'No'}`,
  ];

  if (report.hardFailures.length > 0) {
    lines.push('', '## Hard Failures');
    for (const f of report.hardFailures) {
      lines.push(
        `### ${f.criterionId}: ${f.description}`,
        `**Evidence**: ${f.evidence}`,
        `**Diagnostic hypothesis**: ${f.diagnosticHypothesis}`,
        f.filesInvolved.length > 0
          ? `**Files involved**: ${f.filesInvolved.join(', ')}`
          : '',
        '',
      );
    }
  }

  const passCount = report.criterionVerdicts.filter((v) => v.verdict === 'pass').length;
  const failCount = report.criterionVerdicts.filter((v) => v.verdict === 'fail').length;

  if (report.criterionVerdicts.length > 0) {
    lines.push('', '## Criterion Verdicts');
    for (const v of report.criterionVerdicts) {
      lines.push(`- [${v.criterionId}] ${v.verdict}: ${v.evidence}`);
    }
  }

  if (report.nextActions.length > 0) {
    lines.push('', '## Next Actions', ...report.nextActions.map((a) => `- ${a}`));
  }

  return {
    title: `Evaluator report (${report.overall}) — ${packetId}`,
    label: 'eval-report',
    text: lines.join('\n'),
    metadata: {
      ts,
      packetId,
      category: 'eval-report' as const,
      verdict: report.overall,
      hardFailureCount: report.hardFailures.length,
      contractGapDetected: report.contractGapDetected,
      criterionPass: passCount,
      criterionFail: failCount,
    },
    tags: ['report', 'evaluator', packetId, report.overall],
  };
}

/**
 * Convert a QA report into a memory document.
 * Includes overall verdict, issues with diagnostic hypotheses.
 */
export function qaReportToDocument(report: QAReport, round: number): MemvidDocument {
  const ts = new Date().toISOString();

  const lines: string[] = [
    `# QA Report — Round ${round}`,
    '',
    `**Overall verdict**: ${report.overallVerdict?.toUpperCase() ?? 'UNKNOWN'}`,
    `**Scenarios checked**: ${report.scenariosChecked ?? 0}`,
    `**Issues found**: ${report.issues?.length ?? 0}`,
  ];

  if (report.summary) {
    lines.push('', '## Summary', report.summary);
  }

  if (report.issues && report.issues.length > 0) {
    lines.push('', '## Issues');
    for (const issue of report.issues) {
      lines.push(
        `### [${issue.severity?.toUpperCase()}] ${issue.title}`,
        issue.description ?? '',
        issue.diagnosticHypothesis ? `**Diagnostic hypothesis**: ${issue.diagnosticHypothesis}` : '',
        issue.filesInvolved?.length > 0
          ? `**Files involved**: ${issue.filesInvolved.join(', ')}`
          : '',
        '',
      );
    }
  }

  if (report.consoleErrors && report.consoleErrors.length > 0) {
    lines.push('', '## Console Errors', ...report.consoleErrors.map((e) => `- ${e}`));
  }

  return {
    title: `QA report (${report.overallVerdict ?? 'unknown'}) — Round ${round}`,
    label: 'qa-report',
    text: lines.join('\n'),
    metadata: {
      ts,
      category: 'qa-report' as const,
      round,
      verdict: report.overallVerdict,
      issueCount: report.issues?.length ?? 0,
      scenariosChecked: report.scenariosChecked ?? 0,
    },
    tags: ['report', 'qa', `round-${round}`, report.overallVerdict ?? 'unknown'],
  };
}

/**
 * Query memvid for semantically relevant context for a builder or evaluator.
 * Returns a formatted markdown string suitable for prompt injection,
 * or undefined if memvid is not available or the query fails.
 *
 * This augments (does not replace) readCompletionContexts().
 */
export async function queryMemoryContext(
  memory: RunMemory | null,
  contract: PacketContract,
  role: 'builder' | 'evaluator',
  opts?: { maxResults?: number; timeoutMs?: number },
): Promise<string | undefined> {
  if (!memory) return undefined;

  const maxResults = opts?.maxResults ?? 10;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  try {
    // Race against timeout
    return await Promise.race([
      queryMemoryContextImpl(memory, contract, role, maxResults),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  } catch (err) {
    console.log(`[memvid] Warning: memory context query failed: ${(err as Error).message}`);
    return undefined;
  }
}

async function queryMemoryContextImpl(
  memory: RunMemory,
  contract: PacketContract,
  role: 'builder' | 'evaluator',
  maxResults: number,
): Promise<string | undefined> {
  // Construct multiple targeted queries from the contract
  const queries: { label: string; query: string }[] = [];

  // 1. Objective query — finds prior work related to this packet's goal
  if (contract.objective) {
    queries.push({ label: contract.objective, query: contract.objective });
  }

  // 2. File queries — finds prior decisions about the same files
  if (contract.likelyFiles && contract.likelyFiles.length > 0) {
    // Group files into a single query to avoid too many searches
    const fileList = contract.likelyFiles.slice(0, 5).join(', ');
    queries.push({ label: `files: ${fileList}`, query: `changes to ${fileList}` });
  }

  // 3. Role-specific query
  if (role === 'evaluator') {
    queries.push({ label: 'prior evaluator findings', query: 'evaluator failure diagnostic hypothesis' });
  } else {
    queries.push({ label: 'established patterns', query: 'pattern convention decision established' });
  }

  // Execute queries in parallel and collect results
  const allHits: Array<{ label: string; hit: SearchHit }> = [];
  const seenSnippets = new Set<string>();
  const hitsPerQuery = Math.max(2, Math.ceil(maxResults / queries.length));

  const queryResults = await Promise.all(
    queries.map(async (q) => {
      const hits = await memory.search(q.query, { k: hitsPerQuery, mode: 'auto', snippetChars: 300 });
      return { label: q.label, hits };
    }),
  );

  for (const { label, hits } of queryResults) {
    for (const hit of hits) {
      // Deduplicate by snippet content
      const key = hit.snippet.slice(0, 100);
      if (!seenSnippets.has(key)) {
        seenSnippets.add(key);
        allHits.push({ label, hit });
      }
    }
  }

  if (allHits.length === 0) return undefined;

  // Sort by score descending, take top maxResults
  allHits.sort((a, b) => b.hit.score - a.hit.score);
  const topHits = allHits.slice(0, maxResults);

  // Format as markdown
  const lines: string[] = ['## Relevant Prior Context (from run memory)', ''];
  for (const { label, hit } of topHits) {
    lines.push(`### Related to: "${label}" (score: ${hit.score.toFixed(2)})`);
    lines.push(`[${hit.title}] ${hit.snippet}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Convert a completion summary into a memory document.
 * These are the key decision/context narratives passed between packets.
 */
export function completionSummaryToDocument(
  summary: string,
  packetId: string,
): MemvidDocument {
  const ts = new Date().toISOString();

  return {
    title: `Completion summary — ${packetId}`,
    label: 'summary',
    text: summary,
    metadata: {
      ts,
      packetId,
      category: 'summary' as const,
    },
    tags: ['summary', packetId],
  };
}

// ============================================================
// 8. Real-time encoding helpers
//    Convert live agent messages and operator inputs into
//    MemvidDocuments for per-turn exhaustive encoding.
// ============================================================

/**
 * Context about an agent session — used to tag per-turn documents.
 */
export interface AgentMessageContext {
  /** Role of the agent (builder, evaluator, planner, qa_agent, etc.) */
  role: string;
  /** Packet this session belongs to (if any). */
  packetId?: string;
  /** Index of the current turn within the session (increments on assistant text turns). */
  turnIndex: number;
}

/**
 * Convert any AgentMessage into one or more MemvidDocuments.
 *
 * No filtering — every message type is encoded.
 * No truncation — full text for all messages; long texts chunked via chunkText().
 *
 * Per message type:
 *   system   → 1 session-start doc
 *   assistant (text only)  → 1+ reasoning docs (chunked if long)
 *   assistant (tool calls) → 1 tool-call doc per call + optional reasoning doc
 *   tool_result → 1 doc per result in msg.toolResults
 *   event    → 1 agent-event doc
 *   result   → 1 session-end doc
 */
export function agentMessageToDocuments(
  msg: AgentMessage,
  ctx: AgentMessageContext,
): MemvidDocument[] {
  const ts = new Date().toISOString();
  const { role, packetId, turnIndex } = ctx;
  const docs: MemvidDocument[] = [];

  const baseMetadata = {
    ts,
    role,
    packetId,
    turnIndex,
    messageType: msg.type,
  };

  switch (msg.type) {
    case 'system': {
      docs.push({
        title: `Session start — ${role}${packetId ? ` — ${packetId}` : ''}`,
        label: 'session',
        text: [
          `Session started: ${msg.subtype ?? 'init'}`,
          msg.sessionId ? `sessionId: ${msg.sessionId}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        metadata: {
          ...baseMetadata,
          category: 'session' as const,
          sessionId: msg.sessionId,
        },
        tags: ['session', role, ...(packetId ? [packetId] : []), 'start'].filter(Boolean),
      });
      break;
    }

    case 'assistant': {
      const hasText = Boolean(msg.text?.trim());
      const hasTools = Boolean(msg.toolUses && msg.toolUses.length > 0);

      // Reasoning doc — emit even when tool calls are also present
      if (hasText) {
        const chunks = chunkText(msg.text!);
        chunks.forEach((chunk, ci) => {
          const chunkSuffix = chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : '';
          docs.push({
            title: `${role} reasoning — ${packetId ?? 'no-packet'} — turn ${turnIndex}${chunkSuffix}`,
            label: 'reasoning',
            text: chunk,
            metadata: {
              ...baseMetadata,
              category: 'reasoning' as const,
              chunkIndex: ci,
              chunkTotal: chunks.length,
            },
            tags: ['reasoning', role, ...(packetId ? [packetId] : [])].filter(Boolean),
          });
        });
      }

      // Tool-call docs — one per tool use
      if (hasTools) {
        for (const toolUse of msg.toolUses!) {
          docs.push({
            title: `Tool call: ${toolUse.name}${packetId ? ` — ${packetId}` : ''}`,
            label: 'tool-call',
            text: JSON.stringify(toolUse.input),
            metadata: {
              ...baseMetadata,
              category: 'tool-call' as const,
              toolName: toolUse.name,
            },
            tags: ['tool-call', toolUse.name, role, ...(packetId ? [packetId] : [])].filter(Boolean),
          });
        }
      }
      break;
    }

    case 'tool_result': {
      const results = msg.toolResults ?? [];
      for (const result of results) {
        docs.push({
          title: `Tool result${packetId ? ` — ${packetId}` : ''}`,
          label: 'tool-result',
          text: result.output,
          metadata: {
            ...baseMetadata,
            category: 'tool-result' as const,
            toolUseId: result.toolUseId,
            isError: result.isError ?? false,
          },
          tags: [
            'tool-result',
            role,
            ...(packetId ? [packetId] : []),
            result.isError ? 'error' : 'ok',
          ].filter(Boolean),
        });
      }
      break;
    }

    case 'event': {
      docs.push({
        title: `Agent event: ${msg.subtype ?? 'unknown'}${packetId ? ` — ${packetId}` : ''}`,
        label: 'agent-event',
        text: [
          `Event: ${msg.subtype ?? 'unknown'}`,
          msg.text ? `\n${msg.text}` : null,
        ]
          .filter(Boolean)
          .join(''),
        metadata: {
          ...baseMetadata,
          category: 'agent-event' as const,
          subtype: msg.subtype,
        },
        tags: [
          'agent-event',
          msg.subtype ?? 'unknown',
          role,
          ...(packetId ? [packetId] : []),
        ].filter(Boolean),
      });
      break;
    }

    case 'result': {
      const status = msg.isError ? 'error' : 'success';
      docs.push({
        title: `Session end — ${role}${packetId ? ` — ${packetId}` : ''}`,
        label: 'session',
        text: [
          `Session ended: ${msg.subtype ?? status}`,
          msg.numTurns != null ? `numTurns: ${msg.numTurns}` : null,
          msg.costUsd != null ? `costUsd: ${msg.costUsd}` : null,
          `isError: ${msg.isError ?? false}`,
        ]
          .filter(Boolean)
          .join('\n'),
        metadata: {
          ...baseMetadata,
          category: 'session' as const,
          numTurns: msg.numTurns,
          costUsd: msg.costUsd,
          isError: msg.isError ?? false,
          sessionId: msg.sessionId,
        },
        tags: [
          'session',
          role,
          ...(packetId ? [packetId] : []),
          'end',
          status,
        ].filter(Boolean),
      });
      break;
    }
  }

  return docs;
}

/**
 * Convert the initial prompt for an agent session into MemvidDocuments.
 * Long prompts are chunked into overlapping pieces via chunkText().
 * Returns one or more documents.
 */
export function promptToDocuments(
  prompt: string,
  role: string,
  packetId?: string,
): MemvidDocument[] {
  const ts = new Date().toISOString();
  const chunks = chunkText(prompt);

  return chunks.map((chunk, ci) => {
    const chunkSuffix = chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : '';
    return {
      title: `${role} prompt${packetId ? ` — ${packetId}` : ''}${chunkSuffix}`,
      label: 'prompt',
      text: chunk,
      metadata: {
        ts,
        role,
        packetId,
        category: 'prompt' as const,
        chunkIndex: ci,
        chunkTotal: chunks.length,
      },
      tags: ['prompt', role, ...(packetId ? [packetId] : [])].filter(Boolean),
    };
  });
}

/**
 * Convert an operator inbox message into a MemvidDocument.
 * Full JSON serialization — no truncation.
 */
export function inboxMessageToDocument(
  msg: { type: string; message?: string; [key: string]: unknown },
  packetId?: string,
): MemvidDocument {
  const ts = new Date().toISOString();

  return {
    title: `Operator message: ${msg.type}${packetId ? ` — ${packetId}` : ''}`,
    label: 'operator',
    text: JSON.stringify(msg),
    metadata: {
      ts,
      packetId,
      category: 'operator' as const,
      msgType: msg.type,
    },
    tags: ['operator', msg.type, ...(packetId ? [packetId] : [])].filter(Boolean),
  };
}

/**
 * Convert a contract negotiation round (proposal or review) into a MemvidDocument.
 * Full JSON serialization — no truncation.
 */
export function contractRoundToDocument(
  kind: 'proposal' | 'review',
  round: number,
  packetId: string,
  content: unknown,
): MemvidDocument {
  const ts = new Date().toISOString();

  return {
    title: `Contract ${kind} round ${round} — ${packetId}`,
    label: 'contract-round',
    text: JSON.stringify(content, null, 2),
    metadata: {
      ts,
      packetId,
      category: 'contract-round' as const,
      kind,
      round,
    },
    tags: ['contract-round', packetId, `round-${round}`, kind],
  };
}

/**
 * Convert a plan review round result into a MemvidDocument.
 * Full JSON serialization — no truncation.
 */
export function planReviewToDocument(review: unknown, round: number): MemvidDocument {
  const ts = new Date().toISOString();

  return {
    title: `Plan review — round ${round}`,
    label: 'plan-review',
    text: JSON.stringify(review, null, 2),
    metadata: {
      ts,
      category: 'plan-review' as const,
      round,
    },
    tags: ['plan-review', `round-${round}`],
  };
}
