import { createHash } from "node:crypto";
import type { RunId, TaskRun } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type {
  AttemptLauncherPort,
  AttemptSettlementPort,
  RecoveryControlPort,
  RunContextPort,
  RunEventPublisherPort,
  RuntimeControlPort,
  UserMessageObserverPort,
} from "./collaboration-ports.js";
import { effectiveTaskExecutionPolicy } from "@tagent/governance/domain";
import { taskPolicyResumeInstructions } from "./llm-payload.js";
import type { RuntimeProviderFailure } from "../ports/attempt-runtime.js";

type ContinuationState = ExecutionStateView<
  | "closing" | "continuationOwner" | "persistence" | "preparationTasks" | "runtimeDefaults" | "runtimes",
  "attempts" | "continuations" | "events" | "sessions" | "taskRuns"
>;

export class ContinuationScheduler {
  constructor(
    private readonly state: ContinuationState,
    private readonly dependencies: {
      attemptExecutor: AttemptLauncherPort;
      contextService: RunContextPort;
      eventHub: RunEventPublisherPort;
      recovery: RecoveryControlPort;
      runtimeRegistry: RuntimeControlPort;
      settlement: AttemptSettlementPort;
      userMessageObserver: UserMessageObserverPort;
    },
  ) {}


  public captureUserMessage(run: TaskRun, messageId: number, content: string, subjectId?: string) {
    const context = this.state.persistence.sessions.listRecentMessages(run.sessionId, 8).filter((message) => message.id < messageId).slice(-4).map((message) => `${message.role}: ${message.content}`).join("\n");
    this.dependencies.userMessageObserver.observe({ run, messageId, content, context, subjectId });
  }



