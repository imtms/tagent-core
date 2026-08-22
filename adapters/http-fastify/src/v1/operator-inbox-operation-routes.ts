import type { FastifyInstance } from "fastify";
import {
  encodeAbi,
  OperatorInboxItemParamsSchema,
  OperatorInboxRetryParamsSchema,
  ProfileOperationResponseSchema,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { principalOf } from "./auth.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  mapProfileOperationReceipt,
} from "./profile-route-support.js";
import { runProfileOperation } from "./profile-operation-support.js";

export function registerOperatorInboxOperationV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "operator:inbox:read", "operator");
  const control = authorizeProfile(dependencies, "operator:inbox:control", "operator");

  app.post("/api/v1/operator/sessions/:sessionId/inbox/:itemId/start", {
    onRequest: control,
    schema: { params: OperatorInboxItemParamsSchema },
  }, async (request, reply) => {
    const { sessionId, itemId } = request.params as { sessionId: string; itemId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const operation = await runProfileOperation(request, reply, dependencies, {
      profileId: "operator.session-inbox.v1",
      endpointId: "operator.session_inbox.start",
      resourceType: "session_inbox_item",
      resourceId: itemId,
      operation: "start",
      payload: { sessionId, itemId },
      effect: () => {
        const outcome = dependencies.service.startSessionInputNow(sessionId, itemId);
        return outcome.status === "started"
          ? { status: "succeeded", result: { itemId, taskRunId: outcome.run.id } }
          : { status: "failed", error: { code: "resource.state_conflict", status: outcome.status } };
      },
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });

  app.post("/api/v1/operator/task-runs/:taskRunId/retry-launch", {
    onRequest: control,
    schema: { params: OperatorInboxRetryParamsSchema },
  }, async (request, reply) => {
    const { taskRunId } = request.params as { taskRunId: string };
    const sessionId = dependencies.persistence.profileContracts.getTaskRunSessionId(taskRunId);
    if (!sessionId) throw new V1HttpError(404, "resource.not_found", "TaskRun not found", "not_found");
    assertProfileResourceScope(request, "session", sessionId);
    const operation = await runProfileOperation(request, reply, dependencies, {
      profileId: "operator.session-inbox.v1",
      endpointId: "operator.session_inbox.retry_launch",
      resourceType: "task_run",
      resourceId: taskRunId,
      operation: "retry_launch",
      payload: { taskRunId },
      effect: () => {
        const outcome = dependencies.service.retryInboxLaunch(taskRunId);
        return outcome.status === "started"
          ? { status: "succeeded", result: { taskRunId } }
          : { status: "failed", error: { code: "resource.state_conflict", status: outcome.status } };
      },
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
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
