import type { FastifyInstance } from "fastify";
import {
  canonicalJson,
  encodeAbi,
  OperatorInboxItemParamsSchema,
  OperatorInboxRetryParamsSchema,
  ProfileOperationResponseSchema,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { principalOf } from "./auth.js";
import { requestIdOf, successEnvelope, V1HttpError } from "./errors.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  mapProfileOperationReceipt,
  profileOperationHeaders,
} from "./profile-route-support.js";

export function registerOperatorInboxOperationV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "operator:inbox:read", "operator");
  const control = authorizeProfile(dependencies, "operator:inbox:control", "operator");

  app.post("/api/v1/operator/sessions/:sessionId/inbox/:itemId/start", {
    onRequest: control,
    schema: { params: OperatorInboxItemParamsSchema },
  }, async (request, reply) => {
    const { sessionId, itemId } = request.params as { sessionId: string; itemId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const headers = profileOperationHeaders(request);
    const principal = principalOf(request);
    const identity = {
      principalId: principal.subjectId,
      profileId: "operator.session-inbox.v1",
      endpointId: "operator.session_inbox.start",
      resourceType: "session_inbox_item",
      resourceId: itemId,
      idempotencyKey: headers["idempotency-key"],
    };
    let claim;
    try {
      claim = dependencies.persistence.profileContracts.claimOperation({
        ...identity,
        canonicalPayload: canonicalJson({ sessionId, itemId }),
        delegatedActorId: headers["x-tagent-delegated-actor"],
        delegatedRequestId: headers["x-tagent-delegated-request-id"],
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("idempotency conflict")) {
        throw new V1HttpError(409, "idempotency.conflict", "Idempotency key is bound to a different canonical request", "conflict");
      }
      throw error;
    }
    let receipt = claim.receipt;
    if (claim.claimed) {
      try {
        const outcome = dependencies.service.startSessionInputNow(sessionId, itemId);
        receipt = outcome.status === "started"
          ? dependencies.persistence.profileContracts.settleOperation(identity, "succeeded", {
            itemId,
            taskRunId: outcome.run.id,
          })
          : dependencies.persistence.profileContracts.settleOperation(identity, "failed", {}, {
            code: "resource.state_conflict",
            status: outcome.status,
          });
      } catch {
        receipt = dependencies.persistence.profileContracts.settleOperation(identity, "outcome_unknown", {}, {
          code: "operation.outcome_unknown",
        });
      }
      dependencies.persistence.profileContracts.recordAudit({
        principalId: principal.subjectId,
        grantedScopes: principal.grantedScopes,
        delegatedActorId: headers["x-tagent-delegated-actor"],
        delegatedRequestId: headers["x-tagent-delegated-request-id"],
        requestId: requestIdOf(request),
        profileId: identity.profileId,
        endpointId: identity.endpointId,
        resourceType: identity.resourceType,
        resourceId: identity.resourceId,
        operation: "start",
        outcome: receipt.status === "succeeded" ? "succeeded" : receipt.status === "failed" ? "failed" : "outcome_unknown",
        errorCode: typeof receipt.error?.code === "string" ? receipt.error.code : undefined,
      });
    } else {
      reply.header("Idempotency-Replayed", "true");
    }
    if (receipt.status === "started") reply.code(202);
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation: mapProfileOperationReceipt(receipt) }));
  });

  app.post("/api/v1/operator/task-runs/:taskRunId/retry-launch", {
    onRequest: control,
    schema: { params: OperatorInboxRetryParamsSchema },
  }, async (request, reply) => {
    const { taskRunId } = request.params as { taskRunId: string };
    const sessionId = dependencies.persistence.profileContracts.getTaskRunSessionId(taskRunId);
    if (!sessionId) throw new V1HttpError(404, "resource.not_found", "TaskRun not found", "not_found");
    assertProfileResourceScope(request, "session", sessionId);
    const headers = profileOperationHeaders(request);
    const principal = principalOf(request);
    const identity = {
      principalId: principal.subjectId,
      profileId: "operator.session-inbox.v1",
      endpointId: "operator.session_inbox.retry_launch",
      resourceType: "task_run",
      resourceId: taskRunId,
      idempotencyKey: headers["idempotency-key"],
    };
    let claim;
    try {
      claim = dependencies.persistence.profileContracts.claimOperation({
        ...identity,
        canonicalPayload: canonicalJson({ taskRunId }),
        delegatedActorId: headers["x-tagent-delegated-actor"],
        delegatedRequestId: headers["x-tagent-delegated-request-id"],
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("idempotency conflict")) {
        throw new V1HttpError(409, "idempotency.conflict", "Idempotency key is bound to a different canonical request", "conflict");
      }
      throw error;
    }
    let receipt = claim.receipt;
    if (claim.claimed) {
      try {
        const outcome = dependencies.service.retryInboxLaunch(taskRunId);
        receipt = outcome.status === "started"
          ? dependencies.persistence.profileContracts.settleOperation(identity, "succeeded", { taskRunId })
          : dependencies.persistence.profileContracts.settleOperation(identity, "failed", {}, {
            code: "resource.state_conflict",
            status: outcome.status,
          });
      } catch {
        receipt = dependencies.persistence.profileContracts.settleOperation(identity, "outcome_unknown", {}, {
          code: "operation.outcome_unknown",
        });
      }
      dependencies.persistence.profileContracts.recordAudit({
        principalId: principal.subjectId,
        grantedScopes: principal.grantedScopes,
        delegatedActorId: headers["x-tagent-delegated-actor"],
        delegatedRequestId: headers["x-tagent-delegated-request-id"],
        requestId: requestIdOf(request),
        profileId: identity.profileId,
        endpointId: identity.endpointId,
        resourceType: identity.resourceType,
        resourceId: identity.resourceId,
        operation: "retry_launch",
        outcome: receipt.status === "succeeded" ? "succeeded" : receipt.status === "failed" ? "failed" : "outcome_unknown",
        errorCode: typeof receipt.error?.code === "string" ? receipt.error.code : undefined,
      });
    } else {
      reply.header("Idempotency-Replayed", "true");
    }
    if (receipt.status === "started") reply.code(202);
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation: mapProfileOperationReceipt(receipt) }));
  });

  app.get("/api/v1/operator/operations/:requestId", { onRequest: read }, async (request) => {
    const { requestId } = request.params as { requestId: string };
    const principal = principalOf(request);
    const receipts = dependencies.persistence.profileContracts.findOperations(principal.subjectId, requestId, "operator.");
    if (!receipts.length) throw new V1HttpError(404, "resource.not_found", "Operation not found", "not_found");
    if (receipts.length > 1) {
      throw new V1HttpError(409, "operation.identity_ambiguous", "Operation identity is ambiguous", "conflict");
    }
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, {
      operation: mapProfileOperationReceipt(receipts[0]),
    }));
  });
}
