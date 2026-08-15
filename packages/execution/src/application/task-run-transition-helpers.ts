import type { CanonicalJsonValue } from "@tagent/governance/domain";
import type { RunEvent, RunId } from "../domain/task-run.js";
import type { AttemptExecutionToken } from "../ports/attempt-runtime.js";
import type {
  TaskRunTransitionPort,
  TaskRunTransitionOutcome,
  TaskRunTransitionResult,
} from "../ports/task-run-transition-port.js";
import type { RunEventPublisherPort } from "./collaboration-ports.js";

function runtimeTransitionFence(token: AttemptExecutionToken) {
  return {
    attemptId: token.attemptId,
    expectedVersion: token.expectedVersion,
    leaseToken: token.leaseToken,
    executionFence: token.executionFence,
  };
}

export function failRuntimeTaskRun(
  transitions: TaskRunTransitionPort,
  token: AttemptExecutionToken,
  reason: string,
  data: Readonly<Record<string, CanonicalJsonValue>>,
  cause?: unknown,
): TaskRunTransitionOutcome & { event: RunEvent } {
  return requireTerminalTransition(transitions.transitionRuntime(
    { kind: "fail", reason, data },
    runtimeTransitionFence(token),
  ), token.runId, cause);
}

function requireTerminalTransition(
  result: TaskRunTransitionResult,
  runId: RunId,
  cause?: unknown,
): TaskRunTransitionOutcome & { event: RunEvent } {
  const [outcome, ...unexpected] = result.transitions;
  if (!outcome || unexpected.length > 0 || !outcome.event) {
    throw new Error(`TaskRun ${runId} transition did not return exactly one terminal outcome`, {
      cause,
    });
  }
  return outcome as TaskRunTransitionOutcome & { event: RunEvent };
}

export function publishTransitionOutcome(
  publisher: RunEventPublisherPort,
  outcome: TaskRunTransitionOutcome & { event: RunEvent },
): void {
  for (const event of outcome.precedingEvents) publisher.publish(event);
  publisher.publish(outcome.event);
}
