export type ProfileOperationStatus = "started" | "succeeded" | "failed" | "outcome_unknown";

export interface ProfileOperationReceiptRecord {
  principalId: string;
  delegatedActorId: string | null;
  delegatedRequestId: string | null;
  profileId: string;
  endpointId: string;
  resourceType: string;
  resourceId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: ProfileOperationStatus;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ProfileOperationIdentity {
  principalId: string;
  profileId: string;
  endpointId: string;
  resourceType: string;
  resourceId: string;
  idempotencyKey: string;
}

export interface ProfileSynchronousMutationInput<T> {
  profileId: string;
  endpointId: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  mutation: ProfileMutationContext;
  readRevision(): number | undefined;
  perform(): { value: T; resultingRevision: number };
}

export interface ProfileSynchronousMutationReplayInput {
  profileId: string;
  endpointId: string;
  resourceType: string;
  resourceId: string;
  mutation: ProfileMutationContext;
}

export interface ProfileMutationContext {
  principalId: string;
  grantedScopes: readonly string[];
  delegatedActorId?: string;
  delegatedRequestId?: string;
  requestId: string;
  idempotencyKey: string;
  canonicalPayload: string;
  expectedRevision: number;
}

export interface ProfileSessionSettingsRecord {
  sessionId: string;
  title: string;
  modelId: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  revision: number;
  updatedAt: number;
}

export type ProfileMutationResult<T> =
  | { status: "succeeded"; value: T; replayed: boolean }
  | { status: "not_found" }
  | { status: "idempotency_conflict" }
  | { status: "concurrency_conflict"; currentRevision: number }
  | { status: "state_conflict" };

export interface ProfilePageQuery {
  snapshotRowId?: number;
  after?: { createdAt: number; id: string };
  limit: number;
}

export interface ProfileInboxItemRecord {
  id: string;
  sessionId: string;
  content: string;
  status: "queued" | "claimed" | "started" | "routed" | "deleted" | "failed";
  decision: "pending" | "start_taskrun" | "steer" | "follow_up" | "discussion" | "defer" | "merge" | "delete";
  runId: string | null;
  position: number;
  summary: string;
  intent: "steer_active" | "follow_up_active" | "update_active_context" | "new_task" | "parallel_task" | "merge_candidate" | "discussion" | "clarification" | "defer";
  targetRunId: string | null;
  priority: number;
  urgency: "low" | "normal" | "high" | "critical";
  relation: "same_goal" | "correction" | "constraint" | "follow_up" | "parallel" | "derived" | "depends_on" | "independent";
  acceptanceCriteria: string[];
  confidence: number;
  reason: string;
  executionPolicy: { gateProfile?: "off" | "relaxed" | "strict" } | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileContextManifestRecord {
  id: string;
  taskRunId: string;
  attempt: number;
  source: "session" | "transcript";
  items: Array<{
    kind: "system_prompt" | "taskrun_contract" | "workspace_goal" | "skill" | "session_message" | "transcript_message"
      | "core_memory" | "memory_card" | "cold_topic" | "workflow_revision" | "communication_profile" | "project_rule" | "user_prompt";
    sourceId: string;
    selected: boolean;
    estimatedTokens: number;
  }>;
  manifestHash: string;
  createdAt: number;
}

export interface ProfileContractRepository {
  getProfileResourceRevision(profileId: string, resourceType: string, resourceId: string): number;
  bumpProfileResourceRevision(profileId: string, resourceType: string, resourceId: string): number;
  runSynchronousMutation<T>(input: ProfileSynchronousMutationInput<T>): ProfileMutationResult<T>;
  replaySynchronousMutation<T>(input: ProfileSynchronousMutationReplayInput): ProfileMutationResult<T> | undefined;
  getInboxCollectionRevision(sessionId: string): number | undefined;
  getInboxItem(sessionId: string, itemId: string): ProfileInboxItemRecord | undefined;
  listInboxPage(sessionId: string, query: ProfilePageQuery): {
    items: ProfileInboxItemRecord[];
    snapshotRowId: number;
    collectionRevision: number;
  } | undefined;
  getTaskRunSessionId(taskRunId: string): string | undefined;
  listContextManifestPage(taskRunId: string, query: ProfilePageQuery): {
    items: ProfileContextManifestRecord[];
    snapshotRowId: number;
  };
  getSessionSettings(sessionId: string): ProfileSessionSettingsRecord | undefined;
  updateSessionSettings(input: {
    sessionId: string;
    settings: {
      title?: string;
      modelId?: string;
      reasoningEffort?: ProfileSessionSettingsRecord["reasoningEffort"];
    };
    mutation: ProfileMutationContext;
    validate?(): void;
  }): ProfileMutationResult<ProfileSessionSettingsRecord>;
  claimOperation(input: ProfileOperationIdentity & {
    canonicalPayload: string;
    delegatedActorId?: string;
    delegatedRequestId?: string;
  }): { receipt: ProfileOperationReceiptRecord; claimed: boolean };
  getOperation(identity: ProfileOperationIdentity): ProfileOperationReceiptRecord | undefined;
  findOperations(principalId: string, idempotencyKey: string, profileIdPrefix?: string): ProfileOperationReceiptRecord[];
  settleOperation(
    identity: ProfileOperationIdentity,
    status: Exclude<ProfileOperationStatus, "started">,
    result?: Record<string, unknown>,
    error?: Record<string, unknown>,
  ): ProfileOperationReceiptRecord;
  recordAudit(input: {
    principalId: string;
    grantedScopes: readonly string[];
    delegatedActorId?: string;
    delegatedRequestId?: string;
    requestId: string;
    profileId: string;
    endpointId: string;
    resourceType: string;
    resourceId: string;
    operation: string;
    outcome: "succeeded" | "failed" | "outcome_unknown";
    errorCode?: string;
    timestamp?: number;
  }): void;
}
