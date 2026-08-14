import type { AttemptRuntimePort } from "../ports/attempt-runtime.js";
import type { RunId } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type { RunEventPublisherPort } from "./collaboration-ports.js";

async function joinRuntimeShutdown(disposals: Promise<unknown>[], adjacentWork: Promise<unknown>[]) {
  const [disposalResults] = await Promise.all([
    Promise.allSettled(disposals),
    Promise.allSettled(adjacentWork),
  ]);
  const failures = disposalResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Runtime shutdown failed to reach quiescence");
}

type RuntimeRegistryState = ExecutionStateView<
  | "checkpointDrafts" | "checkpointTimers" | "checkpointTokens" | "closing"
  | "continuationOwner" | "continuationRecoveryTimer" | "controlDeliveryTasks"
    | "executionTasks" | "lastCheckpointTranscriptSeq" | "persistence" | "preparationTasks" | "runtimes",
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
    const preparationTasks = [...this.state.preparationTasks.values()];
    const controlDeliveryTasks = [...this.state.controlDeliveryTasks.values()];
    const executionTasks = [...this.state.executionTasks.values()];
    const runtimes = [...this.state.runtimes.values()];
    for (const task of preparationTasks) {
      task.controller.abort(new Error("Service is shutting down"));
    }
    if (this.state.continuationRecoveryTimer) clearTimeout(this.state.continuationRecoveryTimer);
    this.state.continuationRecoveryTimer = undefined;
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

    // Disposal requests cancellation and is the runtime-owned quiescence
    // barrier. Start every disposer before joining adjacent tasks so control
    // delivery and execution promises that are waiting on a runtime can settle.
    const disposals = runtimes.map((runtime) => Promise.resolve().then(() => runtime.dispose()));
    await joinRuntimeShutdown(disposals, [
      ...preparationTasks.map((task) => task.promise),
      ...controlDeliveryTasks,
      ...executionTasks,
    ]);

    this.state.preparationTasks.clear();
    this.state.controlDeliveryTasks.clear();
    this.state.executionTasks.clear();
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
