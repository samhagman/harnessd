/**
 * Zod schemas and TypeScript types for all harnessd data structures.
 *
 * These schemas are used at boundaries: file read/write and agent output parsing.
 * Internally, code passes plain TypeScript types (inferred from schemas).
 *
 * Reference: TAD sections 8, 19, 23
 */

import { z } from "zod";

// ------------------------------------
// Enums and constants
// ------------------------------------

export const RunPhaseSchema = z.enum([
  "planning",
  "plan_review",
  "awaiting_plan_approval",
  "selecting_packet",
  "negotiating_contract",
  "building_packet",
  "evaluating_packet",
  "fixing_packet",
  "awaiting_human_review",
  "rate_limited",
  "paused",
  "needs_human",
  "completed",
  "failed",
  // QA and Round 2 phases
  "qa_review",
  "round2_planning",
  "awaiting_round2_approval",
]);

export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const PacketTypeSchema = z.enum([
  "bugfix",
  "ui_feature",
  "backend_feature",
  "migration",
  "refactor",
  "long_running_job",
  "integration",
  "tooling",
]);

export type PacketType = z.infer<typeof PacketTypeSchema>;

export const PacketStatusSchema = z.enum([
  "pending",
  "negotiating",
  "building",
  "evaluating",
  "fixing",
  "done",
  "blocked",
  "failed",
]);

export type PacketStatus = z.infer<typeof PacketStatusSchema>;

export const CriterionKindSchema = z.enum([
  "command",
  "scenario",
  "api",
  "artifact",
  "invariant",
  "negative",
  "observability",
  "performance",
  "rubric",
]);

export type CriterionKind = z.infer<typeof CriterionKindSchema>;

export const CriterionSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export type CriterionSeverity = z.infer<typeof CriterionSeveritySchema>;

export const WorkerRoleSchema = z.enum([
  "planner",
  "plan_reviewer",
  "contract_builder",
  "contract_evaluator",
  "builder",
  "evaluator",
  "qa_agent",
  "round2_planner",
]);

export type WorkerRole = z.infer<typeof WorkerRoleSchema>;

export const ContractDecisionSchema = z.enum([
  "accept",
  "revise",
  "split",
  "escalate",
]);

export type ContractDecision = z.infer<typeof ContractDecisionSchema>;

export const ContractStatusSchema = z.enum([
  "proposed",
  "accepted",
  "revise",
  "split",
  "escalate",
]);

export type ContractStatus = z.infer<typeof ContractStatusSchema>;

// ------------------------------------
// Core data models
// ------------------------------------

export const RateLimitStateSchema = z.object({
  status: z.enum(["ok", "suspected", "confirmed"]),
  retryCount: z.number().int().min(0),
  nextRetryAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

export type RateLimitState = z.infer<typeof RateLimitStateSchema>;

export const OperatorFlagsSchema = z.object({
  pauseAfterCurrentPacket: z.boolean(),
  stopRequested: z.boolean(),
});

export type OperatorFlags = z.infer<typeof OperatorFlagsSchema>;

export const RunStateSchema = z.object({
  runId: z.string(),
  objective: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  phase: RunPhaseSchema,
  currentPacketId: z.string().nullable(),
  packetOrder: z.array(z.string()),
  completedPacketIds: z.array(z.string()),
  failedPacketIds: z.array(z.string()),
  blockedPacketIds: z.array(z.string()),
  currentWorkerRole: WorkerRoleSchema.nullable(),
  currentWorkerSessionId: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  rateLimitState: RateLimitStateSchema,
  operatorFlags: OperatorFlagsSchema,
  // QA and Round 2 tracking
  round: z.number().int().default(1),
  qaReportPath: z.string().nullable().default(null),
  round2PacketOrder: z.array(z.string()).default([]),
  round2CompletedPacketIds: z.array(z.string()).default([]),
  maxRounds: z.number().int().default(10),
  // Workspace directory (persisted so resume can restore it)
  workspaceDir: z.string().nullable().default(null),
});

export type RunState = z.infer<typeof RunStateSchema>;

export const PacketSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: PacketTypeSchema,
  objective: z.string(),
  whyNow: z.string(),
  dependencies: z.array(z.string()),
  status: PacketStatusSchema,
  priority: z.number().int(),
  estimatedSize: z.enum(["S", "M", "L", "XL"]),
  risks: z.array(z.string()),
  notes: z.array(z.string()).default([]),
  expectedFiles: z.array(z.string()).default([]),
  criticalConstraints: z.array(z.string()).default([]),
  integrationInputs: z.array(z.object({
    fromPacket: z.string(),
    provides: z.array(z.string()),
  })).default([]),
  requiresHumanReview: z.boolean().default(false),
});

