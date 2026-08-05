import type { CanonicalJsonValue, GateEvaluation } from "@tagent/governance/domain";
import type { RunEvent, RunId } from "../domain/task-run.js";
import type { AttemptExecutionToken } from "../ports/attempt-runtime.js";
import type {
  MessageRejectedPrecedingEvent,
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

export function completeRuntimeTaskRun(
  transitions: TaskRunTransitionPort,
  token: AttemptExecutionToken,
  data: Readonly<Record<string, CanonicalJsonValue>>,
): TaskRunTransitionOutcome & { event: RunEvent } {
  return requireTerminalTransition(transitions.transitionRuntime(
    { kind: "complete", reason: "", data },
    runtimeTransitionFence(token),
  ), token.runId);
}

export function blockRuntimeTaskRun(
  transitions: TaskRunTransitionPort,
  token: AttemptExecutionToken,
  reason: string,
  data: Readonly<Record<string, CanonicalJsonValue>>,
  precedingEvents?: readonly MessageRejectedPrecedingEvent[],
): TaskRunTransitionOutcome & { event: RunEvent } {
  return requireTerminalTransition(transitions.transitionRuntime({
    kind: "block",
    reason,
    data,
    ...(precedingEvents ? { precedingEvents } : {}),
  }, runtimeTransitionFence(token)), token.runId);
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

export function canonicalGateEvaluations(gates: readonly GateEvaluation[]): CanonicalJsonValue[] {
  return gates.map((gate) => ({
    id: gate.id,
    runId: gate.runId,
    attempt: gate.attempt,
    checkpointSeq: gate.checkpointSeq,
    gateType: gate.gateType,
    evaluator: gate.evaluator,
    evaluatorModel: gate.evaluatorModel,
    summary: gate.summary,
    passed: gate.passed,
    failures: gate.failures.map((failure) => ({ ...failure })),
    ...(gate.criterionCoverage === undefined ? {} : {
      criterionCoverage: gate.criterionCoverage.map((criterion) => ({
        ...criterion,
        evidenceRefs: [...criterion.evidenceRefs],
      })),
    }),
    inputManifestHash: gate.inputManifestHash,
    createdAt: gate.createdAt,
  }));
}

export function requireTerminalTransition(
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
