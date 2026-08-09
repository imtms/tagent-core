import type { AttemptRuntimePort, AttemptExecutionToken, RuntimeMessage as AgentMessage } from "../ports/attempt-runtime.js";
import type { TaskRun } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import { failRuntimeTaskRun, publishTransitionOutcome } from "./task-run-transition-helpers.js";
import { settleRuntimeInitializationFailure } from "./runtime-initialization-failure.js";
import { settleRuntimeFactoryFailure } from "./runtime-factory-failure.js";
import { settleAttemptExecutionFailure } from "./attempt-execution-failure.js";
import { selectRuntimeModel } from "./runtime-model-selection.js";
import type {
  AttemptSettlementPort,
  ContinuationControlPort,
  ControlCommandPort,
  PostAttemptPort,
  RecoveryControlPort,
  RunContextPort,
  RunEventPublisherPort,
  RuntimeControlPort,
  RuntimeHostFactoryPort,
  SupervisorPort,
} from "./collaboration-ports.js";

type AttemptExecutorState = ExecutionStateView<
  | "checkpointDrafts" | "checkpointTimers" | "checkpointTokens" | "closing"
  | "continuationOwner" | "executionOwner" | "executionTasks"
  | "lastCheckpointTranscriptSeq" | "persistence"
  | "recalledMemory" | "runtimeDefaults" | "runtimeFactory" | "runtimes"
  | "workspace",
  | "attempts" | "continuations" | "events" | "runtime" | "runtimeMutations"
  | "sessions" | "taskRuns" | "taskRunTransitions" | "transcript"
