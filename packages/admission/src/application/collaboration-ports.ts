import type { SessionId, Submission } from "../domain/index.js";
import type { RoutedSessionInputAnalysis, SessionInputRouterContext } from "./session-input-router.js";
import type { RunId, TaskRun } from "@tagent/execution/domain";

export interface AdmissionRouterPort {
  route(content: string, activeRun?: TaskRun, context?: SessionInputRouterContext): Promise<RoutedSessionInputAnalysis>;
}

export interface AdmissionSupervisorPort {
  proposeParallelTaskStart(parentRunId: RunId, inboxItemId: string, summary: string): { id: string };
  proposeExternalActionStart(runId: RunId, summary: string): { id: string };
  markExecuted(id: string, status: "executed" | "superseded" | "failed", error?: string): unknown;
}

export interface AdmissionExternalActionApprovalPort {
  requestForInitialLaunch(item: Submission, run: TaskRun, retry: boolean): void;
  requestForTool(input: {
    runId: RunId; attemptId: string; attempt: number; expectedVersion: number; toolCallId: string; toolName: string;
  }): { approvalId: string; reason: string };
  requestAfterUserInput(input: {
    runId: RunId; attemptId: string; attempt: number; expectedVersion: number; inputRequestId: string;
  }): { approvalId: string; reason: string };
  requestForResume(input: {
    runId: RunId; attemptId: string; attempt: number; expectedVersion: number; actorId: string; reason: string;
  }): { approvalId: string; reason: string };
}

export interface AdmissionDispatchPort {
  launchClaimedSessionInbox(item: Submission, run: TaskRun, retry?: boolean): TaskRun | undefined;
  dispatchSessionInbox(sessionId: SessionId): TaskRun | undefined;
  requestExternalActionApproval(input: {
    runId: RunId;
    attemptId: string;
    attempt: number;
    expectedVersion: number;
    toolCallId: string;
    toolName: string;
  }): { approvalId: string; reason: string };
  requestExternalActionApprovalAfterUserInput(input: {
    runId: RunId;
    attemptId: string;
    attempt: number;
    expectedVersion: number;
    inputRequestId: string;
  }): { approvalId: string; reason: string };
  requestExternalActionApprovalForResume(input: {
    runId: RunId;
    attemptId: string;
    attempt: number;
    expectedVersion: number;
    actorId: string;
    reason: string;
  }): { approvalId: string; reason: string };
}
