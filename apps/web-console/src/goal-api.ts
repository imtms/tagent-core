import type { ConsoleV1 } from "@tagent/abi";
import { createRequestId } from "./id";
import { withCoreAbi } from "./api-transport";

export type WorkspaceGoal = ConsoleV1.ConsoleWorkspaceGoal;
export type WorkspaceGoalSummary = ConsoleV1.ConsoleWorkspaceGoalSummary;
export type WorkspaceGoalDefinition = ConsoleV1.ConsoleWorkspaceGoalDefinition;
export type WorkspaceGoalRoadmap = ConsoleV1.ConsoleWorkspaceGoalRoadmap;
export type WorkspaceGoalRoadmapItem = ConsoleV1.ConsoleWorkspaceGoalRoadmapItem;
export type WorkspaceGoalOperationReceipt = ConsoleV1.ConsoleWorkspaceGoalOperationReceipt;

interface WorkspaceGoalTaskRunStart {
  goal: WorkspaceGoal;
  inboxItemId: string;
  runId: string | null;
}

export interface GoalApiRequest {
  <T>(url: string, init: RequestInit | undefined, decode: (payload: unknown) => T | Promise<T>): Promise<T>;
}

export function createGoalApi(request: GoalApiRequest) {
  return {
    workspaceGoals: (workspaceId: string) => request(`/api/v1/console/workspaces/${workspaceId}/goals`, undefined, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSummariesSchema, payload))),
    workspaceGoal: (goalId: string) => request(`/api/v1/console/workspace-goals/${goalId}`, undefined, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, payload))),
    createWorkspaceGoal: (workspaceId: string, definition: WorkspaceGoalDefinition) => request(`/api/v1/console/workspaces/${workspaceId}/goals`, { method: "POST", body: JSON.stringify({ definition, requestId: createRequestId(), actorId: "web_console" }) }, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, payload))),
    reviseWorkspaceGoal: (goalId: string, definition: WorkspaceGoalDefinition, requestId = createRequestId()) => request(`/api/v1/console/workspace-goals/${goalId}/definition-revisions`, { method: "POST", body: JSON.stringify({ definition, requestId, actorId: "web_console" }) }, (payload) => payload as Record<string, unknown>),
    addWorkspaceGoalRoadmap: (goalId: string, content: WorkspaceGoalRoadmap, requestId = createRequestId()) => request(`/api/v1/console/workspace-goals/${goalId}/roadmaps`, { method: "POST", body: JSON.stringify({ content, requestId, actorId: "web_console" }) }, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, payload))),
    generateWorkspaceGoalRoadmap: (goalId: string, requestId = createRequestId()) => request(`/api/v1/console/workspace-goals/${goalId}/roadmap/generate`, { method: "POST", body: JSON.stringify({ requestId, actorId: "web_console" }) }, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, payload))),
    workspaceGoalOperation: (goalId: string, requestId: string) => request(`/api/v1/console/workspace-goals/${encodeURIComponent(goalId)}/operations/${encodeURIComponent(requestId)}`, undefined, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalOperationReceiptSchema, payload))),
    startWorkspaceGoalRoadmapItem: (goalId: string, roadmapItemId: string) => request(`/api/v1/console/workspace-goals/${goalId}/task-runs`, { method: "POST", body: JSON.stringify({ roadmapItemId, requestId: createRequestId() }) }, decodeWorkspaceGoalTaskRunStart),
    decideWorkspaceGoal: (goalId: string, targetRevisionId: string, targetHash: string, kind: "approve_goal" | "approve_roadmap" | "request_change" | "pause" | "resume" | "close" | "cancel", approvedItemIds: string[] = [], reason = "") => request(`/api/v1/console/workspace-goals/${goalId}/decisions`, { method: "POST", body: JSON.stringify({ requestId: createRequestId(), targetRevisionId, targetHash, kind, approvedItemIds, reason, actorId: "web_console" }) }, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, payload))),
  };
}

async function decodeWorkspaceGoalTaskRunStart(payload: unknown): Promise<WorkspaceGoalTaskRunStart> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Workspace Goal TaskRun response");
  const value = payload as Record<string, unknown>;
  if (typeof value.inboxItemId !== "string" || !(typeof value.runId === "string" || value.runId === null)) {
    throw new Error("Invalid Workspace Goal TaskRun response");
  }
  return {
    goal: await withCoreAbi((abi) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, value.goal)),
    inboxItemId: value.inboxItemId,
    runId: value.runId,
  };
}
