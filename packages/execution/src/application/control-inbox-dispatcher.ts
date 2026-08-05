import { randomUUID } from "node:crypto";
import type { RunId } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";
import type { RunEventPublisherPort } from "./collaboration-ports.js";

type ControlInboxState = ExecutionStateView<
  | "checkpointTokens" | "closing" | "controlDeliveryTasks" | "persistence" | "runtimeDefaults" | "runtimes",
  "controlInbox" | "events" | "runtimeMutations" | "taskRuns"
>;

export class ControlInboxDispatcher {
  constructor(
    private readonly state: ControlInboxState,
    private readonly dependencies: { eventHub: RunEventPublisherPort },
  ) {}


  async followUp(runId: RunId, instruction: string, requestId: string = randomUUID()) {
    return this.enqueueControl(runId, "follow_up", instruction, requestId);
  }

  async enqueueControl(runId: RunId, kind: "steer" | "follow_up", instruction: string, requestId: string) {
    if (this.state.closing) return { status: "closing" as const };
    const admission = this.state.persistence.controlInbox.enqueueControl(runId, requestId, kind, instruction, this.state.runtimeDefaults.controlInboxCapacity ?? 32);
    if (admission.status !== "accepted" && admission.status !== "duplicate") return { status: admission.status };
    const item = admission.item;
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, admission.status === "duplicate" ? "control.duplicate" : "control.accepted", { controlId: item.id, requestId, attempt: item.attempt, kind }));
    if (admission.status === "accepted") {
      await this.scheduleControlDelivery(runId, item.attempt);
      if (this.state.persistence.controlInbox.getControlItem(item.id)?.status === "queued") await this.scheduleControlDelivery(runId, item.attempt);
    }
    const persisted = this.state.persistence.controlInbox.getControlItem(item.id)!;
    const status = persisted.status === "delivered" ? "accepted" as const
      : persisted.status === "queued" || persisted.status === "delivering" ? "accepted" as const
      : "inactive" as const;
    return { status, item: persisted };
  }

  public scheduleControlDelivery(runId: RunId, attempt: number) {
    const active = this.state.controlDeliveryTasks.get(runId);
    if (active) return active;
    const task = this.deliverControlInbox(runId, attempt).finally(() => {
      if (this.state.controlDeliveryTasks.get(runId) === task) this.state.controlDeliveryTasks.delete(runId);
    });
    this.state.controlDeliveryTasks.set(runId, task);
    return task;
  }

  public async deliverControlInbox(runId: RunId, attempt: number) {
    const runtime = this.state.runtimes.get(runId);
    if (!runtime || this.state.closing) return;
    while (true) {
      const current = this.state.persistence.taskRuns.getRun(runId);
      if (!current || current.status !== "running" || current.attempt !== attempt) return;
      const item = this.state.persistence.controlInbox.claimControlItem(runId, attempt);
      if (!item) return;
      const token = this.state.checkpointTokens.get(runId);
      if (!token || token.ordinal !== attempt) {
        this.state.persistence.controlInbox.completeControlItem(item.id, "superseded", "Attempt execution token is stale");
        return;
      }
      const fenceContext = {
        attemptId: token.attemptId,
        expectedVersion: token.expectedVersion,
        leaseToken: token.leaseToken,
        fence: token.executionFence,
      };
      try {
        const event = this.state.persistence.runtimeMutations.appendEvent(fenceContext, "control.delivering", {
          controlId: item.id,
          requestId: item.requestId,
          attempt,
          kind: item.kind,
        });
        this.dependencies.eventHub.publish(event);
      } catch {
        this.state.persistence.controlInbox.completeControlItem(item.id, "superseded", "Attempt advanced before delivery");
        return;
      }
      try {
        const result = item.kind === "steer" ? await runtime.steer(item.content) : runtime.followUp ? await runtime.followUp(item.content) : "settled";
        if (result === "accepted") {
          try {
            const completion = this.state.persistence.runtimeMutations.completeControlDelivery(
              fenceContext,
              item.id,
              "delivered",
            );
            this.dependencies.eventHub.publish(completion.event);
          } catch {
            this.state.persistence.controlInbox.completeControlItem(item.id, "superseded", "Attempt advanced during delivery");
            return;
          }
          continue;
        }
        try {
          const completion = this.state.persistence.runtimeMutations.completeControlDelivery(
            fenceContext,
            item.id,
            "rejected",
            "pi_settled",
          );
          this.dependencies.eventHub.publish(completion.event);
        } catch {
          this.state.persistence.controlInbox.completeControlItem(item.id, "superseded", "Attempt advanced during delivery");
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const completion = this.state.persistence.runtimeMutations.completeControlDelivery(
            fenceContext,
            item.id,
            "rejected",
            message,
          );
          this.dependencies.eventHub.publish(completion.event);
        } catch {
          this.state.persistence.controlInbox.completeControlItem(item.id, "superseded", "Attempt advanced during delivery");
        }
        return;
      }
    }
  }

  async steer(runId: RunId, instruction: string, requestId: string = randomUUID()) {
    return this.enqueueControl(runId, "steer", instruction, requestId);
  }
}
