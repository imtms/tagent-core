import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import {
  ConsoleWorkspaceGoalSchema,
  ConsoleWorkspaceGoalSummarySchema,
  ConsoleWorkspaceGoalRevisionSchema,
  ConsoleGenerateWorkspaceGoalRoadmapRequestSchema,
  ConsoleWorkspaceGoalOperationReceiptSchema,
  ConsoleCreateWorkspaceGoalRequestSchema,
  ConsoleReviseWorkspaceGoalDefinitionRequestSchema,
  ConsoleReviseWorkspaceGoalRoadmapRequestSchema,
  ConsoleDecideWorkspaceGoalRequestSchema,
  ConsoleStartWorkspaceGoalTaskRunRequestSchema,
  ConsoleStartWorkspaceGoalTaskRunResultSchema,
  decodeAbi,
  encodeAbi,
} from "@tagent/abi";
import type { V1ApiDependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";
import { assertChannelSessionScope } from "./route-support.js";

const GoalIdParamsSchema = Type.Object({ goalId: Type.String({ minLength: 1, maxLength: 300 }) });
const GoalOperationParamsSchema = Type.Object({ goalId: Type.String({ minLength: 1, maxLength: 300 }), requestId: Type.String({ minLength: 1, maxLength: 300 }) });
const WorkspaceIdParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 300 }) });
const CreateGoalBodySchema = ConsoleCreateWorkspaceGoalRequestSchema;
const ReviseGoalBodySchema = ConsoleReviseWorkspaceGoalDefinitionRequestSchema;
const RoadmapBodySchema = ConsoleReviseWorkspaceGoalRoadmapRequestSchema;
const GenerateRoadmapBodySchema = ConsoleGenerateWorkspaceGoalRoadmapRequestSchema;
const StartRoadmapItemBodySchema = ConsoleStartWorkspaceGoalTaskRunRequestSchema;
const DecisionBodySchema = ConsoleDecideWorkspaceGoalRequestSchema;

type GoalIdParams = Static<typeof GoalIdParamsSchema>;
type GoalOperationParams = Static<typeof GoalOperationParamsSchema>;
type WorkspaceIdParams = Static<typeof WorkspaceIdParamsSchema>;

function requireScopedGoal(request: FastifyRequest, dependencies: V1ApiDependencies, goalId: string) {
  const goal = dependencies.service.getWorkspaceGoal(goalId);
  if (!goal) throw consoleError(404, "workspace_goal.not_found", "Workspace Goal not found");
  assertChannelSessionScope(request, goal.workspaceId);
  return goal;
}

