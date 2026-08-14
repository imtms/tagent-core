import type { FastifyInstance } from "fastify";
import {
  AdminLearningCenterResponseSchema,
  AdminLearningSessionParamsSchema,
  AdminLearningSettingsResponseSchema,
  AdminLearningTaskRunParamsSchema,
  AdminTaskRunLearningPolicyRequestSchema,
  AdminTaskRunLearningPolicyResponseSchema,
  decodeAbi,
  encodeAbi,
  LearningSettingsUpdateRequestSchema,
  ProfileOperationResponseSchema,
  type LearningSettings,
} from "@tagent/abi";
import type { ProfileMutationResult } from "@tagent/admission/ports";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { arrayCount, runAdminProfileOperation } from "./admin-profile-support.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  profileMutationContext,
  profileMutationHeaders,
  profileMutationValue,
  setRevisionEtag,
} from "./profile-route-support.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapSettings(state: Record<string, unknown>, memoryAvailable: boolean): LearningSettings {
  const updatedAt = Number(state.updatedAt ?? 0);
  return {
    memoryAvailable: Boolean(state.memoryAvailable ?? memoryAvailable),
    memoryEnabled: Boolean(state.memoryEnabled),
    learningEnabled: Boolean(state.learningEnabled),
    autoExecutionEnabled: Boolean(state.autoExecutionEnabled),
    passiveLearningEnabled: Boolean(state.passiveLearningEnabled ?? state.learningEnabled),
    activeExecutionRequiresApproval: true,
    updatedAt: new Date(Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0).toISOString(),
    reason: String(state.reason ?? "learning_control_unavailable").slice(0, 2_000),
  };
}

function settingsState(dependencies: ChannelV1Dependencies): Record<string, unknown> {
  return object(dependencies.learningControl?.snapshot() ?? {
    memoryAvailable: Boolean(dependencies.memory), memoryEnabled: Boolean(dependencies.memory), learningEnabled: false,
    autoExecutionEnabled: false, passiveLearningEnabled: false, updatedAt: 1, reason: "learning_control_unavailable",
  });
}

export function registerAdminLearningProfileV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "admin:learning:read", "admin");
  const write = authorizeProfile(dependencies, "admin:learning:write", "admin");

  app.get("/api/v1/admin/profiles/learning/settings", { onRequest: read }, async (request, reply) => {
    const state = settingsState(dependencies);
    const resourceRevision = dependencies.persistence.profileContracts.getProfileResourceRevision(
      "admin.learning.v1", "learning_settings", "global",
    );
    setRevisionEtag(reply, resourceRevision);
    return encodeAbi(AdminLearningSettingsResponseSchema, successEnvelope(request, {
      settings: mapSettings(state, Boolean(dependencies.memory)), resourceRevision,
    }));
  });

  app.patch("/api/v1/admin/profiles/learning/settings", {
    onRequest: write,
    schema: { body: LearningSettingsUpdateRequestSchema },
  }, async (request, reply) => {
    if (!dependencies.learningControl) {
      throw new V1HttpError(503, "learning.control_unavailable", "Learning feature control is unavailable", "unavailable", true);
    }
    const body = decodeAbi(LearningSettingsUpdateRequestSchema, request.body);
    const operation = await runAdminProfileOperation(request, reply, dependencies, {
      profileId: "admin.learning.v1", endpointId: "admin.learning.settings.update",
      resourceType: "learning_settings", resourceId: "global", operation: "update", payload: body,
      effect: async () => {
        const state = object(await dependencies.service.updateLearningSettings(body));
        const resourceRevision = dependencies.persistence.profileContracts.bumpProfileResourceRevision(
          "admin.learning.v1", "learning_settings", "global",
        );
        return { resourceRevision, updatedAt: String(state.updatedAt ?? "") };
      },
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });

  app.get("/api/v1/admin/profiles/learning/sessions/:sessionId", {
    onRequest: read,
    schema: { params: AdminLearningSessionParamsSchema },
  }, async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    assertProfileResourceScope(request, "session", sessionId);
    if (!dependencies.persistence.sessions.getSession(sessionId)) {
      throw new V1HttpError(404, "resource.not_found", "Session not found", "not_found");
    }
    const center = object(dependencies.service.getLearningCenter(sessionId));
    const feature = object(center.featureState);
    return encodeAbi(AdminLearningCenterResponseSchema, successEnvelope(request, { center: {
      sessionId,
      counts: {
        workflows: arrayCount(center.workflows), bindings: arrayCount(center.bindings), feedback: arrayCount(center.feedback),
        proposals: arrayCount(center.proposals), policies: arrayCount(center.learningPolicies),
        evaluations: arrayCount(center.evaluations), approvals: arrayCount(center.approvals),
      },
      memoryEnabled: Boolean(feature.memoryEnabled), learningEnabled: Boolean(feature.learningEnabled),
      autoExecutionEnabled: Boolean(feature.autoExecutionEnabled),
    } }));
  });

  app.put("/api/v1/admin/profiles/learning/task-runs/:taskRunId/policy", {
    onRequest: write,
    schema: { params: AdminLearningTaskRunParamsSchema, body: AdminTaskRunLearningPolicyRequestSchema },
  }, async (request, reply) => {
    const { taskRunId } = request.params as { taskRunId: string };
    const sessionId = dependencies.persistence.profileContracts.getTaskRunSessionId(taskRunId);
    if (!sessionId) throw new V1HttpError(404, "resource.not_found", "TaskRun not found", "not_found");
    assertProfileResourceScope(request, "session", sessionId);
    const body = decodeAbi(AdminTaskRunLearningPolicyRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    type Policy = { taskRunId: string; policy: "allow" | "metadata_only" | "deny"; reason: string; resourceRevision: number };
    const mutation = dependencies.persistence.profileContracts.runSynchronousMutation<Policy>({
      profileId: "admin.learning.v1", endpointId: "admin.learning.policy.update", resourceType: "task_run",
      resourceId: taskRunId, operation: "update_policy", mutation: profileMutationContext(request, headers, body),
      readRevision: () => dependencies.persistence.profileContracts.getProfileResourceRevision(
        "admin.learning.v1", "task_run_policy", taskRunId,
      ),
      perform: () => {
        const updated = object(dependencies.service.setRunLearningPolicy(taskRunId, body.policy, body.reason));
        const resourceRevision = dependencies.persistence.profileContracts.bumpProfileResourceRevision(
          "admin.learning.v1", "task_run_policy", taskRunId,
        );
        const value: Policy = { taskRunId, policy: body.policy, reason: String(updated.reason ?? body.reason).slice(0, 2_000),
          resourceRevision };
        return { value, resultingRevision: value.resourceRevision };
      },
    }) as ProfileMutationResult<Policy>;
    const result = profileMutationValue(mutation);
    setRevisionEtag(reply, result.value.resourceRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(AdminTaskRunLearningPolicyResponseSchema, successEnvelope(request, result.value));
  });
}
