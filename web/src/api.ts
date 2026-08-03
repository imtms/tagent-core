import { createRequestId } from "./id";

export interface Session { id: string; title: string; createdAt: number; updatedAt: number; latestRunStatus: string | null; latestRunPhase: string | null }
export interface SessionInputAnalysis { summary: string; intent: "steer_active" | "follow_up_active" | "update_active_context" | "new_task" | "parallel_task" | "merge_candidate" | "discussion" | "clarification" | "defer"; targetRunId: string | null; priority: number; urgency: "low" | "normal" | "high" | "critical"; relation: "same_goal" | "correction" | "constraint" | "follow_up" | "parallel" | "derived" | "depends_on" | "independent"; acceptanceCriteria: string[]; scope: string; nonGoals: string[]; confidence: number; reason: string; routerVersion: string }
export interface TaskRunContract { sourceInput: string; summary: string; acceptanceCriteria: string[]; scope: string; nonGoals: string[]; sourceInboxIds: string[]; parentRunId: string | null; relation: SessionInputAnalysis["relation"]; intent: SessionInputAnalysis["intent"]; decisionReason: string; routerVersion: string }
export interface SessionInboxItem { id: string; sessionId: string; requestId: string; content: string; status: "queued" | "claimed" | "started" | "routed" | "deleted" | "failed"; decision: "pending" | "start_taskrun" | "steer" | "follow_up" | "discussion" | "defer" | "merge" | "delete"; runId: string | null; error: string; position: number; createdAt: number; updatedAt: number; claimedAt: number | null; startedAt: number | null; analysis: SessionInputAnalysis; manualOrder: boolean }
export interface Message { id: number; sessionId: string; role: "user" | "assistant" | "tool"; content: string; createdAt: number }
export interface ContextManifestItem { kind: string; sourceId: string; role?: string; selected: boolean; reason: string; estimatedTokens: number; metadata?: Record<string, unknown> }
export interface ContextManifest { id: string; source: "session" | "transcript"; attempt: number; manifestHash: string; createdAt: number; items: ContextManifestItem[]; stats: Record<string, number | string> }
export interface PlanItem { key: string; title: string; status: string; required: boolean; position: number }
export interface RunCheck { key: string; title: string; status: string; required: boolean; command: string; evidence: string; stale: boolean }
export interface Artifact { id: string; title: string; kind: string; uri: string }
export interface ArtifactContent extends Artifact { content: string; format: "markdown" | "text"; bytes: number; source: "inline" | "file" }
export interface UserInputField { key: string; label: string; description: string; inputType: "text" | "textarea"; required: boolean; placeholder: string }
export interface UserInputRequest { id: string; runId: string; attempt: number; prompt: string; fields: UserInputField[]; status: "pending" | "submitted" | "cancelled" | "superseded"; response: Record<string, string>; requestedAt: number; submittedAt: number | null }
export interface TaskRun {
  id: string; sessionId: string; requestId: string; status: string; phase: string; goal: string; contract: TaskRunContract | null;
  blockedReason: string; lastEventSeq: number; attempt: number; resumedAt: number | null; createdAt: number; updatedAt: number; completedAt: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  transcriptCount: number;
  checkpoint: { runId: string; attempt: number; active: boolean; assistantPartial: string; currentTool: { toolCallId: string; toolName: string; startedAt?: number; lastActivityAt?: number } | null; lastEventSeq: number; lastTranscriptSeq: number; updatedAt: number } | null;
  continuations: Array<{ id: string; ordinal: number; status: string; reason: string; error: string; createdAt: number; startedAt: number | null; completedAt: number | null; leaseOwner: string; leaseUntil: number | null; heartbeatAt: number | null }>;
  plan: PlanItem[]; checks: RunCheck[];
  userInputRequests: UserInputRequest[]; pendingUserInput: UserInputRequest | null;
  artifacts: Artifact[];
  completionGate: { passed: boolean; failures: Array<{ kind: string; key: string; reason: string }> };
  launchRetryable: boolean;
  resumable: boolean;
  supervision: {
    latestDecision: { id: string; evaluator: "llm" | "system"; evaluatorModel: string; action: string; reasonCode: string; rationale: string; confidence: number; status: string; attempt: number; checkpointSeq: number } | null;
    latestGates: Array<{ id: string; evaluator: "llm" | "system"; evaluatorModel: string; summary: string; gateType: string; passed: boolean; failures: Array<{ kind: string; key: string; reason: string; disposition: string }>; criterionCoverage?: Array<{ criterion: string; status: "covered" | "unsupported" | "contradicted" | "blocked"; evidenceRefs: string[]; reason: string }> }>;
    progress: { meaningfulChanges: number; consecutiveFailures: number; repeatedOperations: number; checkpointSeq: number; lastProgressAt: number } | null;
    approvalRequests: Array<{ id: string; decisionId: string; actionType: "resume_taskrun" | "start_parallel_taskrun"; targetType: "taskrun" | "session_inbox_item"; targetId: string; reason: string; metadata: Record<string, unknown>; status: "pending" | "approved" | "rejected" | "superseded"; requestedAt: number; resolvedAt: number | null; resolvedBy: string; resolution: string }>;
    latestContextManifest: ContextManifest | null;
  };
}
export interface EventConsumerCursor { runId: string; consumerId: string; generation: number; ackedSeq: number; terminalAckedSeq: number | null; claimedAt: number; updatedAt: number }
export interface RunEvent { runId: string; seq: number; type: string; data: Record<string, unknown>; createdAt: number }
export type TranscriptItem =
  | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
  | { seq: number; index: number; attempt: number; kind: "thinking"; text: string; redacted: boolean; createdAt: number }
  | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; status: string; createdAt: number };
