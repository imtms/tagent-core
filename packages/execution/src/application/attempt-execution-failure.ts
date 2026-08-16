import type { TaskRun } from "../domain/task-run.js";
import type { AttemptExecutionToken } from "../ports/attempt-runtime.js";
import type { ExecutionPersistencePort } from "../ports/execution-persistence.js";
import type { AttemptSettlementPort, RunEventPublisherPort } from "./collaboration-ports.js";
import { failRuntimeTaskRun, publishTransitionOutcome } from "./task-run-transition-helpers.js";

interface AttemptExecutionFailureInput {
  closing: boolean;
  run: TaskRun;
  token: AttemptExecutionToken;
  continuationId?: string;
  continuationOwner: string;
  error: unknown;
  persistence: Pick<ExecutionPersistencePort, "continuations" | "sessions" | "taskRuns" | "taskRunTransitions">;
  settlement: AttemptSettlementPort;
  eventHub: RunEventPublisherPort;
}

/** Last-resort terminalization for exceptions raised after the runtime itself has settled. */
export function settleAttemptExecutionFailure(input: AttemptExecutionFailureInput): void {
  if (input.closing) return;
  const message = `Attempt settlement failed safely: ${input.error instanceof Error ? input.error.message : String(input.error)}`;
  const current = input.persistence.taskRuns.getRun(input.run.id);
  if (current?.status === "running" && current.attempt === input.token.ordinal) {
    try {
      const transition = failRuntimeTaskRun(
        input.persistence.taskRunTransitions,
        input.token,
        message,
        { error: message, reason: "attempt_settlement_failed" },
      );
      input.persistence.sessions.appendMessage(input.run.sessionId, "assistant", `Run failed: ${message}`);
      publishTransitionOutcome(input.eventHub, transition);
    } catch {
      input.settlement.recoverInterruptedAttempt(input.token, message);
    }
  }
  if (input.continuationId && input.persistence.continuations.ownsContinuationLease(input.continuationId, input.continuationOwner)) {
    input.persistence.continuations.updateContinuation(input.continuationId, "failed", message, input.continuationOwner);
  }
}
