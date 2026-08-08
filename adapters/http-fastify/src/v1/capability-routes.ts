import type { FastifyInstance } from "fastify";
import { CoreCapabilitiesResponseSchema, encodeAbi } from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope } from "./errors.js";
import { authorizeChannel } from "./route-support.js";

export function registerCapabilityV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  app.get("/api/v1/capabilities", { onRequest: authorizeChannel(dependencies.serviceCredentials, "sessions:read") }, async (request) =>
    encodeAbi(CoreCapabilitiesResponseSchema, successEnvelope(request, {
      releaseVersion: "0.3.0",
      apiVersions: ["channel.v1", "operator.console.v1"],
      eventSpecVersion: "1.0",
      persistenceSchemaVersion: 39,
      commandTypes: ["task_run.steer", "task_run.follow_up", "task_run.cancel", "task_run.resume", "task_run.compact", "task_run.submit_user_input", "task_run.resolve_approval"],
      eventTypes: ["task_run.started", "task_run.waiting_input", "task_run.blocked", "task_run.resumed", "task_run.completed", "task_run.failed", "task_run.cancelled", "task_run.interrupted", "message.started", "message.delta", "message.completed", "tool.started", "tool.progress", "tool.completed", "tool.failed", "provider.failure", "approval.requested", "approval.resolved", "user_input.submitted", "diagnostic.internal"],
      interactions: { approvalResolution: true, userInputSubmission: true },
      operator: { workspaceGoals: true, roadmapGenerationIdempotent: true },
      retention: { automaticDeletion: false },
      limits: { transcriptPageMax: 500, eventReplayBatch: 256, eventLiveBuffer: 1_000, artifactPreviewBytes: 5 * 1024 * 1024, artifactDownloadBytes: 50 * 1024 * 1024 },
    })));
}
