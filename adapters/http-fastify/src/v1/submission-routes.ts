import type { FastifyInstance } from "fastify";
import {
  canonicalizeSubmissionRequest,
  decodeAbi,
  encodeAbi,
  normalizeSubmissionRequest,
  SessionCreateRequestSchema,
  SessionSchema,
  SessionParamsSchema,
  SubmissionCreateHeadersSchema,
  SubmissionCreateRequestSchema,
  SubmissionLookupParamsSchema,
  SubmissionResponseSchema,
  type SessionParams,
  type SubmissionLookupParams,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { mapSession, mapSubmissionReceipt } from "./mappers.js";
import { authorizeChannel, conflict, missing } from "./route-support.js";

function isOpaqueAutomationMarker(content: string): boolean {
  return /^(?:(?:final-)?ui-sync|release)-[a-z0-9._-]*\d{10,}$/i.test(content) && !/[\s：:，,。.!?？]/.test(content);
}

export function registerSubmissionV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const { persistence, service, serviceCredentials } = dependencies;
  const { sessions, submissions } = persistence;

  app.post("/api/v1/sessions", {
    onRequest: authorizeChannel(serviceCredentials, "sessions:write"),
    schema: { body: SessionCreateRequestSchema },
  }, async (request) => {
    const body = decodeAbi(SessionCreateRequestSchema, request.body);
    const session = sessions.createSession(body.title?.trim() || "New workspace");
    return successEnvelope(request, encodeAbi(SessionSchema, mapSession(session)));
  });

  app.post("/api/v1/sessions/:sessionId/submissions", {
    onRequest: authorizeChannel(serviceCredentials, "sessions:write"),
    schema: { params: SessionParamsSchema, headers: SubmissionCreateHeadersSchema, body: SubmissionCreateRequestSchema },
  }, async (request) => {
    const { sessionId } = request.params as SessionParams;
    if (!sessions.getSession(sessionId)) throw missing("session");
    const headers = decodeAbi(SubmissionCreateHeadersSchema, request.headers);
    const body = normalizeSubmissionRequest(decodeAbi(SubmissionCreateRequestSchema, request.body));
    if (!body.content) throw new V1HttpError(400, "submission.invalid", "Submission content is required", "validation");
    if (isOpaqueAutomationMarker(body.content)) {
      throw new V1HttpError(422, "submission.non_actionable", "Opaque automation marker is not an executable task", "validation", false, { reason: "non_actionable_prompt" });
    }
    const idempotencyKey = headers["idempotency-key"];
    const canonicalPayload = canonicalizeSubmissionRequest(body);
    const existing = submissions.getSessionSubmission(sessionId, idempotencyKey);
    if (existing && canonicalizeSubmissionRequest({ content: existing.content }) !== canonicalPayload) {
      throw conflict("submission.idempotency_conflict", "Idempotency-Key was already used with a different payload", { idempotencyKey });
    }
    const result = await service.enqueueSessionInput(sessionId, body.content, idempotencyKey);
    if (canonicalizeSubmissionRequest({ content: result.item.content }) !== canonicalPayload) {
      throw conflict("submission.idempotency_conflict", "Idempotency-Key was already used with a different payload", { idempotencyKey });
    }
    return encodeAbi(
      SubmissionResponseSchema,
      successEnvelope(request, { receipt: mapSubmissionReceipt(result.item) }),
    );
  });

  app.get("/api/v1/sessions/:sessionId/submissions/:idempotencyKey", {
    onRequest: authorizeChannel(serviceCredentials, "sessions:read"),
    schema: { params: SubmissionLookupParamsSchema },
  }, async (request) => {
    const { sessionId, idempotencyKey } = request.params as SubmissionLookupParams;
    if (!sessions.getSession(sessionId)) throw missing("session");
    const item = submissions.getSessionSubmission(sessionId, idempotencyKey);
    if (!item) throw missing("submission");
    return encodeAbi(
      SubmissionResponseSchema,
      successEnvelope(request, { receipt: mapSubmissionReceipt(item) }),
    );
  });
}
