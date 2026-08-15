import type { FastifyInstance } from "fastify";
import {
  decodeAbi,
  encodeAbi,
  OperatorSessionSettingsParamsSchema,
  OperatorSessionSettingsResponseSchema,
  OperatorSessionSettingsUpdateRequestSchema,
  type OperatorSessionSettings,
  type OperatorSessionSettingsParams,
  type OperatorSessionSettingsUpdateRequest,
} from "@tagent/abi";
import type { ProfileSessionSettingsRecord } from "@tagent/admission/ports";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  profileMutationContext,
  profileMutationHeaders,
  profileMutationValue,
  replayProfileMutation,
  setRevisionEtag,
} from "./profile-route-support.js";

function mapSettings(record: ProfileSessionSettingsRecord): OperatorSessionSettings {
  return {
    sessionId: record.sessionId,
    title: record.title,
    modelId: record.modelId,
    reasoningEffort: record.reasoningEffort,
    revision: record.revision,
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

function validateModel(dependencies: ChannelV1Dependencies, modelId: string | undefined): void {
  if (modelId === undefined) return;
  const runtime = dependencies.runtimeConfig as { modelId?: unknown; fallbackModelIds?: unknown } | undefined;
  const allowed = [runtime?.modelId, ...(Array.isArray(runtime?.fallbackModelIds) ? runtime.fallbackModelIds : [])]
    .filter((value): value is string => typeof value === "string" && Boolean(value));
  if (allowed.length && !allowed.includes(modelId)) {
    throw new V1HttpError(400, "session.model_not_allowed", "modelId is not configured for this Core", "validation");
  }
}

export function registerOperatorSessionSettingsV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "operator:session-settings:read", "operator");
  const write = authorizeProfile(dependencies, "operator:session-settings:write", "operator");

  app.get("/api/v1/operator/sessions/:sessionId/settings", {
    onRequest: read,
    schema: { params: OperatorSessionSettingsParamsSchema },
  }, async (request, reply) => {
    const { sessionId } = request.params as OperatorSessionSettingsParams;
    assertProfileResourceScope(request, "session", sessionId);
    const settings = dependencies.persistence.profileContracts.getSessionSettings(sessionId);
    if (!settings) throw new V1HttpError(404, "resource.not_found", "Session not found", "not_found");
    setRevisionEtag(reply, settings.revision);
    return encodeAbi(OperatorSessionSettingsResponseSchema, successEnvelope(request, { settings: mapSettings(settings) }));
  });

  app.patch("/api/v1/operator/sessions/:sessionId/settings", {
    onRequest: write,
    schema: { params: OperatorSessionSettingsParamsSchema, body: OperatorSessionSettingsUpdateRequestSchema },
  }, async (request, reply) => {
    const { sessionId } = request.params as OperatorSessionSettingsParams;
    assertProfileResourceScope(request, "session", sessionId);
    const body = decodeAbi(OperatorSessionSettingsUpdateRequestSchema, request.body) as OperatorSessionSettingsUpdateRequest;
    const normalized = {
      ...(body.title === undefined ? {} : { title: body.title.trim() }),
      ...(body.modelId === undefined ? {} : { modelId: body.modelId.trim() }),
      ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
    };
    const headers = profileMutationHeaders(request);
    const mutation = profileMutationContext(request, headers, normalized);
    const replay = replayProfileMutation<ProfileSessionSettingsRecord>(dependencies, {
      profileId: "operator.session-settings.v1", endpointId: "operator.session_settings.update",
      resourceType: "session", resourceId: sessionId,
    }, mutation);
    const result = profileMutationValue(replay ?? dependencies.persistence.profileContracts.updateSessionSettings({
      sessionId, settings: normalized, mutation,
      validate: () => validateModel(dependencies, normalized.modelId),
    }));
    setRevisionEtag(reply, result.value.revision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorSessionSettingsResponseSchema, successEnvelope(request, { settings: mapSettings(result.value) }));
  });
}
