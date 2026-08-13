import type { AttemptRequestEnvelope } from "../domain/attempt-request-envelope.js";
export { createAttemptRequestEnvelope, requestHash } from "../domain/attempt-request-envelope.js";
export type { AttemptRequestEnvelope } from "../domain/attempt-request-envelope.js";

export interface AttemptRequestEnvelopeRepository {
  record(envelope: AttemptRequestEnvelope): AttemptRequestEnvelope;
  get(id: string): AttemptRequestEnvelope | undefined;
  listForAttempt(attemptId: string): AttemptRequestEnvelope[];
}
