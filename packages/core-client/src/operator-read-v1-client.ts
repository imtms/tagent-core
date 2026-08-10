import type {
  OperatorReadCapabilities,
  OperatorSessionListResponse,
  OperatorSessionTaskRunListResponse,
  OperatorTaskRunSummary,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { ConsoleGoalClient } from "./console-goal-client.js";
import { protocolError } from "./errors.js";

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function pageQuery(options: { cursor?: string; limit?: number }): string {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  return query.size ? `?${query}` : "";
}

function validatePageOptions<T>(url: string, input: unknown, decode: (value: unknown) => T): T {
  try { return decode(input); }
  catch (error) {
    throw protocolError("GET", url, `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
  }
}

export class OperatorReadClient extends ConsoleGoalClient {
  async getOperatorReadCapabilities(): Promise<OperatorReadCapabilities> {
    const abi = await loadCoreAbi();
    return this.request("/api/v1/operator/capabilities", {
      decode: (payload) => abi.decodeAbi(abi.OperatorReadCapabilitiesResponseSchema, payload).data,
    });
  }

  async listOperatorSessions(options: { cursor?: string; limit?: number } = {}): Promise<OperatorSessionListResponse> {
    const abi = await loadCoreAbi();
    const basePath = "/api/v1/operator/sessions";
    const query = validatePageOptions(this.resolve(basePath), options, (value) => abi.decodeAbi(abi.OperatorListQuerySchema, value));
    return this.request(`${basePath}${pageQuery(query)}`, {
      decode: (payload) => abi.decodeAbi(abi.OperatorSessionListResponseSchema, payload),
    });
  }

  async listSessionTaskRuns(
    sessionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<OperatorSessionTaskRunListResponse> {
    const abi = await loadCoreAbi();
    const basePath = `/api/v1/operator/sessions/${encodePathSegment(sessionId)}/task-runs`;
    const query = validatePageOptions(this.resolve(basePath), options, (value) => abi.decodeAbi(abi.OperatorListQuerySchema, value));
    const path = `${basePath}${pageQuery(query)}`;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.OperatorSessionTaskRunListResponseSchema, payload),
    });
  }

  async getLatestSessionTaskRun(sessionId: string): Promise<OperatorTaskRunSummary | null> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/operator/sessions/${encodePathSegment(sessionId)}/task-runs/latest`;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.OperatorLatestSessionTaskRunResponseSchema, payload).data,
    });
  }
}
