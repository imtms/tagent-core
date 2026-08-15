import { Type, type Static } from "typebox";
import { RequestIdSchema } from "../../shared/primitives.js";
import { TaskRunCommandTypeSchema } from "./command-schemas.js";
import { KnownTaskRunEventTypeSchema } from "./event-schemas.js";

export const OPERATOR_PROFILE_ENDPOINT_IDS = [
  "channel.capabilities.get",
  "channel.sessions.create", "channel.sessions.get",
  "channel.submissions.create", "channel.submissions.get",
  "channel.task_runs.get",
  "channel.task_run_commands.create", "channel.task_run_commands.get",
  "channel.task_run_interactions.list", "channel.task_run_transcript.list",
  "channel.task_run_artifacts.list", "channel.task_run_artifacts.get",
  "channel.event_consumers.claim", "channel.event_consumers.ack",
  "channel.task_run_events.stream",
  "operator.workspace_goals.list", "operator.workspace_goals.get",
  "operator.workspace_goals.create", "operator.workspace_goals.revise_definition",
  "operator.workspace_goals.revise_roadmap", "operator.workspace_goals.generate_roadmap",
  "operator.workspace_goals.get_operation", "operator.workspace_goals.decide",
  "operator.workspace_goals.start_task_run",
] as const;

export const OperatorProfileEndpointIdSchema = Type.Union([
  Type.Literal("channel.capabilities.get"),
  Type.Literal("channel.sessions.create"), Type.Literal("channel.sessions.get"),
  Type.Literal("channel.submissions.create"), Type.Literal("channel.submissions.get"),
  Type.Literal("channel.task_runs.get"),
  Type.Literal("channel.task_run_commands.create"), Type.Literal("channel.task_run_commands.get"),
  Type.Literal("channel.task_run_interactions.list"), Type.Literal("channel.task_run_transcript.list"),
  Type.Literal("channel.task_run_artifacts.list"), Type.Literal("channel.task_run_artifacts.get"),
  Type.Literal("channel.event_consumers.claim"), Type.Literal("channel.event_consumers.ack"),
  Type.Literal("channel.task_run_events.stream"),
  Type.Literal("operator.workspace_goals.list"), Type.Literal("operator.workspace_goals.get"),
  Type.Literal("operator.workspace_goals.create"), Type.Literal("operator.workspace_goals.revise_definition"),
  Type.Literal("operator.workspace_goals.revise_roadmap"), Type.Literal("operator.workspace_goals.generate_roadmap"),
  Type.Literal("operator.workspace_goals.get_operation"), Type.Literal("operator.workspace_goals.decide"),
  Type.Literal("operator.workspace_goals.start_task_run"),
]);
export type OperatorProfileEndpointId = Static<typeof OperatorProfileEndpointIdSchema>;

export const CoreCapabilitiesSchema = Type.Object({
  releaseVersion: Type.String({ minLength: 1 }),
  apiVersions: Type.Array(Type.String({ minLength: 1 })),
  eventSpecVersion: Type.String({ minLength: 1 }),
  persistenceSchemaVersion: Type.Integer({ minimum: 1 }),
  commandTypes: Type.Array(TaskRunCommandTypeSchema),
  eventTypes: Type.Array(KnownTaskRunEventTypeSchema),
  interactions: Type.Object({ approvalResolution: Type.Boolean(), userInputSubmission: Type.Boolean() }, { additionalProperties: false }),
  operator: Type.Object({
    profileVersion: Type.String({ minLength: 1 }),
    endpointIds: Type.Array(OperatorProfileEndpointIdSchema),
    workspaceGoals: Type.Boolean(),
    roadmapGenerationIdempotent: Type.Boolean(),
  }, { additionalProperties: false }),
  approval: Type.Object({
    ready: Type.Literal(true),
  }, { additionalProperties: false }),
  receiptRecovery: Type.Object({
    protocolVersion: Type.String({ minLength: 1 }),
    exactReplay: Type.Boolean(),
    commandLookup: Type.Boolean(),
    interruptedEffectState: Type.Literal("outcome_unknown"),
    automaticUnknownReplay: Type.Literal(false),
  }, { additionalProperties: false }),
  retention: Type.Object({ automaticDeletion: Type.Boolean(), cursorExpiry: Type.Boolean() }, { additionalProperties: false }),
  limits: Type.Object({
    transcriptPageMax: Type.Integer({ minimum: 1 }), eventReplayBatch: Type.Integer({ minimum: 1 }),
    eventLiveBuffer: Type.Integer({ minimum: 1 }), artifactPreviewBytes: Type.Integer({ minimum: 1 }),
    artifactDownloadBytes: Type.Integer({ minimum: 1 }), artifactListPageMax: Type.Integer({ minimum: 1 }),
    interactionPageMax: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type CoreCapabilities = Static<typeof CoreCapabilitiesSchema>;

export const CoreCapabilitiesResponseSchema = Type.Object({
  data: CoreCapabilitiesSchema,
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type CoreCapabilitiesResponse = Static<typeof CoreCapabilitiesResponseSchema>;
