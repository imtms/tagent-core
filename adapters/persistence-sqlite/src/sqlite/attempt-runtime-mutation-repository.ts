import type Database from "better-sqlite3";
import type {
  FencedRuntimeMutationContext,
  FencedRuntimeMutationPort,
} from "@tagent/execution/ports";
import type { Store } from "../store.js";
import { requestUserInputWithInternalHook } from "./internal-user-input-coordinator.js";
import {
  TaskRunExecutionFenceValidator,
  type TaskRunExecutionScope,
} from "./task-run-execution-fence.js";

/**
 * Compatibility implementation for legacy Store mutations.
 *
 * Every method validates Attempt identity/version and execution lease token/fence
 * inside the same SQLite transaction that invokes the legacy mutation.
 */
export class SqliteFencedRuntimeMutationRepository implements FencedRuntimeMutationPort {
  private readonly executionFenceValidator: TaskRunExecutionFenceValidator;

  constructor(
    private readonly db: Database.Database,
    private readonly store: Store,
  ) {
    this.executionFenceValidator = new TaskRunExecutionFenceValidator(db);
  }

  appendEvent: FencedRuntimeMutationPort["appendEvent"] = (context, type, data) =>
    this.withFence(context, ({ runId }) => this.store.appendEvent(runId, type, data));

  appendTranscript: FencedRuntimeMutationPort["appendTranscript"] = (context, message) =>
    this.withFence(context, ({ runId, ordinal }) => this.store.appendTranscript(runId, ordinal, message));

  setRunPhase: FencedRuntimeMutationPort["setRunPhase"] = (context, phase) =>
    this.withFence(context, ({ runId }) => this.store.setRunPhase(runId, phase));

  advanceRunPhase: FencedRuntimeMutationPort["advanceRunPhase"] = (context, phase) =>
    this.withFence(context, ({ runId }) => this.store.advanceRunPhase(runId, phase));

  requestUserInput: FencedRuntimeMutationPort["requestUserInput"] = (context, prompt, fields, toolCallId) =>
    this.withFence(context, ({ runId, ordinal }) => {
      const toolAttempt = this.db.prepare(`SELECT 1 FROM tool_attempts
        WHERE run_id=? AND attempt=? AND tool_call_id=? AND status='running'`)
        .get(runId, ordinal, toolCallId);
      if (!toolAttempt) throw new Error(`Tool attempt ${toolCallId} is not running for fenced Attempt`);
      let capturedEvent: { runId: string; seq: number; type: string; data: Record<string, unknown>; createdAt: number } | undefined;
      const request = requestUserInputWithInternalHook(this.store, runId, prompt, fields, ({ request: hookedRequest, event: hookedEvent }) => {
        const eventData = hookedEvent.data as { requestId?: string };
        if (eventData.requestId !== hookedRequest.id) throw new Error("Store waiting event request identity mismatch");
        this.db.prepare(`UPDATE attempts SET legacy_event_seq=? WHERE id=? AND ordinal=? AND status='waiting_input'`).run(hookedEvent.seq, context.attemptId, ordinal);
        const snapshot = JSON.stringify({ runId, ordinal, status: "waiting_input", legacyEventSeq: hookedEvent.seq, active: false });
        this.db.prepare(`INSERT INTO attempt_shadow_comparisons (id,attempt_id,scenario,legacy_json,projected_json,mismatch,gate_sample,created_at) VALUES (lower(hex(randomblob(16))),?,'input',?,?,0,0,?)`).run(context.attemptId, snapshot, snapshot, hookedEvent.createdAt);
        this.db.prepare(`UPDATE attempt_transition_audit SET legacy_event_seq=? WHERE rowid=(SELECT rowid FROM attempt_transition_audit WHERE attempt_id=? AND scenario='input' ORDER BY rowid DESC LIMIT 1)`).run(hookedEvent.seq, context.attemptId);
        this.store.completeToolAttempt(runId, ordinal, toolCallId, true);
        capturedEvent = hookedEvent as typeof capturedEvent;
      });
      const eventRow = this.db.prepare(`SELECT run_id as runId,seq,attempt_id as attemptId,type,data,created_at as createdAt
        FROM run_events WHERE run_id=? AND seq=(SELECT last_event_seq FROM runs WHERE id=?)`).get(runId, runId) as { runId: string; seq: number; attemptId: string; type: string; data: string; createdAt: number } | undefined;
      if (!eventRow || eventRow.type !== "run.waiting_for_input" || eventRow.attemptId !== context.attemptId || !capturedEvent) {
        throw new Error("Store requestUserInput did not produce the expected fenced waiting event");
      }
      const eventData = JSON.parse(eventRow.data) as { requestId?: string };
      if (eventData.requestId !== request.id) throw new Error("Store waiting event request identity mismatch");
      const event = { ...eventRow, data: eventData };
      return { request, event, toolAttemptCompleted: true as const };
    });

  upsertCheckpoint: FencedRuntimeMutationPort["upsertCheckpoint"] = (context, checkpoint) =>
    this.withFence(context, ({ runId, ordinal }) => this.store.upsertCheckpoint({
      ...checkpoint,
      runId,
      attempt: ordinal,
    }));

