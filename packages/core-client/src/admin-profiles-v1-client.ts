import type {
  AdminMemoryCaptureRequest,
  AdminMemoryForgetRequest,
  AdminMemoryGovernRequest,
  AdminMemoryRecordsResponse,
  AdminMemoryStatusResponse,
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

  getAdminMemoryStatus(options: CoreCallOptions = {}): Promise<AdminMemoryStatusResponse> {
    return this.profileRequest("/api/v1/admin/profiles/memory/status", "AdminMemoryStatusResponseSchema", options);
  }

  async recallAdminMemory(input: PrincipalMemoryRecallRequest, options: CoreCallOptions = {}): Promise<MemoryRecallResponse> {
    const path = "/api/v1/admin/profiles/memory/recall";
    const body = await this.validated("POST", path, "PrincipalMemoryRecallRequestSchema", input);
    return this.profileRequest(path, "MemoryRecallResponseSchema", { ...options, json: body, method: "POST" });
  }

  listAdminMemoryRecords(scope: MemoryScope, query: ProfileListQuery = {}, options: CoreCallOptions = {}): Promise<AdminMemoryRecordsResponse> {
    const path = `/api/v1/admin/profiles/memory/records${this.queryString({ scopeType: scope.type, scopeId: scope.id, ...query })}`;
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

  getAdminOperation(requestId: string, options: CoreCallOptions = {}): Promise<ProfileOperationResponse> {
    return this.profileRequest(`/api/v1/admin/operations/${encodeURIComponent(requestId)}`, "ProfileOperationResponseSchema", options);
  }
}
