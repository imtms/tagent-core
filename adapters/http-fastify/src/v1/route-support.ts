import type { FastifyRequest } from "fastify";
import type { ServiceCredential, ServiceScope } from "../auth.js";
import { authorizeV1 } from "./auth.js";
import { V1HttpError } from "./errors.js";

export function authorizeChannel(credentials: ServiceCredential[], scope: ServiceScope) {
  return async (request: FastifyRequest): Promise<void> => authorizeV1(request, credentials, scope, "channel");
}

export function missing(resource: "session" | "submission" | "task_run" | "artifact"): V1HttpError {
  return new V1HttpError(404, `${resource}.not_found`, `${resource.replace("_", " ")} not found`, "not_found");
}

export function conflict(code: string, message: string, details: Record<string, unknown> = {}): V1HttpError {
  return new V1HttpError(409, code, message, "conflict", false, details);
}
