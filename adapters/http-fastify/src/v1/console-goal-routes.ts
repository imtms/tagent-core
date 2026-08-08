import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import {
  ConsoleWorkspaceGoalDefinitionSchema,
  ConsoleWorkspaceGoalRoadmapSchema,
  ConsoleWorkspaceGoalSchema,
  ConsoleWorkspaceGoalSummarySchema,
  decodeAbi,
  encodeAbi,
} from "@tagent/abi";
import { WorkspaceGoalService } from "@tagent/governance";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

const GoalIdParamsSchema = Type.Object({ goalId: Type.String({ minLength: 1, maxLength: 300 }) });
const WorkspaceIdParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 300 }) });
const OptionalRequestIdSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 300 }));
const OptionalActorIdSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 300 }));
const CreateGoalBodySchema = Type.Object({ definition: ConsoleWorkspaceGoalDefinitionSchema, requestId: OptionalRequestIdSchema, actorId: OptionalActorIdSchema });
const ReviseGoalBodySchema = Type.Object({ definition: ConsoleWorkspaceGoalDefinitionSchema, actorId: OptionalActorIdSchema });
const RoadmapBodySchema = Type.Object({ content: ConsoleWorkspaceGoalRoadmapSchema, sourceArtifactId: Type.Optional(Type.Union([Type.String(), Type.Null()])), actorId: OptionalActorIdSchema });
const GenerateRoadmapBodySchema = Type.Object({ actorId: OptionalActorIdSchema });
const StartRoadmapItemBodySchema = Type.Object({
  roadmapItemId: Type.String({ minLength: 1, maxLength: 300 }),
  requestId: OptionalRequestIdSchema,
});
const DecisionBodySchema = Type.Object({
  requestId: OptionalRequestIdSchema,
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
      return successEnvelope(request, goals.reviseDefinition(goalId, body.definition, body.actorId?.trim() || "web_console"));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/roadmaps", { onRequest: write, schema: { params: GoalIdParamsSchema, body: RoadmapBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(RoadmapBodySchema, request.body);
    try {
      goals.addRoadmap(goalId, body.content, body.sourceArtifactId?.trim() || null, body.actorId?.trim() || "web_console");
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/roadmap/generate", { onRequest: write, schema: { params: GoalIdParamsSchema, body: GenerateRoadmapBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    const body = decodeAbi(GenerateRoadmapBodySchema, request.body ?? {});
    try {
      await dependencies.service.generateWorkspaceGoalRoadmap(goalId, body.actorId?.trim() || "web_console");
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
    } catch (error) { throw mapGoalError(error); }
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
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) return consoleError(404, "workspace_goal.not_found", message);
  if (message.includes("stale")) return consoleError(409, "workspace_goal.stale_revision", message);
  if (message.includes("idempotency conflict")) return consoleError(409, "workspace_goal.idempotency_conflict", message);
  if (message.includes("terminal")) return consoleError(409, "workspace_goal.terminal", message);
  if (message.includes("not ready") || message.includes("must be") || message.includes("only a")) return consoleError(409, "workspace_goal.invalid_transition", message);
  if (message.includes("conflict")) return consoleError(409, "workspace_goal.conflict", message);
  return consoleError(400, "workspace_goal.invalid", message);
}