  public queueContinuation(runId: RunId, providerFailure?: RuntimeProviderFailure) {
    const run = this.state.persistence.taskRuns.getRun(runId);
    if (!run || run.status !== "blocked") return;
    if (this.requiresExternalActionApproval(run)) return;
    const delayedProviderRetry = Boolean(providerFailure?.retryable && providerFailure.retryAfterMs);
    const currentSignature = continuationProgressSignature(run);
    const latestSignatures = run.continuations
      .filter((item) => !item.reason.includes("[provider-retry:"))
      .slice(-2)
      .map((item) => continuationReasonSignature(item.reason));
    if (!delayedProviderRetry && latestSignatures.length === 2 && latestSignatures.every((signature) => signature === currentSignature)) {
      this.state.persistence.sessions.appendMessage(run.sessionId, "assistant", `Run remains blocked because two continuations produced the same unresolved gate/evidence state without durable progress: ${run.blockedReason}`);
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.stalled", { reason: "repeated_gate_state", signature: currentSignature }));
      return;
    }
    const maxContinuations = this.state.runtimeDefaults.maxContinuations ?? 4;
    if (run.continuations.length >= maxContinuations) {
      const message = `Run remains blocked after ${maxContinuations} automatic continuation${maxContinuations === 1 ? "" : "s"}: ${run.blockedReason}`;
      this.state.persistence.sessions.appendMessage(run.sessionId, "assistant", message);
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.exhausted", { reason: "max_continuations", limit: maxContinuations }));
      return;
    }
    const notBefore = delayedProviderRetry ? Date.now() + providerFailure!.retryAfterMs! : 0;
    const providerMarker = delayedProviderRetry ? `\n[provider-retry:${providerFailure!.kind}:${notBefore}]` : "";
    const continuation = this.state.persistence.continuations.queueContinuation(runId, `${run.blockedReason}${providerMarker}\n[progress-signature:${currentSignature}]`, notBefore);
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.queued", {
      continuationId: continuation.id,
      ordinal: continuation.ordinal,
      reason: run.blockedReason,
      progressSignature: currentSignature,
      notBefore,
      ...(delayedProviderRetry ? { providerFailureKind: providerFailure!.kind, retryAfterMs: providerFailure!.retryAfterMs } : {}),
    }));
    this.dependencies.recovery.scheduleContinuationRecovery();
  }

  public startQueuedContinuation(runId: RunId) {
    if (this.state.closing) return;
    if (this.state.runtimes.has(runId)) return;
    const current = this.state.persistence.taskRuns.getRun(runId);
    if (current && this.requiresExternalActionApproval(current)) {
      const queued = current.continuations.some((continuation) => continuation.status === "queued");
      this.state.persistence.continuations.cancelQueuedContinuations(
        runId,
        "External-action continuation requires a fresh Attempt-bound approval",
      );
      if (queued) this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.stalled", {
        reason: "external_action_reapproval_required",
        attempt: current.attempt,
      }));
      return;
    }
    this.dependencies.recovery.repairTranscript(runId, "continuation");
    const claimed = this.state.persistence.continuations.claimContinuation(runId, this.state.continuationOwner, 30_000);
    if (!claimed) return;
    const { continuation, run, event } = claimed;
    this.dependencies.recovery.scheduleContinuationRecovery();
    let preparationLeaseTimer: ReturnType<typeof setInterval> | undefined;
    try {
      preparationLeaseTimer = setInterval(() => {
        if (!this.state.persistence.continuations.renewContinuationLease(continuation.id, this.state.continuationOwner, 30_000)) {
          if (preparationLeaseTimer) clearInterval(preparationLeaseTimer);
          preparationLeaseTimer = undefined;
          this.dependencies.recovery.recoverContinuations();
        }
      }, 10_000);
      preparationLeaseTimer.unref?.();
      const prompt = this.buildContinuationPrompt(run, continuation.ordinal, continuation.reason);
      const transcript = this.dependencies.contextService.prepareContinuationTranscript(run, prompt);
      this.dependencies.contextService.publishContextEvents(runId, transcript);
      this.dependencies.eventHub.publish(event);
      this.dependencies.attemptExecutor.launch(run, prompt, transcript.messages, continuation.id, { attemptContext: transcript.attemptContext });
    } catch (error) {
      const message = `Continuation preparation failed safely: ${error instanceof Error ? error.message : String(error)}`;
      this.state.persistence.continuations.releaseContinuationLease(continuation.id, this.state.continuationOwner, message);
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.preparation.failed", {
        continuationId: continuation.id, attempt: run.attempt, error: message,
      }));
      this.dependencies.recovery.scheduleContinuationRecovery();
    } finally {
      if (preparationLeaseTimer) clearInterval(preparationLeaseTimer);
    }
  }

  public buildContinuationPrompt(run: TaskRun, ordinal: number, continuationReason = "") {
    const policyInstructions = taskPolicyResumeInstructions(effectiveTaskExecutionPolicy(run.contract));
    const prerequisiteOnly = ["deterministic_plan_incomplete", "deterministic_check_incomplete"].includes(run.supervision.latestDecision?.reasonCode ?? "");
    const restartHandoff = /\[restart-handoff:(.+):([^:\]]+)\]\s*$/.exec(continuationReason);
    if (restartHandoff) return [
      `Core Generation handoff ${restartHandoff[1]} resumed after requesting release ${restartHandoff[2]}.`,
      "Continue from the persisted transcript, operation receipts, Context Manifest, checkpoints, and current TaskRun state. Do not repeat a settled external effect. Reconcile any outcome_unknown receipt before acting.",
      "Verify the active Core release and the work completed before restart, finish only the remaining objective, then provide one complete standalone final response.",
      ...policyInstructions,
      `Original goal: ${run.goal}`,
    ].join("\n\n");
    const crashRecovery = /\[crash-recovery:(\d+)\]\s*$/.exec(continuationReason);
    if (crashRecovery) return [
      `Automatic Core crash recovery resumed the interrupted TaskRun from restart event ${crashRecovery[1]}.`,
      "Core verified that there was no outcome_unknown operation or control delivery, no unfinished tool call, and no pending input or approval before queuing this continuation.",
      "Continue from the persisted transcript, operation receipts, Context Manifest, checkpoints, and current TaskRun state. Do not repeat a settled effect; complete only the interrupted work and then provide one standalone final response.",
      ...policyInstructions,
      `Original goal: ${run.goal}`,
    ].join("\n\n");
    const providerRetry = /\[provider-retry:([^:\]]+):(\d+)\]/.exec(continuationReason);
    if (providerRetry) return [
      `Automatic provider recovery ${ordinal} is running after the external ${providerRetry[1]} delay elapsed.`,
      "The previous Attempt ended because the provider was temporarily unavailable; this is not evidence that the TaskRun work or completion gates regressed.",
      "Continue from the persisted transcript and current TaskRun state. Do not redo completed work or repeat already successful external effects. Resume only the interrupted work, then provide a complete standalone final response.",
      ...policyInstructions,
      `Original goal: ${run.goal}`,
    ].join("\n\n");
    return [
      `Automatic continuation ${ordinal} is running because the completion gate blocked the previous attempt.`,
      `Gate failures: ${(run.supervision.latestGates.find((gate) => gate.gateType === "completion")?.failures ?? run.completionGate.failures).map((failure) => `${failure.key}: ${failure.reason}`).join("; ")}`,
      "The previous candidate response was rejected by Supervisor and was not delivered as the final chat answer. Do not merely acknowledge this continuation or repeat a short conclusion.",
      "Use the persisted transcript and TaskRun state. Resolve only the remaining gate failures, then provide a complete standalone final response that directly addresses the original contract.",
      prerequisiteOnly
        ? "Semantic contract coverage has not been evaluated yet. Do not interpret unevaluated acceptance criteria as unsupported, restart completed research, or rewrite existing deliverables; repair only the listed plan/check prerequisites, then submit the complete candidate for semantic review."
        : "",
      ...policyInstructions,
      `Original goal: ${run.goal}`,
    ].join("\n\n");
  }

  cancel(runId: RunId) {
    const runtime = this.state.runtimes.get(runId);
    const attempt = this.state.persistence.attempts.getActiveAttempt(runId);
    if (!attempt) return false;
    let cancellation: ReturnType<typeof this.state.persistence.attempts.cancelAttempt>;
    try {
      cancellation = this.state.persistence.attempts.cancelAttempt({
        attemptId: attempt.id,
        reason: "Cancelled by user",
      });
    } catch {
      return false;
    }
    if (!cancellation.cancelled || !cancellation.event) return false;
    this.dependencies.eventHub.publish(cancellation.event);
    this.state.preparationTasks.get(runId)?.controller.abort(new Error("Cancelled by user"));
    if (runtime) void this.dependencies.runtimeRegistry.abortRuntime(runtime, runId);
    return true;
  }

  private requiresExternalActionApproval(run: TaskRun) {
    return effectiveTaskExecutionPolicy(run.contract).mode === "external_action"
      || run.supervision.approvalRequests.some((approval) => approval.actionType === "execute_external_action");
  }
}

