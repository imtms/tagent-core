import type { RunId } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type { ContinuationControlPort, RunEventPublisherPort } from "./collaboration-ports.js";

type RecoveryState = ExecutionStateView<
  | "closing" | "continuationRecoveryTimer" | "persistence" | "supervisorRestartReconciled",
  "continuations" | "events" | "supervisorDecisions" | "transcript"
>;

export class RecoveryCoordinator {
  constructor(
    private readonly state: RecoveryState,
    private readonly dependencies: {
      continuation: ContinuationControlPort;
      eventHub: RunEventPublisherPort;
    },
  ) {}


  public repairTranscript(runId: RunId, reason: "cancelled" | "resume" | "continuation") {
    const repaired = this.state.persistence.transcript.repairTranscript(runId, reason);
    if (repaired.length) this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "transcript.repaired", { reason, repaired }));
    return repaired;
  }

  recoverContinuations() {
    if (this.state.closing) return [];
    if (this.state.continuationRecoveryTimer) clearTimeout(this.state.continuationRecoveryTimer);
    this.state.continuationRecoveryTimer = undefined;
    if (!this.state.supervisorRestartReconciled) {
      this.state.supervisorRestartReconciled = true;
      this.state.persistence.supervisorDecisions.reconcileSupervisorDecisionStatuses();
      for (const pending of this.state.persistence.supervisorDecisions.listSupervisorContinuationsNeedingReconcile()) this.dependencies.continuation.queueContinuation(pending.runId);
      this.state.persistence.continuations.queueSafeCrashRecoveryContinuations();
    }
    const recovered = this.state.persistence.continuations.recoverContinuationsAfterRestart();
    const runIds = [...new Set(recovered.map((item) => item.runId))];
    for (const runId of runIds) {
      const items = recovered.filter((item) => item.runId === runId);
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "continuation.recovered", { reason: "lease_expired_or_queued", continuations: items.map((item) => ({ id: item.id, ordinal: item.ordinal })) }));
      setImmediate(() => this.dependencies.continuation.startQueuedContinuation(runId));
    }
    this.scheduleContinuationRecovery();
    return runIds;
  }

  public scheduleContinuationRecovery() {
    if (this.state.continuationRecoveryTimer) clearTimeout(this.state.continuationRecoveryTimer);
    this.state.continuationRecoveryTimer = undefined;
    if (this.state.closing) return;
    const leaseUntil = this.state.persistence.continuations.nextContinuationLeaseExpiry();
    if (leaseUntil === null) return;
    const delay = Math.min(2_147_483_647, Math.max(1, leaseUntil - Date.now() + 1));
    this.state.continuationRecoveryTimer = setTimeout(() => this.recoverContinuations(), delay);
    this.state.continuationRecoveryTimer.unref?.();
  }

}
