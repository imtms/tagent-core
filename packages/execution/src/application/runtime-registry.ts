import type { AttemptRuntimePort } from "../ports/attempt-runtime.js";
import type { RunId } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type { RunEventPublisherPort } from "./collaboration-ports.js";

const SHUTDOWN_JOIN_TIMEOUT_MS = 5_000;

async function boundedJoin(promises: Promise<unknown>[], timeoutMs = SHUTDOWN_JOIN_TIMEOUT_MS) {
  if (!promises.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    for (const task of this.state.preparationTasks.values()) {
      task.controller.abort(new Error("Service is shutting down"));
    }
    await boundedJoin([...this.state.preparationTasks.values()].map((task) => task.promise));
    this.state.preparationTasks.clear();
    if (this.state.continuationRecoveryTimer) clearTimeout(this.state.continuationRecoveryTimer);
    this.state.continuationRecoveryTimer = undefined;
    await boundedJoin([...this.state.controlDeliveryTasks.values()]);
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
    await boundedJoin(aborts);
    await boundedJoin([...this.state.executionTasks.values()]);
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