function continuationReasonSignature(reason: string) {
  const embedded = /\[progress-signature:([0-9a-f]{64})\]\s*$/.exec(reason)?.[1];
  if (embedded) return embedded;
  return createHash("sha256").update(normalizeGateText(reason)).digest("hex");
}

function continuationProgressSignature(run: TaskRun) {
  const gateFailures = (run.supervision.latestGates.find((gate) => gate.gateType === "completion")?.failures ?? run.completionGate.failures)
    .map((failure) => ({ kind: failure.kind, key: failure.key, disposition: "disposition" in failure ? failure.disposition : "local" }))
    .sort((left, right) => `${left.kind}:${left.key}`.localeCompare(`${right.kind}:${right.key}`));
  const state = {
    gateFailures,
    plan: run.plan.map(({ key, status, required }) => ({ key, status, required })).sort((left, right) => left.key.localeCompare(right.key)),
    checks: run.checks.map(({ key, status, required, stale, sourceOperationId, observedAt }) => ({ key, status, required, stale, sourceOperationId: sourceOperationId ?? null, observedAt: observedAt ?? null })).sort((left, right) => left.key.localeCompare(right.key)),
    artifacts: run.artifacts.map(({ id, kind, uri, content }) => ({ id, kind, uri, contentHash: createHash("sha256").update(content).digest("hex") })).sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function normalizeGateText(value: string) {
  return value.toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>").replace(/\d{10,}/g, "<number>").replace(/\s+/g, " ").trim();
}
