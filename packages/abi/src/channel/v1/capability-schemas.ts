import { Type, type Static } from "typebox";
import { RequestIdSchema } from "../../shared/primitives.js";
import { TaskRunCommandTypeSchema } from "./command-schemas.js";
import { KnownTaskRunEventTypeSchema } from "./event-schemas.js";

export const CoreCapabilitiesSchema = Type.Object({
  releaseVersion: Type.String({ minLength: 1 }),
  apiVersions: Type.Array(Type.String({ minLength: 1 })),
  eventSpecVersion: Type.String({ minLength: 1 }),
  persistenceSchemaVersion: Type.Integer({ minimum: 1 }),
  commandTypes: Type.Array(TaskRunCommandTypeSchema),
  eventTypes: Type.Array(KnownTaskRunEventTypeSchema),
  interactions: Type.Object({ approvalResolution: Type.Boolean(), userInputSubmission: Type.Boolean() }, { additionalProperties: false }),
  operator: Type.Object({ workspaceGoals: Type.Boolean(), roadmapGenerationIdempotent: Type.Boolean() }, { additionalProperties: false }),
  retention: Type.Object({ automaticDeletion: Type.Boolean() }, { additionalProperties: false }),
  limits: Type.Object({
    transcriptPageMax: Type.Integer({ minimum: 1 }), eventReplayBatch: Type.Integer({ minimum: 1 }),
    eventLiveBuffer: Type.Integer({ minimum: 1 }), artifactPreviewBytes: Type.Integer({ minimum: 1 }),
    artifactDownloadBytes: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type CoreCapabilities = Static<typeof CoreCapabilitiesSchema>;

export const CoreCapabilitiesResponseSchema = Type.Object({
  data: CoreCapabilitiesSchema,
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type CoreCapabilitiesResponse = Static<typeof CoreCapabilitiesResponseSchema>;