export type Packet = z.infer<typeof PacketSchema>;

/**
 * Compact packet summary passed to builder and evaluator prompts.
 * Contains only the fields needed for plan context — avoids injecting
 * full Packet objects (which include status metadata, dates, etc.).
 */
export interface PacketSummary {
  id: string;
  title: string;
  objective: string;
  status: string;
  expectedFiles?: string[];
  criticalConstraints?: string[];
  notes?: string[];
}

// ------------------------------------
// Acceptance criteria
// ------------------------------------

export const ScenarioSchema = z.object({
  tool: z.enum(["playwright", "bash", "manual-script", "chrome-devtools"]),
  steps: z.array(z.string()),
  expects: z.array(z.string()),
});

export const RubricSchema = z.object({
  scale: z.literal("1-5"),
  threshold: z.number(),
  dimensions: z.array(z.string()),
});

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  kind: CriterionKindSchema,
  description: z.string(),
  blocking: z.boolean(),
  threshold: z.number().optional(),
  command: z.string().optional(),
  expected: z.string().optional(),
  scenario: ScenarioSchema.optional(),
  rubric: RubricSchema.optional(),
  evidenceRequired: z.array(z.string()),
  // Evaluator-added criterion metadata (absent on negotiated criteria)
  source: z.enum(["contract", "evaluator"]).optional(),
  severity: CriterionSeveritySchema.optional(),
  rationale: z.string().optional(),
  addedInEvalRound: z.number().int().optional(),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * Evaluator-proposed criterion — what the evaluator outputs in its report.
 * Does NOT include an id; the orchestrator assigns canonical IDs.
 */
export const ProposedCriterionSchema = z.object({
  kind: CriterionKindSchema,
  description: z.string(),
  blocking: z.boolean(),
  evidenceRequired: z.array(z.string()),
  severity: CriterionSeveritySchema,
  rationale: z.string(),
  evidence: z.string(),
  command: z.string().optional(),
  expected: z.string().optional(),
  scenario: ScenarioSchema.optional(),
});

export type ProposedCriterion = z.infer<typeof ProposedCriterionSchema>;

// ------------------------------------
// Contract
// ------------------------------------

export const ContractRiskSchema = z.object({
  id: z.string(),
  description: z.string(),
  mitigation: z.string(),
});

export const BackgroundJobPlanSchema = z.object({
  id: z.string(),
  description: z.string(),
  command: z.string(),
  heartbeatExpected: z.boolean(),
  completionSignal: z.string(),
});

export const MicroFanoutPlanSchema = z.object({
  id: z.string(),
  kind: z.enum(["research", "draft", "validate"]),
  brief: z.string(),
  maxAgents: z.number().int(),
  directRepoEditsAllowed: z.boolean(),
});

export const PacketContractSchema = z.object({
  packetId: z.string(),
  round: z.number().int(),
  status: ContractStatusSchema,
  title: z.string(),
  packetType: PacketTypeSchema,
  objective: z.string(),
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(ContractRiskSchema),
  likelyFiles: z.array(z.string()),
  implementationPlan: z.array(z.string()),
  backgroundJobs: z.array(BackgroundJobPlanSchema),
  microFanoutPlan: z.array(MicroFanoutPlanSchema),
  acceptance: z.array(AcceptanceCriterionSchema),
  reviewChecklist: z.array(z.string()),
  proposedCommitMessage: z.string(),
});

export type PacketContract = z.infer<typeof PacketContractSchema>;

// ------------------------------------
// Contract review
// ------------------------------------

