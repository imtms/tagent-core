import { describe, expect, expectTypeOf, it } from "vitest";
import type { Static } from "typebox";
import * as Abi from "@tagent/abi";
import * as AdminV1 from "@tagent/abi/admin/v1";
import * as ChannelV1 from "@tagent/abi/channel/v1";
import * as InternalV1 from "@tagent/abi/internal/v1";
import * as OperatorReadV1 from "@tagent/abi/operator/read-v1";
import {
  AdminConfigStatusSchema,
  AdminConfigStatusResponseSchema,
  CommandResponseSchema,
  CoreCapabilitiesResponseSchema,
  ConsoleCaptureJobSchema,
  ConsoleMemorySourceRefSchema,
  ErrorEnvelopeSchema,
  EventConsumerParamsSchema,
  EventConsumerAckRequestSchema,
  EventConsumerCursorSchema,
  MemoryCaptureRequestSchema,
  MEMORY_SOURCE_TYPES as ABI_MEMORY_SOURCE_TYPES,
  MemorySourceReferenceSchema,
  SessionParamsSchema,
  SubmissionLookupParamsSchema,
  SubmissionCreateHeadersSchema,
  SubmissionCreateRequestSchema,
  SubmissionResponseSchema,
  TaskRunArtifactParamsSchema,
  TaskRunCommandSchema,
  TaskRunEventSchema,
  ProjectionCriticalTaskRunEventSchema,
  PROJECTION_CRITICAL_TASK_RUN_EVENT_TYPES,
  TaskRunParamsSchema,
  WorkerCallbackSchema,
  canonicalizeSubmissionRequest,
  commandResponseFixture,
  coreCapabilitiesFixture,
  createSubmissionApplicationInput,
  createTaskRunEventId,
  decodeAbi,
  mapSubmissionToExecutionRequest,
  normalizeSubmissionRequest,
  projectionCriticalTaskRunEventFixtures,
  submissionIdempotencyFixtures,
  taskRunCommandFixtures,
  taskRunEventFixture,
  unknownTaskRunEventFixture,
  operatorReadCapabilitiesFixture,
  operatorLatestTaskRunFixture,
  operatorSessionListFixture,
  operatorTaskRunListFixture,
  type SubmissionCreateRequest,
  type TaskRunCommand,
  type TaskRunEvent,
} from "@tagent/abi";
import { MEMORY_SOURCE_TYPES as DOMAIN_MEMORY_SOURCE_TYPES } from "@tagent/memory";

describe("ABI runtime decoding", () => {
  it("publishes the standalone Operator Read v1 ABI and canonical fixtures", () => {
    expect(decodeAbi(OperatorReadV1.OperatorReadCapabilitiesResponseSchema, operatorReadCapabilitiesFixture))
      .toEqual(operatorReadCapabilitiesFixture);
    expect(decodeAbi(OperatorReadV1.OperatorSessionListResponseSchema, operatorSessionListFixture))
      .toEqual(operatorSessionListFixture);
    expect(decodeAbi(OperatorReadV1.OperatorSessionTaskRunListResponseSchema, operatorTaskRunListFixture))
      .toEqual(operatorTaskRunListFixture);
    expect(decodeAbi(OperatorReadV1.OperatorLatestSessionTaskRunResponseSchema, operatorLatestTaskRunFixture))
      .toEqual(operatorLatestTaskRunFixture);
  });

  it("decodes unknown input before a typed consumer can use it", () => {
    const input: unknown = { content: "implement the contract", modelId: "fixture-model" };
    const decoded = decodeAbi(SubmissionCreateRequestSchema, input);
    const consume = (request: SubmissionCreateRequest): string => request.content;

    expect(consume(decoded)).toBe("implement the contract");
    expect(() => decodeAbi(SubmissionCreateRequestSchema, { content: "ok", extra: true })).toThrow();
    expect(() => decodeAbi(SubmissionCreateRequestSchema, { content: 42 })).toThrow();
  });

  it("derives exported TypeScript types from their schemas", () => {
    expectTypeOf<SubmissionCreateRequest>().toEqualTypeOf<Static<typeof SubmissionCreateRequestSchema>>();
    expectTypeOf<TaskRunCommand>().toEqualTypeOf<Static<typeof TaskRunCommandSchema>>();
    expectTypeOf<TaskRunEvent>().toEqualTypeOf<Static<typeof TaskRunEventSchema>>();
  });

  it("uses one complete Memory provenance contract across admin and console ABI", () => {
    expect(ABI_MEMORY_SOURCE_TYPES).toEqual(DOMAIN_MEMORY_SOURCE_TYPES);

    for (const sourceType of ABI_MEMORY_SOURCE_TYPES) {
      const sourceRef = { sourceType, sourceId: `${sourceType}:fixture`, revision: "1" };
      expect(decodeAbi(MemorySourceReferenceSchema, sourceRef)).toEqual(sourceRef);
      expect(decodeAbi(ConsoleMemorySourceRefSchema, sourceRef)).toEqual(sourceRef);
      expect(decodeAbi(ConsoleCaptureJobSchema, {
        id: `job-${sourceType}`,
        status: "completed",
        attempts: 1,
        createdAt: 1,
        updatedAt: 2,
        request: { sourceRefs: [sourceRef] },
      })).toMatchObject({ request: { sourceRefs: [sourceRef] } });
    }

    expect(() => decodeAbi(MemorySourceReferenceSchema, {
      sourceType: "task_run",
      sourceId: "legacy-abi-typo",
    })).toThrow();
  });

  it("decodes the production admin config status response shape", () => {
    const status = {
      runtime: "in-process",
      provider: "openai-compatible",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      modelId: "model-fixture",
      fallbackModelIds: [],
      credentialConfigured: true,
      providerTimeoutMs: 15_000,
      providerMaxRetries: 2,
      runTimeoutMs: 900_000,
      maxContinuations: 3,
      schemaVersion: 35,
      memoryEnabled: true,
      memoryBackend: "postgres",
      memoryColdBackend: "s3",
      learningEnabled: true,
      learningAutoExecutionEnabled: false,
    };

    expect(decodeAbi(AdminConfigStatusSchema, status)).toEqual(status);
    expect(decodeAbi(AdminConfigStatusResponseSchema, {
      data: status,
      requestId: "config-status-fixture",
    })).toMatchObject({ data: { runTimeoutMs: 900_000 } });
  });
});

