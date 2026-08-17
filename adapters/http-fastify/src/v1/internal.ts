import type { FastifyInstance, FastifyRequest } from "fastify";
import { authorizeV1 } from "./auth.js";
import type { V1ApiDependencies } from "./dependencies.js";
import { V1HttpError } from "./errors.js";

export function registerInternalV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const authorize = async (request: FastifyRequest): Promise<void> => {
    authorizeV1(request, dependencies.serviceCredentials, "internal", "internal");
  };

  app.all("/api/v1/internal/*", { onRequest: authorize }, async () => {
    throw new V1HttpError(404, "route.not_found", "Internal v1 route not found", "not_found", false, { surface: "internal" });
  });
}