export const ContractReviewScoresSchema = z.object({
  scopeFit: z.number(),
  testability: z.number(),
  riskCoverage: z.number(),
  clarity: z.number(),
  specAlignment: z.number(),
});

export const ContractReviewSchema = z.object({
  packetId: z.string(),
  round: z.number().int(),
  decision: ContractDecisionSchema,
  scores: ContractReviewScoresSchema,
  requiredChanges: z.array(z.string()),
  suggestedCriteriaAdditions: z.array(AcceptanceCriterionSchema),
  missingRisks: z.array(z.string()),
  rationale: z.string(),
});

export type ContractReview = z.infer<typeof ContractReviewSchema>;

// ------------------------------------
// Builder report
// ------------------------------------

export const CommandRunSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  summary: z.string(),
});

export const BackgroundJobStatusSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  note: z.string(),
});

export const MicroFanoutUsedSchema = z.object({
  id: z.string(),
  kind: z.string(),
  summary: z.string(),
});

export const SelfCheckResultSchema = z.object({
  criterionId: z.string(),
  status: z.enum(["pass", "fail", "unknown", "untested"]),
  evidence: z.string(),
});

export const BuilderReportSchema = z.object({
  packetId: z.string(),
  sessionId: z.string(),
  changedFiles: z.array(z.string()),
  commandsRun: z.array(CommandRunSchema),
  backgroundJobs: z.array(BackgroundJobStatusSchema),
  microFanoutUsed: z.array(MicroFanoutUsedSchema),
  selfCheckResults: z.array(SelfCheckResultSchema),
  remainingConcerns: z.array(z.string()),
  claimsDone: z.boolean(),
  commitShas: z.array(z.string()).nullable().default(null),
});

export type BuilderReport = z.infer<typeof BuilderReportSchema>;

// ------------------------------------
// Evaluator report
// ------------------------------------

export const HardFailureSchema = z.object({
  criterionId: z.string(),
  description: z.string(),
  evidence: z.string(),
  reproduction: z.array(z.string()),
  // Root-cause diagnosis (evaluator's best theory about WHY it fails)
  diagnosticHypothesis: z.string(),
  // Files the builder should investigate (not just the file that errored)
  filesInvolved: z.array(z.string()).default([]),
});

export const RubricScoreSchema = z.object({
  criterionId: z.string(),
  score: z.number(),
  threshold: z.number(),
  rationale: z.string(),
});

export const CriterionVerdictSchema = z.object({
  criterionId: z.string(), // matches the AC id from the contract
  verdict: z.enum(["pass", "fail", "skip"]),
  evidence: z.string(), // what the evaluator observed (required)
  skipReason: z.string().optional(), // required if verdict is "skip"
});

export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

export const EvaluatorReportSchema = z.object({
  packetId: z.string(),
  sessionId: z.string(),
  overall: z.enum(["pass", "fail"]),
  hardFailures: z.array(HardFailureSchema),
  rubricScores: z.array(RubricScoreSchema),
  criterionVerdicts: z.array(CriterionVerdictSchema).default([]),
  missingEvidence: z.array(z.string()),
  nextActions: z.array(z.string()),
  contractGapDetected: z.boolean(),
  // Criterion expansion: evaluator-proposed criteria for medium-severity findings
  addedCriteria: z.array(ProposedCriterionSchema).default([]),
  additionalIssuesOmitted: z.boolean().default(false),
  // Advisory escalation: evaluator can explicitly promote advisory criteria to blocking
  advisoryEscalations: z.array(z.object({
    criterionId: z.string(),
    reason: z.string(),
  })).default([]),
});

export type EvaluatorReport = z.infer<typeof EvaluatorReportSchema>;

// ------------------------------------
// QA report
// ------------------------------------

export const QAIssueSeveritySchema = z.enum(["critical", "major", "minor"]);

export type QAIssueSeverity = z.infer<typeof QAIssueSeveritySchema>;

