import type {
  CapabilityProfileDetailResponse,
  CapabilityProfileId,
  CapabilityProfileRegistryResponse,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { OperatorReadClient } from "./operator-read-v1-client.js";

export class CapabilityProfileClient extends OperatorReadClient {
  async listCapabilityProfiles(): Promise<CapabilityProfileRegistryResponse> {
    const abi = await loadCoreAbi();
    return this.request("/api/v1/capability-profiles", {
      decode: (payload) => abi.decodeAbi(abi.CapabilityProfileRegistryResponseSchema, payload),
    });
  }

  async getCapabilityProfile(profileId: CapabilityProfileId): Promise<CapabilityProfileDetailResponse> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/capability-profiles/${encodeURIComponent(profileId)}`;
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.CapabilityProfileDetailResponseSchema, payload),
    });
  }
}
