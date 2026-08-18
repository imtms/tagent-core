import { Type, type Static } from "typebox";
import { JsonObjectSchema, TimestampMillisecondsSchema } from "../../shared/primitives.js";
import { GateProfileSchema } from "../../channel/v1/submission-schemas.js";

const ConsoleNullableTimestampSchema = Type.Union([TimestampMillisecondsSchema, Type.Null()]);
const ConsoleTaskExecutionPolicySchema = Type.Object({
  mode: Type.String(), sideEffectRisk: Type.String(), evidencePolicy: Type.String(), reviewPolicy: Type.String(),
  policyVersion: Type.String(), confidence: Type.Number(), reason: Type.String(), exactOutput: Type.Optional(Type.String()),
  gateProfile: Type.Optional(GateProfileSchema),
});
export const ConsoleReasoningEffortSchema = Type.Union([
  Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
  Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);

export const ConsoleSessionInputAnalysisSchema = Type.Object({
  summary: Type.String(),
  intent: Type.Union([
    Type.Literal("steer_active"), Type.Literal("follow_up_active"), Type.Literal("update_active_context"),
    Type.Literal("new_task"), Type.Literal("parallel_task"), Type.Literal("merge_candidate"),
    Type.Literal("discussion"), Type.Literal("clarification"), Type.Literal("defer"),
  ]),
  targetRunId: Type.Union([Type.String(), Type.Null()]),
  priority: Type.Number(),
  urgency: Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")]),
  relation: Type.Union([
    Type.Literal("same_goal"), Type.Literal("correction"), Type.Literal("constraint"),
    Type.Literal("follow_up"), Type.Literal("parallel"), Type.Literal("derived"),
    Type.Literal("depends_on"), Type.Literal("independent"),
  ]),
  acceptanceCriteria: Type.Array(Type.String()),
  scope: Type.String(),
  nonGoals: Type.Array(Type.String()),
  confidence: Type.Number(),
  reason: Type.String(),
  routerVersion: Type.String(),
  executionPolicy: Type.Optional(ConsoleTaskExecutionPolicySchema),
});
export type ConsoleSessionInputAnalysis = Static<typeof ConsoleSessionInputAnalysisSchema>;

export const ConsoleTaskRunWorkspaceGoalSchema = Type.Object({
  goalId: Type.String(),
  mode: Type.Union([Type.Literal("workspace"), Type.Literal("roadmap")]),
  definitionRevisionId: Type.String(), definitionRevision: Type.Number(), definitionHash: Type.String(),
  title: Type.String(), outcome: Type.String(), scope: Type.Array(Type.String()), nonGoals: Type.Array(Type.String()),
  criteria: Type.Array(Type.Object({ key: Type.String(), title: Type.String(), required: Type.Boolean() })),
  roadmapRevisionId: Type.Union([Type.String(), Type.Null()]), roadmapRevision: Type.Union([Type.Number(), Type.Null()]),
  roadmapHash: Type.Union([Type.String(), Type.Null()]), approvedRoadmapItemIds: Type.Array(Type.String()),
  targetRoadmapItemIds: Type.Array(Type.String()),
  roadmapItems: Type.Array(Type.Object({
    id: Type.String(), title: Type.String(), outcome: Type.String(), verification: Type.String(), criterionKeys: Type.Array(Type.String()),
  })),
  targetCriterionKeys: Type.Array(Type.String()),
  criterionPrompts: Type.Array(Type.Object({ key: Type.String(), prompt: Type.String() })),
  attachedAt: TimestampMillisecondsSchema,
});
export type ConsoleTaskRunWorkspaceGoal = Static<typeof ConsoleTaskRunWorkspaceGoalSchema>;

export const ConsoleTaskRunSkillSchema = Type.Object({
  skillId: Type.String(), revisionId: Type.String(), revision: Type.Number(), name: Type.String(),
  description: Type.String(), content: Type.String(), filePath: Type.String(), sha256: Type.String(),
  disableModelInvocation: Type.Boolean(),
});
export type ConsoleTaskRunSkill = Static<typeof ConsoleTaskRunSkillSchema>;

export const ConsoleTaskRunContractSchema = Type.Object({
  sourceInput: Type.String(),
  summary: Type.String(),
  acceptanceCriteria: Type.Array(Type.String()),
  scope: Type.String(),
  nonGoals: Type.Array(Type.String()),
  sourceInboxIds: Type.Array(Type.String()),
  parentRunId: Type.Union([Type.String(), Type.Null()]),
  relation: ConsoleSessionInputAnalysisSchema.properties.relation,
  intent: ConsoleSessionInputAnalysisSchema.properties.intent,
  decisionReason: Type.String(),
  routerVersion: Type.String(),
  executionPolicy: Type.Optional(Type.Union([ConsoleTaskExecutionPolicySchema, Type.Null()])),
  workspaceGoal: Type.Optional(Type.Union([ConsoleTaskRunWorkspaceGoalSchema, Type.Null()])),
  skills: Type.Optional(Type.Array(ConsoleTaskRunSkillSchema)),
});
export type ConsoleTaskRunContract = Static<typeof ConsoleTaskRunContractSchema>;

export const ConsoleSessionInboxItemSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  requestId: Type.String(),
  content: Type.String(),
  status: Type.Union([
    Type.Literal("queued"), Type.Literal("claimed"), Type.Literal("started"),
    Type.Literal("routed"), Type.Literal("deleted"), Type.Literal("failed"),
  ]),
  decision: Type.Union([
    Type.Literal("pending"), Type.Literal("start_taskrun"), Type.Literal("steer"),
    Type.Literal("follow_up"), Type.Literal("discussion"), Type.Literal("defer"),
    Type.Literal("merge"), Type.Literal("delete"),
  ]),
  runId: Type.Union([Type.String(), Type.Null()]),
  error: Type.String(),
  position: Type.Number(),
  createdAt: TimestampMillisecondsSchema,
  updatedAt: TimestampMillisecondsSchema,
  claimedAt: ConsoleNullableTimestampSchema,
  startedAt: ConsoleNullableTimestampSchema,
  analysis: ConsoleSessionInputAnalysisSchema,
  manualOrder: Type.Boolean(),
});
export type ConsoleSessionInboxItem = Static<typeof ConsoleSessionInboxItemSchema>;

