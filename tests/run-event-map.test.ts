import { describe, expect, it } from "vitest";
import type { RunEventMap, RunEventType } from "@tagent/execution/domain";

function acceptsEvent<TType extends RunEventType>(type: TType, data: RunEventMap[TType]) {
  return { type, data };
}

describe("RunEventMap", () => {
  it("keeps event names closed and key payloads typed", () => {
    expect(acceptsEvent("message.delta", { delta: "chunk", ordinal: 1 })).toEqual({
      type: "message.delta",
      data: { delta: "chunk", ordinal: 1 },
    });
    acceptsEvent("tool.started", { toolCallId: "call-1", toolName: "read" });
    acceptsEvent("provider.failure", { kind: "timeout", retryable: true, summary: "idle", stopReason: "error" });
    acceptsEvent("request.envelope.persisted", {
      envelopeId: "request-envelope:attempt-1:1",
      requestOrdinal: 1,
      envelopeHash: "a".repeat(64),
      providerPayloadHash: "b".repeat(64),
      model: "model-1",
    });

    // @ts-expect-error Unknown names must not cross the authoritative append boundary.
    acceptsEvent("test.marker", {});
    // @ts-expect-error message.delta requires an ordinal.
    acceptsEvent("message.delta", { delta: "chunk" });
    // @ts-expect-error tool.started requires a stable call identity.
    acceptsEvent("tool.started", { toolName: "read" });
  });
});
