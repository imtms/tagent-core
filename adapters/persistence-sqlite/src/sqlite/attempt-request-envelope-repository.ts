import type Database from "better-sqlite3";
import { canonicalRequestJson, requestHash, type AttemptRequestEnvelope } from "@tagent/execution/domain";
import type { AttemptRequestEnvelopeRepository } from "@tagent/execution/ports";

interface Row {
  id: string;
  runId: string;
  attemptId: string;
  attempt: number;
  requestOrdinal: number;
  schemaVersion: number;
  envelopeJson: string;
  envelopeHash: string;
  providerPayloadHash: string;
  createdAt: number;
}

function parse(row: Row | undefined): AttemptRequestEnvelope | undefined {
  if (!row) return undefined;
  let envelope: AttemptRequestEnvelope;
  try { envelope = JSON.parse(row.envelopeJson) as AttemptRequestEnvelope; }
  catch (error) { throw new Error(`Attempt request envelope ${row.id} contains invalid durable JSON`, { cause: error }); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(`Attempt request envelope ${row.id} contains an invalid durable envelope`);
  }
  if (envelope.envelopeHash !== row.envelopeHash || envelope.providerPayloadHash !== row.providerPayloadHash
    || requestHash(envelope.providerPayload) !== envelope.providerPayloadHash) {
    throw new Error(`Attempt request envelope ${row.id} failed durable hash verification`);
  }
  const { envelopeHash: _hash, id: _id, ...identity } = envelope;
  if (requestHash(identity) !== envelope.envelopeHash) throw new Error(`Attempt request envelope ${row.id} failed envelope hash verification`);
  if (envelope.id !== row.id || envelope.runId !== row.runId || envelope.attemptId !== row.attemptId
    || envelope.attempt !== row.attempt || envelope.requestOrdinal !== row.requestOrdinal
    || envelope.schemaVersion !== row.schemaVersion || envelope.createdAt !== row.createdAt) {
    throw new Error(`Attempt request envelope ${envelope.id} failed durable metadata verification`);
  }
  return envelope;
}

export class SqliteAttemptRequestEnvelopeRepository implements AttemptRequestEnvelopeRepository {
  constructor(private readonly db: Database.Database) {}

  record(envelope: AttemptRequestEnvelope): AttemptRequestEnvelope {
    return this.db.transaction(() => {
      const expected = createValidatedEnvelope(envelope);
      const existing = this.get(envelope.id);
      if (existing) {
        if (existing.envelopeHash !== expected.envelopeHash) throw new Error(`Attempt request envelope ${envelope.id} already exists with different content`);
        return existing;
      }
      this.db.prepare(`INSERT INTO attempt_request_envelopes
        (id,run_id,attempt_id,attempt,request_ordinal,schema_version,envelope_json,provider_payload_hash,envelope_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        expected.id, expected.runId, expected.attemptId, expected.attempt, expected.requestOrdinal,
        expected.schemaVersion, canonicalRequestJson(expected), expected.providerPayloadHash, expected.envelopeHash, expected.createdAt,
      );
      return this.get(expected.id)!;
    })();
  }

  get(id: string): AttemptRequestEnvelope | undefined {
    return parse(this.db.prepare(`SELECT id,run_id AS runId,attempt_id AS attemptId,attempt,
      request_ordinal AS requestOrdinal,schema_version AS schemaVersion,envelope_json AS envelopeJson,
      envelope_hash AS envelopeHash,provider_payload_hash AS providerPayloadHash,created_at AS createdAt
      FROM attempt_request_envelopes WHERE id=?`).get(id) as Row | undefined);
  }

  listForAttempt(attemptId: string): AttemptRequestEnvelope[] {
    return (this.db.prepare(`SELECT id,run_id AS runId,attempt_id AS attemptId,attempt,
      request_ordinal AS requestOrdinal,schema_version AS schemaVersion,envelope_json AS envelopeJson,
      envelope_hash AS envelopeHash,provider_payload_hash AS providerPayloadHash,created_at AS createdAt
      FROM attempt_request_envelopes WHERE attempt_id=? ORDER BY request_ordinal`).all(attemptId) as Row[])
      .map((row) => parse(row)!);
  }
}

function createValidatedEnvelope(envelope: AttemptRequestEnvelope): AttemptRequestEnvelope {
  const providerPayloadHash = requestHash(envelope.providerPayload);
  const {
    id,
    schemaVersion: _schemaVersion,
    envelopeHash: _envelopeHash,
    providerPayloadHash: _providerPayloadHash,
    ...draft
  } = envelope;
  const identity = { schemaVersion: 1 as const, ...draft, providerPayloadHash };
  const expected: AttemptRequestEnvelope = {
    id: `request-envelope:${envelope.attemptId}:${envelope.requestOrdinal}`,
    ...identity,
    envelopeHash: requestHash(identity),
  };
  if (id !== expected.id || envelope.schemaVersion !== 1
    || envelope.providerPayloadHash !== expected.providerPayloadHash
    || envelope.envelopeHash !== expected.envelopeHash) {
    throw new Error(`Attempt request envelope ${id} failed input integrity verification`);
  }
  return expected;
}