export const ConsoleMessageSchema = Type.Object({
  id: Type.Number(),
  sessionId: Type.String(),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
  content: Type.String(),
  createdAt: TimestampMillisecondsSchema,
});
export type ConsoleMessage = Static<typeof ConsoleMessageSchema>;

export const ConsoleContextManifestItemSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("system_prompt"), Type.Literal("taskrun_contract"), Type.Literal("workspace_goal"),
    Type.Literal("skill"),
    Type.Literal("session_message"), Type.Literal("transcript_message"), Type.Literal("core_memory"),
    Type.Literal("memory_card"), Type.Literal("cold_topic"), Type.Literal("project_rule"),
    Type.Literal("user_prompt"),
  ]),
  sourceId: Type.String(),
  role: Type.Optional(Type.String()),
  selected: Type.Boolean(),
  reason: Type.String(),
  estimatedTokens: Type.Number(),
  metadata: Type.Optional(JsonObjectSchema),
});
export type ConsoleContextManifestItem = Static<typeof ConsoleContextManifestItemSchema>;

export const ConsoleContextManifestSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  source: Type.Union([Type.Literal("session"), Type.Literal("transcript")]),
  attempt: Type.Number(),
  manifestHash: Type.String(),
  createdAt: TimestampMillisecondsSchema,
  items: Type.Array(ConsoleContextManifestItemSchema),
  stats: Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()])),
});
export type ConsoleContextManifest = Static<typeof ConsoleContextManifestSchema>;

export const ConsoleTaskRunPlanItemSchema = Type.Object({
  key: Type.String(), title: Type.String(), status: Type.String(), required: Type.Boolean(), position: Type.Number(),
});
export type ConsoleTaskRunPlanItem = Static<typeof ConsoleTaskRunPlanItemSchema>;

export const ConsoleTaskRunCheckSchema = Type.Object({
  key: Type.String(), title: Type.String(), status: Type.String(), required: Type.Boolean(),
  command: Type.String(), evidence: Type.String(), stale: Type.Boolean(),
  sourceOperationId: Type.Union([Type.String(), Type.Null()]),
  observedAt: ConsoleNullableTimestampSchema,
});
export type ConsoleTaskRunCheck = Static<typeof ConsoleTaskRunCheckSchema>;

export const ConsoleArtifactSchema = Type.Object({
  id: Type.String(), title: Type.String(), kind: Type.String(), uri: Type.String(),
});
export type ConsoleArtifact = Static<typeof ConsoleArtifactSchema>;

export const ConsoleUserInputFieldSchema = Type.Object({
  key: Type.String(), label: Type.String(), description: Type.String(),
  inputType: Type.Union([Type.Literal("text"), Type.Literal("textarea")]),
  required: Type.Boolean(), placeholder: Type.String(),
});
export type ConsoleUserInputField = Static<typeof ConsoleUserInputFieldSchema>;

export const ConsoleUserInputRequestSchema = Type.Object({
  id: Type.String(), runId: Type.String(), attempt: Type.Number(), prompt: Type.String(),
  fields: Type.Array(ConsoleUserInputFieldSchema),
  status: Type.Union([Type.Literal("pending"), Type.Literal("submitted"), Type.Literal("cancelled"), Type.Literal("superseded")]),
  response: Type.Record(Type.String(), Type.String()),
  requestedAt: TimestampMillisecondsSchema,
  submittedAt: ConsoleNullableTimestampSchema,
});
export type ConsoleUserInputRequest = Static<typeof ConsoleUserInputRequestSchema>;

