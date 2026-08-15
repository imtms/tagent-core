import type { FastifyInstance } from "fastify";
import {
  AdminAutonomyApprovalResponseSchema,
  AdminAutonomyApprovalsResponseSchema,
  AdminAutonomyDecisionRequestSchema,
  AdminAutonomyParamsSchema,
  AdminAutonomyRevokeRequestSchema,
  AdminEmptyRequestSchema,
  decodeAbi,
  encodeAbi,
  ProfileOperationResponseSchema,
  type AdminAutonomyApproval,
} from "@tagent/abi";
import type { ProfileMutationResult } from "@tagent/admission/ports";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { principalOf } from "./auth.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { decodeProfileCursor, encodeProfileCursor, encodeProfileSnapshot } from "./profile-cursor.js";
import { profileRevision, runAdminProfileOperation } from "./admin-profile-support.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  profileListQuery,
  profileMutationContext,
  profileMutationHeaders,
  profileMutationValue,
  setRevisionEtag,
} from "./profile-route-support.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapApproval(value: unknown, managedRevision?: number): AdminAutonomyApproval {
  const approval = object(value);
  const status = ["pending", "approved", "rejected", "revoked", "expired", "executed"].includes(String(approval.status))
    ? approval.status : "pending";
  const actionType = ["activate_workflow", "apply_revision", "start_canary", "execute_workflow"].includes(String(approval.actionType))
    ? approval.actionType : "execute_workflow";
  const riskClass = ["low", "medium", "high"].includes(String(approval.riskClass)) ? approval.riskClass : "high";
  const updatedAt = Number(approval.updatedAt ?? approval.createdAt ?? 0);
  const nullableTime = (candidate: unknown) => candidate === null || candidate === undefined ? null : new Date(Number(candidate)).toISOString();
  return {
    id: String(approval.id), scopeId: String(approval.scopeId),
    actionType: actionType as AdminAutonomyApproval["actionType"],
    targetType: String(approval.targetType ?? "unknown").slice(0, 200), targetId: String(approval.targetId),
    status: status as AdminAutonomyApproval["status"], riskClass: riskClass as AdminAutonomyApproval["riskClass"],
    requestedBy: String(approval.requestedBy ?? "system").slice(0, 300),
    requestReason: String(approval.requestReason ?? "").slice(0, 2_000),
    expiresAt: new Date(Math.max(0, Number(approval.expiresAt ?? 0))).toISOString(),
    decidedBy: typeof approval.decidedBy === "string" && approval.decidedBy ? approval.decidedBy.slice(0, 300) : null,
    decisionReason: String(approval.decisionReason ?? "").slice(0, 2_000),
    decidedAt: nullableTime(approval.decidedAt), executedAt: nullableTime(approval.executedAt),
    resourceRevision: managedRevision ?? profileRevision(updatedAt),
    createdAt: new Date(Math.max(0, Number(approval.createdAt ?? 0))).toISOString(),
    updatedAt: new Date(Math.max(0, updatedAt)).toISOString(),
  };
}

function requireApproval(dependencies: ChannelV1Dependencies, approvalId: string): Record<string, unknown> {
  const approval = object(dependencies.service.getAutonomyApproval(approvalId));
  if (!approval.id) throw new V1HttpError(404, "resource.not_found", "Autonomy approval not found", "not_found");
  return approval;
}

function approvalConflict(error: unknown): never {
  if (error instanceof V1HttpError) throw error;
  throw new V1HttpError(409, "resource.state_conflict", error instanceof Error ? error.message : String(error), "conflict");
}

