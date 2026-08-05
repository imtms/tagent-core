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

type ContinuationState = ExecutionStateView<
  | "closing" | "continuationOwner" | "persistence" | "runtimeDefaults" | "runtimes",
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


  public captureUserMessage(run: TaskRun, messageId: number, content: string) {
    const context = this.state.persistence.sessions.listRecentMessages(run.sessionId, 8).filter((message) => message.id < messageId).slice(-4).map((message) => `${message.role}: ${message.content}`).join("\n");
    this.dependencies.userMessageObserver.observe({ run, messageId, content, context });
  }



  public queueContinuation(runId: RunId) {
    const run = this.state.persistence.taskRuns.getRun(runId);
    if (!run || run.status !== "blocked") return;
    const latestReasons = run.continuations.slice(-2).map((item) => item.reason.replace(/\s+/g, " ").trim());
    const currentReason = run.blockedReason.replace(/\s+/g, " ").trim();
    if (latestReasons.length === 2 && latestReasons.every((reason) => reason === currentReason)) {
      this.state.persistence.sessions.appendMessage(run.sessionId, "assistant", `Run remains blocked because two continuations produced the same unresolved gate failure without a changed diagnosis: ${run.blockedReason}`);
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.stalled", { reason: "repeated_gate_failure", repeatedReason: currentReason }));
      return;
    }
    const maxContinuations = this.state.runtimeDefaults.maxContinuations ?? 128;
    if (run.continuations.length >= maxContinuations) {
      const message = `Run remains blocked after ${maxContinuations} automatic continuation${maxContinuations === 1 ? "" : "s"}: ${run.blockedReason}`;
      this.state.persistence.sessions.appendMessage(run.sessionId, "assistant", message);
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.exhausted", { reason: "max_continuations", limit: maxContinuations }));
      return;
    }
    const continuation = this.state.persistence.continuations.queueContinuation(runId, run.blockedReason);
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.queued", { continuationId: continuation.id, ordinal: continuation.ordinal, reason: continuation.reason }));
  }

  public startQueuedContinuation(runId: RunId) {
    if (this.state.closing) return;
    if (this.state.runtimes.has(runId)) return;
    this.dependencies.recovery.repairTranscript(runId, "continuation");
    const claimed = this.state.persistence.continuations.claimContinuation(runId, this.state.continuationOwner, 30_000);
    if (!claimed) return;
    const { continuation, run, event } = claimed;
    const prompt = this.buildContinuationPrompt(run, continuation.ordinal);
    const transcript = this.dependencies.contextService.prepareContinuationTranscript(run, prompt);
    this.dependencies.contextService.publishContextEvents(runId, transcript);
    this.dependencies.eventHub.publish(event);
    this.dependencies.attemptExecutor.launch(run, prompt, transcript.messages, continuation.id);
  }

  public buildContinuationPrompt(run: TaskRun, ordinal: number) {
    return [
      `Automatic continuation ${ordinal} is running because the completion gate blocked the previous attempt.`,
      `Gate failures: ${(run.supervision.latestGates.find((gate) => gate.gateType === "completion")?.failures ?? run.completionGate.failures).map((failure) => `${failure.key}: ${failure.reason}`).join("; ")}`,
      "The previous candidate response was rejected by Supervisor and was not delivered as the final chat answer. Do not merely acknowledge this continuation or repeat a short conclusion.",
      "Use the persisted transcript and TaskRun state. Resolve only the remaining gate failures, verify the result, then provide a complete standalone final response that directly addresses the original contract.",
      "Completion-gate requirements override conflicting instructions in the original goal.",
      `Original goal: ${run.goal}`,
    ].join("\n\n");
  }

  cancel(runId: RunId) {
    const runtime = this.state.runtimes.get(runId);
    if (!runtime) return false;
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
    this.dependencies.settlement.projectWorkflowExperience(runId);
    void this.dependencies.runtimeRegistry.abortRuntime(runtime, runId);
    return true;
  }
}