describe("channel v1 submission idempotency", () => {
  it("enforces the required Idempotency-Key character and length contract", () => {
    expect(decodeAbi(SubmissionCreateHeadersSchema, { "idempotency-key": "A-z_09.:-key" }))
      .toEqual({ "idempotency-key": "A-z_09.:-key" });

    for (const invalid of ["", "contains space", "slash/is-not-allowed", "x".repeat(129)]) {
      expect(() => decodeAbi(SubmissionCreateHeadersSchema, { "idempotency-key": invalid })).toThrow();
    }
    expect(() => decodeAbi(SubmissionCreateHeadersSchema, {})).toThrow();
  });

  it("maps the application idempotency key to the bounded execution request", () => {
    const applicationInput = createSubmissionApplicationInput(
      submissionIdempotencyFixtures.headers,
      submissionIdempotencyFixtures.originalPayload,
    );

    expect(applicationInput).toEqual(submissionIdempotencyFixtures.applicationInput);
    expect(mapSubmissionToExecutionRequest(applicationInput)).toEqual({
      content: "Build the ABI",
      requestId: "submission.fixture-001",
      modelId: "fixture-model",
    });
  });

  it("locks same-payload replay and different-payload conflict fixtures", () => {
    const original = canonicalizeSubmissionRequest(submissionIdempotencyFixtures.originalPayload);
    const replay = canonicalizeSubmissionRequest(submissionIdempotencyFixtures.repeatedCanonicalPayload);
    const advisoryModelChange = canonicalizeSubmissionRequest(submissionIdempotencyFixtures.advisoryModelPayload);
    const whitespaceVariant = canonicalizeSubmissionRequest({
      content: "  Build the ABI\n",
      modelId: "whitespace-advisory-model",
    });
    const conflict = canonicalizeSubmissionRequest(submissionIdempotencyFixtures.conflictingPayload);

    expect(replay).toBe(original);
    expect(advisoryModelChange).toBe(original);
    expect(whitespaceVariant).toBe(original);
    expect(conflict).not.toBe(original);
    expect(decodeAbi(SubmissionResponseSchema, submissionIdempotencyFixtures.originalResponse))
      .toEqual(submissionIdempotencyFixtures.originalResponse);
    expect(decodeAbi(ErrorEnvelopeSchema, submissionIdempotencyFixtures.conflictError).error.code)
      .toBe("submission.idempotency_conflict");
    expect(decodeAbi(ErrorEnvelopeSchema, submissionIdempotencyFixtures.notFoundError).error.code)
      .toBe("submission.not_found");
  });

  it("normalizes content while preserving the advisory modelId outside canonical identity", () => {
    const normalized = normalizeSubmissionRequest({
      content: " \tBuild the ABI\n ",
      modelId: "  advisory-model-is-unchanged  ",
    });

    expect(normalized).toEqual({
      content: "Build the ABI",
      modelId: "  advisory-model-is-unchanged  ",
    });
    expect(canonicalizeSubmissionRequest(normalized)).toBe(JSON.stringify({ content: "Build the ABI" }));
  });

  it("freezes Gate style into execution and idempotency semantics", () => {
    const relaxed = normalizeSubmissionRequest({ content: " Research the market ", gateProfile: "relaxed" });
    const strict = normalizeSubmissionRequest({ content: " Research the market ", gateProfile: "strict" });
    expect(relaxed).toEqual({ content: "Research the market", gateProfile: "relaxed" });
    expect(mapSubmissionToExecutionRequest({ idempotencyKey: "gate-profile-1", ...relaxed })).toEqual({
      content: "Research the market", requestId: "gate-profile-1", gateProfile: "relaxed",
    });
    expect(canonicalizeSubmissionRequest(relaxed)).not.toBe(canonicalizeSubmissionRequest(strict));
  });
});

