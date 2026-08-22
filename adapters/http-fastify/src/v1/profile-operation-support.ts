import type { FastifyReply, FastifyRequest } from "fastify";
import { canonicalJson } from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { principalOf } from "./auth.js";
import { requestIdOf, V1HttpError } from "./errors.js";
import { mapProfileOperationReceipt, profileOperationHeaders } from "./profile-route-support.js";

type ProfileOperationOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "failed"; error: Record<string, unknown> };

export async function runProfileOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ChannelV1Dependencies,
  input: {
    profileId: string;
    endpointId: string;
    resourceType: string;
    resourceId: string;
    operation: string;
    payload: unknown;
    effect(): Promise<ProfileOperationOutcome> | ProfileOperationOutcome;
    exposeUnknownErrorMessage?: boolean;
    acceptUnknownOutcome?: boolean;
  },
) {
  const headers = profileOperationHeaders(request);
  const principal = principalOf(request);
  const identity = {
    principalId: principal.subjectId,
    profileId: input.profileId,
    endpointId: input.endpointId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    idempotencyKey: headers["idempotency-key"],
  };
  let claim;
  try {
    claim = dependencies.persistence.profileContracts.claimOperation({
      ...identity,
      canonicalPayload: canonicalJson(input.payload),
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
      const outcome = await input.effect();
      receipt = outcome.status === "succeeded"
        ? dependencies.persistence.profileContracts.settleOperation(identity, "succeeded", outcome.result)
        : dependencies.persistence.profileContracts.settleOperation(identity, "failed", {}, outcome.error);
    } catch (error) {
      receipt = dependencies.persistence.profileContracts.settleOperation(identity, "outcome_unknown", {}, {
        code: "operation.outcome_unknown",
        ...(input.exposeUnknownErrorMessage
          ? { message: error instanceof Error ? error.message.slice(0, 500) : "Operation outcome is unknown" }
          : {}),
      });
    }
    dependencies.persistence.profileContracts.recordAudit({
      principalId: principal.subjectId,
      grantedScopes: principal.grantedScopes,
      delegatedActorId: headers["x-tagent-delegated-actor"],
      delegatedRequestId: headers["x-tagent-delegated-request-id"],
      requestId: requestIdOf(request),
      profileId: input.profileId,
      endpointId: input.endpointId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      operation: input.operation,
      outcome: receipt.status === "succeeded" ? "succeeded" : receipt.status === "failed" ? "failed" : "outcome_unknown",
      errorCode: typeof receipt.error?.code === "string" ? receipt.error.code : undefined,
    });
  } else {
    reply.header("Idempotency-Replayed", "true");
  }
  if (receipt.status === "started" || (input.acceptUnknownOutcome && receipt.status === "outcome_unknown")) reply.code(202);
  return mapProfileOperationReceipt(receipt);
}

export async function runAdminProfileOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ChannelV1Dependencies,
  input: {
    profileId: "admin.memory.v1";
    endpointId: string;
    resourceType: string;
    resourceId: string;
    operation: string;
    payload: unknown;
    effect(): Promise<Record<string, unknown>> | Record<string, unknown>;
  },
) {
  return runProfileOperation(request, reply, dependencies, {
    ...input,
    effect: async () => ({ status: "succeeded", result: await input.effect() }),
    exposeUnknownErrorMessage: true,
    acceptUnknownOutcome: true,
  });
}

export function profileRevision(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}
