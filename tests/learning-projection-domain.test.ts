import { describe, expect, it } from "vitest";
import {
  canonicalLearningProjectionDigest,
  decodeIntegrationLearningProjection,
  decodeLegacyLearningProjection,
  reconcileLearningProjectionPair,
  type IntegrationLearningProjectionRecord,
  type LegacyLearningProjectionRecord,
} from "@tagent/learning/domain";

const sourceEventId = "run:run-1:event:7";
const taskRun = { id: "run-1", attempt: 2, status: "waiting_input", updatedAt: 999 };

function legacy(overrides: Partial<LegacyLearningProjectionRecord> = {}): LegacyLearningProjectionRecord {
  return {
    outboxSequence: 1,
    sourceEventId,
    payloadHash: "payload-hash",
    runId: "run-1",
    attemptOrdinal: 2,
    attemptId: "attempt:run-1:2",
    lifecycle: "run.waiting_input",
    outcome: "waiting_input",
    eventSeq: 7,
    payloadJson: JSON.stringify({ prompt: "Continue?", requestId: "7ad715cd-3d06-4cbc-b3b4-8e3c250d76f6" }),
    snapshotJson: JSON.stringify(taskRun),
    ...overrides,
  };
}

function integration(
  overrides: Partial<IntegrationLearningProjectionRecord> = {},
): IntegrationLearningProjectionRecord {
  return {
    outboxSequence: 1,
    sourceEventId,
    payloadHash: "payload-hash",
    aggregateId: "run-1",
    aggregateVersion: 7,
    runEventRef: sourceEventId,
    attemptId: "attempt:run-1:2",
    attemptOrdinal: 2,
    payloadJson: JSON.stringify({ prompt: "Continue?", requestId: "7ad715cd-3d06-4cbc-b3b4-8e3c250d76f6" }),
    evidenceSnapshotJson: JSON.stringify({
      taskRun,
      attempt: { id: "attempt:run-1:2", ordinal: 2 },
      checkpoint: { runId: "run-1", attempt: 2 },
      runEventRef: { runId: "run-1", seq: 7, type: "run.waiting_for_input", createdAt: 998 },
    }),
    ...overrides,
  };
}

describe("Learning projection domain", () => {
  it("decodes legacy and integration envelopes independently into one canonical lifecycle", () => {
    expect(decodeLegacyLearningProjection(legacy())).toMatchObject({
      runId: "run-1", attemptOrdinal: 2, lifecycle: "run.waiting_input", outcome: "waiting_input",
    });
    expect(decodeIntegrationLearningProjection(integration())).toMatchObject({
      runId: "run-1", attemptOrdinal: 2, lifecycle: "run.waiting_input", outcome: "waiting_input",
    });

    const syntheticSource = "run:run-1:synthetic:restart.interruption:attempt:run-1:2:2:"
      + "a".repeat(64);
    expect(decodeIntegrationLearningProjection(integration({
      sourceEventId: syntheticSource,
      runEventRef: null,
      aggregateVersion: 2,
      evidenceSnapshotJson: JSON.stringify({
        taskRun: { id: "run-1", attempt: 2, status: "interrupted" },
        attempt: { id: "attempt:run-1:2", ordinal: 2 }, checkpoint: {}, runEventRef: null,
      }),
    }))).toMatchObject({ lifecycle: "restart.interruption", outcome: "interrupted" });
  });

  it("keeps the digest deterministic while excluding UUIDs, clocks, and mutable policy", () => {
    const first = decodeLegacyLearningProjection(legacy());
    const second = decodeLegacyLearningProjection(legacy({
      payloadJson: JSON.stringify({ prompt: "Continue?", requestId: "91644929-c96b-448c-b4a3-dedb1d88ad30" }),
      snapshotJson: JSON.stringify({ ...taskRun, updatedAt: 123_456, learningPolicy: "deny" }),
    }));
    expect(canonicalLearningProjectionDigest(first)).toBe(canonicalLearningProjectionDigest(second));
  });

  it("blocks projection identity drift before hash, snapshot, or digest comparison", () => {
    expect(reconcileLearningProjectionPair(legacy(), integration({ aggregateId: "run-corrupt" })))
      .toMatchObject({ status: "blocker", detail: "projection pair identity mismatch" });
  });

  it("classifies missing, hash, snapshot, and decoded digest mismatches fail-closed", () => {
    expect(reconcileLearningProjectionPair(null, integration()).status).toBe("missing");
    expect(reconcileLearningProjectionPair(legacy({ payloadHash: "other" }), integration()).status)
      .toBe("hash_mismatch");
    expect(reconcileLearningProjectionPair(legacy({
      snapshotJson: JSON.stringify({ ...taskRun, status: "completed" }),
    }), integration()).status).toBe("snapshot_mismatch");
    expect(reconcileLearningProjectionPair(legacy({ lifecycle: "run.completed" }), integration()).status)
      .toBe("digest_mismatch");
    expect(reconcileLearningProjectionPair(legacy(), integration()).status).toBe("match");
  });
});
