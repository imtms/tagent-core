import { describe, expect, it } from "vitest";
import {
  canonicalLearningProjectionDigest,
  decodeIntegrationLearningProjection,
  type IntegrationLearningProjectionRecord,
} from "@tagent/learning/domain";

const sourceEventId = "run:run-1:event:7";

function integration(
  overrides: Partial<IntegrationLearningProjectionRecord> = {},
  snapshotOverrides: Record<string, unknown> = {},
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
    payloadJson: JSON.stringify({
      prompt: "Continue?",
      requestId: "7ad715cd-3d06-4cbc-b3b4-8e3c250d76f6",
    }),
    evidenceSnapshotJson: JSON.stringify({
      taskRun: {
        id: "run-1", attempt: 2, status: "waiting_input", updatedAt: 999, ...snapshotOverrides,
      },
      attempt: { id: "attempt:run-1:2", ordinal: 2 },
      checkpoint: { runId: "run-1", attempt: 2 },
      runEventRef: { runId: "run-1", seq: 7, type: "run.waiting_for_input", createdAt: 998 },
    }),
    ...overrides,
  };
}

describe("Learning projection domain", () => {
  it("decodes the integration envelope into the current lifecycle", () => {
    expect(decodeIntegrationLearningProjection(integration())).toMatchObject({
      runId: "run-1",
      attemptOrdinal: 2,
      eventSeq: 7,
      lifecycle: "run.waiting_input",
      outcome: "waiting_input",
    });
  });

  it("keeps the digest deterministic while excluding IDs, clocks, and mutable policy", () => {
    const first = decodeIntegrationLearningProjection(integration());
    const second = decodeIntegrationLearningProjection(integration({
      payloadJson: JSON.stringify({
        prompt: "Continue?",
        requestId: "91644929-c96b-448c-b4a3-dedb1d88ad30",
      }),
    }, { updatedAt: 123_456, learningPolicy: "deny" }));
    expect(canonicalLearningProjectionDigest(first)).toBe(canonicalLearningProjectionDigest(second));
  });

  it("rejects malformed evidence before any effect can run", () => {
    expect(() => decodeIntegrationLearningProjection(integration({
      evidenceSnapshotJson: JSON.stringify({ taskRun: {}, runEventRef: null }),
    }))).toThrow(/runEventRef\.type is required/);
    expect(() => decodeIntegrationLearningProjection(integration({ payloadJson: "[]" })))
      .toThrow(/payload_json must be a JSON object/);
  });
});
