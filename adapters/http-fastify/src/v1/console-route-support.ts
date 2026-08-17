import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServiceScope } from "../auth.js";
import type { HttpMemoryAccess, HttpMemoryScope } from "../ports/index.js";
import { authorizeV1, principalOf } from "./auth.js";
import type { V1ApiDependencies } from "./dependencies.js";
import { V1HttpError } from "./errors.js";

export function authorizeConsole(dependencies: V1ApiDependencies, scope: ServiceScope, surface: "channel" | "admin" = "channel") {
  return async (request: FastifyRequest): Promise<void> => authorizeV1(request, dependencies.serviceCredentials, scope, surface);
}

export function consoleError(status: number, code: string, message: string): V1HttpError {
  const category = status === 404 ? "not_found"
    : status === 409 ? "conflict"
    : status === 429 ? "rate_limited"
    : status >= 500 ? "unavailable"
    : "validation";
  return new V1HttpError(status, code, message, category, status >= 500);
}

export async function withRequestAbortSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("HTTP request was aborted"));
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
}

export function memoryAccess(
  request: FastifyRequest,
  scopes: HttpMemoryScope[],
  purpose: HttpMemoryAccess["purpose"],
): HttpMemoryAccess {
  const principal = principalOf(request);
  if (!principal.localAdmin) {
    const allowed = new Set(principal.resourceScopes.map((scope) => `${scope.type}:${scope.id}`));
    if (scopes.some((scope) => !allowed.has(`${scope.type}:${scope.id}`))) {
      throw new V1HttpError(403, "auth.resource_scope_denied", "Memory resource scope is not authorized", "permission_denied");
    }
  }
  return { subjectId: principal.subjectId, scopes, purpose };
}
