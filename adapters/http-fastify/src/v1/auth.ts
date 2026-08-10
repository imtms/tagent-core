import type { FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { secureEqual, type ServiceCredential, type ServiceScope } from "../auth.js";
import type { HttpMemoryScope } from "../ports/index.js";
import { V1HttpError } from "./errors.js";

export type V1Surface = "channel" | "operator" | "admin" | "internal";
export type V1RequiredScope = ServiceScope;

export interface V1Principal {
  subjectId: string;
  resourceScopes: HttpMemoryScope[];
  localAdmin: boolean;
}

const principals = new WeakMap<FastifyRequest, V1Principal>();

function credentialPrincipal(credential: ServiceCredential): V1Principal {
  return {
    subjectId: credential.principal?.subjectId
      ?? `service:${createHash("sha256").update(credential.token).digest("hex").slice(0, 24)}`,
    resourceScopes: credential.principal?.resourceScopes.map((scope) => ({ ...scope })) ?? [],
    localAdmin: false,
  };
}

export function principalOf(request: FastifyRequest): V1Principal {
  const principal = principals.get(request);
  if (!principal) {
    throw new V1HttpError(401, "auth.unauthenticated", "Authentication required", "unauthenticated");
  }
  return principal;
}

export function authorizeV1(request: FastifyRequest, credentials: ServiceCredential[], requiredScope: V1RequiredScope, surface: V1Surface): void {
  authorizeV1Scopes(request, credentials, [requiredScope], surface);
}

export function authorizeV1Scopes(
  request: FastifyRequest,
  credentials: ServiceCredential[],
  requiredScopes: readonly V1RequiredScope[],
  surface: V1Surface,
): void {
  if (!credentials.length) {
    principals.set(request, { subjectId: "local-admin", resourceScopes: [], localAdmin: true });
    return;
  }
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new V1HttpError(401, "auth.unauthenticated", "Authentication required", "unauthenticated", false, { surface });
  }
  const token = authorization.slice(7);
  const credential = credentials.find((candidate) => secureEqual(token, candidate.token));
  if (!credential) throw new V1HttpError(401, "auth.unauthenticated", "Authentication required", "unauthenticated", false, { surface });
  const missingScopes = requiredScopes.filter((scope) => !credential.scopes.includes(scope));
  if (missingScopes.length) {
    throw new V1HttpError(403, "auth.permission_denied", "Insufficient service credential scope", "permission_denied", false, {
      surface,
      ...(requiredScopes.length === 1
        ? { requiredScope: requiredScopes[0] }
        : { requiredScopes, missingScopes }),
    });
  }
  principals.set(request, credentialPrincipal(credential));
}
