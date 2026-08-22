import type {
  OperatorInboxDecisionRequest,
  OperatorInboxItemResponse,
  OperatorInboxListResponse,
  OperatorInboxMergeRequest,
  OperatorInboxMutationResponse,
  OperatorInboxReorderRequest,
  OperatorInboxUpdateRequest,
  ProfileListQuery,
  ProfileOperationResponse,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { protocolError } from "./errors.js";
import { OperatorSessionSettingsClient } from "./operator-session-settings-v1-client.js";
import type { CoreCallOptions } from "./transport.js";

export class OperatorInboxClient extends OperatorSessionSettingsClient {
  async listOperatorInbox(
    sessionId: string,
    query: ProfileListQuery = {},
    options: CoreCallOptions = {},
  ): Promise<OperatorInboxListResponse> {
    const abi = await loadCoreAbi();
    const basePath = `/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/inbox`;
    let input: ProfileListQuery;
    try { input = abi.decodeAbi(abi.ProfileListQuerySchema, query); }
    catch (error) {
      throw protocolError("GET", this.resolve(basePath), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
    }
    return this.request(`${basePath}${this.queryString(input)}`, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.OperatorInboxListResponseSchema, payload),
    });
  }

  private async mutateInbox<T>(input: {
    sessionId: string;
    suffix: string;
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    revision: number;
    idempotencyKey: string;
    body?: unknown;
    requestSchema?: keyof Awaited<ReturnType<typeof loadCoreAbi>>;
    responseSchema: keyof Awaited<ReturnType<typeof loadCoreAbi>>;
    options?: CoreCallOptions;
  }): Promise<T> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/operator/sessions/${encodeURIComponent(input.sessionId)}/inbox${input.suffix}`;
    let body = input.body;
    if (input.requestSchema) {
      try { body = abi.decodeAbi(abi[input.requestSchema] as never, input.body); }
      catch (error) {
        throw protocolError(input.method, this.resolve(path), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
      }
    }
    const headers = new Headers(input.options?.headers);
    headers.set("If-Match", `"r${input.revision}"`);
    return this.request(path, {
      ...input.options,
      decode: (payload) => abi.decodeAbi(abi[input.responseSchema] as never, payload) as T,
      headers,
      idempotencyKey: input.idempotencyKey,
      idempotent: true,
      ...(body === undefined ? {} : { json: body }),
      method: input.method,
    });
  }

  async reorderOperatorInbox(
    sessionId: string, revision: number, idempotencyKey: string, input: OperatorInboxReorderRequest,
    options: CoreCallOptions = {},
  ): Promise<OperatorInboxMutationResponse> {
    return this.mutateInbox({ sessionId, suffix: "/order", method: "PUT", revision, idempotencyKey, body: input,
      requestSchema: "OperatorInboxReorderRequestSchema", responseSchema: "OperatorInboxMutationResponseSchema", options });
  }

  async updateOperatorInboxItem(
    sessionId: string, itemId: string, revision: number, idempotencyKey: string, input: OperatorInboxUpdateRequest,
    options: CoreCallOptions = {},
  ): Promise<OperatorInboxItemResponse> {
    return this.mutateInbox({ sessionId, suffix: `/${encodeURIComponent(itemId)}`, method: "PATCH", revision, idempotencyKey,
      body: input, requestSchema: "OperatorInboxUpdateRequestSchema", responseSchema: "OperatorInboxItemResponseSchema", options });
  }

  async decideOperatorInboxItem(
    sessionId: string, itemId: string, revision: number, idempotencyKey: string, input: OperatorInboxDecisionRequest,
    options: CoreCallOptions = {},
  ): Promise<OperatorInboxItemResponse> {
    return this.mutateInbox({ sessionId, suffix: `/${encodeURIComponent(itemId)}/decision`, method: "POST", revision, idempotencyKey,
      body: input, requestSchema: "OperatorInboxDecisionRequestSchema", responseSchema: "OperatorInboxItemResponseSchema", options });
  }

  async mergeOperatorInboxItem(
    sessionId: string, itemId: string, revision: number, idempotencyKey: string, input: OperatorInboxMergeRequest,
    options: CoreCallOptions = {},
  ): Promise<OperatorInboxMutationResponse> {
    return this.mutateInbox({ sessionId, suffix: `/${encodeURIComponent(itemId)}/merge`, method: "POST", revision, idempotencyKey,
      body: input, requestSchema: "OperatorInboxMergeRequestSchema", responseSchema: "OperatorInboxMutationResponseSchema", options });
  }

  async deleteOperatorInboxItem(
    sessionId: string, itemId: string, revision: number, idempotencyKey: string,
    options: CoreCallOptions = {},
  ): Promise<OperatorInboxMutationResponse> {
    return this.mutateInbox({ sessionId, suffix: `/${encodeURIComponent(itemId)}`, method: "DELETE", revision, idempotencyKey,
      responseSchema: "OperatorInboxMutationResponseSchema", options });
  }

  async startOperatorInboxItem(
    sessionId: string, itemId: string, idempotencyKey: string, options: CoreCallOptions = {},
  ): Promise<ProfileOperationResponse> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(itemId)}/start`;
    return this.request(path, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.ProfileOperationResponseSchema, payload),
      idempotencyKey,
      idempotent: true,
      method: "POST",
    });
  }

  async retryOperatorInboxLaunch(
    taskRunId: string, idempotencyKey: string, options: CoreCallOptions = {},
  ): Promise<ProfileOperationResponse> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/operator/task-runs/${encodeURIComponent(taskRunId)}/retry-launch`;
    return this.request(path, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.ProfileOperationResponseSchema, payload),
      idempotencyKey,
      idempotent: true,
      method: "POST",
    });
  }

  async getOperatorOperation(requestId: string, options: CoreCallOptions = {}): Promise<ProfileOperationResponse> {
    const abi = await loadCoreAbi();
    return this.request(`/api/v1/operator/operations/${encodeURIComponent(requestId)}`, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.ProfileOperationResponseSchema, payload),
    });
  }
}
