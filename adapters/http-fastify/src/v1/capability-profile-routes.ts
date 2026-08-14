import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CAPABILITY_PROFILE_DESCRIPTORS,
  CapabilityProfileDetailResponseSchema,
  CapabilityProfileRegistryResponseSchema,
  encodeAbi,
  type CapabilityProfileAuthorization,
  type CapabilityProfileDescriptor,
  type ProfileServiceScope,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { authorizeV1Scopes, principalOf } from "./auth.js";
import { successEnvelope, V1HttpError } from "./errors.js";

function authorizeRegistry(dependencies: ChannelV1Dependencies) {
  return async (request: FastifyRequest): Promise<void> => {
    authorizeV1Scopes(request, dependencies.serviceCredentials, [], "operator");
  };
}

function profileAuthorization(request: FastifyRequest, profile: CapabilityProfileDescriptor): CapabilityProfileAuthorization {
  const principal = principalOf(request);
  const granted = new Set(principal.grantedScopes);
  const availableEndpointIds = profile.endpoints
    .filter((endpoint) => endpoint.requiredScopes.every((scope) => principal.localAdmin || granted.has(scope)))
    .map((endpoint) => endpoint.id);
  const missingScopes = [...new Set(profile.endpoints.flatMap((endpoint) => endpoint.requiredScopes)
    .filter((scope) => !principal.localAdmin && !granted.has(scope)))] as ProfileServiceScope[];
  return {
    principalId: principal.subjectId,
    status: availableEndpointIds.length === profile.endpoints.length
      ? "available"
      : availableEndpointIds.length
        ? "partially_available"
        : "unavailable",
    availableEndpointIds,
    missingScopes,
  };
}

export function registerCapabilityProfileV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const authorize = authorizeRegistry(dependencies);

  app.get("/api/v1/capability-profiles", { onRequest: authorize }, async (request) =>
    encodeAbi(CapabilityProfileRegistryResponseSchema, successEnvelope(request, {
      profiles: CAPABILITY_PROFILE_DESCRIPTORS.map((profile) => ({
        id: profile.id,
        version: profile.version,
        audience: profile.audience,
        detailPath: profile.detailPath,
        authorization: profileAuthorization(request, profile),
      })),
    })));

  app.get("/api/v1/capability-profiles/:profileId", { onRequest: authorize }, async (request) => {
    const { profileId } = request.params as { profileId: string };
    const profile = CAPABILITY_PROFILE_DESCRIPTORS.find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new V1HttpError(404, "capability.unsupported", "Capability profile is not supported", "not_found", false, { profileId });
    }
    return encodeAbi(CapabilityProfileDetailResponseSchema, successEnvelope(request, {
      profile,
      authorization: profileAuthorization(request, profile),
    }));
  });
}
