import type { TaskRun } from "../domain/task-run.js";
import type { AttemptExecutionToken } from "../ports/attempt-runtime.js";
import type { ExecutionPersistencePort } from "../ports/execution-persistence.js";
import type {
  AttemptSettlementPort,
  PostAttemptPort,
  RunEventPublisherPort,
} from "./collaboration-ports.js";
import {
  failRuntimeTaskRun,
  publishTransitionOutcome,
} from "./task-run-transition-helpers.js";

interface RuntimeInitializationFailureInput {
  closing: boolean;
  run: TaskRun;
  token: AttemptExecutionToken;
  launchOptions?: { inboxItemId?: string; retry?: boolean };
  error: unknown;
  persistence: Pick<ExecutionPersistencePort, "taskRuns" | "taskRunTransitions">;
  settlement: AttemptSettlementPort;
  postAttempt: PostAttemptPort;
  eventHub: RunEventPublisherPort;
}

export function settleRuntimeInitializationFailure(input: RuntimeInitializationFailureInput): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const current = input.persistence.taskRuns.getRun(input.run.id);
  if (input.closing || current?.status !== "running" || current.attempt !== input.token.ordinal) return;

  if (input.settlement.isApprovedCanaryAttempt(input.token)) {
    const recovered = input.settlement.recoverInterruptedAttempt(
      input.token,
      `Runtime initialization failed: ${message}`,
    );
    if (recovered && input.launchOptions?.inboxItemId) {
      input.postAttempt.attemptLaunchFailed({
        inboxItemId: input.launchOptions.inboxItemId,
        runId: input.run.id,
        message,
      });
    }
    return;
  }

  const transition = failRuntimeTaskRun(
    input.persistence.taskRunTransitions,
    input.token,
    message,
    {
      error: message,
      reason: "runtime_initialization_failed",
      stage: "runtime_initialize",
      retryable: true,
      ...(input.launchOptions?.inboxItemId ? { inboxItemId: input.launchOptions.inboxItemId } : {}),
    },
    input.error,
  );
  publishTransitionOutcome(input.eventHub, transition);
  if (input.launchOptions?.inboxItemId) {
    input.postAttempt.attemptLaunchFailed({
      inboxItemId: input.launchOptions.inboxItemId,
      runId: input.run.id,
      message,
    });
  }
  input.settlement.projectWorkflowExperience(input.run.id);
}
