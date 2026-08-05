import type { AttemptRuntimePort } from "../ports/attempt-runtime.js";
import type { RunId } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type { RunEventPublisherPort } from "./collaboration-ports.js";

type RuntimeRegistryState = ExecutionStateView<
  | "checkpointDrafts" | "checkpointTimers" | "checkpointTokens" | "closing"
  | "continuationOwner" | "continuationRecoveryTimer" | "controlDeliveryTasks"
    | "executionTasks" | "lastCheckpointTranscriptSeq" | "persistence" | "runtimes",
    "continuations" | "events" | "taskRuns" | "taskRunTransitions"
>;

export class RuntimeRegistry {
  constructor(
    private readonly state: RuntimeRegistryState,
    private readonly dependencies: { eventHub: RunEventPublisherPort },
  ) {}


  public async abortRuntime(runtime: AttemptRuntimePort, runId?: RunId) {
    try {
      await runtime.abort();
    } catch (error) {
      if (runId && this.state.persistence.taskRuns.getRun(runId)) this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "runtime.abort.failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async compact(runId: RunId, instructions?: string) {
    const runtime = this.state.runtimes.get(runId);
    if (!runtime?.compact) return "inactive" as const;
    try { await runtime.compact(instructions); }
    catch (error) {
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "context.compaction.failed", { error: error instanceof Error ? error.message : String(error) }));
      return "failed" as const;
    }
    return "completed" as const;
  }

  async closeRuntimes() {
    this.state.closing = true;
    if (this.state.continuationRecoveryTimer) clearTimeout(this.state.continuationRecoveryTimer);
    this.state.continuationRecoveryTimer = undefined;
    await Promise.allSettled([...this.state.controlDeliveryTasks.values()]);
    for (const timer of this.state.checkpointTimers.values()) clearTimeout(timer);
    this.state.checkpointTimers.clear();
    for (const runId of this.state.checkpointDrafts.keys()) {
      try {
        this.dependencies.eventHub.flushCheckpoint(runId);
      } catch {
        // Terminal/cancel/recovery mutations fence out stale in-memory drafts.
      }
    }
    this.state.checkpointTokens.clear();
    this.state.lastCheckpointTranscriptSeq.clear();
    const aborts: Promise<void>[] = [];
    for (const runtime of this.state.runtimes.values()) {
      aborts.push(this.abortRuntime(runtime).finally(() => runtime.dispose?.()));
    }
    await Promise.all(aborts);
    await Promise.allSettled([...this.state.executionTasks.values()]);
    this.state.runtimes.clear();
    const released = this.state.persistence.continuations.releaseContinuationLeases(this.state.continuationOwner);
    this.state.persistence.taskRunTransitions.transitionSystem(
      { kind: "shutdown_interrupt_active" },
      {
        kind: "lifecycle_interrupt",
        component: "runtime_registry",
        phase: "shutdown",
      },
    );
    return released;
  }
}
