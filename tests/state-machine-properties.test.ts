import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite/store";
import { attemptIdFor, canonicalRequestJson, createAttemptRequestEnvelope, requestHash } from "@tagent/execution/domain";
import { corePersistence } from "./support/test-persistence.js";

const propertySeed = 0x5eed2026;

function reverseObjectOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectOrder(item)]));
  }
  return value;
}

describe("critical persistence and replay properties", () => {
  it("canonical provider requests ignore object insertion order and hash semantic changes", () => {
    fc.assert(fc.property(
      fc.dictionary(fc.string({ minLength: 1, maxLength: 16 }), fc.jsonValue(), { maxKeys: 16 }),
      fc.string({ maxLength: 64 }),
      (payload, changed) => {
        const reordered = reverseObjectOrder(payload);
        expect(canonicalRequestJson(reordered)).toBe(canonicalRequestJson(payload));
        expect(requestHash(reordered)).toBe(requestHash(payload));
        const changedPayload = { ...payload, __property_change__: changed };
        const otherPayload = { ...payload, __property_change__: `${changed}\u0000` };
        expect(requestHash(changedPayload)).not.toBe(requestHash(otherPayload));
      },
    ), { seed: propertySeed, numRuns: 100 });
  });

  it("operation and tool-attempt receipts replay identical payloads and reject identity reuse", () => {
    const store = new Store(":memory:");
    let caseOrdinal = 0;
    try {
      fc.assert(fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue(), { maxKeys: 10 }),
        fc.integer({ min: 1, max: 6 }),
        (payload, replayCount) => {
          const run = store.createRun(store.createSession().id, "property replay");
          const operationId = `operation:${caseOrdinal++}:${requestHash(payload)}`;
          expect(store.claimOperation(operationId, run.id, run.attempt, "property.operation", payload).claimed).toBe(true);
          for (let index = 0; index < replayCount; index += 1) {
            expect(store.claimOperation(operationId, run.id, run.attempt, "property.operation", reverseObjectOrder(payload)).claimed).toBe(false);
          }
          store.updateOperation(operationId, { status: "succeeded", result: { replayCount } });
          expect(store.claimOperation(operationId, run.id, run.attempt, "property.operation", payload)).toMatchObject({
            claimed: false,
            status: "succeeded",
            result: { replayCount },
          });
          expect(() => store.claimOperation(operationId, run.id, run.attempt, "property.operation", { ...payload, __different__: true })).toThrow("different payload");

          const firstAttempt = store.recordToolAttempt(run.id, run.attempt, "tool-call", "read", payload);
          expect(firstAttempt.created).toBe(true);
          for (let index = 0; index < replayCount; index += 1) {
            expect(store.recordToolAttempt(run.id, run.attempt, "tool-call", "read", reverseObjectOrder(payload)).created).toBe(false);
          }
          expect(() => store.recordToolAttempt(run.id, run.attempt, "tool-call", "read", { ...payload, __different__: true })).toThrow("different content");
        },
      ), { seed: propertySeed + 1, numRuns: 50 });
    } finally {
      store.close();
    }
  });

  it("allocates a gap-free monotonic event sequence for arbitrary append traces", () => {
    const store = new Store(":memory:");
    try {
      fc.assert(fc.property(fc.array(fc.jsonValue(), { minLength: 1, maxLength: 80 }), (payloads) => {
        const run = store.createRun(store.createSession().id, "event ordering property");
        for (const [index, payload] of payloads.entries()) {
          store.appendEvent(run.id, "run.updated", { index, payload });
        }
        const events = store.listEvents(run.id);
        expect(events.map((event) => event.seq)).toEqual(payloads.map((_, index) => index + 1));
        expect(events.map((event) => event.data.payload)).toEqual(payloads);
        expect(store.getRun(run.id)?.lastEventSeq).toBe(payloads.length);
      }), { seed: propertySeed + 2, numRuns: 50 });
    } finally {
      store.close();
    }
  });

  it("keeps request envelopes and the current schema stable across repeated opens", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.jsonValue(), async (reopens, payload) => {
      const directory = await mkdtemp(path.join(tmpdir(), "tagent-current-schema-property-"));
      const filename = path.join(directory, "core.db");
      try {
        const opened = new Store(filename);
        const run = opened.createRun(opened.createSession().id, "reopen property");
        const envelope = createAttemptRequestEnvelope({
          runId: run.id,
          attemptId: attemptIdFor(run.id, run.attempt),
          attempt: run.attempt,
          requestOrdinal: 1,
          providerPayload: payload,
          model: { id: "model", provider: "test", api: "openai-completions", baseUrl: "https://example.test/v1", contextWindow: 1_000, maxTokens: 100 },
          createdAt: 1,
        });
        corePersistence(opened).requestEnvelopes.record(envelope);
        const schema = opened.db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master WHERE name LIKE '%request_envelope%' ORDER BY type,name").all();
        opened.close();

        for (let index = 0; index < reopens; index += 1) {
          const reopened = new Store(filename);
          expect(reopened.getSchemaVersion()).toBe(2);
          expect(reopened.db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master WHERE name LIKE '%request_envelope%' ORDER BY type,name").all()).toEqual(schema);
          expect(corePersistence(reopened).requestEnvelopes.get(envelope.id)).toEqual(envelope);
          reopened.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }), { seed: propertySeed + 3, numRuns: 12 });
  }, 15_000);
});
