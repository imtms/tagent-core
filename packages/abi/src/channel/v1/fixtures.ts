import type { ErrorEnvelope } from "../../shared/envelopes.js";
import type { CommandResponse, TaskRunCommand } from "./command-schemas.js";
import type { CoreCapabilitiesResponse } from "./capability-schemas.js";
import { createTaskRunEventId, type ProjectionCriticalTaskRunEvent, type TaskRunEvent } from "./event-schemas.js";
import { OPERATOR_PROFILE_ENDPOINT_IDS } from "./capability-schemas.js";
import type {
  SubmissionApplicationInput,
  SubmissionCreateHeaders,
  SubmissionCreateRequest,
  SubmissionResponse,
} from "./submission-schemas.js";

const fixtureTime = "2026-08-04T12:34:56.789Z";

export const submissionIdempotencyFixtures = {
  headers: { "idempotency-key": "submission.fixture-001" } satisfies SubmissionCreateHeaders,
  originalPayload: { content: "Build the ABI", modelId: "fixture-model" } satisfies SubmissionCreateRequest,
  repeatedCanonicalPayload: { content: "Build the ABI", modelId: "fixture-model" } satisfies SubmissionCreateRequest,
  advisoryModelPayload: { content: "Build the ABI", modelId: "different-advisory-model" } satisfies SubmissionCreateRequest,
  conflictingPayload: { content: "Change the ABI" } satisfies SubmissionCreateRequest,
  applicationInput: {
    idempotencyKey: "submission.fixture-001",
    content: "Build the ABI",
    modelId: "fixture-model",
  } satisfies SubmissionApplicationInput,
  originalResponse: {
    data: {
      receipt: {
        idempotencyKey: "submission.fixture-001",
        sessionId: "session-fixture-001",
        submissionId: "submission-fixture-001",
        status: "started",
        taskRunId: "task-run-fixture-001",
        error: null,
        audit: null,
        createdAt: fixtureTime,
        updatedAt: fixtureTime,
      },
    },
    requestId: "request-fixture-001",
  } satisfies SubmissionResponse,
  conflictError: {
    error: {
      code: "submission.idempotency_conflict",
      message: "The idempotency key is already bound to a different canonical payload.",
      requestId: "request-fixture-002",
      retryable: false,
      details: { idempotencyKey: "submission.fixture-001" },
    },
  } satisfies ErrorEnvelope,
  notFoundError: {
    error: {
      code: "submission.not_found",
      message: "Submission not found.",
      requestId: "request-fixture-003",
      retryable: false,
      details: { idempotencyKey: "submission.fixture-404" },
    },
  } satisfies ErrorEnvelope,
} as const;

export const taskRunCommandFixtures = [
  { commandId: "command-steer", type: "task_run.steer", expectedAttemptId: null, payload: { content: "Focus on ABI" } },
  { commandId: "command-follow-up", type: "task_run.follow_up", expectedAttemptId: "attempt-001", payload: { content: "Then add tests" } },
  { commandId: "command-cancel", type: "task_run.cancel", expectedAttemptId: "attempt-001", payload: { reason: "Superseded" } },
  { commandId: "command-resume", type: "task_run.resume", expectedAttemptId: "attempt-002", payload: {} },
  { commandId: "command-compact", type: "task_run.compact", expectedAttemptId: "attempt-002", payload: { reason: "Context pressure" } },
  { commandId: "command-input", type: "task_run.submit_user_input", expectedAttemptId: "attempt-002", payload: { requestId: "input-001", response: { answer: "yes" } } },
  { commandId: "command-approval", type: "task_run.resolve_approval", expectedAttemptId: "attempt-002", payload: { approvalRequestId: "approval-001", decision: "approved", resolution: "Reviewed" } },
] as const satisfies readonly TaskRunCommand[];

export const commandResponseFixture = {
  data: {
    receipt: {
      commandId: "command-steer",
      taskRunId: "task-run-fixture-001",
      type: "task_run.steer",
      status: "accepted",
      state: "succeeded",
      outcome: "accepted",
      replayed: false,
      requestId: "request-command-001",
      result: { accepted: true },
      error: null,
      audit: { principalId: "gateway-fixture", origin: null },
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    },
  },
  requestId: "request-command-001",
} as const satisfies CommandResponse;

