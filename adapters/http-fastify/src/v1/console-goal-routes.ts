import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import {
  ConsoleWorkspaceGoalDefinitionSchema,
  ConsoleWorkspaceGoalRoadmapSchema,
  ConsoleWorkspaceGoalSchema,
  ConsoleWorkspaceGoalSummarySchema,
  ConsoleGenerateWorkspaceGoalRoadmapRequestSchema,
  ConsoleWorkspaceGoalOperationReceiptSchema,
  canonicalJson,
  decodeAbi,
  encodeAbi,
} from "@tagent/abi";
import { WorkspaceGoalService } from "@tagent/governance";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

const GoalIdParamsSchema = Type.Object({ goalId: Type.String({ minLength: 1, maxLength: 300 }) });
const GoalOperationParamsSchema = Type.Object({ goalId: Type.String({ minLength: 1, maxLength: 300 }), requestId: Type.String({ minLength: 1, maxLength: 300 }) });
const WorkspaceIdParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 300 }) });
const OptionalActorIdSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 300 }));
const CreateGoalBodySchema = Type.Object({ definition: ConsoleWorkspaceGoalDefinitionSchema, requestId: Type.String({ minLength: 1, maxLength: 300 }), actorId: OptionalActorIdSchema });
const ReviseGoalBodySchema = Type.Object({ definition: ConsoleWorkspaceGoalDefinitionSchema, requestId: Type.String({ minLength: 1, maxLength: 300 }), actorId: OptionalActorIdSchema });
const RoadmapBodySchema = Type.Object({ content: ConsoleWorkspaceGoalRoadmapSchema, requestId: Type.String({ minLength: 1, maxLength: 300 }), sourceArtifactId: Type.Optional(Type.Union([Type.String(), Type.Null()])), actorId: OptionalActorIdSchema });
const GenerateRoadmapBodySchema = ConsoleGenerateWorkspaceGoalRoadmapRequestSchema;
const StartRoadmapItemBodySchema = Type.Object({
  roadmapItemId: Type.String({ minLength: 1, maxLength: 300 }),
  requestId: Type.String({ minLength: 1, maxLength: 300 }),
});
const DecisionBodySchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 300 }),
  targetRevisionId: Type.String({ minLength: 1, maxLength: 300 }),
  targetHash: Type.String({ minLength: 1, maxLength: 128 }),
  kind: Type.Union([
    Type.Literal("approve_goal"), Type.Literal("approve_roadmap"), Type.Literal("request_change"),
    Type.Literal("pause"), Type.Literal("resume"), Type.Literal("close"), Type.Literal("cancel"),
  ]),
  approvedItemIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 200 })),
  reason: Type.Optional(Type.String({ maxLength: 4000 })),
  actorId: OptionalActorIdSchema,
});

type GoalIdParams = Static<typeof GoalIdParamsSchema>;
type GoalOperationParams = Static<typeof GoalOperationParamsSchema>;
type WorkspaceIdParams = Static<typeof WorkspaceIdParamsSchema>;

