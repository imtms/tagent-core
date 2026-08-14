import type {
  AdminAutonomyApprovalResponse,
  AdminAutonomyApprovalsResponse,
  AdminAutonomyDecisionRequest,
  AdminAutonomyRevokeRequest,
  AdminLearningCenterResponse,
  AdminLearningSettingsResponse,
  AdminMemoryCaptureRequest,
  AdminMemoryForgetRequest,
  AdminMemoryGovernRequest,
  AdminMemoryRecordsResponse,
  AdminMemoryStatusResponse,
  AdminTaskRunLearningPolicyRequest,
  AdminTaskRunLearningPolicyResponse,
  AdminWorkflowResponse,
  AdminWorkflowsResponse,
  LearningSettingsUpdateRequest,
  MemoryRecallResponse,
  MemoryScope,
  PrincipalMemoryRecallRequest,
  ProfileListQuery,
  ProfileOperationResponse,
} from "@tagent/abi";
import { loadCoreAbi, type CoreAbi } from "./abi-loader.js";
import { protocolError } from "./errors.js";
import { OperatorSkillsClient } from "./operator-skills-v1-client.js";
import type { CoreCallOptions, CoreRequestOptions } from "./transport.js";

type SchemaName = keyof CoreAbi;

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  return query.size ? `?${query}` : "";
}