export const ConsoleTaskRunSchema = Type.Object({
  id: Type.String(), sessionId: Type.String(), requestId: Type.String(), status: Type.String(), phase: Type.String(),
  goal: Type.String(), modelId: Type.String({ minLength: 1 }), reasoningEffort: ConsoleReasoningEffortSchema,
  contract: Type.Union([ConsoleTaskRunContractSchema, Type.Null()]),
  gateRequired: Type.Boolean(),
  blockedReason: Type.String(), lastEventSeq: Type.Number(), attempt: Type.Number(), resumedAt: ConsoleNullableTimestampSchema,
  createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema, completedAt: ConsoleNullableTimestampSchema,
  usage: Type.Object({
    input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(),
    totalTokens: Type.Number(), cost: Type.Number(),
  }),
  transcriptCount: Type.Number(),
  checkpoint: Type.Union([Type.Object({
    runId: Type.String(), attempt: Type.Number(), active: Type.Boolean(), assistantPartial: Type.String(),
    currentTool: Type.Union([Type.Object({
      toolCallId: Type.String(), toolName: Type.String(), startedAt: Type.Optional(TimestampMillisecondsSchema),
      lastActivityAt: Type.Optional(TimestampMillisecondsSchema),
    }), Type.Null()]),
    lastEventSeq: Type.Number(), lastTranscriptSeq: Type.Number(), updatedAt: TimestampMillisecondsSchema,
  }), Type.Null()]),
  continuations: Type.Array(Type.Object({
    id: Type.String(), ordinal: Type.Number(), status: Type.String(), reason: Type.String(), error: Type.String(),
    notBefore: TimestampMillisecondsSchema, createdAt: TimestampMillisecondsSchema, startedAt: ConsoleNullableTimestampSchema,
    completedAt: ConsoleNullableTimestampSchema, leaseOwner: Type.String(), leaseUntil: ConsoleNullableTimestampSchema,
    heartbeatAt: ConsoleNullableTimestampSchema,
  })),
  plan: Type.Array(ConsoleTaskRunPlanItemSchema), checks: Type.Array(ConsoleTaskRunCheckSchema),
  userInputRequests: Type.Array(ConsoleUserInputRequestSchema),
  pendingUserInput: Type.Union([ConsoleUserInputRequestSchema, Type.Null()]),
  artifacts: Type.Array(ConsoleArtifactSchema),
  completionGate: Type.Object({
    passed: Type.Boolean(), failures: Type.Array(Type.Object({ kind: Type.String(), key: Type.String(), reason: Type.String() })),
  }),
  launchRetryable: Type.Boolean(), resumable: Type.Boolean(),
  supervision: Type.Object({
    latestDecision: Type.Union([Type.Object({
      id: Type.String(), evaluator: Type.Union([Type.Literal("llm"), Type.Literal("system")]),
      evaluatorModel: Type.String(), action: Type.String(), reasonCode: Type.String(), rationale: Type.String(),
      confidence: Type.Number(), status: Type.String(), attempt: Type.Number(), checkpointSeq: Type.Number(),
    }), Type.Null()]),
    latestGates: Type.Array(Type.Object({
      id: Type.String(), evaluator: Type.Union([Type.Literal("llm"), Type.Literal("system")]),
      evaluatorModel: Type.String(), summary: Type.String(), gateType: Type.String(), passed: Type.Boolean(),
      failures: Type.Array(Type.Object({ kind: Type.String(), key: Type.String(), reason: Type.String(), disposition: Type.String() })),
      criterionCoverage: Type.Optional(Type.Array(Type.Object({
        criterion: Type.String(),
        status: Type.Union([Type.Literal("covered"), Type.Literal("unsupported"), Type.Literal("contradicted"), Type.Literal("blocked")]),
        evidenceRefs: Type.Array(Type.String()), reason: Type.String(),
      }))),
    })),
    progress: Type.Union([Type.Object({
      meaningfulChanges: Type.Number(), consecutiveFailures: Type.Number(), repeatedOperations: Type.Number(),
      checkpointSeq: Type.Number(), lastProgressAt: TimestampMillisecondsSchema,
    }), Type.Null()]),
    approvalRequests: Type.Array(Type.Object({
      id: Type.String(), decisionId: Type.String(),
      actionType: Type.Union([Type.Literal("resume_taskrun"), Type.Literal("start_parallel_taskrun"), Type.Literal("execute_external_action")]),
      targetType: Type.Union([Type.Literal("taskrun"), Type.Literal("session_inbox_item")]),
      targetId: Type.String(), reason: Type.String(), metadata: JsonObjectSchema,
      status: Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("superseded"), Type.Literal("consumed")]),
      requestedAt: TimestampMillisecondsSchema, resolvedAt: ConsoleNullableTimestampSchema,
      resolvedBy: Type.String(), resolution: Type.String(),
    })),
    latestContextManifest: Type.Union([ConsoleContextManifestSchema, Type.Null()]),
  }),
});
export type ConsoleTaskRun = Static<typeof ConsoleTaskRunSchema>;
