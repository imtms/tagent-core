import type { FastifyInstance } from "fastify";
import {
  AdminEmptyRequestSchema,
  AdminWorkflowActivateRequestSchema,
  AdminWorkflowActivationRequestSchema,
  AdminWorkflowDeleteRequestSchema,
  AdminWorkflowParamsSchema,
  AdminWorkflowResponseSchema,
  AdminWorkflowsResponseSchema,
  AdminWorkflowSuspendRequestSchema,
  decodeAbi,
  encodeAbi,
  ProfileOperationResponseSchema,
  type AdminWorkflow,
  type AdminWorkflowRevision,
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

function mapRevision(value: unknown): AdminWorkflowRevision | null {
  const revision = object(value);
  if (typeof revision.id !== "string") return null;
  const steps = Array.isArray(revision.steps) ? revision.steps : [];
  const riskClass = ["low", "medium", "high"].includes(String(revision.riskClass)) ? revision.riskClass : "high";
  const confidence = Number(revision.confidence ?? 0);
  return {
    id: revision.id,
    revision: profileRevision(revision.revision),
    name: String(revision.name ?? "Unnamed workflow").slice(0, 300),
    intent: String(revision.intent ?? "unspecified").slice(0, 5_000),
    steps: steps.slice(0, 100).flatMap((candidate) => {
      const step = object(candidate);
      if (typeof step.stepId !== "string" || typeof step.instruction !== "string" || !step.instruction) return [];
      return [{ stepId: step.stepId, instruction: step.instruction.slice(0, 10_000), required: Boolean(step.required) }];
    }),
    requiredCapabilities: (Array.isArray(revision.requiredCapabilities) ? revision.requiredCapabilities : [])
      .map(String).filter(Boolean).slice(0, 100).map((item) => item.slice(0, 300)),
    riskClass: riskClass as AdminWorkflowRevision["riskClass"],
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    createdAt: new Date(Math.max(0, Number(revision.createdAt ?? 0))).toISOString(),
  };
}

function mapWorkflow(value: unknown, managedRevision?: number): AdminWorkflow {
  const workflow = object(value);
  const status = ["candidate", "active", "suspended", "deprecated"].includes(String(workflow.status))
    ? workflow.status : "candidate";
  const updatedAt = Number(workflow.updatedAt ?? 0);
  return {
    id: String(workflow.id),
    scopeId: String(workflow.scopeId),
    status: status as AdminWorkflow["status"],
    activeRevisionId: typeof workflow.activeRevisionId === "string" && workflow.activeRevisionId ? workflow.activeRevisionId : null,
    deletedAt: workflow.deletedAt === null || workflow.deletedAt === undefined ? null : new Date(Number(workflow.deletedAt)).toISOString(),
    purgeAfter: workflow.purgeAfter === null || workflow.purgeAfter === undefined ? null : new Date(Number(workflow.purgeAfter)).toISOString(),
    resourceRevision: managedRevision ?? profileRevision(updatedAt),
    revision: mapRevision(workflow.revision),
    createdAt: new Date(Math.max(0, Number(workflow.createdAt ?? 0))).toISOString(),
    updatedAt: new Date(Math.max(0, updatedAt)).toISOString(),
  };
}

function requireWorkflow(dependencies: ChannelV1Dependencies, workflowId: string): Record<string, unknown> {
  const workflow = object(dependencies.service.getWorkflow(workflowId, true));
  if (!workflow.id) throw new V1HttpError(404, "resource.not_found", "Workflow not found", "not_found");
  return workflow;
}

function authorizeWorkflow(request: Parameters<typeof assertProfileResourceScope>[0], workflow: Record<string, unknown>) {
  assertProfileResourceScope(request, "session", String(workflow.scopeId));
}

function workflowConflict(error: unknown): never {
  if (error instanceof V1HttpError) throw error;
  throw new V1HttpError(409, "resource.state_conflict", error instanceof Error ? error.message : String(error), "conflict");
}

export function registerAdminWorkflowProfileV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "admin:workflow:read", "admin");
  const write = authorizeProfile(dependencies, "admin:workflow:write", "admin");

  app.get("/api/v1/admin/profiles/workflows", { onRequest: read }, async (request) => {
    const raw = request.query as { scopeId?: unknown };
    if (typeof raw.scopeId !== "string" || !raw.scopeId || raw.scopeId.length > 256) {
      throw new V1HttpError(400, "request.validation_failed", "scopeId is required", "validation");
    }
    assertProfileResourceScope(request, "session", raw.scopeId);
    const query = profileListQuery(request);
    const limit = query.limit ?? 50;
    const resourceId = `workflows:${raw.scopeId}`;
    const state: { snapshotRowId?: number; after?: { createdAt: number; id: string } } = query.cursor
      ? decodeProfileCursor(query.cursor, { kind: "admin_collection", resourceId }) : {};
    const all = (dependencies.service.listWorkflows(raw.scopeId) as unknown[]).map((item) => {
      const workflow = object(item);
      return mapWorkflow(item, dependencies.persistence.profileContracts.getProfileResourceRevision(
        "admin.workflow.v1", "workflow", String(workflow.id),
      ));
    })
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id));
    const snapshotRowId = state.snapshotRowId ?? Math.max(0, ...all.map((item) => Date.parse(item.updatedAt)));
    const eligible = all.filter((item) => {
      const timestamp = Date.parse(item.updatedAt);
      return timestamp <= snapshotRowId && (!state.after || timestamp < state.after.createdAt
        || timestamp === state.after.createdAt && item.id < state.after.id);
    });
    const items = eligible.slice(0, limit);
    const hasMore = eligible.length > limit;
    const last = items.at(-1);
    return encodeAbi(AdminWorkflowsResponseSchema, successEnvelope(request, { items, pageInfo: {
      nextCursor: hasMore && last ? encodeProfileCursor({ kind: "admin_collection", resourceId, snapshotRowId,
        after: { createdAt: Date.parse(last.updatedAt), id: last.id } }) : null,
      hasMore, limit, snapshot: encodeProfileSnapshot({ kind: "admin_collection", resourceId, snapshotRowId }),
    } }));
  });

  app.post("/api/v1/admin/profiles/workflows/:workflowId/activation-requests", {
    onRequest: write,
    schema: { params: AdminWorkflowParamsSchema, body: AdminWorkflowActivationRequestSchema },
  }, async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const workflow = requireWorkflow(dependencies, workflowId);
    authorizeWorkflow(request, workflow);
    const body = decodeAbi(AdminWorkflowActivationRequestSchema, request.body);
    const principal = principalOf(request);
    const operation = await runAdminProfileOperation(request, reply, dependencies, {
      profileId: "admin.workflow.v1", endpointId: "admin.workflows.activation_request", resourceType: "workflow",
      resourceId: workflowId, operation: "request_activation", payload: { workflowId, ...body },
      effect: () => {
        const approval = object(dependencies.service.requestWorkflowActivation(
          workflowId, body.revisionId, principal.subjectId, body.reason,
        ));
        return { approvalId: String(approval.id ?? ""), status: String(approval.status ?? "pending") };
      },
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });

  const mutate = async (request: Parameters<typeof profileMutationHeaders>[0], reply: Parameters<typeof setRevisionEtag>[0], input: {
    endpointId: string; operation: string; bodySchema: typeof AdminWorkflowActivateRequestSchema | typeof AdminWorkflowSuspendRequestSchema
      | typeof AdminWorkflowDeleteRequestSchema | typeof AdminEmptyRequestSchema;
    effect(workflowId: string, body: Record<string, unknown>): void;
  }) => {
    const { workflowId } = request.params as { workflowId: string };
    const workflow = requireWorkflow(dependencies, workflowId);
    authorizeWorkflow(request, workflow);
    const body = decodeAbi(input.bodySchema as never, request.body ?? {}) as Record<string, unknown>;
    const headers = profileMutationHeaders(request);
    try {
      const mutation = dependencies.persistence.profileContracts.runSynchronousMutation<AdminWorkflow>({
        profileId: "admin.workflow.v1", endpointId: input.endpointId, resourceType: "workflow", resourceId: workflowId,
        operation: input.operation, mutation: profileMutationContext(request, headers, body),
        readRevision: () => dependencies.persistence.profileContracts.getProfileResourceRevision(
          "admin.workflow.v1", "workflow", workflowId,
        ),
        perform: () => {
          input.effect(workflowId, body);
          const revision = dependencies.persistence.profileContracts.bumpProfileResourceRevision(
            "admin.workflow.v1", "workflow", workflowId,
          );
          const value = mapWorkflow(requireWorkflow(dependencies, workflowId), revision);
          return { value, resultingRevision: value.resourceRevision };
        },
      }) as ProfileMutationResult<AdminWorkflow>;
      const result = profileMutationValue(mutation);
      setRevisionEtag(reply, result.value.resourceRevision);
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return encodeAbi(AdminWorkflowResponseSchema, successEnvelope(request, { workflow: result.value }));
    } catch (error) { return workflowConflict(error); }
  };

  app.post("/api/v1/admin/profiles/workflows/:workflowId/activate", {
    onRequest: write, schema: { params: AdminWorkflowParamsSchema, body: AdminWorkflowActivateRequestSchema },
  }, (request, reply) => mutate(request, reply, {
    endpointId: "admin.workflows.activate", operation: "activate", bodySchema: AdminWorkflowActivateRequestSchema,
    effect: (workflowId, body) => { dependencies.service.activateWorkflow(workflowId, body.revisionId as string | undefined, String(body.approvalId)); },
  }));

  app.post("/api/v1/admin/profiles/workflows/:workflowId/suspend", {
    onRequest: write, schema: { params: AdminWorkflowParamsSchema, body: AdminWorkflowSuspendRequestSchema },
  }, (request, reply) => mutate(request, reply, {
    endpointId: "admin.workflows.suspend", operation: "suspend", bodySchema: AdminWorkflowSuspendRequestSchema,
    effect: (workflowId, body) => { dependencies.service.suspendWorkflow(workflowId, String(body.reason)); },
  }));

  app.delete("/api/v1/admin/profiles/workflows/:workflowId", {
    onRequest: write, schema: { params: AdminWorkflowParamsSchema, body: AdminWorkflowDeleteRequestSchema },
  }, (request, reply) => mutate(request, reply, {
    endpointId: "admin.workflows.delete", operation: "delete", bodySchema: AdminWorkflowDeleteRequestSchema,
    effect: (workflowId, body) => {
      const ok = dependencies.service.forgetWorkflow(workflowId, String(body.reason), body.gracePeriodMs as number | undefined);
      if (!ok) throw new Error("Workflow not found");
    },
  }));

  app.post("/api/v1/admin/profiles/workflows/:workflowId/restore", {
    onRequest: write, schema: { params: AdminWorkflowParamsSchema, body: AdminEmptyRequestSchema },
  }, (request, reply) => mutate(request, reply, {
    endpointId: "admin.workflows.restore", operation: "restore", bodySchema: AdminEmptyRequestSchema,
    effect: (workflowId) => { dependencies.service.restoreWorkflow(workflowId); },
  }));
}
