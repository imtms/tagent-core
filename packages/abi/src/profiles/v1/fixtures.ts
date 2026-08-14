import type { CapabilityProfileDetailResponse, CapabilityProfileRegistryResponse } from "./schemas.js";
import { CAPABILITY_PROFILE_DESCRIPTORS } from "./descriptors.js";

const authorization = (profile: (typeof CAPABILITY_PROFILE_DESCRIPTORS)[number]) => ({
  principalId: "gateway-fixture",
  status: "available" as const,
  availableEndpointIds: [...profile.endpointIds],
  missingScopes: [],
});

export const capabilityProfileRegistryFixture = {
  data: {
    profiles: CAPABILITY_PROFILE_DESCRIPTORS.map((profile) => ({
      id: profile.id,
      version: profile.version,
      audience: profile.audience,
      detailPath: profile.detailPath,
      authorization: authorization(profile),
    })),
  },
  requestId: "request-profile-registry-001",
} satisfies CapabilityProfileRegistryResponse;

export const capabilityProfileDetailFixtures = CAPABILITY_PROFILE_DESCRIPTORS.map((profile) => ({
  data: { profile, authorization: authorization(profile) },
  requestId: `request-profile-${profile.id}`,
})) satisfies CapabilityProfileDetailResponse[];
