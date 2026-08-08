import type { RuntimeMessage } from "./attempt-runtime.js";
import type {
  RunCheckpoint,
  RunEvent,
  RunPhase,
  UserInputField,
  UserInputRequest,
} from "../domain/task-run.js";
import type {
  Attempt,
  AttemptAuthorityGate,
  AttemptAuthorityReceipt,
  AttemptAuthorityScenario,
  AttemptAuthorityState,
  AttemptId,
  AttemptShadowComparison,
  AttemptTransitionAudit,
  CandidateResult,
  ExecutionLease,
  TerminalAttemptStatus,
} from "../domain/index.js";
import type { Artifact, PlanItem, RunCheck } from "@tagent/governance/domain";
import type { OperationRecord, OperationUpdate } from "@tagent/governance/ports";

export interface ShadowComparisonInput {
  attemptId: string;
  scenario: AttemptAuthorityScenario;
  legacy: Record<string, unknown>;
  projected: Record<string, unknown>;
  mismatch: boolean;
  createdAt?: number;
}

export interface AttemptRepository {
  getAttempt(attemptId: string): Attempt | undefined;
  getAttemptForRun(runId: string, ordinal: number): Attempt | undefined;
  getActiveAttempt(runId: string): Attempt | undefined;
  listAttempts(runId: string): Attempt[];
  listTransitionAudit(attemptId: string): AttemptTransitionAudit[];
  listShadowComparisons(filter?: { attemptId?: string; runId?: string }): AttemptShadowComparison[];
  acquireExecutionLease(input: {
    attemptId: string;
    expectedVersion: number;
    ownerId: string;
    leaseMs: number;
    timestamp?: number;
  }): ExecutionLease;
  renewExecutionLease(input: {
    attemptId: string;
    ownerId: string;
    leaseToken: string;
    fence: number;
    leaseMs: number;
    timestamp?: number;
  }): ExecutionLease;
  releaseExecutionLease(input: {
    attemptId: string;
    ownerId: string;
    leaseToken: string;
    fence: number;
    timestamp?: number;
  }): boolean;
  recordCandidateResult(input: {
    id: string;
    attemptId: string;
    expectedVersion: number;
    leaseToken: string;
    fence: number;
    response: string;
    timestamp?: number;
  }): CandidateResult;
  settleAttempt(input: {
    attemptId: string;
    expectedVersion: number;
    leaseToken: string;
    fence: number;
    candidateResultId: string;
    supervisorDecisionId: string;
    status: TerminalAttemptStatus;
    reason: string;
    timestamp?: number;
  }): Attempt;
  recoverInterruptedAttempt(input: {
    attemptId: string;
    expectedVersion: number;
    ownerId: string;
    leaseToken: string;
    fence: number;
    reason: string;
    supervisorDecisionId?: string;
    timestamp?: number;
  }): { attempt: Attempt; event?: RunEvent; recovered: boolean };
  cancelAttempt(input: {
    attemptId: string;
    reason: string;
    timestamp?: number;
  }): { attempt: Attempt; event?: RunEvent; cancelled: boolean };
}

export interface AttemptAuthorityRepository {
  getAuthorityState(): AttemptAuthorityState;
  evaluateAuthorityGate(): AttemptAuthorityGate;
  recordShadowComparisons(inputs: ShadowComparisonInput[]): AttemptShadowComparison[];
  recordAuthorityReceipt(input: {
    id: string;
    requestedAttemptId: string;
    decision: AttemptAuthorityReceipt["decision"];
    actor: string;
    reason: string;
    createdAt?: number;
  }): AttemptAuthorityReceipt;
  requestAuthority(input: { requestedAttemptId: string; receiptId: string; timestamp?: number }): AttemptAuthorityState;
  assertAttemptApproved(attemptId: string): void;
  rollbackAuthority(input: { receiptId: string; timestamp?: number }): AttemptAuthorityState;
}

export interface FencedRuntimeMutationContext {
  attemptId: string;
  expectedVersion: number;
  leaseToken: string;
  fence: number;
  timestamp?: number;
}

export type TaskRunStateMutation =
  | { action: "phase"; phase: "discover" | "plan" | "implement" | "verify" | "review" }
  | { action: "plan"; item: Omit<PlanItem, "runId"> }
  | { action: "check"; check: RunCheck }
  | { action: "mark_checks_stale" }
  | { action: "artifact"; artifact: Omit<Artifact, "runId" | "createdAt"> };

/** Runtime-originated writes that validate the execution fence in the same SQLite transaction as the mutation. */
export interface FencedRuntimeMutationPort {
  appendEvent(context: FencedRuntimeMutationContext, type: string, data: Record<string, unknown>): RunEvent;
  appendTranscript(context: FencedRuntimeMutationContext, message: RuntimeMessage): number;
  setRunPhase(context: FencedRuntimeMutationContext, phase: RunPhase): boolean;
  advanceRunPhase(
    context: FencedRuntimeMutationContext,
    phase: Exclude<RunPhase, "done" | "blocked" | "waiting_input">,
  ): boolean;
  requestUserInput(
    context: FencedRuntimeMutationContext,
    prompt: string,
    fields: UserInputField[],
    toolCallId: string,
  ): { request: UserInputRequest; event: RunEvent; toolAttemptCompleted: true };
  upsertCheckpoint(
    context: FencedRuntimeMutationContext,
    checkpoint: Omit<RunCheckpoint, "runId" | "attempt" | "updatedAt"> & { updatedAt?: number },
  ): RunCheckpoint;
  claimOperation(
    context: FencedRuntimeMutationContext,
    id: string,
    operationType: string,
    payload: unknown,
  ): OperationRecord & { claimed: boolean };
  updateOperation(context: FencedRuntimeMutationContext, id: string, update: OperationUpdate): OperationRecord;
  recordToolAttempt(
    context: FencedRuntimeMutationContext,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): { argsHash: string; guard: { blocked: boolean; reason: string } };
  completeToolAttempt(
    context: FencedRuntimeMutationContext,
    toolCallId: string,
    success: boolean,
    error?: string,
  ): void;
  completeControlDelivery(
    context: FencedRuntimeMutationContext,
    itemId: string,
    status: "delivered" | "rejected",
    error?: string,
  ): { completed: true; event: RunEvent };
  completeSupervisorDecision(
    context: FencedRuntimeMutationContext,
    decisionId: string,
    status: "executed" | "failed",
    error: string,
    data: Record<string, unknown>,
  ): { completed: true; event: RunEvent };
  upsertPlanItem(context: FencedRuntimeMutationContext, item: Omit<PlanItem, "runId">): void;
  markChecksStale(context: FencedRuntimeMutationContext): number;
  upsertCheck(context: FencedRuntimeMutationContext, check: RunCheck): void;
  applyTaskRunBatch(context: FencedRuntimeMutationContext, mutations: TaskRunStateMutation[]): void;
  addArtifact(
    context: FencedRuntimeMutationContext,
    artifact: Omit<Artifact, "runId" | "createdAt">,
  ): Artifact;
}

export type { AttemptId };
