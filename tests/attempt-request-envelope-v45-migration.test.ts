import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "@tagent/persistence-sqlite";
import { attemptIdFor, createAttemptRequestEnvelope } from "@tagent/execution/domain";
import { agentPersistence } from "./support/test-persistence.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function v44Fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "tagent-v45-envelope-"));
  directories.push(directory);
  const filename = path.join(directory, "core.db");
  const seed = new Store(filename);
  seed.db.exec(`
    DROP INDEX idx_request_envelopes_run;
    DROP INDEX idx_request_envelopes_attempt_ordinal;
    DROP TABLE attempt_request_envelopes;
    UPDATE schema_meta SET version=44 WHERE id=1;
  `);
  seed.close();
  return filename;
}

describe("Attempt request envelope schema v45", () => {
  it("migrates v44, creates the exact indexes and foreign keys, and is re-entrant", async () => {
    const filename = await v44Fixture();
    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(45);
    expect((migrated.db.prepare("PRAGMA table_info(attempt_request_envelopes)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "id", "run_id", "attempt_id", "attempt", "request_ordinal", "schema_version",
      "envelope_json", "provider_payload_hash", "envelope_hash", "created_at",
    ]);
    expect((migrated.db.prepare("PRAGMA index_list(attempt_request_envelopes)").all() as Array<{ name: string; unique: number }>)
      .filter((index) => index.name.startsWith("idx_request_envelopes")).map(({ name, unique }) => ({ name, unique })).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual([
        { name: "idx_request_envelopes_attempt_ordinal", unique: 1 },
        { name: "idx_request_envelopes_run", unique: 0 },
      ]);
    expect((migrated.db.prepare("PRAGMA foreign_key_list(attempt_request_envelopes)").all() as Array<{ from: string; table: string; to: string }>)
      .map(({ from, table, to }) => ({ from, table, to })))
      .toEqual([
        { from: "run_id", table: "attempts", to: "run_id" },
        { from: "attempt", table: "attempts", to: "ordinal" },
        { from: "attempt_id", table: "attempts", to: "id" },
      ]);
    migrated.close();
    expect(() => new Store(filename).close()).not.toThrow();
  });

  it("detects durable JSON, digest, and relational metadata tampering", () => {
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "persist request envelope");
    const attemptId = attemptIdFor(run.id, run.attempt);
    const envelope = createAttemptRequestEnvelope({
      runId: run.id,
      attemptId,
      attempt: run.attempt,
      requestOrdinal: 1,
      model: { id: "model", provider: "test", api: "openai-completions", baseUrl: "https://example.test/v1", contextWindow: 1_000, maxTokens: 100 },
      providerPayload: { model: "model", messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }] },
      createdAt: 1,
    });
    const repository = agentPersistence(store).requestEnvelopes;
    repository.record(envelope);
    expect(() => repository.record({ ...envelope, envelopeHash: "0".repeat(64) })).toThrow("input integrity verification");
    const originalJson = (store.db.prepare("SELECT envelope_json AS value FROM attempt_request_envelopes WHERE id=?").get(envelope.id) as { value: string }).value;

    store.db.prepare("UPDATE attempt_request_envelopes SET envelope_json=? WHERE id=?").run(originalJson.replace("hello", "tampered"), envelope.id);
    expect(() => repository.get(envelope.id)).toThrow(/hash verification/);
    store.db.prepare("UPDATE attempt_request_envelopes SET envelope_json=?,created_at=? WHERE id=?").run(originalJson, 2, envelope.id);
    expect(() => repository.get(envelope.id)).toThrow("durable metadata verification");
    store.close();
  });

  it("rejects request envelopes whose Run, Attempt ID, and ordinal do not identify one Attempt", () => {
    const store = new Store(":memory:");
    const first = store.createRun(store.createSession().id, "first");
    const second = store.createRun(store.createSession().id, "second");
    const envelope = createAttemptRequestEnvelope({
      runId: first.id, attemptId: attemptIdFor(second.id, second.attempt), attempt: first.attempt,
      requestOrdinal: 1,
      model: { id: "model", provider: "test", api: "openai-completions", baseUrl: "https://example.test/v1", contextWindow: 1_000, maxTokens: 100 },
      providerPayload: { model: "model", messages: [] }, createdAt: 1,
    });
    expect(() => agentPersistence(store).requestEnvelopes.record(envelope)).toThrow(/FOREIGN KEY constraint failed/);
    store.close();
  });

  it("fails closed when a v45 index or foreign key drifts", async () => {
    const filename = await v44Fixture();
    new Store(filename).close();
    const db = new Database(filename);
    db.pragma("foreign_keys = OFF");
    db.exec("DROP INDEX idx_request_envelopes_run; CREATE INDEX idx_request_envelopes_run ON attempt_request_envelopes(run_id,request_ordinal)");
    db.close();
    expect(() => new Store(filename)).toThrow("invalid idx_request_envelopes_run columns");
  });
});