export const QAIssueSchema = z.object({
  id: z.string(),
  severity: QAIssueSeveritySchema,
  title: z.string(),
  description: z.string(),
  stepsToReproduce: z.array(z.string()),
  screenshotPath: z.string().optional(),
  relatedPackets: z.array(z.string()),
  diagnosticHypothesis: z.string()
    .describe("Code-level root cause hypothesis: which file, function, and logic error causes this issue"),
  filesInvolved: z.array(z.string()).default([])
    .describe("File paths the agent believes contain the bug"),
  rootCauseLayer: z.enum(["ui", "state", "api", "data", "infra", "unknown"]).default("unknown")
    .describe("Which architectural layer the root cause lives in"),
});

export type QAIssue = z.infer<typeof QAIssueSchema>;

export const QAScenarioResultSchema = z.object({
  scenarioId: z.string(),
  name: z.string(),
  status: z.enum(["pass", "fail", "blocked"]),
  notes: z.string(),
});

export type QAScenarioResult = z.infer<typeof QAScenarioResultSchema>;

export const QAReportSchema = z.object({
  overallVerdict: z.enum(["pass", "fail"]),
  scenariosChecked: z.number().int(),
  issues: z.array(QAIssueSchema),
  scenarioResults: z.array(QAScenarioResultSchema).default([]),
  consoleErrors: z.array(z.string()),
  summary: z.string(),
});

export type QAReport = z.infer<typeof QAReportSchema>;

// ------------------------------------
// Worker result envelope
// ------------------------------------

export const RESULT_START_SENTINEL = "===HARNESSD_RESULT_START===";
export const RESULT_END_SENTINEL = "===HARNESSD_RESULT_END===";

export const WorkerResultEnvelopeSchema = z.object({
  role: WorkerRoleSchema,
  packetId: z.string().optional(),
  payload: z.unknown(),
});

export type WorkerResultEnvelope = z.infer<typeof WorkerResultEnvelopeSchema>;

// ------------------------------------
// Event log
// ------------------------------------

export const EventTypeSchema = z.enum([
  "run.started",
  "run.paused",
  "run.resumed",
  "run.needs_human",
  "run.completed",
  "run.failed",
  "planning.started",
  "planning.completed",
  "planning.failed",
  "packet.selected",
  "packet.done",
  "packet.failed",
  "packet.blocked",
  "contract.round.started",
  "contract.round.reviewed",
  "contract.accepted",
  "contract.escalated",
  "contract.split",
  "builder.started",
  "builder.heartbeat",
  "builder.background_job.started",
  "builder.background_job.completed",
  "builder.completed",
  "builder.failed",
  "builder.warning",
  "evaluator.started",
  "evaluator.passed",
  "evaluator.failed",
  "worker.rate_limited",
  "worker.resumed",
  "poke.received",
  "poke.responded",
  "plan.awaiting_approval",
  "plan.approved",
  "packet.awaiting_review",
  "packet.approved",
  "packet.rejected",
  "packet.reset",
  "nudge.sent",
  "context.injected",
  // Plan review events
  "plan_review.started",
  "plan_review.completed",
  "plan_review.revision_requested",
  // QA and Round 2 events
  "qa.started",
  "qa.passed",
  "qa.failed",
  "round2.planning.started",
  "round2.planning.completed",
  "round2.plan.awaiting_approval",
  "round2.plan.approved",
  // Tool gate events
  "gate.started",
  "gate.passed",
  "gate.failed",
  "gate.skipped",
  "gate.blocked",
  "gate.baseline_failed",
  "gate.baseline_passed",
  // Criterion expansion events
  "evaluator.criteria_expanded",
  // Operator control events
  "packet.fix_counter_reset",
  // Memory events
  "memory.encoded",
  "memory.error",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEntrySchema = z.object({
  ts: z.string(),
  event: EventTypeSchema,
  phase: RunPhaseSchema.optional(),
  packetId: z.string().optional(),
  detail: z.string().optional(),
});

export type EventEntry = z.infer<typeof EventEntrySchema>;

// ------------------------------------
// Status snapshot
// ------------------------------------

export const StatusSnapshotSchema = z.object({
  runId: z.string(),
  phase: RunPhaseSchema,
  objective: z.string(),
  elapsed: z.string(),
  currentPacket: z
    .object({
      id: z.string(),
      title: z.string(),
      status: PacketStatusSchema,
    })
    .nullable(),
  contractRound: z.number().int().nullable(),
  currentWorker: z
    .object({
      role: WorkerRoleSchema,
      sessionId: z.string().nullable(),
      heartbeatAge: z.string().nullable(),
    })
    .nullable(),
  packetsComplete: z.number().int(),
  packetsTotal: z.number().int(),
  lastEvent: z.string().nullable(),
  alerts: z.array(z.string()),
  nextAction: z.string(),
  criteriaBreakdown: z
    .object({
      negotiatedPass: z.number().int(),
      negotiatedTotal: z.number().int(),
      evaluatorPass: z.number().int(),
      evaluatorTotal: z.number().int(),
      effectivePass: z.number().int(),
      effectiveTotal: z.number().int(),
    })
    .nullable()
    .optional(),
  updatedAt: z.string(),
});

export type StatusSnapshot = z.infer<typeof StatusSnapshotSchema>;

// ------------------------------------
// Risk register
// ------------------------------------

export const RiskEntrySchema = z.object({
  id: z.string(),
  description: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  mitigation: z.string(),
  watchpoints: z.array(z.string()),
});

export type RiskEntry = z.infer<typeof RiskEntrySchema>;

export const RiskRegisterSchema = z.object({
  risks: z.array(RiskEntrySchema),
});

export type RiskRegister = z.infer<typeof RiskRegisterSchema>;

// ------------------------------------
// Project config
// ------------------------------------

export const QAPassThresholdSchema = z.object({
  maxCritical: z.number().int().default(0),
  maxMajor: z.number().int().default(0),
  maxMinor: z.number().int().default(5),
});

export type QAPassThreshold = z.infer<typeof QAPassThresholdSchema>;

export const DevServerConfigSchema = z.object({
  command: z.string(),
  readyPattern: z.string().default("Local:"),
  port: z.number().int().default(5173),
  backendPort: z.number().int().optional(),
});

export type DevServerConfig = z.infer<typeof DevServerConfigSchema>;

export const ToolGateConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  blocking: z.boolean().default(true),
  packetTypes: z.array(PacketTypeSchema).optional(),
});