export class AdminProfilesClient extends OperatorSkillsClient {
  private async validated<T>(method: string, path: string, schemaName: SchemaName, value: unknown): Promise<T> {
    const abi = await loadCoreAbi();
    try { return abi.decodeAbi(abi[schemaName] as never, value) as T; }
    catch (error) {
      throw protocolError(method, this.resolve(path), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
    }
  }

  private async profileRequest<T>(path: string, responseSchema: SchemaName, options: CoreRequestOptions<unknown> = {}): Promise<T> {
    const abi = await loadCoreAbi();
    return this.request(path, { ...options, decode: (payload) => abi.decodeAbi(abi[responseSchema] as never, payload) as T });
  }

  private async operation(path: string, method: "POST" | "PATCH" | "DELETE", idempotencyKey: string,
    body: unknown, requestSchema?: SchemaName, options: CoreCallOptions = {}): Promise<ProfileOperationResponse> {
    const payload = requestSchema ? await this.validated(method, path, requestSchema, body) : body;
    return this.profileRequest(path, "ProfileOperationResponseSchema", {
      ...options, idempotencyKey, idempotent: true, ...(payload === undefined ? {} : { json: payload }), method,
    });
  }

  private async conditional<T>(path: string, method: "POST" | "PUT" | "DELETE", revision: number,
    idempotencyKey: string, body: unknown, requestSchema: SchemaName, responseSchema: SchemaName,
    options: CoreCallOptions = {}): Promise<T> {
    const payload = await this.validated(method, path, requestSchema, body);
    const headers = new Headers(options.headers);
    headers.set("If-Match", `"r${revision}"`);
    return this.profileRequest(path, responseSchema, {
      ...options, headers, idempotencyKey, idempotent: true, json: payload, method,
    });
  }

  getAdminMemoryStatus(options: CoreCallOptions = {}): Promise<AdminMemoryStatusResponse> {
    return this.profileRequest("/api/v1/admin/profiles/memory/status", "AdminMemoryStatusResponseSchema", options);
  }

  async recallAdminMemory(input: PrincipalMemoryRecallRequest, options: CoreCallOptions = {}): Promise<MemoryRecallResponse> {
    const path = "/api/v1/admin/profiles/memory/recall";
    const body = await this.validated("POST", path, "PrincipalMemoryRecallRequestSchema", input);
    return this.profileRequest(path, "MemoryRecallResponseSchema", { ...options, json: body, method: "POST" });
  }

  listAdminMemoryRecords(scope: MemoryScope, query: ProfileListQuery = {}, options: CoreCallOptions = {}): Promise<AdminMemoryRecordsResponse> {
    const path = `/api/v1/admin/profiles/memory/records${queryString({ scopeType: scope.type, scopeId: scope.id, ...query })}`;
    return this.profileRequest(path, "AdminMemoryRecordsResponseSchema", options);
  }

  captureAdminMemory(input: AdminMemoryCaptureRequest, idempotencyKey: string, options: CoreCallOptions = {}) {
    return this.operation("/api/v1/admin/profiles/memory/captures", "POST", idempotencyKey, input, "AdminMemoryCaptureRequestSchema", options);
  }

  governAdminMemory(memoryId: string, input: AdminMemoryGovernRequest, idempotencyKey: string, options: CoreCallOptions = {}) {
    return this.operation(`/api/v1/admin/profiles/memory/records/${encodeURIComponent(memoryId)}/govern`, "POST", idempotencyKey,
      input, "AdminMemoryGovernRequestSchema", options);
  }

  forgetAdminMemory(memoryId: string, input: AdminMemoryForgetRequest, idempotencyKey: string, options: CoreCallOptions = {}) {
    return this.operation(`/api/v1/admin/profiles/memory/records/${encodeURIComponent(memoryId)}`, "DELETE", idempotencyKey,
      input, "AdminMemoryForgetRequestSchema", options);
  }

  getAdminLearningSettings(options: CoreCallOptions = {}): Promise<AdminLearningSettingsResponse> {
    return this.profileRequest("/api/v1/admin/profiles/learning/settings", "AdminLearningSettingsResponseSchema", options);
  }

  updateAdminLearningSettings(input: LearningSettingsUpdateRequest, idempotencyKey: string, options: CoreCallOptions = {}) {
    return this.operation("/api/v1/admin/profiles/learning/settings", "PATCH", idempotencyKey,
      input, "LearningSettingsUpdateRequestSchema", options);
  }

  getAdminLearningCenter(sessionId: string, options: CoreCallOptions = {}): Promise<AdminLearningCenterResponse> {
    return this.profileRequest(`/api/v1/admin/profiles/learning/sessions/${encodeURIComponent(sessionId)}`,
      "AdminLearningCenterResponseSchema", options);
  }

  updateAdminTaskRunLearningPolicy(taskRunId: string, revision: number, idempotencyKey: string,
    input: AdminTaskRunLearningPolicyRequest, options: CoreCallOptions = {}): Promise<AdminTaskRunLearningPolicyResponse> {
    return this.conditional(`/api/v1/admin/profiles/learning/task-runs/${encodeURIComponent(taskRunId)}/policy`, "PUT",
      revision, idempotencyKey, input, "AdminTaskRunLearningPolicyRequestSchema", "AdminTaskRunLearningPolicyResponseSchema", options);
  }

  listAdminWorkflows(scopeId: string, query: ProfileListQuery = {}, options: CoreCallOptions = {}): Promise<AdminWorkflowsResponse> {
    return this.profileRequest(`/api/v1/admin/profiles/workflows${queryString({ scopeId, ...query })}`, "AdminWorkflowsResponseSchema", options);
  }

  requestAdminWorkflowActivation(workflowId: string, input: { revisionId?: string; reason: string }, idempotencyKey: string,
    options: CoreCallOptions = {}) {
    return this.operation(`/api/v1/admin/profiles/workflows/${encodeURIComponent(workflowId)}/activation-requests`, "POST",
      idempotencyKey, input, "AdminWorkflowActivationRequestSchema", options);
  }

  private workflowMutation(workflowId: string, suffix: string, method: "POST" | "DELETE", revision: number,
    idempotencyKey: string, input: unknown, schema: SchemaName, options: CoreCallOptions): Promise<AdminWorkflowResponse> {
    return this.conditional(`/api/v1/admin/profiles/workflows/${encodeURIComponent(workflowId)}${suffix}`, method,
      revision, idempotencyKey, input, schema, "AdminWorkflowResponseSchema", options);
  }

  activateAdminWorkflow(workflowId: string, revision: number, idempotencyKey: string,
    input: { revisionId?: string; approvalId: string }, options: CoreCallOptions = {}) {
    return this.workflowMutation(workflowId, "/activate", "POST", revision, idempotencyKey, input, "AdminWorkflowActivateRequestSchema", options);
  }

  suspendAdminWorkflow(workflowId: string, revision: number, idempotencyKey: string,
    input: { reason: string }, options: CoreCallOptions = {}) {
    return this.workflowMutation(workflowId, "/suspend", "POST", revision, idempotencyKey, input, "AdminWorkflowSuspendRequestSchema", options);
  }

  deleteAdminWorkflow(workflowId: string, revision: number, idempotencyKey: string,
    input: { reason: string; gracePeriodMs?: number }, options: CoreCallOptions = {}) {
    return this.workflowMutation(workflowId, "", "DELETE", revision, idempotencyKey, input, "AdminWorkflowDeleteRequestSchema", options);
  }

  restoreAdminWorkflow(workflowId: string, revision: number, idempotencyKey: string, options: CoreCallOptions = {}) {
    return this.workflowMutation(workflowId, "/restore", "POST", revision, idempotencyKey, {}, "AdminEmptyRequestSchema", options);
  }

  listAdminAutonomyApprovals(scopeId: string, query: ProfileListQuery = {}, options: CoreCallOptions = {}): Promise<AdminAutonomyApprovalsResponse> {
    return this.profileRequest(`/api/v1/admin/profiles/autonomy/approvals${queryString({ scopeId, ...query })}`,
      "AdminAutonomyApprovalsResponseSchema", options);
  }

  decideAdminAutonomyApproval(approvalId: string, revision: number, idempotencyKey: string,
    input: AdminAutonomyDecisionRequest, options: CoreCallOptions = {}): Promise<AdminAutonomyApprovalResponse> {
    return this.conditional(`/api/v1/admin/profiles/autonomy/approvals/${encodeURIComponent(approvalId)}/decision`, "POST",
      revision, idempotencyKey, input, "AdminAutonomyDecisionRequestSchema", "AdminAutonomyApprovalResponseSchema", options);
  }

  revokeAdminAutonomyApproval(approvalId: string, revision: number, idempotencyKey: string,
    input: AdminAutonomyRevokeRequest, options: CoreCallOptions = {}): Promise<AdminAutonomyApprovalResponse> {
    return this.conditional(`/api/v1/admin/profiles/autonomy/approvals/${encodeURIComponent(approvalId)}/revoke`, "POST",
      revision, idempotencyKey, input, "AdminAutonomyRevokeRequestSchema", "AdminAutonomyApprovalResponseSchema", options);
  }

  executeAdminAutonomyApproval(approvalId: string, idempotencyKey: string, options: CoreCallOptions = {}) {
    return this.operation(`/api/v1/admin/profiles/autonomy/approvals/${encodeURIComponent(approvalId)}/execute`, "POST",
      idempotencyKey, {}, "AdminEmptyRequestSchema", options);
  }

  getAdminOperation(requestId: string, options: CoreCallOptions = {}): Promise<ProfileOperationResponse> {
    return this.profileRequest(`/api/v1/admin/operations/${encodeURIComponent(requestId)}`, "ProfileOperationResponseSchema", options);
  }
}
