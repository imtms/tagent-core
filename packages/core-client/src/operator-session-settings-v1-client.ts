import type {
  OperatorSessionSettingsResponse,
  OperatorSessionSettingsUpdateRequest,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { CapabilityProfileClient } from "./capability-profile-client.js";
import { protocolError } from "./errors.js";
import type { CoreCallOptions } from "./transport.js";

function pathFor(sessionId: string): string {
  return `/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/settings`;
}

function validateInput<T>(url: string, input: unknown, decode: (value: unknown) => T): T {
  try { return decode(input); }
  catch (error) {
    throw protocolError("PATCH", url, `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
  }
}

export class OperatorSessionSettingsClient extends CapabilityProfileClient {
  async getOperatorSessionSettings(sessionId: string, options: CoreCallOptions = {}): Promise<OperatorSessionSettingsResponse> {
    const abi = await loadCoreAbi();
    const path = pathFor(sessionId);
    return this.request(path, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.OperatorSessionSettingsResponseSchema, payload),
    });
  }

  async updateOperatorSessionSettings(
    sessionId: string,
    revision: number,
    idempotencyKey: string,
    input: OperatorSessionSettingsUpdateRequest,
    options: CoreCallOptions = {},
  ): Promise<OperatorSessionSettingsResponse> {
    const abi = await loadCoreAbi();
    const path = pathFor(sessionId);
    const body = validateInput(this.resolve(path), input, (value) => abi.decodeAbi(abi.OperatorSessionSettingsUpdateRequestSchema, value));
    const headers = new Headers(options.headers);
    headers.set("If-Match", `"r${revision}"`);
    return this.request(path, {
      ...options,
      decode: (payload) => abi.decodeAbi(abi.OperatorSessionSettingsResponseSchema, payload),
      headers,
      idempotencyKey,
      idempotent: true,
      json: body,
      method: "PATCH",
    });
  }
}
