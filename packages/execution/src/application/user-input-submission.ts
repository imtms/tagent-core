import { effectiveTaskExecutionPolicy } from "@tagent/governance/domain";
import type { RunId, TaskRun, UserInputRequest } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type {
  ContinuationControlPort,
  ExternalActionApprovalBoundaryPort,
  RunEventPublisherPort,
  RuntimeControlPort,
} from "./collaboration-ports.js";

type UserInputSubmissionState = ExecutionStateView<
  "closing" | "executionTasks" | "persistence" | "runtimes",
  "approvals" | "attempts" | "events" | "sessions" | "taskRuns"
>;

interface UserInputSubmissionDependencies {
  continuation: ContinuationControlPort;
  eventHub: RunEventPublisherPort;
  externalActionApproval: ExternalActionApprovalBoundaryPort;
  runtimeRegistry: RuntimeControlPort;
  resume(runId: RunId, request: UserInputRequest): Promise<unknown>;
}

/** Submits requested data and preserves the separate external-approval boundary. */
export async function submitRunUserInput(
  state: UserInputSubmissionState,
  dependencies: UserInputSubmissionDependencies,
  requestId: string,
  response: Record<string, string>,
) {
  if (state.closing) throw new Error("Service is shutting down");
  const existing = state.persistence.taskRuns.getUserInputRequestById(requestId);
  if (!existing || existing.status !== "pending" && existing.status !== "submitted") {
    throw new Error("User input request is not pending");
  }
  let submitted: { request: UserInputRequest; run: TaskRun };
  if (existing.status === "pending") {
    const runtime = state.runtimes.get(existing.runId);
    if (runtime) {
      await dependencies.runtimeRegistry.abortRuntime(runtime, existing.runId);
      await state.executionTasks.get(existing.runId);
    }
    submitted = state.persistence.taskRuns.submitUserInput(requestId, response);
    const summary = submitted.request.fields
      .map((field) => `${field.label}: ${submitted.request.response[field.key] ?? ""}`)
      .join("\n");
    const message = state.persistence.sessions.appendMessage(submitted.run.sessionId, "user", summary);
    dependencies.continuation.captureUserMessage(submitted.run, message.id, summary);
    dependencies.eventHub.publish(state.persistence.events.appendEvent(submitted.run.id, "run.input.submitted", {
      requestId,
      fieldKeys: submitted.request.fields.map((field) => field.key),
      submittedAt: submitted.request.submittedAt,
    }));
  } else {
    const retriedResponse = Object.fromEntries(existing.fields.map((field) => [
      field.key,
      String(response[field.key] ?? "").trim(),
    ]));
    if (existing.fields.some((field) => retriedResponse[field.key] !== (existing.response[field.key] ?? ""))) {
      throw new Error("User input request was already submitted with a different response");
    }
    const run = state.persistence.taskRuns.getRun(existing.runId);
    if (!run) throw new Error(`TaskRun ${existing.runId} does not exist`);
    submitted = { request: existing, run };
  }

  const run = submitted.run;
  if (effectiveTaskExecutionPolicy(run.contract).mode !== "external_action") {
    return dependencies.resume(run.id, submitted.request);
  }
  if (run.status === "blocked" && state.persistence.approvals.hasPendingApproval(run.id)) return run;
  if (run.status !== "waiting_input" || run.pendingUserInput) {
    throw new Error("Submitted external-action input is not at a resumable approval boundary");
  }
  const sourceAttempt = state.persistence.attempts.getAttemptForRun(run.id, run.attempt);
  if (!sourceAttempt) throw new Error(`TaskRun ${run.id} has no source Attempt ${run.attempt}`);
  dependencies.externalActionApproval.requestAfterUserInput({
    runId: run.id,
    attemptId: sourceAttempt.id,
    attempt: run.attempt,
    expectedVersion: sourceAttempt.version,
    inputRequestId: submitted.request.id,
  });
  return state.persistence.taskRuns.getRun(run.id)!;
}
