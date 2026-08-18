import type { FastifyRequest } from "fastify";
import type { ServiceCredential, ServiceScope } from "../auth.js";
import { assertV1ResourceScope, authorizeV1 } from "./auth.js";
import { V1HttpError } from "./errors.js";
import { decodeAbi } from "@tagent/abi";
import type { Static, TSchema } from "typebox";
import type { ChannelV1Dependencies } from "./dependencies.js";

export function authorizeChannel(credentials: ServiceCredential[], scope: ServiceScope) {
  return async (request: FastifyRequest): Promise<void> => authorizeV1(request, credentials, scope, "channel");
}

export function assertChannelSessionScope(request: FastifyRequest, sessionId: string): void {
  assertV1ResourceScope(request, "session", sessionId);
}

export function requireChannelTaskRun(
  request: FastifyRequest,
  taskRuns: ChannelV1Dependencies["persistence"]["taskRuns"],
  taskRunId: string,
) {
  const run = taskRuns.getRunReadView(taskRunId);
  if (!run) throw missing("task_run");
  assertChannelSessionScope(request, run.sessionId);
  return run;
}

export function missing(resource: "session" | "submission" | "task_run" | "command" | "artifact"): V1HttpError {
  return new V1HttpError(404, `${resource}.not_found`, `${resource.replace("_", " ")} not found`, "not_found");
}

export function conflict(code: string, message: string, details: Record<string, unknown> = {}): V1HttpError {
  return new V1HttpError(409, code, message, "conflict", false, details);
}

export function decodeQuery<const Schema extends TSchema>(schema: Schema, input: unknown): Static<Schema> {
  try { return decodeAbi(schema, input); }
  catch (error) {
    throw new V1HttpError(400, "request.validation_failed", "Query parameters are invalid", "validation", false, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
