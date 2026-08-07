import type { FastifyInstance } from "fastify";
import {
  ConsoleWorkspaceGoalDefinitionSchema,
  ConsoleWorkspaceGoalPlanSchema,
  ConsoleWorkspaceGoalSchema,
  ConsoleWorkspaceGoalSummarySchema,
  encodeAbi,
} from "@tagent/abi";
import { WorkspaceGoalService, type WorkspaceGoalDecisionKind } from "@tagent/governance";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

export function registerConsoleGoalV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const goals = new WorkspaceGoalService(dependencies.persistence.workspaceGoals);
  const read = authorizeConsole(dependencies, "sessions:read");
  const write = authorizeConsole(dependencies, "sessions:write");

  app.get("/api/v1/console/workspaces/:workspaceId/goals", { onRequest: read }, async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    if (!dependencies.persistence.sessions.getSession(workspaceId)) throw consoleError(404, "workspace.not_found", "workspace not found");
    return successEnvelope(request, goals.list(workspaceId).map((goal) => encodeAbi(ConsoleWorkspaceGoalSummarySchema, goal)));
  });

  app.post("/api/v1/console/workspaces/:workspaceId/goals", { onRequest: write }, async (request) => {
    const { workspaceId } = request.params as { workspaceId: string };
    if (!dependencies.persistence.sessions.getSession(workspaceId)) throw consoleError(404, "workspace.not_found", "workspace not found");
    const body = (request.body ?? {}) as { definition?: unknown; requestId?: string; actorId?: string };
    try {
      const definition = encodeAbi(ConsoleWorkspaceGoalDefinitionSchema, body.definition as never);
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.create({ workspaceId, definition, createdBy: body.actorId?.trim() || "web_console", idempotencyKey: body.requestId?.trim() || undefined })));
    } catch (error) { throw mapGoalError(error); }
  });

  app.get("/api/v1/console/workspace-goals/:goalId", { onRequest: read }, async (request) => {
    const goal = goals.get((request.params as { goalId: string }).goalId);
    if (!goal) throw consoleError(404, "workspace_goal.not_found", "Workspace Goal not found");
    return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goal));
  });

  app.post("/api/v1/console/workspace-goals/:goalId/definition-revisions", { onRequest: write }, async (request) => {
    const { goalId } = request.params as { goalId: string };
    const body = (request.body ?? {}) as { definition?: unknown; actorId?: string };
    try { return successEnvelope(request, goals.reviseDefinition(goalId, encodeAbi(ConsoleWorkspaceGoalDefinitionSchema, body.definition as never), body.actorId?.trim() || "web_console")); }
    catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/plans", { onRequest: write }, async (request) => {
    const { goalId } = request.params as { goalId: string };
    const body = (request.body ?? {}) as { content?: unknown; sourceArtifactId?: string; actorId?: string };
    try {
      const content = encodeAbi(ConsoleWorkspaceGoalPlanSchema, body.content as never);
      return successEnvelope(request, goals.addPlan(goalId, content, body.sourceArtifactId ?? null, body.actorId?.trim() || "web_console"));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/decisions", { onRequest: write }, async (request) => {
    const { goalId } = request.params as { goalId: string };
    const body = (request.body ?? {}) as { targetRevisionId?: string; targetHash?: string; kind?: WorkspaceGoalDecisionKind; approvedItemIds?: string[]; reason?: string; actorId?: string };
    if (!body.targetRevisionId || !body.targetHash || !body.kind) throw consoleError(400, "workspace_goal.decision_invalid", "targetRevisionId, targetHash and kind are required");
    try {
      goals.decide({ goalId, targetRevisionId: body.targetRevisionId, targetHash: body.targetHash, kind: body.kind, approvedItemIds: body.approvedItemIds, reason: body.reason, actorId: body.actorId?.trim() || "web_console" });
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
    } catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/run-links", { onRequest: write }, async (request) => {
    const { goalId } = request.params as { goalId: string };
    const body = (request.body ?? {}) as { runId?: string; goalRevision?: number; planRevisionId?: string | null; approvedItemIds?: string[]; criterionKeys?: string[] };
    try { return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.linkRun({ goalId, runId: body.runId ?? "", goalRevision: Number(body.goalRevision), planRevisionId: body.planRevisionId, approvedItemIds: body.approvedItemIds, criterionKeys: body.criterionKeys }))); }
    catch (error) { throw mapGoalError(error); }
  });

  app.post("/api/v1/console/workspace-goals/:goalId/evidence", { onRequest: write }, async (request) => {
    const { goalId } = request.params as { goalId: string };
    const body = (request.body ?? {}) as { goalRevision?: number; criterionKey?: string; runId?: string; checkKey?: string | null; artifactId?: string | null; operationId?: string | null; sourceDigest?: string; status?: "valid" | "stale" | "contradicted" };
    try {
      goals.linkEvidence({ goalId, goalRevision: Number(body.goalRevision), criterionKey: body.criterionKey ?? "", runId: body.runId ?? "", checkKey: body.checkKey, artifactId: body.artifactId, operationId: body.operationId, sourceDigest: body.sourceDigest ?? "", status: body.status });
      return successEnvelope(request, encodeAbi(ConsoleWorkspaceGoalSchema, goals.get(goalId)!));
    } catch (error) { throw mapGoalError(error); }
  });
}

function mapGoalError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) return consoleError(404, "workspace_goal.not_found", message);
  if (message.includes("stale") || message.includes("conflict") || message.includes("not ready")) return consoleError(409, "workspace_goal.conflict", message);
  return consoleError(400, "workspace_goal.invalid", message);
}