>;
export class AttemptExecutor {
  constructor(
    private readonly state: AttemptExecutorState,
    private readonly dependencies: {
      contextService: RunContextPort;
      continuation: ContinuationControlPort;
      controlInbox: ControlCommandPort;
      eventHub: RunEventPublisherPort;
      postAttempt: PostAttemptPort;
      recovery: RecoveryControlPort;
      runtimeHost: RuntimeHostFactoryPort;
      runtimeRegistry: RuntimeControlPort;
      settlement: AttemptSettlementPort;
      supervisor: SupervisorPort;
    },
  ) {}
  public launch(run: TaskRun, prompt: string, initialMessages: AgentMessage[] = [], continuationId?: string, launchOptions?: { initialize?: boolean; inboxItemId?: string; retry?: boolean }) {
    if (this.state.closing) return;
    const idleTimeoutMs = this.state.runtimeDefaults.runTimeoutMs ?? 120_000;
    const hardTimeoutMs = this.state.runtimeDefaults.runHardTimeoutMs ?? 86_400_000;
    const executionLeaseMs = this.state.runtimeDefaults.executionLeaseMs ?? 30_000;
    const executionLeaseHeartbeatMs = this.state.runtimeDefaults.executionLeaseHeartbeatMs ?? 10_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    let executionLeaseTimer: ReturnType<typeof setInterval> | undefined;
    let runtime: AttemptRuntimePort;
    let lastActivityAt = Date.now();
    let runtimeSettled = false;
    const failTimeout = (reason: "idle_timeout" | "hard_timeout", limitMs: number) => {
      const current = this.state.persistence.taskRuns.getRun(run.id);
      if (!current || current.status !== "running" || current.attempt !== token.ordinal) return;
      void this.dependencies.runtimeRegistry.abortRuntime(runtime, run.id);
      const message = reason === "idle_timeout"
        ? `Run idle for ${limitMs}ms without progress`
        : `Run exceeded ${limitMs}ms absolute hard timeout`;
      const currentAttempt = this.state.persistence.attempts.getAttempt(token.attemptId);
      if (currentAttempt?.status === "settling" || this.dependencies.settlement.isApprovedCanaryAttempt(token)) {
        this.dependencies.settlement.recoverInterruptedAttempt(token, message);
        return;
      }
      const transition = failRuntimeTaskRun(
        this.state.persistence.taskRunTransitions, token, message, { error: message, reason, limitMs },
      );
      this.state.persistence.sessions.appendMessage(run.sessionId, "assistant", `Run failed: ${message}`);
      publishTransitionOutcome(this.dependencies.eventHub, transition);
      this.dependencies.settlement.projectWorkflowExperience(run.id);
    };
    const checkIdle = () => {
      idleTimer = undefined;
      if (runtimeSettled || this.state.persistence.taskRuns.getRun(run.id)?.status !== "running") return;
      const remaining = idleTimeoutMs - (Date.now() - lastActivityAt);
      if (remaining > 0) {
        idleTimer = setTimeout(checkIdle, remaining);
        return;
      }
      failTimeout("idle_timeout", idleTimeoutMs);
    };
    const touchActivity = () => {
      if (!idleTimeoutMs || runtimeSettled) return;
      lastActivityAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(checkIdle, idleTimeoutMs);
    };
    const stopIdleWatchdog = () => {
      runtimeSettled = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    const attempt = this.state.persistence.attempts.getAttemptForRun(run.id, run.attempt);
    if (!attempt || !attempt.active || attempt.status !== "running") {
      throw new Error(`Active Attempt ${run.id}:${run.attempt} is unavailable`);
    }
    const executionLease = this.state.persistence.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: this.state.executionOwner,
      leaseMs: executionLeaseMs,
    });
    const token: AttemptExecutionToken = {
      runId: run.id,
      attemptId: attempt.id,
      ordinal: run.attempt,
      expectedVersion: attempt.version,
      ownerId: this.state.executionOwner,
      leaseToken: executionLease.token,
      executionFence: executionLease.fence,
    };
    const checkpointBase = this.state.persistence.taskRuns.getRun(run.id) ?? run;
    this.state.checkpointDrafts.set(run.id, { runId: run.id, attempt: run.attempt, active: true, assistantPartial: "", currentTool: null, lastEventSeq: checkpointBase.lastEventSeq });
    this.state.checkpointTokens.set(run.id, token);
    this.state.lastCheckpointTranscriptSeq.set(run.id, checkpointBase.checkpoint?.lastTranscriptSeq ?? this.state.persistence.transcript.getLastTranscriptSeq(run.id));
    try {
      this.dependencies.eventHub.flushCheckpoint(run.id);
    } catch (error) {
      this.state.checkpointDrafts.delete(run.id);
      this.state.checkpointTokens.delete(run.id);
      this.state.lastCheckpointTranscriptSeq.delete(run.id);
      this.state.persistence.attempts.releaseExecutionLease({
        attemptId: token.attemptId,
        ownerId: token.ownerId,
        leaseToken: token.leaseToken,
        fence: token.executionFence,
      });
      throw error;
    }
    const runtimeHost = this.dependencies.runtimeHost.create({
      token,
      onActivity: touchActivity,
      onEvent: (event) => {
        touchActivity();
        this.dependencies.eventHub.updateCheckpoint(event);
        this.dependencies.eventHub.publish(event);
        const decision = this.dependencies.supervisor.reviewCheckpoint(run.id, event);
        if (decision?.action === "steer") {
          void this.dependencies.controlInbox.enqueueControl(run.id, "steer", decision.instruction, `supervisor:${decision.id}`).then((result) => {
            const current = this.state.persistence.taskRuns.getRun(run.id);
            if (!current || current.status !== "running" || current.attempt !== decision.attempt
              || current.lastEventSeq < decision.checkpointSeq
              || this.state.persistence.attempts.getActiveAttempt(run.id)?.id !== token.attemptId) {
              return this.dependencies.supervisor.markExecuted(decision.id, "superseded");
            }
            try {
              const completion = this.state.persistence.runtimeMutations.completeSupervisorDecision({
                attemptId: token.attemptId,
                expectedVersion: token.expectedVersion,
                leaseToken: token.leaseToken,
                fence: token.executionFence,
              }, decision.id, result.status === "accepted" ? "executed" : "failed", result.status, {
                action: decision.action,
                reasonCode: decision.reasonCode,
                status: result.status,
              });
              this.dependencies.eventHub.publish(completion.event);
            } catch { /* Cancellation/recovery atomically supersedes the proposed decision. */ }
          });
        }
      },
      memorySubjectId: `session:${run.sessionId}`,
    });
    try {
      const executionProfile = selectRuntimeModel(run, this.state.runtimeDefaults.model, this.state.runtimeDefaults.fallbackModels);
      runtime = this.state.runtimeFactory({
        token,
        workspace: this.state.workspace,
        systemPrompt: this.dependencies.contextService.buildSystemPrompt(run, this.state.recalledMemory.get(run.id) ?? ""),
        capabilities: runtimeHost.capabilities,
        eventSink: runtimeHost.eventSink,
        initialMessages,
        model: executionProfile.model,
        fallbackModels: executionProfile.fallbackModels,
        reasoningEffort: executionProfile.reasoningEffort,
        apiKey: this.state.runtimeDefaults.apiKey,
        providerTimeoutMs: this.state.runtimeDefaults.providerTimeoutMs,
        providerMaxRetries: this.state.runtimeDefaults.providerMaxRetries,
        runTimeoutMs: this.state.runtimeDefaults.runTimeoutMs,
        runHardTimeoutMs: this.state.runtimeDefaults.runHardTimeoutMs,
        historicalToolResultChars: this.state.runtimeDefaults.historicalToolResultChars,
        historicalTaskRunReceiptChars: this.state.runtimeDefaults.historicalTaskRunReceiptChars,
      });
    } catch (error) {
      settleRuntimeFactoryFailure({ state: this.state, run, token, continuationId, continuationOwner: this.state.continuationOwner, launchOptions, error,
        settlement: this.dependencies.settlement, postAttempt: this.dependencies.postAttempt, eventHub: this.dependencies.eventHub });
      return;
    }
    this.state.runtimes.set(run.id, runtime);
    executionLeaseTimer = setInterval(() => {
      try {
        this.state.persistence.attempts.renewExecutionLease({
          attemptId: token.attemptId,
          ownerId: token.ownerId,
          leaseToken: token.leaseToken,
          fence: token.executionFence,
          leaseMs: executionLeaseMs,
        });
      } catch (error) {
        if (executionLeaseTimer) clearInterval(executionLeaseTimer);
        executionLeaseTimer = undefined;
        this.dependencies.settlement.recoverInterruptedAttempt(
          token,
          `Execution lease heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        void this.dependencies.runtimeRegistry.abortRuntime(runtime, run.id);
      }
    }, executionLeaseHeartbeatMs);
    executionLeaseTimer.unref?.();
    if (continuationId) leaseTimer = setInterval(() => {
      if (this.state.persistence.continuations.renewContinuationLease(continuationId, this.state.continuationOwner, 30_000)) return;
      if (leaseTimer) clearInterval(leaseTimer);
      leaseTimer = undefined;
      const current = this.state.persistence.taskRuns.getRun(run.id);
      if (current?.status === "running" && current.attempt === token.ordinal) {
        this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(run.id, "continuation.lease.lost", { continuationId, attempt: token.ordinal, leaseOwner: this.state.continuationOwner }));
      }
      void this.dependencies.runtimeRegistry.abortRuntime(runtime, run.id);
      this.dependencies.recovery.recoverContinuations();
    }, 10_000);
    touchActivity();
    hardTimer = setTimeout(() => failTimeout("hard_timeout", hardTimeoutMs), hardTimeoutMs);

    const execution = (async () => {
      if (launchOptions?.initialize && runtime.initialize) {
        try {
          await runtime.initialize();
          const event = this.state.persistence.runtimeMutations.appendEvent({
            attemptId: token.attemptId,
            expectedVersion: token.expectedVersion,
            leaseToken: token.leaseToken,
            fence: token.executionFence,
          }, "runtime.initialized", { inboxItemId: launchOptions.inboxItemId, retry: Boolean(launchOptions.retry), attempt: token.ordinal });
          this.dependencies.eventHub.publish(event);
        } catch (error) {
          settleRuntimeInitializationFailure({
            closing: this.state.closing, run, token, launchOptions, error,
            persistence: this.state.persistence,
            settlement: this.dependencies.settlement, postAttempt: this.dependencies.postAttempt,
            eventHub: this.dependencies.eventHub,
          });
          return false;
        }
      }
      return this.dependencies.settlement.execute(run.id, token, runtime, prompt, continuationId, stopIdleWatchdog);
    })().then((blocked) => {
      if (this.state.closing) return;
      if (continuationId) {
        if (!this.state.persistence.continuations.ownsContinuationLease(continuationId, this.state.continuationOwner)) return;
        const status = this.state.persistence.taskRuns.getRun(run.id)?.status;
        this.state.persistence.continuations.updateContinuation(continuationId, status === "completed" ? "completed" : status === "blocked" ? "blocked" : status === "cancelled" ? "cancelled" : "failed", status === "failed" ? this.state.persistence.taskRuns.getRun(run.id)?.blockedReason ?? "" : "", this.state.continuationOwner);
      }
      if (blocked) this.dependencies.continuation.queueContinuation(run.id);
    }).catch((error: unknown) => settleAttemptExecutionFailure({
      closing: this.state.closing, run, token, continuationId, continuationOwner: this.state.continuationOwner, error, persistence: this.state.persistence, settlement: this.dependencies.settlement, eventHub: this.dependencies.eventHub,
    })).finally(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (leaseTimer) clearInterval(leaseTimer);
      if (executionLeaseTimer) clearInterval(executionLeaseTimer);
      if (this.state.persistence.taskRuns.getRun(run.id)?.status === "cancelled") this.dependencies.recovery.repairTranscript(run.id, "cancelled");
      runtime.dispose?.();
      this.state.runtimes.delete(run.id);
      this.state.recalledMemory.delete(run.id);
      const timer = this.state.checkpointTimers.get(run.id);
      if (timer) clearTimeout(timer);
      this.state.checkpointTimers.delete(run.id);
      this.state.checkpointDrafts.delete(run.id);
      this.state.checkpointTokens.delete(run.id);
      this.state.lastCheckpointTranscriptSeq.delete(run.id);
      this.state.persistence.attempts.releaseExecutionLease({
        attemptId: token.attemptId,
        ownerId: token.ownerId,
        leaseToken: token.leaseToken,
        fence: token.executionFence,
      });
      if (this.state.executionTasks.get(run.id) === execution) this.state.executionTasks.delete(run.id);
      setImmediate(() => {
        try {
          if (this.state.closing) return;
          this.dependencies.postAttempt.attemptFinalized(run);
          this.dependencies.continuation.startQueuedContinuation(run.id);
        } catch { /* Persistence resources may already be closed during shutdown. */ }
      });
    });
    this.state.executionTasks.set(run.id, execution);
  }
}
