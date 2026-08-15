import { ConsoleDecode } from "@tagent/core-client";
import { createRequestId } from "./id";
import type { ApiRequest } from "./api-transport";
import type { LearningFeatureState, MemoryKind, MemoryScope } from "./api-types";

export function createAdminApi(request: ApiRequest) {
  return {
    status: () => request("/api/v1/admin/config/status", undefined, ConsoleDecode.runtimeStatus),
    learningSettings: () => request("/api/v1/admin/console/learning/settings", undefined, ConsoleDecode.learningFeatureState),
    updateLearningSettings: (input: Partial<Pick<LearningFeatureState, "memoryEnabled" | "learningEnabled" | "autoExecutionEnabled">>) => request("/api/v1/admin/console/learning/settings", { method: "PATCH", body: JSON.stringify({ ...input, reason: "web_ui" }) }, ConsoleDecode.learningFeatureState),
    memoryJobs: (scope: MemoryScope) => request("/api/v1/admin/memory/jobs", { method: "POST", body: JSON.stringify({ scopes: [scope], limit: 100 }) }, ConsoleDecode.captureJobs),
    memoryStatus: (scope: MemoryScope) => request("/api/v1/admin/memory/status", { method: "POST", body: JSON.stringify({ scopes: [scope] }) }, ConsoleDecode.memoryStatus),
    memoryExport: (scope: MemoryScope, limit = 200) => request("/api/v1/admin/memory/export", { method: "POST", body: JSON.stringify({ scope, limit }) }, ConsoleDecode.memoryExport),
    memoryRecall: (scope: MemoryScope, cue: string, kinds?: MemoryKind[]) => request("/api/v1/admin/memory/recall-console", { method: "POST", body: JSON.stringify({ scopes: [scope], cue, kinds, maxCards: 12, maxColdTopics: 4 }) }, ConsoleDecode.recallResult),
    memoryCapture: (scope: MemoryScope, content: string) => request("/api/v1/admin/memory/capture", { method: "POST", body: JSON.stringify({ scope, content, idempotencyKey: createRequestId() }) }, ConsoleDecode.captureJobId),
    memoryReindex: (scope: MemoryScope) => request("/api/v1/admin/memory/reindex", { method: "POST", body: JSON.stringify({ scope }) }, ConsoleDecode.reindexJob),
    memoryReindexJobs: (scope: MemoryScope) => request("/api/v1/admin/memory/reindex/jobs", { method: "POST", body: JSON.stringify({ scopes: [scope], limit: 20 }) }, ConsoleDecode.reindexJobs),
    memoryGovern: (scope: MemoryScope, id: string, action: "approve" | "reject" | "correct" | "resolve", options: Record<string, unknown> = {}) => request("/api/v1/admin/memory/govern", { method: "POST", body: JSON.stringify({ scope, id, action, ...options }) }, ConsoleDecode.jsonObject),
    memoryFeedback: (scope: MemoryScope, recordId: string, signal: string) => request("/api/v1/admin/memory/feedback", { method: "POST", body: JSON.stringify({ scope, recordId, signal }) }, ConsoleDecode.jsonObject),
    memoryCoreSnapshot: (scope: MemoryScope, options: Record<string, unknown> = {}) => request("/api/v1/admin/memory/core-snapshot", { method: "POST", body: JSON.stringify({ scope, ...options }) }, ConsoleDecode.coreMemorySnapshot),
    memoryRestore: (scope: MemoryScope, ids?: string[], topicIds?: string[]) => request("/api/v1/admin/memory/restore", { method: "POST", body: JSON.stringify({ scope, ids, topicIds }) }, ConsoleDecode.jsonObject),
    memoryForget: (scope: MemoryScope, ids?: string[], topicIds?: string[]) => request("/api/v1/admin/memory/forget", { method: "POST", body: JSON.stringify({ scope, ids, topicIds }) }, ConsoleDecode.forgetResult),
    learningCenter: (sessionId: string) => request(`/api/v1/admin/sessions/${sessionId}/learning-center`, undefined, ConsoleDecode.learningCenter),
    requestWorkflowActivation: (id: string, revisionId?: string) => request(`/api/v1/admin/workflows/${id}/activation-request`, { method: "POST", body: JSON.stringify({ revisionId, actor: "learning_center", reason: "Activate this workflow for future runs" }) }, ConsoleDecode.autonomyApproval),
    activateWorkflow: (id: string, approvalId: string, revisionId?: string) => request(`/api/v1/admin/workflows/${id}/activate`, { method: "POST", body: JSON.stringify({ approvalId, revisionId }) }, ConsoleDecode.workflowDefinition),
    suspendWorkflow: (id: string) => request(`/api/v1/admin/workflows/${id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "learning_center" }) }, ConsoleDecode.workflowDefinition),
    forgetWorkflow: (id: string) => request(`/api/v1/admin/workflows/${id}`, { method: "DELETE", body: JSON.stringify({ reason: "learning_center", gracePeriodMs: 2_592_000_000 }) }, ConsoleDecode.ok),
    restoreWorkflow: (id: string) => request(`/api/v1/admin/workflows/${id}/restore`, { method: "POST", body: "{}" }, ConsoleDecode.workflowDefinition),
    approveWorkflowProposal: (id: string) => request(`/api/v1/admin/workflow-proposals/${id}/approve`, { method: "POST", body: JSON.stringify({ actor: "learning_center" }) }, ConsoleDecode.jsonObject),
    rejectWorkflowProposal: (id: string) => request(`/api/v1/admin/workflow-proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ actor: "learning_center" }) }, ConsoleDecode.jsonObject),
    requestWorkflowProposalApplication: (id: string) => request(`/api/v1/admin/workflow-proposals/${id}/application-request`, { method: "POST", body: JSON.stringify({ actor: "learning_center", reason: "Apply approved proposal as a candidate revision" }) }, ConsoleDecode.autonomyApproval),
    applyWorkflowProposal: (id: string, approvalId: string) => request(`/api/v1/admin/workflow-proposals/${id}/apply`, { method: "POST", body: JSON.stringify({ actor: "learning_center", approvalId }) }, ConsoleDecode.jsonObject),
    approveAutonomy: (id: string) => request(`/api/v1/admin/autonomy-approvals/${id}/approve`, { method: "POST", body: JSON.stringify({ actor: "learning_center_human", reason: "Reviewed evidence, impact, diff and rollback" }) }, ConsoleDecode.autonomyApproval),
    rejectAutonomy: (id: string) => request(`/api/v1/admin/autonomy-approvals/${id}/reject`, { method: "POST", body: JSON.stringify({ actor: "learning_center_human", reason: "Rejected after human review" }) }, ConsoleDecode.autonomyApproval),
    revokeAutonomy: (id: string) => request(`/api/v1/admin/autonomy-approvals/${id}/revoke`, { method: "POST", body: JSON.stringify({ actor: "learning_center_human", reason: "Approval withdrawn before execution" }) }, ConsoleDecode.autonomyApproval),
    executeAutonomy: (id: string) => request(`/api/v1/admin/autonomy-approvals/${id}/execute`, { method: "POST", body: JSON.stringify({ actor: "learning_center_human" }) }, ConsoleDecode.jsonObject),
    setLearningPolicy: (runId: string, policy: "allow" | "metadata_only" | "deny") => request(`/api/v1/admin/task-runs/${runId}/learning-policy`, { method: "POST", body: JSON.stringify({ policy, reason: "learning_center" }) }, ConsoleDecode.jsonObject),
    setWorkflowApplication: (bindingId: string, status: "exposed" | "adopted" | "partial" | "rejected") => request(`/api/v1/admin/workflow-bindings/${bindingId}/application`, { method: "POST", body: JSON.stringify({ status }) }, ConsoleDecode.jsonObject),
    runWorkflowDistiller: () => request("/api/v1/admin/workflow-distillation/run", { method: "POST", body: JSON.stringify({ owner: "learning_center" }) }, ConsoleDecode.jsonObject),
    retryWorkflowDistillation: (id: string) => request(`/api/v1/admin/workflow-distillation/${id}/retry`, { method: "POST", body: "{}" }, ConsoleDecode.jsonObject),
  };
}