export type ToolGateConfig = z.infer<typeof ToolGateConfigSchema>;

// ------------------------------------
// Backend selection per role
// ------------------------------------

export const BackendTypeSchema = z.enum(["claude", "codex"]);

export type BackendType = z.infer<typeof BackendTypeSchema>;

export const RoleBackendMapSchema = z.object({
  planner: BackendTypeSchema.optional(),
  plan_reviewer: BackendTypeSchema.optional(),
  contract_builder: BackendTypeSchema.optional(),
  contract_evaluator: BackendTypeSchema.optional(),
  builder: BackendTypeSchema.optional(),
  evaluator: BackendTypeSchema.optional(),
  qa_agent: BackendTypeSchema.optional(),
  round2_planner: BackendTypeSchema.optional(),
}).default({});

export type RoleBackendMap = z.infer<typeof RoleBackendMapSchema>;

// ------------------------------------
// Project config
// ------------------------------------

export const ProjectConfigSchema = z.object({
  maxNegotiationRounds: z.number().int().default(10),
  maxNegotiationRoundsRisky: z.number().int().default(10),
  maxFixLoopsPerPacket: z.number().int().default(10),
  staleWorkerMinutes: z.number().default(15),
  heartbeatWriteSeconds: z.number().default(20),
  resumeBackoffMinutes: z.array(z.number()).default([5, 15, 30, 60]),
  allowBuilderMicroFanout: z.boolean().default(true),
  maxBuilderMicroFanoutAgents: z.number().int().default(3),
  allowDirectEditSubagents: z.boolean().default(false),
  renderStatusOnEveryEvent: z.boolean().default(true),
  maxConsecutiveResumeFailures: z.number().int().default(8),
  model: z.string().optional(),
  // QA and Round 2 settings
  maxRounds: z.number().int().default(10),
  qaPassThreshold: QAPassThresholdSchema.default({ maxCritical: 0, maxMajor: 0, maxMinor: 5 }),
  skipQA: z.boolean().default(false),
  devServer: DevServerConfigSchema.nullish(),
  /** Custom tool gates to run between builder and evaluator */
  toolGates: z.array(ToolGateConfigSchema).default([]),
  /** Enable default gates (typecheck + test). Defaults to true. */
  enableDefaultGates: z.boolean().default(true),
  /** Max rounds of plan review negotiation (planner ↔ reviewer). */
  maxPlanReviewRounds: z.number().int().default(10),
  /** Skip the plan review phase entirely. */
  skipPlanReview: z.boolean().default(false),
  /** Per-role backend selection. Defaults all roles to "claude". */
  roleBackends: RoleBackendMapSchema,
  /** Model for Codex CLI backend (e.g. "o3", "o4-mini"). Passed as --model flag. */
  codexModel: z.string().optional(),
  /** Research tool availability: Context7 (always-on) and Perplexity (opt-in). */
  researchTools: z.object({
    context7: z.boolean().default(true),
    perplexity: z.boolean().default(false),
  }).default({ context7: true, perplexity: false }),
  /** Enable run memory (memvid). When false, no .mv2 file is created, search_memory is not available, and memory sections are omitted from prompts. */
  enableMemory: z.boolean().default(true),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ------------------------------------
// Plan review
// ------------------------------------

export const PlanReviewIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  area: z.enum(["architecture", "scope", "risk", "acceptance_criteria", "integration", "ux"]),
  description: z.string(),
  suggestion: z.string(),
});