export function registerConsoleGoalV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const goals = new WorkspaceGoalService(dependencies.persistence.workspaceGoals);
  const read = authorizeConsole(dependencies, "sessions:read");
  const write = authorizeConsole(dependencies, "sessions:write");

  app.get("/api/v1/console/workspaces/:workspaceId/goals", { onRequest: read, schema: { params: WorkspaceIdParamsSchema } }, async (request) => {
    const { workspaceId } = request.params as WorkspaceIdParams;
    if (!dependencies.persistence.sessions.getSession(workspaceId)) throw consoleError(404, "workspace.not_found", "workspace not found");
    return successEnvelope(request, goals.list(workspaceId).map((goal) => encodeAbi(ConsoleWorkspaceGoalSummarySchema, goal)));
  });

  app.post("/api/v1/console/workspaces/:workspaceId/goals", { onRequest: write, schema: { params: WorkspaceIdParamsSchema, body: CreateGoalBodySchema } }, async (request) => {
    const { workspaceId } = request.params as WorkspaceIdParams;
    if (!dependencies.persistence.sessions.getSession(workspaceId)) throw consoleError(404, "workspace.not_found", "workspace not found");
    const body = decodeAbi(CreateGoalBodySchema, request.body);
    try {
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.create({ workspaceId, definition: body.definition, createdBy: body.actorId?.trim() || "web_console", idempotencyKey: body.requestId?.trim() || undefined })));
    } catch (error) { throw mapGoalError(error); }
  });

  app.get("/api/v1/console/workspace-goals/:goalId", { onRequest: read, schema: { params: GoalIdParamsSchema } }, async (request) => {
    const goal = goals.get((request.params as GoalIdParams).goalId);
    if (!goal) throw consoleError(404, "workspace_goal.not_found", "Workspace Goal not found");
    return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goal));
  });

  app.post("/api/v1/console/workspace-goals/:goalId/definition-revisions", { onRequest: write, schema: { params: GoalIdParamsSchema, body: ReviseGoalBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(ReviseGoalBodySchema, request.body);
    try {
      const actorId = body.actorId?.trim() || "web_console";
      const claim = dependencies.persistence.workspaceGoalOperations.claimWorkspaceGoalOperation({ goalId, requestId: body.requestId, operationType: "definition.revise", canonicalPayload: canonicalJson({ definition: body.definition, actorId }) });
      if (!claim.claimed) return successEnvelope(request, replayGoalOperation(claim.receipt));
      try {
        const result = goals.reviseDefinition(goalId, body.definition, actorId);
        dependencies.persistence.workspaceGoalOperations.settleWorkspaceGoalOperation(goalId, body.requestId, "succeeded", result as unknown as Record<string, unknown>);
        return successEnvelope(request, result);
      } catch (error) {
        dependencies.persistence.workspaceGoalOperations.settleWorkspaceGoalOperation(goalId, body.requestId, "failed", {}, goalOperationError(error));
        throw error;
      }
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/roadmaps", { onRequest: write, schema: { params: GoalIdParamsSchema, body: RoadmapBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(RoadmapBodySchema, request.body);
    try {
      const actorId = body.actorId?.trim() || "web_console";
      const sourceArtifactId = body.sourceArtifactId?.trim() || null;
      const claim = dependencies.persistence.workspaceGoalOperations.claimWorkspaceGoalOperation({ goalId, requestId: body.requestId, operationType: "roadmap.revise", canonicalPayload: canonicalJson({ content: body.content, sourceArtifactId, actorId }) });
      if (!claim.claimed) return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, replayGoalOperation(claim.receipt) as never));
      try {
        goals.addRoadmap(goalId, body.content, sourceArtifactId, actorId);
        const result = encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!);
        dependencies.persistence.workspaceGoalOperations.settleWorkspaceGoalOperation(goalId, body.requestId, "succeeded", result as unknown as Record<string, unknown>);
        return successEnvelope(request, result);
      } catch (error) {
        dependencies.persistence.workspaceGoalOperations.settleWorkspaceGoalOperation(goalId, body.requestId, "failed", {}, goalOperationError(error));
        throw error;
      }
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/roadmap/generate", { onRequest: write, schema: { params: GoalIdParamsSchema, body: GenerateRoadmapBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(GenerateRoadmapBodySchema, request.body ?? {});
    const actorId = body.actorId?.trim() || "web_console";
    try {
      const claim = dependencies.persistence.workspaceGoalOperations.claimWorkspaceGoalOperation({
        goalId,
        requestId: body.requestId,
        operationType: "roadmap.generate",
        canonicalPayload: canonicalJson({ actorId }),
      });
      if (!claim.claimed) {
        if (claim.receipt.state === "succeeded") return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
        if (claim.receipt.state === "failed") throw new Error(String(claim.receipt.error?.message ?? "Goal Roadmap generation failed"));
        if (claim.receipt.state === "started") throw consoleError(409, "workspace_goal.operation_in_progress", "Goal Roadmap generation is still in progress");
        throw consoleError(409, "workspace_goal.operation_outcome_unknown", "Goal Roadmap generation outcome is unknown; inspect the Goal before retrying with a new requestId");
      }
      try {
        await dependencies.service.generateWorkspaceGoalRoadmap(goalId, actorId);
        dependencies.persistence.workspaceGoalOperations.settleWorkspaceGoalOperation(goalId, body.requestId, "succeeded", { generated: true });
      } catch (error) {
        dependencies.persistence.workspaceGoalOperations.settleWorkspaceGoalOperation(goalId, body.requestId, "failed", {}, goalOperationError(error));
        throw error;
      }
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
    } catch (error) { throw mapGoalError(error); }
  });

  app.get("/api/v1/console/workspace-goals/:goalId/operations/:requestId", { onRequest: read, schema: { params: GoalOperationParamsSchema } }, async (request) => {
    const { goalId, requestId } = request.params as GoalOperationParams;
    if (!goals.get(goalId)) throw consoleError(404, "workspace_goal.not_found", "Workspace Goal not found");
    const receipt = dependencies.persistence.workspaceGoalOperations.getWorkspaceGoalOperation(goalId, requestId);
    if (!receipt) throw consoleError(404, "workspace_goal.operation_not_found", "Workspace Goal operation not found");
    return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalOperationReceiptSchema, receipt));
  });

  app.post("/api/v1/console/workspace-goals/:goalId/task-runs", { onRequest: write, schema: { params: GoalIdParamsSchema, body: StartRoadmapItemBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(StartRoadmapItemBodySchema, request.body);
    try {
      const result = dependencies.service.startWorkspaceGoalRoadmapItem(goalId, body.roadmapItemId, body.requestId?.trim() || undefined) as {
        item: { id: string };
        run: { id: string } | null;
      };
      return successEnvelope(request, {
        goal: encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!),
        inboxItemId: result.item.id,
        runId: result.run?.id ?? null,
      });
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/decisions", { onRequest: write, schema: { params: GoalIdParamsSchema, body: DecisionBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(DecisionBodySchema, request.body);
    try {
      goals.decide({ goalId, requestId: body.requestId, targetRevisionId: body.targetRevisionId, targetHash: body.targetHash, kind: body.kind, approvedItemIds: body.approvedItemIds, reason: body.reason, actorId: body.actorId?.trim() || "web_console" });
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
    } catch (error) { throw mapGoalError(error); }
  });

}