export const coreCapabilitiesFixture = {
  data: {
    releaseVersion: "0.6.5", apiVersions: ["channel.v1", "operator.console.v1", "operator.read.v1"], eventSpecVersion: "1.0", persistenceSchemaVersion: 45,
    commandTypes: taskRunCommandFixtures.map((command) => command.type),
    eventTypes: ["task_run.started", "task_run.completed", "diagnostic.internal"],
    interactions: { approvalResolution: true, userInputSubmission: true },
    operator: { profileVersion: "1.0", endpointIds: [...OPERATOR_PROFILE_ENDPOINT_IDS], workspaceGoals: true, roadmapGenerationIdempotent: true },
    approval: { authority: "legacy", ready: true, canonicalCutoverReady: false },
    receiptRecovery: { protocolVersion: "1.0", exactReplay: true, commandLookup: true, interruptedEffectState: "outcome_unknown", automaticUnknownReplay: false },
    retention: { automaticDeletion: false, cursorExpiry: false },
    limits: {
      transcriptPageMax: 500, eventReplayBatch: 256, eventLiveBuffer: 1_000,
      artifactPreviewBytes: 5_242_880, artifactDownloadBytes: 52_428_800,
      artifactListPageMax: 200, interactionPageMax: 200,
    },
  },
  requestId: "request-capabilities-001",
} as const satisfies CoreCapabilitiesResponse;

export const taskRunEventFixture = {
  specVersion: "1.0",
  eventId: createTaskRunEventId("task-run-fixture-001", 42),
  aggregateType: "task_run",
  aggregateId: "task-run-fixture-001",
  sequence: 42,
  type: "task_run.completed",
  occurredAt: fixtureTime,
  correlationId: null,
  causationId: null,
  payload: {},
} as const satisfies TaskRunEvent;

const projectionEventBase = {
  specVersion: "1.0",
  eventId: createTaskRunEventId("task-run-fixture-catalog", 1),
  aggregateType: "task_run",
  aggregateId: "task-run-fixture-catalog",
  sequence: 1,
  occurredAt: fixtureTime,
  correlationId: null,
  causationId: null,
} as const;

/** One canonical producer fixture for every projection-critical public event. */
export const projectionCriticalTaskRunEventFixtures = [
  { ...projectionEventBase, type: "task_run.started", payload: { goal: "Ship the Gateway contract", attempt: 1 } },
  { ...projectionEventBase, type: "task_run.waiting_input", payload: { requestId: "input-001", prompt: "Choose a target", fields: [{ key: "target", label: "Target", description: "Deployment target", inputType: "text", required: true, placeholder: "staging" }] } },
  { ...projectionEventBase, type: "task_run.blocked", payload: { reason: "Evidence is incomplete", action: "verify" } },
  { ...projectionEventBase, type: "task_run.resumed", payload: { attempt: 2, mode: "durable-snapshot-replay" } },
  { ...projectionEventBase, type: "task_run.completed", payload: {} },
  { ...projectionEventBase, type: "task_run.failed", payload: { reason: "Provider failed", retryable: true } },
  { ...projectionEventBase, type: "task_run.cancelled", payload: { reason: "Cancelled by user" } },
  { ...projectionEventBase, type: "task_run.interrupted", payload: { reason: "Core restarted" } },
  { ...projectionEventBase, type: "message.started", payload: { ordinal: 1 } },
  { ...projectionEventBase, type: "message.delta", payload: { delta: "partial", ordinal: 1 } },
  { ...projectionEventBase, type: "message.completed", payload: { content: "complete", ordinal: 1 } },
  { ...projectionEventBase, type: "tool.started", payload: { toolCallId: "tool-001", toolName: "bash" } },
  { ...projectionEventBase, type: "tool.progress", payload: { toolCallId: "tool-001", toolName: "bash" } },
  { ...projectionEventBase, type: "tool.completed", payload: { toolCallId: "tool-001", toolName: "bash", isError: false } },
  { ...projectionEventBase, type: "tool.failed", payload: { toolCallId: "tool-001", toolName: "bash", reason: "exit 1" } },
  { ...projectionEventBase, type: "provider.failure", payload: { kind: "timeout", retryable: true, stopReason: "timeout" } },
  { ...projectionEventBase, type: "approval.requested", payload: { approvalRequestId: "approval-001", reason: "Resume requires approval" } },
  { ...projectionEventBase, type: "approval.resolved", payload: { approvalRequestId: "approval-001", decision: "approved", resolution: "Reviewed" } },
  { ...projectionEventBase, type: "user_input.submitted", payload: { userInputRequestId: "input-001", fieldKeys: ["target"] } },
  { ...projectionEventBase, type: "diagnostic.internal", payload: { sourceType: "context.loaded" } },
] as const satisfies readonly ProjectionCriticalTaskRunEvent[];

export const unknownTaskRunEventFixture = {
  ...taskRunEventFixture,
  eventId: createTaskRunEventId("task-run-fixture-001", 43),
  sequence: 43,
  type: "task_run.future_event",
  payload: { futureValue: { nested: true } },
  futureEnvelopeField: "preserved",
} as const;