export type PlanReviewIssue = z.infer<typeof PlanReviewIssueSchema>;

export const PlanReviewSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  issues: z.array(PlanReviewIssueSchema),
  missingIntegrationScenarios: z.array(z.string()),
  summary: z.string(),
});

export type PlanReview = z.infer<typeof PlanReviewSchema>;

// ------------------------------------
// Acceptance template
// ------------------------------------

export const AcceptanceTemplateSchema = z.object({
  type: PacketTypeSchema,
  requiredCriterionKinds: z.array(CriterionKindSchema),
  defaultCriteria: z.array(AcceptanceCriterionSchema),
});

export type AcceptanceTemplate = z.infer<typeof AcceptanceTemplateSchema>;

// ------------------------------------
// Session info (persisted per worker)
// ------------------------------------

export const WorkerSessionSchema = z.object({
  sessionId: z.string().nullable(),
  role: WorkerRoleSchema,
  packetId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  resultPath: z.string().nullable(),
});

export type WorkerSession = z.infer<typeof WorkerSessionSchema>;

// ------------------------------------
// Heartbeat
// ------------------------------------

export const HeartbeatSchema = z.object({
  sessionId: z.string().nullable(),
  role: WorkerRoleSchema,
  packetId: z.string().optional(),
  ts: z.string(),
  turnCount: z.number().int(),
});

export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// ------------------------------------
// Inbox / Outbox
// ------------------------------------

export const InboxMessageSchema = z.object({
  type: z.enum([
    "poke",
    "pause",
    "resume",
    "summarize",
    "stop_after_current",
    "approve_plan",
    "approve_packet",
    "reject_packet",
    "send_to_agent",
    "inject_context",
    "reset_packet",
    "pivot_agent",
    "approve_round2",
    "skip_qa",
    "force_approve",
    "reset_fix_counter",
  ]),
  createdAt: z.string(),
  message: z.string().optional(),
  packetId: z.string().optional(),
  context: z.string().optional(),
  /** force_approve only: set to true to acknowledge any blocking skips being overridden */
  blockingSkipsAcknowledged: z.boolean().optional(),
});

export type InboxMessage = z.infer<typeof InboxMessageSchema>;

// ------------------------------------
// Evaluator guide (planner-generated)
// ------------------------------------

export const RubricDimensionSchema = z.object({
  name: z.string(),
  weight: z.number().min(1).max(5),
  description: z.string(),
  score5: z.string().optional(), // calibration: what a 5 looks like
  score3: z.string().optional(), // calibration: what a 3 looks like
  score1: z.string().optional(), // calibration: what a 1 looks like
});