export interface LearningFeatureState { memoryAvailable:boolean;memoryEnabled:boolean;learningEnabled:boolean;autoExecutionEnabled:boolean;passiveLearningEnabled:boolean;activeExecutionRequiresApproval:true;updatedAt:number;reason:string }
export interface RuntimeStatus { runtime: string; provider: string; api: string; baseUrl: string; modelId: string; credentialConfigured: boolean; providerTimeoutMs: number; providerMaxRetries: number; runTimeoutMs: number; maxContinuations: number; schemaVersion?: number; memoryEnabled: boolean; memoryWorkspaceScopeId?: string; memoryBackend?: "memory" | "postgres"; memoryColdBackend?: "local" | "s3"; learningEnabled:boolean;learningAutoExecutionEnabled:boolean;learningRequiresMemory:true;learningActiveExecutionRequiresApproval:true;autoExecutionEnabled?:boolean;passiveLearningEnabled?:boolean }
export interface WorkflowRevision { id:string; workflowId:string; revision:number; name:string; intent:string; cueTerms:string[]; applicability:string[]; nonApplicability:string[]; steps:Array<{stepId:string;instruction:string;required:boolean}>; verification:Array<{check:string;required:boolean;successCondition:string}>; requiredCapabilities:string[]; riskClass:"low"|"medium"|"high"; confidence:number; createdAt:number }
export interface WorkflowDefinition { id:string; scopeId:string; status:"candidate"|"active"|"suspended"|"deprecated"; activeRevisionId:string|null; deletedAt?:number|null; purgeAfter?:number|null; createdAt:number; updatedAt:number; revision?:WorkflowRevision }
export interface AutonomyApproval { id:string;scopeId:string;actionType:"activate_workflow"|"apply_revision"|"start_canary"|"execute_workflow";targetType:string;targetId:string;workflowId:string|null;revisionId:string|null;proposalId:string|null;bindingId:string|null;status:"pending"|"approved"|"rejected"|"revoked"|"expired"|"executed";riskClass:"low"|"medium"|"high";impactScopeJson:string;evidenceJson:string;diffJson:string;rollbackJson:string;requestedBy:string;requestReason:string;expiresAt:number;decidedBy:string;decisionReason:string;decidedAt:number|null;executedAt:number|null;executionReceiptJson:string;createdAt:number }
export interface LearningCenterData { featureState:LearningFeatureState|null;workflows:WorkflowDefinition[]; bindings:Array<{id:string;runId:string;attempt:number;workflowId:string;revisionId:string;relevanceScore:number;applicationMode:string;createdAt:number}>; canaryBindings:Array<{id:string;promotionId:string;runId:string;variant:string;bucket:number;revisionId:string;outcomeStatus?:string;success?:number}>; feedback:Array<{id:string;workflowId:string;revisionId:string;runId:string;attempt:number;signal:string;weight:number;adopted:number;verified:number;note:string;createdAt:number}>; proposals:Array<{id:string;workflowId:string;baseRevisionId:string;reason:string;patchJson:string;changedPathsJson:string;status:"candidate"|"approved"|"rejected"|"applied";createdAt:number}>; learningPolicies:Array<{runId:string;policy:"allow"|"metadata_only"|"deny";reason:string;updatedAt:number}>; quality:Array<{workflowId:string;revisionId?:string;samples:number;score:number}>; distillationJobs:Array<{id:string;taskSignature:string;status:string;attempts:number;checkpointJson:string;error:string;updatedAt:number}>; distillationMetrics:{queued:number;running:number;completed:number;deadLetter:number;failed:number;oldestQueuedAgeMs:number}; evaluations:Array<{id:string;workflowId:string;revisionId:string;kind:string;status:string;sampleSize:number;successRate:number;baselineRate:number;evaluatorId:string;evaluatorVersion:string;datasetId:string;receiptHash:string;createdAt:number}>;approvals:AutonomyApproval[];autonomyAudit:Array<{id:string;category:string;action:string;actor:string;sourceRunId:string|null;workflowId:string|null;revisionId:string|null;approvalId:string|null;evidenceJson:string;metadataJson:string;receiptHash:string;createdAt:number}> }

