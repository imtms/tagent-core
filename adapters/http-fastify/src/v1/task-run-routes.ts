import type { FastifyInstance } from "fastify";
import {
  ArtifactContentResponseSchema,
  ArtifactListResponseSchema,
  CommandResponseSchema,
  decodeAbi,
  encodeAbi,
  TaskRunArtifactParamsSchema,
  TaskRunCommandSchema,
  TaskRunParamsSchema,
  TaskRunSchema,
  TranscriptResponseSchema,
  type TaskRunArtifactParams,
  type TaskRunCommand,
  type TaskRunParams,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { requestIdOf, successEnvelope, V1HttpError } from "./errors.js";
import { mapArtifactContent, mapCommandReceipt, mapTaskRun, mapTranscriptItem } from "./mappers.js";
import { authorizeChannel, conflict, missing } from "./route-support.js";

function commandAdmissionError(status: "inactive" | "closing" | "full"): V1HttpError {
  if (status === "full") return new V1HttpError(429, "task_run.command_capacity_exceeded", "TaskRun control inbox is full", "rate_limited", true);
  if (status === "closing") return new V1HttpError(503, "service.closing", "Service is closing", "unavailable", true);
  return conflict("task_run.invalid_transition", "TaskRun is not active");
}

async function executeCommand(dependencies: ChannelV1Dependencies, taskRunId: string, command: TaskRunCommand): Promise<void> {
  const { service } = dependencies;
  switch (command.type) {
    case "task_run.steer": {
      const result = await service.steer(taskRunId, command.payload.content, command.commandId);
      if (result.status !== "accepted") throw commandAdmissionError(result.status);
      return;
    }
    case "task_run.follow_up": {
      const result = await service.followUp(taskRunId, command.payload.content, command.commandId);
      if (result.status !== "accepted") throw commandAdmissionError(result.status);
      return;
    }
    case "task_run.cancel":
      if (!service.cancel(taskRunId)) throw conflict("task_run.invalid_transition", "TaskRun is not active");
      return;
    case "task_run.resume":
      await service.resume(taskRunId);
      return;
    case "task_run.compact": {
      const result = await service.compact(taskRunId, command.payload.reason);
      if (result === "inactive") throw conflict("task_run.invalid_transition", "TaskRun is not active");
      if (result === "failed") throw new V1HttpError(503, "task_run.compaction_failed", "TaskRun compaction failed", "unavailable", true);
    }
  }
}

export function registerTaskRunV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const { persistence, service, serviceCredentials, workspaceRoot, artifacts } = dependencies;
  const { operations, transcript } = persistence;

  app.get("/api/v1/task-runs/:taskRunId", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    const run = service.getRun(taskRunId);
    if (!run) throw missing("task_run");
    return successEnvelope(request, encodeAbi(TaskRunSchema, mapTaskRun(run)));
  });

  app.post("/api/v1/task-runs/:taskRunId/commands", {
    onRequest: authorizeChannel(serviceCredentials, "runs:control"),
    schema: { params: TaskRunParamsSchema, body: TaskRunCommandSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    const command = decodeAbi(TaskRunCommandSchema, request.body);
    const run = service.getRun(taskRunId);
    if (!run) throw missing("task_run");
    const currentAttemptId = service.getCurrentAttemptId(taskRunId);
    if (command.expectedAttemptId !== null && command.expectedAttemptId !== currentAttemptId) {
      throw conflict("task_run.attempt_mismatch", "TaskRun command targets a stale Attempt", { expectedAttemptId: command.expectedAttemptId, currentAttemptId });
    }
    let operation: ReturnType<ChannelV1Dependencies["persistence"]["operations"]["claimOperation"]>;
    try { operation = operations.claimOperation(command.commandId, taskRunId, run.attempt, command.type, command); }
    catch (error) {
      throw conflict("command.idempotency_conflict", error instanceof Error ? error.message : String(error), { commandId: command.commandId });
    }
    if (!operation.claimed) {
      return encodeAbi(
        CommandResponseSchema,
        successEnvelope(request, {
          receipt: mapCommandReceipt(command, taskRunId, requestIdOf(request), operation, true),
        }),
      );
    }
    try {
      await executeCommand(dependencies, taskRunId, command);
      operations.updateOperation(command.commandId, { status: "succeeded", stage: "completed", result: { accepted: true } });
    } catch (error) {
      const mapped = error instanceof V1HttpError
        ? error
        : conflict("task_run.invalid_transition", error instanceof Error ? error.message : String(error));
      operations.updateOperation(command.commandId, { status: "failed", stage: "execution_failed", error: mapped.message });
      throw mapped;
    }
    return encodeAbi(
      CommandResponseSchema,
      successEnvelope(request, {
        receipt: mapCommandReceipt(
          command,
          taskRunId,
          requestIdOf(request),
          operations.getOperation(command.commandId),
          false,
        ),
      }),
    );
  });

  app.get("/api/v1/task-runs/:taskRunId/transcript", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    if (!service.getRun(taskRunId)) throw missing("task_run");
    return encodeAbi(
      TranscriptResponseSchema,
      successEnvelope(request, { items: transcript.listTranscriptView(taskRunId).map(mapTranscriptItem) }),
    );
  });

  app.get("/api/v1/task-runs/:taskRunId/artifacts", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    const run = service.getRun(taskRunId);
    if (!run) throw missing("task_run");
    return encodeAbi(
      ArtifactListResponseSchema,
      successEnvelope(request, { items: mapTaskRun(run).artifacts }),
    );
  });

  app.get("/api/v1/task-runs/:taskRunId/artifacts/:artifactId/content", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunArtifactParamsSchema },
  }, async (request) => {
    const { taskRunId, artifactId } = request.params as TaskRunArtifactParams;
    const run = service.getRun(taskRunId);
    if (!run) throw missing("task_run");
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) throw missing("artifact");
    try {
      const source = await artifacts.loadSource(artifact.content, artifact.uri, workspaceRoot);
      if (!artifacts.isText(artifact.kind, artifact.title, artifact.uri, source.content)) {
        throw new V1HttpError(400, "artifact.unsupported_content", "Artifact is not a supported text file", "validation");
      }
      const format = artifacts.isMarkdown(artifact.kind, artifact.title, artifact.uri) ? "markdown" : "text";
      return encodeAbi(
        ArtifactContentResponseSchema,
        successEnvelope(request, {
          artifact: mapArtifactContent(artifact, source.content, format, source.source),
        }),
      );
    } catch (error) {
      if (error instanceof V1HttpError) throw error;
      const cause = error as NodeJS.ErrnoException & { code?: string };
      if (cause.code === "ENOENT") throw missing("artifact");
      if (cause.code === "ARTIFACT_PATH_REJECTED") throw new V1HttpError(400, "artifact.path_rejected", cause.message, "validation");
      throw new V1HttpError(503, "artifact.unavailable", "Artifact content is unavailable", "unavailable", true);
    }
  });
}
