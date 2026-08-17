import type { FastifyPluginAsync } from "fastify";
import { decodeAbi } from "@tagent/abi";
import { asV1HttpError, ensureRequestId, errorEnvelope, V1HttpError } from "./errors.js";
import { registerChannelV1Routes } from "./channel.js";
import type { V1ApiDependencies } from "./dependencies.js";
import { registerAdminV1Routes } from "./admin.js";
import { registerInternalV1Routes } from "./internal.js";
import { registerPublicV1Routes } from "./public.js";

export type { V1ApiDependencies } from "./dependencies.js";

export const v1ApiPlugin: FastifyPluginAsync<V1ApiDependencies> = async (app, dependencies): Promise<void> => {
  app.addHook("onRequest", async (request, reply): Promise<void> => {
    ensureRequestId(request, reply);
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (dependencies.writerReadiness && !dependencies.writerReadiness.isWriterReady()) {
      throw new V1HttpError(503, "writer.not_ready", "Core writer is not ready", "unavailable", true);
    }
  });
  app.setValidatorCompiler(({ schema }) => (input) => {
    try { return { value: decodeAbi(schema as never, input) }; }
    catch (error) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = asV1HttpError(error);
    return reply.code(mapped.statusCode).send(errorEnvelope(request, mapped));
  });
  app.setNotFoundHandler((request, reply) => {
    const error = new V1HttpError(404, "route.not_found", "v1 route not found", "not_found", false, { method: request.method, path: request.url.split("?")[0] });
    return reply.code(error.statusCode).send(errorEnvelope(request, error));
  });

  await registerChannelV1Routes(app, dependencies);
  registerAdminV1Routes(app, dependencies);
  registerInternalV1Routes(app, dependencies);
  registerPublicV1Routes(app, dependencies);
};
