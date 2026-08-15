import type { FastifyInstance } from "fastify";
import {
  ArtifactContentResponseSchema,
  canonicalizeTaskRunCommand,
  ArtifactListQuerySchema,
  ArtifactListResponseSchema,
  CommandResponseSchema,
  decodeAbi,
  encodeAbi,
  TaskRunArtifactParamsSchema,
  TaskRunCommandSchema,
  TaskRunCommandParamsSchema,
  TaskRunParamsSchema,
  TaskRunSchema,
  TaskRunInteractionsQuerySchema,
  TaskRunInteractionsResponseSchema,
  TranscriptResponseSchema,
  TranscriptQuerySchema,
  type TaskRunArtifactParams,
  type TaskRunCommandParams,
  type TaskRunInteraction,
  type TaskRunParams,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { requestIdOf, successEnvelope, V1HttpError } from "./errors.js";
import { principalOf } from "./auth.js";
import { mapArtifact, mapArtifactContent, mapCommandReceipt, mapTaskRun, mapTranscriptItem } from "./mappers.js";
import { authorizeChannel, conflict, decodeQuery, missing } from "./route-support.js";
import { withRequestAbortSignal } from "./console-route-support.js";
import { executeTaskRunCommand } from "./task-run-command-handler.js";

export function registerTaskRunV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const { persistence, service, serviceCredentials, workspaceRoot, artifacts } = dependencies;
  const { evidence, taskRunCommands, taskRuns, transcript } = persistence;

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
    const principalId = principalOf(request).subjectId;
    let claimed: ReturnType<typeof taskRunCommands.claimTaskRunCommand>;
    try {
      claimed = taskRunCommands.claimTaskRunCommand({
        principalId,
        taskRunId,
        commandId: command.commandId,
        commandType: command.type,
        canonicalPayload: canonicalizeTaskRunCommand(command),
        targetAttemptId: command.expectedAttemptId,
        provenance: command.origin,
        requestId: requestIdOf(request),
      });
    } catch (error) {
      throw conflict("command.idempotency_conflict", error instanceof Error ? error.message : String(error), { commandId: command.commandId });
    }
    if (!claimed.claimed) {
      return encodeAbi(CommandResponseSchema, successEnvelope(request, { receipt: mapCommandReceipt(claimed.receipt, true) }));
    }
    if (command.type === "task_run.submit_user_input"
      && !run.userInputRequests.some((item) => item.id === command.payload.requestId && item.status === "pending")) {
      const invalid = conflict("user_input.not_pending", "User input request is not pending for this TaskRun");
      taskRunCommands.settleTaskRunCommand(principalId, taskRunId, command.commandId, "failed", {}, apiError(request, invalid));
      throw invalid;
    }
    if (command.type === "task_run.resolve_approval"
      && !run.supervision.approvalRequests.some((item) => item.id === command.payload.approvalRequestId && item.status === "pending")) {
      const invalid = conflict("approval.not_pending", "Approval request is not pending for this TaskRun");
      taskRunCommands.settleTaskRunCommand(principalId, taskRunId, command.commandId, "failed", {}, apiError(request, invalid));
      throw invalid;
    }
    const currentAttemptId = service.getCurrentAttemptId(taskRunId);
    if (command.expectedAttemptId !== null && command.expectedAttemptId !== currentAttemptId) {
      const mismatch = conflict("task_run.attempt_mismatch", "TaskRun command targets a stale Attempt", { expectedAttemptId: command.expectedAttemptId, currentAttemptId });
      taskRunCommands.settleTaskRunCommand(principalId, taskRunId, command.commandId, "failed", {}, apiError(request, mismatch));
      throw mismatch;
    }
    try {
      const result = await executeTaskRunCommand(dependencies, taskRunId, command);
      taskRunCommands.settleTaskRunCommand(principalId, taskRunId, command.commandId, "succeeded", result);
    } catch (error) {
      const mapped = error instanceof V1HttpError
        ? error
        : conflict("task_run.invalid_transition", error instanceof Error ? error.message : String(error));
      taskRunCommands.settleTaskRunCommand(principalId, taskRunId, command.commandId, "failed", {}, apiError(request, mapped));
      throw mapped;
    }
    return encodeAbi(CommandResponseSchema, successEnvelope(request, {
      receipt: mapCommandReceipt(taskRunCommands.getTaskRunCommand(principalId, taskRunId, command.commandId)!, false),
    }));
  });

  app.get("/api/v1/task-runs/:taskRunId/commands/:commandId", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunCommandParamsSchema },
  }, async (request) => {
    const { taskRunId, commandId } = request.params as TaskRunCommandParams;
    if (!service.getRun(taskRunId)) throw missing("task_run");
    const receipt = taskRunCommands.getTaskRunCommand(principalOf(request).subjectId, taskRunId, commandId);
    if (!receipt) throw missing("command");
    return encodeAbi(CommandResponseSchema, successEnvelope(request, { receipt: mapCommandReceipt(receipt, true) }));
  });

  app.get("/api/v1/task-runs/:taskRunId/transcript", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    if (!taskRuns.hasRun(taskRunId)) throw missing("task_run");
    const raw = request.query as { after?: number | string; limit?: number | string };
    const query = decodeQuery(TranscriptQuerySchema, {
      ...(raw.after === undefined ? {} : { after: Number(raw.after) }),
      ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
    });
    const after = query.after ?? 0;
    const limit = query.limit ?? 100;
    const entries = transcript.listTranscriptEntries(taskRunId, { after, limit: limit + 1 });
    const pageEntries = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    const boundary = pageEntries.at(-1)?.seq ?? null;
    const view = transcript.listTranscriptView(taskRunId, { after, limit });
    const items = boundary === null ? [] : view.filter((item) => item.seq <= boundary).map(mapTranscriptItem);
    return encodeAbi(
      TranscriptResponseSchema,
      successEnvelope(request, { items, pageInfo: { nextCursor: hasMore ? boundary : null, hasMore, limit } }),
    );
  });

  app.get("/api/v1/task-runs/:taskRunId/interactions", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    const run = service.getRun(taskRunId);
    if (!run) throw missing("task_run");
    const raw = request.query as { after?: number | string; limit?: number | string };
    const query = decodeQuery(TaskRunInteractionsQuerySchema, {
      ...(raw.after === undefined ? {} : { after: Number(raw.after) }),
      ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
    });
    const after = query.after ?? 0;
    const limit = query.limit ?? 100;
    const all: Array<TaskRunInteraction & { at: number }> = [
      ...run.supervision.approvalRequests.map((item) => ({ kind: "approval" as const, at: item.requestedAt, interaction: {
        id: item.id, taskRunId: run.id, attempt: item.attempt ?? run.attempt, actionType: item.actionType, targetType: item.targetType,
        targetId: item.targetId, reason: item.reason, status: item.status, requestedAt: new Date(item.requestedAt).toISOString(),
        resolvedAt: item.resolvedAt === null ? null : new Date(item.resolvedAt).toISOString(), resolvedBy: item.resolvedBy, resolution: item.resolution,
      } })),
      ...run.userInputRequests.map((item) => ({ kind: "user_input" as const, at: item.requestedAt, interaction: {
        id: item.id, taskRunId: run.id, attempt: item.attempt, prompt: item.prompt, fields: item.fields, status: item.status, response: item.response,
        requestedAt: new Date(item.requestedAt).toISOString(), submittedAt: item.submittedAt === null ? null : new Date(item.submittedAt).toISOString(),
      } })),
    ].sort((left, right) => left.at - right.at || left.interaction.id.localeCompare(right.interaction.id));
    const page = all.slice(after, after + limit);
    const next = after + page.length;
    const hasMore = next < all.length;
    return encodeAbi(TaskRunInteractionsResponseSchema, successEnvelope(request, {
      items: page.map((item): TaskRunInteraction => item.kind === "approval"
        ? { kind: "approval", interaction: item.interaction }
        : { kind: "user_input", interaction: item.interaction }),
      pageInfo: { nextCursor: hasMore ? next : null, hasMore, limit },
    }));
  });

  app.get("/api/v1/task-runs/:taskRunId/artifacts", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as TaskRunParams;
    if (!taskRuns.hasRun(taskRunId)) throw missing("task_run");
    const raw = request.query as { after?: number | string; limit?: number | string };
    const query = decodeQuery(ArtifactListQuerySchema, {
      ...(raw.after === undefined ? {} : { after: Number(raw.after) }),
      ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
    });
    const after = query.after ?? 0;
    const limit = query.limit ?? 100;
    const artifactsPage = evidence.listArtifacts(taskRunId, after, limit + 1);
    const items = artifactsPage.slice(0, limit).map(mapArtifact);
    const next = after + items.length;
    const hasMore = artifactsPage.length > limit;
    return encodeAbi(
      ArtifactListResponseSchema,
      successEnvelope(request, { items, pageInfo: { nextCursor: hasMore ? next : null, hasMore, limit } }),
    );
  });

  app.get("/api/v1/task-runs/:taskRunId/artifacts/:artifactId/content", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunArtifactParamsSchema },
  }, async (request, reply) => {
    const { taskRunId, artifactId } = request.params as TaskRunArtifactParams;
    if (!taskRuns.hasRun(taskRunId)) throw missing("task_run");
    const artifact = evidence.getArtifact(taskRunId, artifactId);
    if (!artifact) throw missing("artifact");
    try {
      const source = await withRequestAbortSignal(request, reply, (signal) =>
        artifacts.loadSource(artifact.content, artifact.uri, workspaceRoot, signal));
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
      if (cause.code === "ARTIFACT_TOO_LARGE") throw new V1HttpError(413, "artifact.too_large", cause.message, "validation");
      throw new V1HttpError(503, "artifact.unavailable", "Artifact content is unavailable", "unavailable", true);
    }
  });

  app.get("/api/v1/task-runs/:taskRunId/artifacts/:artifactId/download", {
    onRequest: authorizeChannel(serviceCredentials, "runs:read"),
    schema: { params: TaskRunArtifactParamsSchema },
  }, async (request, reply) => {
    const { taskRunId, artifactId } = request.params as TaskRunArtifactParams;
    if (!taskRuns.hasRun(taskRunId)) throw missing("task_run");
    const artifact = evidence.getArtifact(taskRunId, artifactId);
    if (!artifact) throw missing("artifact");
    try {
      const source = await withRequestAbortSignal(request, reply, (signal) =>
        artifacts.loadDownload(artifact.content, artifact.uri, workspaceRoot, signal));
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifacts.filename(artifact.title, artifact.uri))}`);
      return reply.send(source.buffer);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException & { code?: string };
      if (cause.code === "ENOENT") throw missing("artifact");
      if (cause.code === "EACCES" || cause.code === "EISDIR") throw new V1HttpError(422, "artifact.unreadable", cause.message, "validation");
      if (cause.code === "ARTIFACT_PATH_REJECTED") throw new V1HttpError(400, "artifact.path_rejected", cause.message, "validation");
      if (cause.code === "ARTIFACT_TOO_LARGE") throw new V1HttpError(413, "artifact.too_large", cause.message, "validation");
      throw new V1HttpError(503, "artifact.unavailable", "Artifact content is unavailable", "unavailable", true);
    }
  });
}

function apiError(request: Parameters<typeof requestIdOf>[0], error: V1HttpError): Record<string, unknown> {
  return { code: error.code, message: error.message, requestId: requestIdOf(request), retryable: error.retryable, details: error.details };
}