function mapGoalError(error: unknown) {
  if (error instanceof V1HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) return consoleError(404, "workspace_goal.not_found", message);
  if (message.includes("stale")) return consoleError(409, "workspace_goal.stale_revision", message);
  if (message.includes("idempotency conflict")) return consoleError(409, "workspace_goal.idempotency_conflict", message);
  if (message.includes("terminal")) return consoleError(409, "workspace_goal.terminal", message);
  if (message.includes("not ready") || message.includes("must be") || message.includes("only a")) return consoleError(409, "workspace_goal.invalid_transition", message);
  if (message.includes("conflict")) return consoleError(409, "workspace_goal.conflict", message);
  return consoleError(400, "workspace_goal.invalid", message);
}

function replayGoalOperation(receipt: { state: string; result: Record<string, unknown> | null; error: Record<string, unknown> | null }): Record<string, unknown> {
  if (receipt.state === "succeeded" && receipt.result) return receipt.result;
  if (receipt.state === "failed") throw consoleError(409, "workspace_goal.operation_failed", String(receipt.error?.message ?? "Workspace Goal operation failed"));
  if (receipt.state === "started") throw consoleError(409, "workspace_goal.operation_in_progress", "Workspace Goal operation is still in progress");
  throw consoleError(409, "workspace_goal.operation_outcome_unknown", "Workspace Goal operation outcome is unknown; inspect the Goal before retrying with a new requestId");
}

function goalOperationError(error: unknown): Record<string, unknown> {
  const mapped = mapGoalError(error);
  return { code: mapped.code, message: mapped.message, retryable: mapped.retryable, details: mapped.details };
}
