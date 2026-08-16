import type { TaskRun } from "../domain/task-run.js";
import type {
  ContinuationControlPort,
  PostAttemptPort,
  RunEventPublisherPort,
} from "./collaboration-ports.js";
import type { ExecutionPersistencePort } from "../ports/execution-persistence.js";

type PostAttemptInput = {
  closing: boolean;
  continuation: ContinuationControlPort;
  eventHub: RunEventPublisherPort;
  persistence: Pick<ExecutionPersistencePort, "events" | "taskRuns">;
  postAttempt: PostAttemptPort;
};

function reportFailure(
  input: PostAttemptInput,
  run: TaskRun,
  phase: "attempt_finalized" | "continuation_start" | "continuation_started",
  error: unknown,
): void {
  if (input.closing || !input.persistence.taskRuns.getRun(run.id)) return;
  try {
    input.eventHub.publish(input.persistence.events.appendEvent(run.id, "run.updated", {
      action: "post_attempt_failed",
      phase,
      error: error instanceof Error ? error.message : String(error),
    }));
  } catch { /* The original post-attempt failure remains authoritative. */ }
}

function runPhase(
  input: PostAttemptInput,
  run: TaskRun,
  phase: "attempt_finalized" | "continuation_start" | "continuation_started",
  operation: () => void,
): boolean {
  try {
    operation();
    return true;
  } catch (error) {
    reportFailure(input, run, phase, error);
    return false;
  }
}

export function finalizePostAttempt(input: {
  closing: boolean;
  continuation: ContinuationControlPort;
  eventHub: RunEventPublisherPort;
  persistence: Pick<ExecutionPersistencePort, "events" | "taskRuns">;
  postAttempt: PostAttemptPort;
}, run: TaskRun): void {
  runPhase(input, run, "attempt_finalized", () => {
    input.postAttempt.attemptFinalized(run, { shuttingDown: input.closing });
  });
  if (input.closing) return;
  if (!runPhase(input, run, "continuation_start", () => {
    input.continuation.startQueuedContinuation(run.id);
  })) return;
  runPhase(input, run, "continuation_started", () => {
    input.postAttempt.continuationStarted(run.id);
  });
}
