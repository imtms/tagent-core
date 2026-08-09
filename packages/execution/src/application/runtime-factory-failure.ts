import type { TaskRun } from "../domain/task-run.js";
import type { AttemptExecutionToken } from "../ports/attempt-runtime.js";
import type { ExecutionStateView } from "./execution-state.js";
import { settleRuntimeInitializationFailure } from "./runtime-initialization-failure.js";
import type { AttemptSettlementPort, PostAttemptPort, RunEventPublisherPort } from "./collaboration-ports.js";

interface RuntimeFactoryFailureInput {
  state: ExecutionStateView<
    "checkpointDrafts" | "checkpointTokens" | "closing" | "lastCheckpointTranscriptSeq" | "persistence",
    "attempts" | "continuations" | "taskRuns" | "taskRunTransitions"
  >;
  run: TaskRun;
  token: AttemptExecutionToken;
  continuationId?: string;
  continuationOwner: string;
  launchOptions?: { initialize?: boolean; inboxItemId?: string; retry?: boolean };
  error: unknown;
  settlement: AttemptSettlementPort;
  postAttempt: PostAttemptPort;
  eventHub: RunEventPublisherPort;
}

export function settleRuntimeFactoryFailure(input: RuntimeFactoryFailureInput): void {
  const { state, run, token } = input;
  state.checkpointDrafts.delete(run.id);
  state.checkpointTokens.delete(run.id);
  state.lastCheckpointTranscriptSeq.delete(run.id);
  try {
    settleRuntimeInitializationFailure({
      closing: state.closing,
      run,
      token,
      launchOptions: input.launchOptions,
      error: input.error,
      persistence: state.persistence,
      settlement: input.settlement,
      postAttempt: input.postAttempt,
      eventHub: input.eventHub,
    });
  } finally {
    if (input.continuationId && state.persistence.continuations.ownsContinuationLease(input.continuationId, input.continuationOwner)) {
      const message = input.error instanceof Error ? input.error.message : String(input.error);
      state.persistence.continuations.updateContinuation(input.continuationId, "failed", message, input.continuationOwner);
    }
    state.persistence.attempts.releaseExecutionLease({
      attemptId: token.attemptId,
      ownerId: token.ownerId,
      leaseToken: token.leaseToken,
      fence: token.executionFence,
    });
    setImmediate(() => {
      try {
        if (!state.closing) input.postAttempt.attemptFinalized(run);
      } catch { /* Persistence resources may already be closed during shutdown. */ }
    });
  }
}