describe("channel v1 route parameters", () => {
  const validCases = [
    [SessionParamsSchema, { sessionId: "session-fixture-001" }],
    [SubmissionLookupParamsSchema, {
      sessionId: "session-fixture-001",
      idempotencyKey: "submission.fixture-001",
    }],
    [TaskRunParamsSchema, { taskRunId: "task-run-fixture-001" }],
    [TaskRunArtifactParamsSchema, {
      taskRunId: "task-run-fixture-001",
      artifactId: "artifact-fixture-001",
    }],
    [EventConsumerParamsSchema, {
      taskRunId: "task-run-fixture-001",
      consumerId: "gateway-fixture",
    }],
  ] as const;

  it("accepts every channel route parameter shape", () => {
    for (const [schema, params] of validCases) {
      expect(decodeAbi(schema, params)).toEqual(params);
    }
  });

  it("rejects invalid idempotency keys, missing properties, and extra properties", () => {
    for (const idempotencyKey of ["", "contains space", "slash/is-not-allowed", "x".repeat(129)]) {
      expect(() => decodeAbi(SubmissionLookupParamsSchema, {
        sessionId: "session-fixture-001",
        idempotencyKey,
      })).toThrow();
    }

    for (const [schema, params] of validCases) {
      for (const requiredProperty of Object.keys(params)) {
        const missingProperty = Object.fromEntries(
          Object.entries(params).filter(([property]) => property !== requiredProperty),
        );
        expect(() => decodeAbi(schema, missingProperty)).toThrow();
      }
      expect(() => decodeAbi(schema, { ...params, extra: true })).toThrow();
    }
  });
});

describe("channel v1 commands and event consumption", () => {
  it("decodes each discriminated command payload and rejects a mismatched payload", () => {
    for (const fixture of taskRunCommandFixtures) {
      const command = decodeAbi(TaskRunCommandSchema, fixture);
      if (command.type === "task_run.steer" || command.type === "task_run.follow_up") {
        expect(command.payload.content.length).toBeGreaterThan(0);
      } else {
        expect(command.payload).toBeTypeOf("object");
      }
    }

    expect(() => decodeAbi(TaskRunCommandSchema, {
      commandId: "bad-command",
      type: "task_run.steer",
      expectedAttemptId: null,
      payload: {},
    })).toThrow();
    expect(() => decodeAbi(TaskRunCommandSchema, {
      commandId: "bad-command",
      type: "task_run.resume",
      expectedAttemptId: null,
      payload: { content: "wrong payload" },
    })).toThrow();
    expect(decodeAbi(CommandResponseSchema, commandResponseFixture)).toEqual(commandResponseFixture);
    expect(decodeAbi(CoreCapabilitiesResponseSchema, coreCapabilitiesFixture)).toEqual(coreCapabilitiesFixture);
  });

  it("locks the deterministic event envelope and accepts future event types and fields", () => {
    expect(createTaskRunEventId("task-run-fixture-001", 42)).toBe("task_run:task-run-fixture-001:42");
    expect(() => createTaskRunEventId("task-run-fixture-001", 0)).toThrow(RangeError);
    expect(decodeAbi(TaskRunEventSchema, taskRunEventFixture)).toEqual(taskRunEventFixture);
    expect(decodeAbi(TaskRunEventSchema, unknownTaskRunEventFixture)).toMatchObject({
      type: "task_run.future_event",
      futureEnvelopeField: "preserved",
      payload: { futureValue: { nested: true } },
    });
    expect(() => decodeAbi(TaskRunEventSchema, { ...taskRunEventFixture, occurredAt: "not-a-date" })).toThrow();
    expect(() => decodeAbi(TaskRunEventSchema, { ...taskRunEventFixture, correlationId: undefined })).toThrow();
  });

  it("publishes one producer-valid canonical fixture for every public event type", () => {
    const decoded = projectionCriticalTaskRunEventFixtures.map((fixture) =>
      decodeAbi(ProjectionCriticalTaskRunEventSchema, fixture));
    expect(decoded.map((event) => event.type)).toEqual(PROJECTION_CRITICAL_TASK_RUN_EVENT_TYPES);
    expect(new Set(decoded.map((event) => event.type))).toHaveLength(PROJECTION_CRITICAL_TASK_RUN_EVENT_TYPES.length);
  });

  it("validates fenced event-consumer cursors and acknowledgements", () => {
    const cursor = {
      taskRunId: "task-run-fixture-001",
      consumerId: "gateway-fixture",
      generation: 2,
      acknowledgedSequence: 41,
      settledAcknowledgedSequence: null,
      finalAcknowledgedSequence: null,
      terminalAcknowledgedSequence: null,
      claimedAt: "2026-08-04T12:34:56.789Z",
      updatedAt: "2026-08-04T12:34:56.789Z",
    };

    expect(decodeAbi(EventConsumerCursorSchema, cursor)).toEqual(cursor);
    expect(decodeAbi(EventConsumerAckRequestSchema, { generation: 2, sequence: 42 }))
      .toEqual({ generation: 2, sequence: 42 });
    expect(() => decodeAbi(EventConsumerAckRequestSchema, { generation: 0, sequence: 42 })).toThrow();
    expect(() => decodeAbi(EventConsumerAckRequestSchema, { generation: 2, sequence: -1 })).toThrow();
  });
});