export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const EvaluatorGuideSchema = z.object({
  domain: z.string(), // e.g. "frontend-ui", "backend-api", "data-pipeline"
  qualityCriteria: z.array(z.object({
    name: z.string(),
    weight: z.number().min(1).max(5),
    description: z.string(),
  })),
  antiPatterns: z.array(z.string()), // things to penalize
  referenceStandard: z.string(), // "the best designs are museum quality"
  edgeCases: z.array(z.string()), // domain-specific edge cases to check
  browserVerification: z.object({
    enabled: z.boolean(),
    viewports: z.array(z.object({ width: z.number(), height: z.number(), label: z.string() })),
    interactions: z.array(z.string()), // things to click/test
  }).optional(),
  calibrationExamples: z.array(z.object({
    dimension: z.string(),
    score: z.number(),
    description: z.string(),
  })),
  skepticismLevel: z.enum(["normal", "high", "adversarial"]).default("normal"),
});

export type EvaluatorGuide = z.infer<typeof EvaluatorGuideSchema>;

// ------------------------------------
// Planning context (operator interview)
// ------------------------------------

export const PlanningContextSchema = z.object({
  vision: z.string().optional(),
  techPreferences: z.array(z.string()).default([]),
  designReferences: z.array(z.string()).default([]),
  avoidList: z.array(z.string()).default([]),
  doneDefinition: z.string().optional(),
  customNotes: z.string().optional(),
});

export type PlanningContext = z.infer<typeof PlanningContextSchema>;

// ------------------------------------
// Helpers
// ------------------------------------

/** Default run state for a new run */
export function defaultRunState(runId: string, objective: string): RunState {
  const now = new Date().toISOString();
  return {
    runId,
    objective,
    createdAt: now,
    updatedAt: now,
    phase: "planning",
    currentPacketId: null,
    packetOrder: [],
    completedPacketIds: [],
    failedPacketIds: [],
    blockedPacketIds: [],
    currentWorkerRole: null,
    currentWorkerSessionId: null,
    lastHeartbeatAt: null,
    rateLimitState: {
      status: "ok",
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    },
    operatorFlags: {
      pauseAfterCurrentPacket: false,
      stopRequested: false,
    },
    // QA and Round 2 defaults
    round: 1,
    qaReportPath: null,
    round2PacketOrder: [],
    round2CompletedPacketIds: [],
    maxRounds: 10,
    workspaceDir: null,
  };
}

/** Default project config with TAD section 23 defaults */
export function defaultProjectConfig(): ProjectConfig {
  return ProjectConfigSchema.parse({});
}

// ------------------------------------
// Integration scenarios (planner-generated)
// ------------------------------------

export const IntegrationStepSchema = z.object({
  action: z.string(),
  expected: z.string(),
});

export type IntegrationStep = z.infer<typeof IntegrationStepSchema>;

export const IntegrationScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  packetDependencies: z.array(z.string()),
  steps: z.array(IntegrationStepSchema),
});

export type IntegrationScenario = z.infer<typeof IntegrationScenarioSchema>;

export const IntegrationScenarioListSchema = z.object({
  scenarios: z.array(IntegrationScenarioSchema),
});

export type IntegrationScenarioList = z.infer<typeof IntegrationScenarioListSchema>;

/** Check if a QA report meets the pass threshold */
export function qaPassesThreshold(
  report: QAReport,
  threshold: QAPassThreshold,
): boolean {
  const criticalCount = report.issues.filter((i) => i.severity === "critical").length;
  const majorCount = report.issues.filter((i) => i.severity === "major").length;
  const minorCount = report.issues.filter((i) => i.severity === "minor").length;

  if (criticalCount > threshold.maxCritical) return false;
  if (majorCount > threshold.maxMajor) return false;
  if (minorCount > threshold.maxMinor) return false;

  // Also fail if overall verdict says fail (even if counts look OK)
  if (report.overallVerdict === "fail") {
    // Only override if counts actually pass — trust the counts over the agent verdict
    if (criticalCount === 0 && majorCount === 0 && minorCount <= threshold.maxMinor) {
      return true;
    }
    return false;
  }

  return true;
}

/** Risky packet types that get extra negotiation rounds */
export const RISKY_PACKET_TYPES: readonly PacketType[] = [
  "migration",
  "integration",
  "long_running_job",
];