export type MemoryKind = "fact" | "preference" | "episode" | "procedure";
export type MemoryTier = "hot" | "warm";
export type MemoryStatus = "candidate" | "active" | "stale" | "superseded" | "disputed" | "quarantined" | "deleted";
export interface MemoryScope { type: "user" | "workspace" | "project" | "session"; id: string }
export interface MemorySourceRef { sourceType: "message" | "run" | "transcript" | "manual"; sourceId: string; revision?: string }
export interface MemoryRecord { id: string; kind: Exclude<MemoryKind, "preference">; tier: MemoryTier; scope: MemoryScope; title: string; content: string; summary: string; topicIds: string[]; entityIds: string[]; status: MemoryStatus; confidence: number; importance: number; sourceRefs: MemorySourceRef[]; createdAt: number; updatedAt: number }
export interface PreferenceRecord { id: string; kind: "preference"; tier: MemoryTier; scope: MemoryScope; dimension: string; value: string; summary: string; topicIds: string[]; entityIds: string[]; applicability: "global" | "workspace" | "project" | "task"; strength: number; origin: "explicit" | "repeated" | "inferred"; status: MemoryStatus; confidence: number; sourceRefs: MemorySourceRef[]; createdAt: number; updatedAt: number }
export type WarmMemory = MemoryRecord | PreferenceRecord;
export interface TopicDescriptor { topicId: string; kind: MemoryKind; scope: MemoryScope; title: string; description: string; aliases: string[]; entityIds: string[]; relatedTopicIds: string[]; coldRevisionId?: string; status: MemoryStatus; updatedAt: number }
export interface ColdTopic { descriptor: TopicDescriptor; revision: { id: string; revision: number; checksum: string; tokenCount: number; createdAt: number; publishedAt?: number }; body: string }
export interface CaptureJob { id:string; status:"queued"|"running"|"completed"|"completed_empty"|"retryable_failed"|"dead_letter"; attempts:number; errorCode?:string; proposalCount?:number; persistedCount?:number; createdAt:number; updatedAt:number; request:{sourceRefs:MemorySourceRef[]; captureSource?:{kind:string;role:string}} }
export interface MemoryStatusResult { records: { hot: number; warm: number; candidate: number; active: number; disputed: number }; topics: number; coldTopics: number; readiness?: any }
export interface ReindexJob {id:string;generation:string;status:string;checkpoint:{processed:number;indexed:number;skipped:number;failed:number;total?:number;phase:string};createdAt:number;updatedAt:number}
export interface CoreMemorySnapshot {revision:number;markdown:string;sourceRecordIds:string[];tokenCount:number;generatedAt:number;editedAt?:number}
export interface MemoryExport { records: WarmMemory[]; topics: ColdTopic[] }
export interface MemoryCard { id: string; kind: MemoryKind; tier: MemoryTier; title: string; content: string; score: number; topicIds: string[]; confidence: number }
export interface RecallResult { cards: MemoryCard[]; coldTopics: ColdTopic[]; trace: { topicIds: string[]; candidateCount: number; deniedCount: number } }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const needsRunControlRequestId = init?.method === "POST" && init.body == null && /^\/api\/runs\/[^/]+\/(cancel|resume)$/.test(url);
  const requestInit = needsRunControlRequestId ? { ...init, body: JSON.stringify({ requestId: createRequestId() }) } : init;
  const headers = new Headers(requestInit?.headers);
  if (requestInit?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...requestInit, headers });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`TAgent API protocol mismatch at ${url}: expected JSON but received ${contentType || "an unknown content type"}. The server may need to be restarted after an upgrade.`);
  }
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? response.statusText);
  return payload as T;
}