describe("ABI envelopes and surface separation", () => {
  it("uses the common {data, requestId} success shape without a competing meta envelope", () => {
    expect(decodeAbi(SubmissionResponseSchema, submissionIdempotencyFixtures.originalResponse)).toEqual({
      data: submissionIdempotencyFixtures.originalResponse.data,
      requestId: "request-fixture-001",
    });
    expect(() => decodeAbi(SubmissionResponseSchema, {
      data: submissionIdempotencyFixtures.originalResponse.data,
      meta: { specVersion: "1.0", requestId: "request-fixture-001" },
    })).toThrow();
  });

  it("keeps channel, admin, and trusted internal exports separate", () => {
    expect(ChannelV1).toHaveProperty("TaskRunSchema");
    expect(ChannelV1).toHaveProperty("SubmissionReceiptSchema");
    expect(ChannelV1).not.toHaveProperty("MemoryScopeSchema");
    expect(ChannelV1).not.toHaveProperty("WorkerCallbackSchema");

    expect(AdminV1).toHaveProperty("MemoryScopeSchema");
    expect(AdminV1).toHaveProperty("WorkflowProposalSchema");
    expect(AdminV1).not.toHaveProperty("TaskRunCommandSchema");
    expect(AdminV1).not.toHaveProperty("WorkerCallbackSchema");

    expect(InternalV1).toHaveProperty("WorkflowEvaluationReceiptSchema");
    expect(InternalV1).toHaveProperty("WorkerCallbackSchema");
    expect(InternalV1).not.toHaveProperty("TaskRunSchema");
    expect(InternalV1).not.toHaveProperty("MemoryScopeSchema");
    expect(Abi.ChannelV1).toBe(ChannelV1);
    expect(Abi.AdminV1).toBe(AdminV1);
    expect(Abi.InternalV1).toBe(InternalV1);
    expect(Abi).not.toHaveProperty("LegacyCompat");
  });

  it("provides JSON-serializable schemas for server and client consumers", () => {
    const serialized = JSON.stringify({
      submission: SubmissionResponseSchema,
      command: TaskRunCommandSchema,
      event: TaskRunEventSchema,
      error: ErrorEnvelopeSchema,
    });
    const schemas = JSON.parse(serialized) as Record<string, { type?: string }>;

    expect(schemas.submission.type).toBe("object");
    expect(schemas.event.type).toBe("object");
    expect(serialized).not.toContain("submission.idempotency_conflict");
    expect(serialized).toContain("task_run");
  });

  it("runtime-decodes representative admin and internal requests", () => {
    expect(decodeAbi(MemoryCaptureRequestSchema, {
      scope: { type: "workspace", id: "workspace-fixture" },
      content: "Remember the ABI boundary",
      idempotencyKey: "memory.fixture-001",
    })).toMatchObject({ content: "Remember the ABI boundary" });

    expect(decodeAbi(WorkerCallbackSchema, {
      workerId: "worker-fixture",
      jobId: "job-fixture",
      leaseToken: "lease-fixture",
      fence: 3,
      occurredAt: "2026-08-04T12:34:56.789Z",
      type: "worker.completed",
      payload: { result: { accepted: true } },
    })).toMatchObject({ type: "worker.completed", fence: 3 });

    expect(() => decodeAbi(AdminConfigStatusSchema, { runtime: "incomplete" })).toThrow();
  });
});