export function registerAdminAutonomyProfileV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "admin:autonomy:read", "admin");
  const decide = authorizeProfile(dependencies, "admin:autonomy:decide", "admin");
  const execute = authorizeProfile(dependencies, "admin:autonomy:execute", "admin");

  app.get("/api/v1/admin/profiles/autonomy/approvals", { onRequest: read }, async (request) => {
    const raw = request.query as { scopeId?: unknown };
    if (typeof raw.scopeId !== "string" || !raw.scopeId || raw.scopeId.length > 256) {
      throw new V1HttpError(400, "request.validation_failed", "scopeId is required", "validation");
    }
    assertProfileResourceScope(request, "session", raw.scopeId);
    const query = profileListQuery(request);
    const limit = query.limit ?? 50;
    const resourceId = `autonomy:${raw.scopeId}`;
    const state: { snapshotRowId?: number; after?: { createdAt: number; id: string } } = query.cursor
      ? decodeProfileCursor(query.cursor, { kind: "admin_collection", resourceId }) : {};
    const page = dependencies.service.listAutonomyApprovalsPage(raw.scopeId, {
      snapshotCreatedAt: state.snapshotRowId,
      after: state.after,
      limit: limit + 1,
    });
    const all = (page.items as unknown[]).map((item) => {
      const approval = object(item);
      return mapApproval(item, dependencies.persistence.profileContracts.getProfileResourceRevision(
        "admin.autonomy.v1", "autonomy_approval", String(approval.id),
      ));
    });
    const snapshotRowId = page.snapshotCreatedAt;
    const items = all.slice(0, limit);
    const hasMore = all.length > limit;
    const last = items.at(-1);
    return encodeAbi(AdminAutonomyApprovalsResponseSchema, successEnvelope(request, { items, pageInfo: {
      nextCursor: hasMore && last ? encodeProfileCursor({ kind: "admin_collection", resourceId, snapshotRowId,
        after: { createdAt: Date.parse(last.createdAt), id: last.id } }) : null,
      hasMore, limit, snapshot: encodeProfileSnapshot({ kind: "admin_collection", resourceId, snapshotRowId }),
    } }));
  });

  const mutate = async (request: Parameters<typeof profileMutationHeaders>[0], reply: Parameters<typeof setRevisionEtag>[0], input: {
    endpointId: string; operation: string; effect(approvalId: string, actor: string, body: Record<string, unknown>): unknown;
    bodySchema: typeof AdminAutonomyDecisionRequestSchema | typeof AdminAutonomyRevokeRequestSchema;
  }) => {
    const { approvalId } = request.params as { approvalId: string };
    const approval = requireApproval(dependencies, approvalId);
    assertProfileResourceScope(request, "session", String(approval.scopeId));
    const body = decodeAbi(input.bodySchema as never, request.body) as Record<string, unknown>;
    const headers = profileMutationHeaders(request);
    try {
      const mutation = dependencies.persistence.profileContracts.runSynchronousMutation<AdminAutonomyApproval>({
        profileId: "admin.autonomy.v1", endpointId: input.endpointId, resourceType: "autonomy_approval",
        resourceId: approvalId, operation: input.operation, mutation: profileMutationContext(request, headers, body),
        readRevision: () => dependencies.persistence.profileContracts.getProfileResourceRevision(
          "admin.autonomy.v1", "autonomy_approval", approvalId,
        ),
        perform: () => {
          input.effect(approvalId, principalOf(request).subjectId, body);
          const revision = dependencies.persistence.profileContracts.bumpProfileResourceRevision(
            "admin.autonomy.v1", "autonomy_approval", approvalId,
          );
          const value = mapApproval(requireApproval(dependencies, approvalId), revision);
          return { value, resultingRevision: value.resourceRevision };
        },
      }) as ProfileMutationResult<AdminAutonomyApproval>;
      const result = profileMutationValue(mutation);
      setRevisionEtag(reply, result.value.resourceRevision);
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return encodeAbi(AdminAutonomyApprovalResponseSchema, successEnvelope(request, { approval: result.value }));
    } catch (error) { return approvalConflict(error); }
  };

  app.post("/api/v1/admin/profiles/autonomy/approvals/:approvalId/decision", {
    onRequest: decide, schema: { params: AdminAutonomyParamsSchema, body: AdminAutonomyDecisionRequestSchema },
  }, (request, reply) => mutate(request, reply, {
    endpointId: "admin.autonomy.approvals.decide", operation: "decide", bodySchema: AdminAutonomyDecisionRequestSchema,
    effect: (approvalId, actor, body) => dependencies.service.decideAutonomyApproval(
      approvalId, body.decision as "approved" | "rejected", actor, String(body.reason),
    ),
  }));

  app.post("/api/v1/admin/profiles/autonomy/approvals/:approvalId/revoke", {
    onRequest: decide, schema: { params: AdminAutonomyParamsSchema, body: AdminAutonomyRevokeRequestSchema },
  }, (request, reply) => mutate(request, reply, {
    endpointId: "admin.autonomy.approvals.revoke", operation: "revoke", bodySchema: AdminAutonomyRevokeRequestSchema,
    effect: (approvalId, actor, body) => dependencies.service.revokeAutonomyApproval(approvalId, actor, String(body.reason)),
  }));

  app.post("/api/v1/admin/profiles/autonomy/approvals/:approvalId/execute", {
    onRequest: execute, schema: { params: AdminAutonomyParamsSchema, body: AdminEmptyRequestSchema },
  }, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const approval = requireApproval(dependencies, approvalId);
    assertProfileResourceScope(request, "session", String(approval.scopeId));
    decodeAbi(AdminEmptyRequestSchema, request.body ?? {});
    const operation = await runAdminProfileOperation(request, reply, dependencies, {
      profileId: "admin.autonomy.v1", endpointId: "admin.autonomy.approvals.execute",
      resourceType: "autonomy_approval", resourceId: approvalId, operation: "execute", payload: { approvalId },
      effect: () => {
        dependencies.service.executeAutonomyApproval(approvalId, principalOf(request).subjectId);
        const updated = requireApproval(dependencies, approvalId);
        return { approvalId, status: String(updated.status ?? "executed") };
      },
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });
}
