import {
  ConsoleWorkspaceGoalSchema,
  ConsoleWorkspaceGoalSummariesSchema,
  decodeAbi,
  type ConsoleV1,
} from "@tagent/abi";
import { createRequestId } from "./id";

export type WorkspaceGoal = ConsoleV1.ConsoleWorkspaceGoal;
export type WorkspaceGoalSummary = ConsoleV1.ConsoleWorkspaceGoalSummary;
export type WorkspaceGoalDefinition = ConsoleV1.ConsoleWorkspaceGoalDefinition;
export type WorkspaceGoalPlan = ConsoleV1.ConsoleWorkspaceGoalPlan;
export type WorkspaceGoalPlanItem = ConsoleV1.ConsoleWorkspaceGoalPlanItem;
export type WorkspaceGoalDecision = ConsoleV1.ConsoleWorkspaceGoalDecision;

export interface GoalApiRequest {
  <T>(url: string, init: RequestInit | undefined, decode: (payload: unknown) => T | Promise<T>): Promise<T>;
}

export function createGoalApi(request: GoalApiRequest) {
  return {
    workspaceGoals: (workspaceId: string) => request(`/api/v1/console/workspaces/${workspaceId}/goals`, undefined, (payload) => decodeAbi(ConsoleWorkspaceGoalSummariesSchema, payload)),
    workspaceGoal: (goalId: string) => request(`/api/v1/console/workspace-goals/${goalId}`, undefined, (payload) => decodeAbi(ConsoleWorkspaceGoalSchema, payload)),
    createWorkspaceGoal: (workspaceId: string, definition: WorkspaceGoalDefinition) => request(`/api/v1/console/workspaces/${workspaceId}/goals`, { method: "POST", body: JSON.stringify({ definition, requestId: createRequestId(), actorId: "web_console" }) }, (payload) => decodeAbi(ConsoleWorkspaceGoalSchema, payload)),
    reviseWorkspaceGoal: (goalId: string, definition: WorkspaceGoalDefinition) => request(`/api/v1/console/workspace-goals/${goalId}/definition-revisions`, { method: "POST", body: JSON.stringify({ definition, actorId: "web_console" }) }, (payload) => payload as Record<string, unknown>),
    addWorkspaceGoalPlan: (goalId: string, content: WorkspaceGoalPlan) => request(`/api/v1/console/workspace-goals/${goalId}/plans`, { method: "POST", body: JSON.stringify({ content, actorId: "web_console" }) }, (payload) => payload as Record<string, unknown>),
    decideWorkspaceGoal: (goalId: string, targetRevisionId: string, targetHash: string, kind: "approve_goal" | "approve_plan" | "request_change" | "pause" | "resume" | "close" | "cancel", approvedItemIds: string[] = [], reason = "") => request(`/api/v1/console/workspace-goals/${goalId}/decisions`, { method: "POST", body: JSON.stringify({ targetRevisionId, targetHash, kind, approvedItemIds, reason, actorId: "web_console" }) }, (payload) => decodeAbi(ConsoleWorkspaceGoalSchema, payload)),
  };
}