export const api = {
  status: () => request<RuntimeStatus | null>("/api/config/status"),
  learningSettings: () => request<LearningFeatureState>("/api/learning/settings"),
  updateLearningSettings: (input:Partial<Pick<LearningFeatureState,"memoryEnabled"|"learningEnabled"|"autoExecutionEnabled">>)=>request<LearningFeatureState>("/api/learning/settings",{method:"PATCH",body:JSON.stringify({...input,reason:"web_ui"})}),
  sessions: () => request<Session[]>("/api/sessions"),
  createSession: (title = "New workspace") => request<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  renameSession: (sessionId: string, title: string) => request<Session>(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  messages: (sessionId: string, limit = 80, beforeId?: number) => request<Message[]>(`/api/sessions/${sessionId}/messages?limit=${limit}${beforeId ? `&beforeId=${beforeId}` : ""}`),
  runs: (sessionId: string, limit = 50) => request<TaskRun[]>(`/api/sessions/${sessionId}/runs?limit=${limit}`),
  latestRun: (sessionId: string) => request<TaskRun | null>(`/api/sessions/${sessionId}/run`),
  run: (runId: string) => request<TaskRun>(`/api/runs/${runId}`),
  contextManifests: (runId: string, limit = 20) => request<ContextManifest[]>(`/api/runs/${runId}/context-manifests?limit=${limit}`),
  transcriptView: (runId: string) => request<TranscriptItem[]>(`/api/runs/${runId}/transcript-view`),
  artifactContent: (runId: string, artifactId: string) => request<ArtifactContent>(`/api/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}/content`),
  artifactDownloadUrl: (runId: string, artifactId: string) => `/api/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}/download`,
  send: (sessionId: string, content: string) => request<{ item: SessionInboxItem; run: TaskRun | null }>(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content, requestId: createRequestId() }) }),
  inbox: (sessionId: string) => request<SessionInboxItem[]>(`/api/sessions/${sessionId}/inbox`),
  updateInbox: (sessionId: string, itemId: string, content: string) => request<SessionInboxItem>(`/api/sessions/${sessionId}/inbox/${itemId}`, { method: "PATCH", body: JSON.stringify({ content }) }),
  reorderInbox: (sessionId: string, itemIds: string[]) => request<SessionInboxItem[]>(`/api/sessions/${sessionId}/inbox/order`, { method: "PUT", body: JSON.stringify({ itemIds }) }),
  startInbox: (sessionId: string, itemId: string) => request<{ status: "started"; item: SessionInboxItem; run: TaskRun }>(`/api/sessions/${sessionId}/inbox/${itemId}/start`, { method: "POST" }),
  deleteInbox: (sessionId: string, itemId: string) => request<{ ok: true }>(`/api/sessions/${sessionId}/inbox/${itemId}`, { method: "DELETE" }),
  decideInbox: (sessionId: string, itemId: string, decision: "pending" | "defer") => request<{ ok: true }>(`/api/sessions/${sessionId}/inbox/${itemId}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  mergeInbox: (sessionId: string, itemId: string, targetId: string) => request<{ ok: true }>(`/api/sessions/${sessionId}/inbox/${itemId}/merge`, { method: "POST", body: JSON.stringify({ targetId }) }),
  cancel: (runId: string) => request(`/api/runs/${runId}/cancel`, { method: "POST" }),
  steer: (runId: string, content: string) => request(`/api/runs/${runId}/steer`, { method: "POST", body: JSON.stringify({ content, requestId: createRequestId() }) }),
  resume: (runId: string) => request<TaskRun>(`/api/runs/${runId}/resume`, { method: "POST" }),
  submitUserInput: (requestId: string, response: Record<string, string>) => request<TaskRun>(`/api/user-input-requests/${requestId}/submit`, { method: "POST", body: JSON.stringify({ response }) }),
  approveRunApproval: (approvalId: string) => request<TaskRun>(`/api/approval-requests/${approvalId}/approve`, { method: "POST" }),
  rejectRunApproval: (approvalId: string) => request<TaskRun>(`/api/approval-requests/${approvalId}/reject`, { method: "POST" }),
  requestParallelStart: (sessionId: string, itemId: string) => request<AutonomyApproval>(`/api/sessions/${sessionId}/inbox/${itemId}/parallel-start-request`, { method: "POST", body: JSON.stringify({ actor: "session_governor", reason: "Start this queued related task before the parent TaskRun completes" }) }),
  retryLaunch: (runId: string) => request<{ status: "started"; item: SessionInboxItem; run: TaskRun }>(`/api/runs/${runId}/retry-launch`, { method: "POST" }),
  claimConsumer: (runId: string, consumerId: string) => request<EventConsumerCursor>(`/api/runs/${runId}/consumers/${encodeURIComponent(consumerId)}/claim`, { method: "POST" }),
  ackConsumer: (runId: string, consumerId: string, generation: number, seq: number) => request(`/api/runs/${runId}/consumers/${encodeURIComponent(consumerId)}/ack`, { method: "POST", body: JSON.stringify({ generation, seq }) }),
  memoryJobs: (scope: MemoryScope) => request<CaptureJob[]>("/api/memory/jobs", { method: "POST", body: JSON.stringify({ scopes: [scope], limit: 100 }) }),
  memoryStatus: (scope: MemoryScope) => request<MemoryStatusResult>("/api/memory/status", { method: "POST", body: JSON.stringify({ scopes: [scope] }) }),
  memoryExport: (scope: MemoryScope, limit = 200) => request<MemoryExport>("/api/memory/export", { method: "POST", body: JSON.stringify({ scope, limit }) }),
  memoryRecall: (scope: MemoryScope, cue: string, kinds?: MemoryKind[]) => request<RecallResult>("/api/memory/recall", { method: "POST", body: JSON.stringify({ scopes: [scope], cue, kinds, maxCards: 12, maxColdTopics: 4 }) }),
  memoryCapture: (scope: MemoryScope, content: string) => request<{ jobId: string }>("/api/memory/capture", { method: "POST", body: JSON.stringify({ scope, content, idempotencyKey: createRequestId() }) }),
  memoryReindex: (scope:MemoryScope)=>request<ReindexJob>("/api/memory/reindex",{method:"POST",body:JSON.stringify({scope})}),
  memoryReindexJobs: (scope:MemoryScope)=>request<ReindexJob[]>("/api/memory/reindex/jobs",{method:"POST",body:JSON.stringify({scopes:[scope],limit:20})}),
  memoryGovern: (scope:MemoryScope,id:string,action:"approve"|"reject"|"correct"|"resolve",options:Record<string,unknown>={})=>request<any>("/api/memory/govern",{method:"POST",body:JSON.stringify({scope,id,action,...options})}),
  memoryFeedback: (scope:MemoryScope,recordId:string,signal:string)=>request<any>("/api/memory/feedback",{method:"POST",body:JSON.stringify({scope,recordId,signal})}),
  memoryCoreSnapshot: (scope:MemoryScope,options:Record<string,unknown>={})=>request<CoreMemorySnapshot|null>("/api/memory/core-snapshot",{method:"POST",body:JSON.stringify({scope,...options})}),
  memoryRestore: (scope:MemoryScope,ids?:string[],topicIds?:string[])=>request<any>("/api/memory/restore",{method:"POST",body:JSON.stringify({scope,ids,topicIds})}),
  memoryForget: (scope: MemoryScope, ids?: string[], topicIds?: string[]) => request<{ records: number; topics: number; objects: number }>("/api/memory/forget", { method: "POST", body: JSON.stringify({ scope, ids, topicIds }) }),
  learningCenter: (sessionId:string)=>request<LearningCenterData>(`/api/sessions/${sessionId}/learning-center`),
  requestWorkflowActivation: (id:string,revisionId?:string)=>request<AutonomyApproval>(`/api/workflows/${id}/activation-request`,{method:"POST",body:JSON.stringify({revisionId,actor:"learning_center",reason:"Activate this workflow for future runs"})}),
  activateWorkflow: (id:string,approvalId:string,revisionId?:string)=>request<WorkflowDefinition>(`/api/workflows/${id}/activate`,{method:"POST",body:JSON.stringify({approvalId,revisionId})}),
  suspendWorkflow: (id:string)=>request<WorkflowDefinition>(`/api/workflows/${id}/suspend`,{method:"POST",body:JSON.stringify({reason:"learning_center"})}),
  forgetWorkflow: (id:string)=>request<{ok:true}>(`/api/workflows/${id}`,{method:"DELETE",body:JSON.stringify({reason:"learning_center",gracePeriodMs:2_592_000_000})}),
  restoreWorkflow: (id:string)=>request<WorkflowDefinition>(`/api/workflows/${id}/restore`,{method:"POST",body:"{}"}),
  approveWorkflowProposal: (id:string)=>request(`/api/workflow-proposals/${id}/approve`,{method:"POST",body:JSON.stringify({actor:"learning_center"})}),
  rejectWorkflowProposal: (id:string)=>request(`/api/workflow-proposals/${id}/reject`,{method:"POST",body:JSON.stringify({actor:"learning_center"})}),
  requestWorkflowProposalApplication: (id:string)=>request<AutonomyApproval>(`/api/workflow-proposals/${id}/application-request`,{method:"POST",body:JSON.stringify({actor:"learning_center",reason:"Apply approved proposal as a candidate revision"})}),
  applyWorkflowProposal: (id:string,approvalId:string)=>request(`/api/workflow-proposals/${id}/apply`,{method:"POST",body:JSON.stringify({actor:"learning_center",approvalId})}),
  approveAutonomy: (id:string)=>request<AutonomyApproval>(`/api/autonomy-approvals/${id}/approve`,{method:"POST",body:JSON.stringify({actor:"learning_center_human",reason:"Reviewed evidence, impact, diff and rollback"})}),
  rejectAutonomy: (id:string)=>request<AutonomyApproval>(`/api/autonomy-approvals/${id}/reject`,{method:"POST",body:JSON.stringify({actor:"learning_center_human",reason:"Rejected after human review"})}),
  revokeAutonomy: (id:string)=>request<AutonomyApproval>(`/api/autonomy-approvals/${id}/revoke`,{method:"POST",body:JSON.stringify({actor:"learning_center_human",reason:"Approval withdrawn before execution"})}),
  executeAutonomy: (id:string)=>request(`/api/autonomy-approvals/${id}/execute`,{method:"POST",body:JSON.stringify({actor:"learning_center_human"})}),
  setLearningPolicy: (runId:string,policy:"allow"|"metadata_only"|"deny")=>request(`/api/runs/${runId}/learning-policy`,{method:"POST",body:JSON.stringify({policy,reason:"learning_center"})}),
  setWorkflowApplication: (bindingId:string,status:"exposed"|"adopted"|"partial"|"rejected")=>request(`/api/workflow-bindings/${bindingId}/application`,{method:"POST",body:JSON.stringify({status})}),
  runWorkflowDistiller: ()=>request("/api/workflow-distillation/run",{method:"POST",body:JSON.stringify({owner:"learning_center"})}),
  retryWorkflowDistillation: (id:string)=>request(`/api/workflow-distillation/${id}/retry`,{method:"POST",body:"{}"}),
};

export function subscribe(runId: string, consumerId: string, generation: number, after: number, onEvent: (event: RunEvent) => void, onError: () => void) {
  const source = new EventSource(`/api/runs/${runId}/events?consumerId=${encodeURIComponent(consumerId)}&generation=${generation}&after=${after}`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as RunEvent);
  source.onerror = onError;
  return () => source.close();
}
