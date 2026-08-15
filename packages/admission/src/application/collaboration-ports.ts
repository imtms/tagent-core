import type { SessionId, Submission, SessionInputAnalysis } from "../domain/index.js";
import type { RunId, TaskRun } from "@tagent/execution/domain";

export interface AdmissionRouterPort {
  analyze(content: string, activeRun?: TaskRun, context?: {
    recentMessages?: Array<{ id: number; role: "user" | "assistant" | "tool"; content: string }>;
    recentRuns?: Array<Pick<TaskRun, "id" | "goal" | "status" | "phase" | "contract" | "updatedAt">>;
  }): Promise<SessionInputAnalysis>;
  takeUsage(analysis: SessionInputAnalysis): Array<{
    model: string;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  }>;
}

export interface AdmissionSupervisorPort {
  proposeParallelTaskStart(parentRunId: RunId, inboxItemId: string, summary: string): { id: string };
  proposeExternalActionStart(runId: RunId, summary: string): { id: string };
  markExecuted(id: string, status: "executed" | "superseded" | "failed", error?: string): unknown;
}

export interface AdmissionDispatchPort {
  launchClaimedSessionInbox(item: Submission, run: TaskRun, retry?: boolean): TaskRun | undefined;
  dispatchSessionInbox(sessionId: SessionId): TaskRun | undefined;
}
