import type { Attempt } from "../domain/attempt.js";
import type { RunId } from "../domain/task-run.js";
import type { ExecutionPersistencePort } from "../ports/execution-persistence.js";
import type { SystemTransitionAuthority, SystemTransitionCommand } from "../ports/task-run-transition-port.js";
import type { RunEventPublisherPort, RunResumeOptions } from "./collaboration-ports.js";

function resumeTransitionRequest(
  sourceAttempt: Attempt,
  options: RunResumeOptions,
): readonly [SystemTransitionCommand, SystemTransitionAuthority] {
  if (options.inputRequest) return [{
    kind: "resume_input",
    attemptId: sourceAttempt.id,
    expectedVersion: sourceAttempt.version,
    inputRequestId: options.inputRequest.id,
  }, { kind: "input_resume", inputRequestId: options.inputRequest.id }];
  if (options.approvalId) return [{
    kind: "resume_approval",
    attemptId: sourceAttempt.id,
    expectedVersion: sourceAttempt.version,
    approvalId: options.approvalId,
  }, { kind: "approval_resume", approvalId: options.approvalId }];
  return [{
    kind: "resume_manual",
    attemptId: sourceAttempt.id,
    expectedVersion: sourceAttempt.version,
    reason: options.reason ?? "Manual resume requested",
  }, { kind: "manual_resume", actorId: options.actorId ?? "user" }];
}

export function transitionResumedAttempt(
  persistence: Pick<ExecutionPersistencePort, "taskRunTransitions">,
  sourceAttempt: Attempt,
  options: RunResumeOptions,
) {
  return persistence.taskRunTransitions.transitionSystem(...resumeTransitionRequest(sourceAttempt, options));
}

export function settleResumePreparationFailure(input: {
  runId: RunId;
  attemptId: string;
  error: unknown;
  persistence: Pick<ExecutionPersistencePort, "attempts" | "taskRunTransitions">;
  eventHub: RunEventPublisherPort;
}): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const attempt = input.persistence.attempts.getAttempt(input.attemptId);
  try {
    if (!attempt) throw new Error(`Resume target Attempt ${input.attemptId} does not exist`, { cause: input.error });
    const failure = input.persistence.taskRunTransitions.transitionSystem({
      kind: "resume_preparation_failed",
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      error: message,
    }, {
      kind: "resume_preparation_failure",
      component: "run_context_service",
    }).transitions[0];
    if (!failure?.event) throw new Error(`TaskRun ${input.runId} resume preparation failure returned no terminal event`, { cause: input.error });
    input.eventHub.publish(failure.event);
  } catch (settlementError) {
    throw new AggregateError(
      [input.error, settlementError],
      `TaskRun ${input.runId} resume context preparation failed and could not be settled`,
      { cause: settlementError },
    );
  }
}