export function registerConsoleGoalV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const read = authorizeConsole(dependencies, "sessions:read");
  const write = authorizeConsole(dependencies, "sessions:write");

  app.get("/api/v1/console/workspaces/:workspaceId/goals", { onRequest: read, schema: { params: WorkspaceIdParamsSchema } }, async (request) => {
    const { workspaceId } = request.params as WorkspaceIdParams;
    assertChannelSessionScope(request, workspaceId);
    try{return successEnvelope(request, dependencies.service.listWorkspaceGoals(workspaceId).map((goal) => encodeAbi(ConsoleWorkspaceGoalSummarySchema, goal)));}
    catch(error){throw mapGoalError(error);}
  });

  app.post("/api/v1/console/workspaces/:workspaceId/goals", { onRequest: write, schema: { params: WorkspaceIdParamsSchema, body: CreateGoalBodySchema } }, async (request) => {
    const { workspaceId } = request.params as WorkspaceIdParams;
    assertChannelSessionScope(request, workspaceId);
    const body = decodeAbi(CreateGoalBodySchema, request.body);
    try {
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, dependencies.service.createWorkspaceGoal(workspaceId,{definition:body.definition,actorId:body.actorId,requestId:body.requestId})));
    } catch (error) { throw mapGoalError(error); }
  });

  app.get("/api/v1/console/workspace-goals/:goalId", { onRequest: read, schema: { params: GoalIdParamsSchema } }, async (request) => {
    const goal = requireScopedGoal(request, dependencies, (request.params as GoalIdParams).goalId);
    return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goal));
  });

  app.post("/api/v1/console/workspace-goals/:goalId/definition-revisions", { onRequest: write, schema: { params: GoalIdParamsSchema, body: ReviseGoalBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    requireScopedGoal(request, dependencies, goalId);
    const body = decodeAbi(ReviseGoalBodySchema, request.body);
    try {
      const result=dependencies.service.reviseWorkspaceGoalDefinition(goalId,{definition:body.definition,actorId:body.actorId,requestId:body.requestId});
      return successEnvelope(request,encodeAbi(ConsoleWorkspaceGoalRevisionSchema,result));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/roadmaps", { onRequest: write, schema: { params: GoalIdParamsSchema, body: RoadmapBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    requireScopedGoal(request, dependencies, goalId);
    const body = decodeAbi(RoadmapBodySchema, request.body);
    try {
      const result=dependencies.service.reviseWorkspaceGoalRoadmap(goalId,{content:body.content,sourceArtifactId:body.sourceArtifactId,actorId:body.actorId,requestId:body.requestId});
      return successEnvelope(request,encodeAbi(ConsoleWorkspaceGoalSchema,result));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/roadmap/generate", { onRequest: write, schema: { params: GoalIdParamsSchema, body: GenerateRoadmapBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    requireScopedGoal(request, dependencies, goalId);
    const body = decodeAbi(GenerateRoadmapBodySchema, request.body ?? {});
    try {
      const goal=await dependencies.service.requestWorkspaceGoalRoadmapGeneration(goalId,{requestId:body.requestId,actorId:body.actorId});
      return successEnvelope(request,encodeAbi(ConsoleWorkspaceGoalSchema,goal));
    } catch (error) { throw mapGoalError(error); }
  });

  app.get("/api/v1/console/workspace-goals/:goalId/operations/:requestId", { onRequest: read, schema: { params: GoalOperationParamsSchema } }, async (request) => {
    const { goalId, requestId } = request.params as GoalOperationParams;
    requireScopedGoal(request, dependencies, goalId);
    const receipt = dependencies.service.getWorkspaceGoalOperation(goalId, requestId);
    if (!receipt) throw consoleError(404, "workspace_goal.operation_not_found", "Workspace Goal operation not found");
    return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalOperationReceiptSchema, receipt));
  });

  app.post("/api/v1/console/workspace-goals/:goalId/task-runs", { onRequest: write, schema: { params: GoalIdParamsSchema, body: StartRoadmapItemBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    requireScopedGoal(request, dependencies, goalId);
    const body = decodeAbi(StartRoadmapItemBodySchema, request.body);
    try {
      const result = dependencies.service.startWorkspaceGoalRoadmapTask(goalId, body.roadmapItemId, body.requestId?.trim() || undefined);
      return successEnvelope(request, encodeAbi(ConsoleStartWorkspaceGoalTaskRunResultSchema, {
        goal: encodeAbi(ConsoleWorkspaceGoalSchema, result.goal),
        inboxItemId: result.inboxItemId,
        runId: result.runId,
      }));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/decisions", { onRequest: write, schema: { params: GoalIdParamsSchema, body: DecisionBodySchema } }, async (request) => {
    const { goalId } = request.params as GoalIdParams;
    requireScopedGoal(request, dependencies, goalId);
    const body = decodeAbi(DecisionBodySchema, request.body);
    try {
      const goal=dependencies.service.decideWorkspaceGoal({ goalId, requestId: body.requestId, targetRevisionId: body.targetRevisionId, targetHash: body.targetHash, kind: body.kind, approvedItemIds: body.approvedItemIds, reason: body.reason, actorId: body.actorId?.trim() || "web_console" });
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goal));
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
  if (message.includes("conflict") || message.includes("already") || message.includes("cannot")
    || message.includes("active TaskRun") || message.includes("queued") || message.includes("no longer launchable")) {
    return consoleError(409, "workspace_goal.conflict", message);
  }
  return consoleError(400, "workspace_goal.invalid", message);
}
