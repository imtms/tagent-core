import type {
  OperatorSkillCatalogResponse,
  OperatorSkillDeleteResponse,
  OperatorSkillResponse,
  OperatorSkillRevisionsResponse,
  OperatorSkillUpdateRequest,
  OperatorSkillUploadRequest,
  OperatorWorkspaceSkillsReplaceRequest,
  OperatorWorkspaceSkillsResponse,
  ProfileListQuery,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { protocolError } from "./errors.js";
import { OperatorContextManifestClient } from "./operator-context-manifest-v1-client.js";
import type { CoreCallOptions } from "./transport.js";

export class OperatorSkillsClient extends OperatorContextManifestClient {
  private async list<T>(path: string, query: ProfileListQuery, schemaName:
    "OperatorSkillCatalogResponseSchema" | "OperatorSkillRevisionsResponseSchema" | "OperatorWorkspaceSkillsResponseSchema",
  options: CoreCallOptions): Promise<T> {
    const abi = await loadCoreAbi();
    let input: ProfileListQuery;
    try { input = abi.decodeAbi(abi.ProfileListQuerySchema, query); }
    catch (error) {
      throw protocolError("GET", this.resolve(path), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
    }
    return this.request(`${path}${this.queryString(input)}`, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi[schemaName], payload) as T,
    });
  }

  async listOperatorSkills(query: ProfileListQuery = {}, options: CoreCallOptions = {}): Promise<OperatorSkillCatalogResponse> {
    return this.list("/api/v1/operator/skills", query, "OperatorSkillCatalogResponseSchema", options);
  }

  async getOperatorSkill(skillId: string, options: CoreCallOptions = {}): Promise<OperatorSkillResponse> {
    const abi = await loadCoreAbi();
    return this.request(`/api/v1/operator/skills/${encodeURIComponent(skillId)}`, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.OperatorSkillResponseSchema, payload),
    });
  }

  async listOperatorSkillRevisions(
    skillId: string, query: ProfileListQuery = {}, options: CoreCallOptions = {},
  ): Promise<OperatorSkillRevisionsResponse> {
    return this.list(`/api/v1/operator/skills/${encodeURIComponent(skillId)}/revisions`, query,
      "OperatorSkillRevisionsResponseSchema", options);
  }

  private async mutate<T>(input: {
    path: string;
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    revision: number;
    idempotencyKey: string;
    body?: unknown;
    requestSchema?: "OperatorSkillUploadRequestSchema" | "OperatorSkillUpdateRequestSchema" | "OperatorWorkspaceSkillsReplaceRequestSchema";
    responseSchema: "OperatorSkillResponseSchema" | "OperatorSkillDeleteResponseSchema" | "OperatorWorkspaceSkillsResponseSchema";
    options: CoreCallOptions;
  }): Promise<T> {
    const abi = await loadCoreAbi();
    let body = input.body;
    if (input.requestSchema) {
      try { body = abi.decodeAbi(abi[input.requestSchema], body); }
      catch (error) {
        throw protocolError(input.method, this.resolve(input.path), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
      }
    }
    const headers = new Headers(input.options.headers);
    headers.set("If-Match", `"r${input.revision}"`);
    return this.request(input.path, {
      ...input.options,
      decode: (payload) => abi.decodeAbi(abi[input.responseSchema], payload) as T,
      headers,
      idempotencyKey: input.idempotencyKey,
      idempotent: true,
      ...(body === undefined ? {} : { json: body }),
      method: input.method,
    });
  }

  async uploadOperatorSkill(
    catalogRevision: number, idempotencyKey: string, input: OperatorSkillUploadRequest, options: CoreCallOptions = {},
  ): Promise<OperatorSkillResponse> {
    return this.mutate({ path: "/api/v1/operator/skills", method: "POST", revision: catalogRevision,
      idempotencyKey, body: input, requestSchema: "OperatorSkillUploadRequestSchema", responseSchema: "OperatorSkillResponseSchema", options });
  }

  async updateOperatorSkill(
    skillId: string, resourceRevision: number, idempotencyKey: string, input: OperatorSkillUpdateRequest,
    options: CoreCallOptions = {},
  ): Promise<OperatorSkillResponse> {
    return this.mutate({ path: `/api/v1/operator/skills/${encodeURIComponent(skillId)}`, method: "PATCH",
      revision: resourceRevision, idempotencyKey, body: input, requestSchema: "OperatorSkillUpdateRequestSchema",
      responseSchema: "OperatorSkillResponseSchema", options });
  }

  async deleteOperatorSkill(
    skillId: string, resourceRevision: number, idempotencyKey: string, options: CoreCallOptions = {},
  ): Promise<OperatorSkillDeleteResponse> {
    return this.mutate({ path: `/api/v1/operator/skills/${encodeURIComponent(skillId)}`, method: "DELETE",
      revision: resourceRevision, idempotencyKey, responseSchema: "OperatorSkillDeleteResponseSchema", options });
  }

  async listOperatorWorkspaceSkills(
    workspaceId: string, query: ProfileListQuery = {}, options: CoreCallOptions = {},
  ): Promise<OperatorWorkspaceSkillsResponse> {
    return this.list(`/api/v1/operator/workspaces/${encodeURIComponent(workspaceId)}/skills`, query,
      "OperatorWorkspaceSkillsResponseSchema", options);
  }

  async replaceOperatorWorkspaceSkills(
    workspaceId: string, bindingRevision: number, idempotencyKey: string,
    input: OperatorWorkspaceSkillsReplaceRequest, options: CoreCallOptions = {},
  ): Promise<OperatorWorkspaceSkillsResponse> {
    return this.mutate({ path: `/api/v1/operator/workspaces/${encodeURIComponent(workspaceId)}/skills`, method: "PUT",
      revision: bindingRevision, idempotencyKey, body: input, requestSchema: "OperatorWorkspaceSkillsReplaceRequestSchema",
      responseSchema: "OperatorWorkspaceSkillsResponseSchema", options });
  }
}
