import type { FastifyInstance } from "fastify";
import { encodeAbi, ProfileOperationResponseSchema } from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { principalOf } from "./auth.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { mapProfileOperationReceipt } from "./profile-route-support.js";
import { authorizeProfile } from "./profile-route-support.js";

export function registerAdminOperationV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const authorize = authorizeProfile(dependencies, "admin:operations:read", "admin");
  app.get("/api/v1/admin/operations/:requestId", { onRequest: authorize }, async (request) => {
    const { requestId } = request.params as { requestId: string };
    const receipts = dependencies.persistence.profileContracts.findOperations(principalOf(request).subjectId, requestId, "admin.");
    if (!receipts.length) throw new V1HttpError(404, "resource.not_found", "Operation receipt not found", "not_found");
    if (receipts.length > 1) throw new V1HttpError(409, "operation.request_id_ambiguous", "Operation request ID is ambiguous", "conflict");
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation: mapProfileOperationReceipt(receipts[0]) }));
  });
}