  claimOperation: FencedRuntimeMutationPort["claimOperation"] = (context, id, operationType, payload) =>
    this.withFence(context, ({ runId, ordinal }) =>
      this.store.claimOperation(id, runId, ordinal, operationType, payload));

  updateOperation: FencedRuntimeMutationPort["updateOperation"] = (context, id, update) =>
    this.withFence(context, ({ runId, ordinal }) => {
      const operation = this.db.prepare("SELECT run_id as runId,attempt FROM operations WHERE id=?")
        .get(id) as { runId: string; attempt: number } | undefined;
      if (!operation || operation.runId !== runId || operation.attempt !== ordinal) {
        throw new Error(`Operation ${id} does not belong to fenced Attempt ${context.attemptId}`);
      }
      return this.store.updateOperation(id, update);
    });

  recordToolAttempt: FencedRuntimeMutationPort["recordToolAttempt"] = (context, toolCallId, toolName, args) =>
    this.withFence(context, ({ runId, ordinal }) =>
      this.store.recordToolAttempt(runId, ordinal, toolCallId, toolName, args));

  completeToolAttempt: FencedRuntimeMutationPort["completeToolAttempt"] = (
    context,
    toolCallId,
    success,
    error,
  ) => this.withFence(context, ({ runId, ordinal }) =>
    this.store.completeToolAttempt(runId, ordinal, toolCallId, success, error));

  completeControlDelivery: FencedRuntimeMutationPort["completeControlDelivery"] = (
    context,
    itemId,
    status,
    error = "",
  ) => this.withFence(context, ({ runId, ordinal }) => {
    const item = this.db.prepare(`SELECT request_id as requestId,attempt,kind,status
      FROM control_inbox WHERE id=? AND run_id=?`).get(itemId, runId) as {
        requestId: string;
        attempt: number;
        kind: string;
        status: string;
      } | undefined;
    if (!item || item.attempt !== ordinal || item.status !== "delivering") {
      throw new Error(`Control item ${itemId} does not belong to fenced Attempt ${context.attemptId}`);
    }
    if (!this.store.completeControlItem(itemId, status, error)) {
      throw new Error(`Control item ${itemId} changed during fenced completion`);
    }
    const event = this.store.appendEvent(
      runId,
      status === "delivered" ? "control.delivered" : "control.rejected",
      {
      controlId: itemId,
      requestId: item.requestId,
      attempt: ordinal,
      kind: item.kind,
      ...(status === "rejected" ? { reason: error } : {}),
      },
    );
    return { completed: true as const, event };
  });

  completeSupervisorDecision: FencedRuntimeMutationPort["completeSupervisorDecision"] = (
    context,
    decisionId,
    status,
    error,
    data,
  ) => this.withFence(context, ({ runId, ordinal }) => {
    const decision = this.db.prepare(`SELECT status FROM supervisor_decisions
      WHERE id=? AND run_id=? AND attempt=?`).get(decisionId, runId, ordinal) as {
        status: string;
      } | undefined;
    if (!decision || decision.status !== "proposed") {
      throw new Error(`Supervisor decision ${decisionId} does not belong to fenced Attempt ${context.attemptId}`);
    }
    const updated = this.db.prepare(`UPDATE supervisor_decisions SET status=?,error=?,executed_at=?
      WHERE id=? AND status='proposed'`).run(status, error, context.timestamp ?? Date.now(), decisionId);
    if (updated.changes !== 1) throw new Error(`Supervisor decision ${decisionId} changed during fenced completion`);
    const event = this.store.appendEvent(runId, "supervisor.decision", { decisionId, ...data });
    return { completed: true as const, event };
  });

  upsertPlanItem: FencedRuntimeMutationPort["upsertPlanItem"] = (context, item) =>
    this.withFence(context, ({ runId }) => this.store.upsertPlanItem(runId, item));

  markChecksStale: FencedRuntimeMutationPort["markChecksStale"] = (context) =>
    this.withFence(context, ({ runId }) => this.store.markChecksStale(runId));

  upsertCheck: FencedRuntimeMutationPort["upsertCheck"] = (context, check) =>
    this.withFence(context, ({ runId }) => this.store.upsertCheck(runId, check));

  applyTaskRunBatch: FencedRuntimeMutationPort["applyTaskRunBatch"] = (context, mutations) =>
    this.withFence(context, ({ runId }) => {
      for (const mutation of mutations) {
        if (mutation.action === "phase") this.store.setRunPhase(runId, mutation.phase);
        else if (mutation.action === "plan") this.store.upsertPlanItem(runId, mutation.item);
        else if (mutation.action === "check") this.store.upsertCheck(runId, mutation.check);
        else if (mutation.action === "mark_checks_stale") this.store.markChecksStale(runId);
        else this.store.addArtifact(runId, mutation.artifact);
      }
    });

  addArtifact: FencedRuntimeMutationPort["addArtifact"] = (context, artifact) =>
    this.withFence(context, ({ runId }) => this.store.addArtifact(runId, artifact));

  private withFence<T>(context: FencedRuntimeMutationContext, work: (scope: TaskRunExecutionScope) => T): T {
    return this.db.transaction(() => {
      const scope = this.executionFenceValidator.validate({
        attemptId: context.attemptId,
        expectedVersion: context.expectedVersion,
        leaseToken: context.leaseToken,
        executionFence: context.fence,
      });
      return work(scope);
    })();
  }
}
