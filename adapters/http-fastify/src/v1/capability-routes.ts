import type { FastifyInstance } from "fastify";
import {
  CoreCapabilitiesResponseSchema,
  encodeAbi,
  OPERATOR_PROFILE_ENDPOINT_IDS,
  PROJECTION_CRITICAL_TASK_RUN_EVENT_TYPES,
  TASK_RUN_COMMAND_TYPES,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope } from "./errors.js";
import { authorizeChannel } from "./route-support.js";

export function registerCapabilityV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const runtime = dependencies.runtimeConfig;
  app.get("/api/v1/capabilities", { onRequest: authorizeChannel(dependencies.serviceCredentials, "sessions:read") }, async (request) =>
    encodeAbi(CoreCapabilitiesResponseSchema, successEnvelope(request, {
      releaseVersion: runtime?.releaseVersion?.trim() || "0.8.14",
      apiVersions: ["channel.v1", "operator.console.v1", "operator.read.v1"],
      eventSpecVersion: "1.0",
      persistenceSchemaVersion: runtime?.schemaVersion ?? 2,
      commandTypes: [...TASK_RUN_COMMAND_TYPES],
      eventTypes: [...PROJECTION_CRITICAL_TASK_RUN_EVENT_TYPES],
      interactions: { approvalResolution: true, userInputSubmission: true },
      operator: { profileVersion: "1.0", endpointIds: [...OPERATOR_PROFILE_ENDPOINT_IDS], workspaceGoals: true, roadmapGenerationIdempotent: true },
      approval: { ready: true },
      receiptRecovery: {
        protocolVersion: "1.0", exactReplay: true, commandLookup: true,
        interruptedEffectState: "outcome_unknown", automaticUnknownReplay: false,
      },
      retention: { automaticDeletion: false, cursorExpiry: false },
      limits: {
        transcriptPageMax: 500, eventReplayBatch: 256, eventLiveBuffer: 1_000,
        artifactPreviewBytes: 5 * 1024 * 1024, artifactDownloadBytes: 50 * 1024 * 1024,
        artifactListPageMax: 200, interactionPageMax: 200,
      },
    })));
}
