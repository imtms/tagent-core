import type { OperatorContextManifestListResponse, ProfileListQuery } from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { protocolError } from "./errors.js";
import { OperatorInboxClient } from "./operator-inbox-v1-client.js";
import type { CoreCallOptions } from "./transport.js";

export class OperatorContextManifestClient extends OperatorInboxClient {
  async listOperatorContextManifests(
    taskRunId: string,
    query: ProfileListQuery = {},
    options: CoreCallOptions = {},
  ): Promise<OperatorContextManifestListResponse> {
    const abi = await loadCoreAbi();
    const basePath = `/api/v1/operator/task-runs/${encodeURIComponent(taskRunId)}/context-manifests`;
    let input: ProfileListQuery;
    try { input = abi.decodeAbi(abi.ProfileListQuerySchema, query); }
    catch (error) {
      throw protocolError("GET", this.resolve(basePath), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
    }
    return this.request(`${basePath}${this.queryString(input)}`, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.OperatorContextManifestListResponseSchema, payload),
    });
  }
}
