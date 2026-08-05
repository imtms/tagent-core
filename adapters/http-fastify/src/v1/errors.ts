import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  encodeAbi,
  ErrorEnvelopeSchema,
  SuccessEnvelopeSchema,
  type ErrorCategory,
  type ErrorEnvelope,
  type SuccessEnvelope,
} from "@tagent/abi";

export class V1HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly category: ErrorCategory,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const requestIds = new WeakMap<FastifyRequest, string>();
const validRequestId = /^[A-Za-z0-9._:-]{1,128}$/;

export function ensureRequestId(request: FastifyRequest, reply: FastifyReply): string {
  const supplied = request.headers["x-request-id"];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  const requestId = typeof candidate === "string" && validRequestId.test(candidate) ? candidate : randomUUID();
  requestIds.set(request, requestId);
  reply.header("X-Request-Id", requestId);
  return requestId;
}

export function requestIdOf(request: FastifyRequest): string {
  return requestIds.get(request) ?? randomUUID();
}

export function successEnvelope<T>(request: FastifyRequest, data: T): SuccessEnvelope & { data: T } {
  return encodeAbi(SuccessEnvelopeSchema, { data, requestId: requestIdOf(request) }) as SuccessEnvelope & { data: T };
}

export function errorEnvelope(request: FastifyRequest, error: V1HttpError): ErrorEnvelope {
  return encodeAbi(ErrorEnvelopeSchema, {
    error: {
      code: error.code,
      message: error.message,
      requestId: requestIdOf(request),
      retryable: error.retryable,
      details: error.details,
    },
  });
}

export function asV1HttpError(error: unknown): V1HttpError {
  if (error instanceof V1HttpError) return error;
  const candidate = error as { validation?: unknown; statusCode?: number; message?: string };
  if (candidate?.validation || candidate?.statusCode === 400) {
    return new V1HttpError(400, "request.validation_failed", candidate.message ?? "Request validation failed", "validation", false, { validation: candidate.validation ?? [] });
  }
  return new V1HttpError(500, "internal.error", "Internal server error", "internal", true);
}
