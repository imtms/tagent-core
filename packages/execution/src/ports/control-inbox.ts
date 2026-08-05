import type { ControlInboxItem, RunId } from "../domain/task-run.js";

export type EnqueueControlResult =
  | { status: "duplicate"; item: ControlInboxItem }
  | { status: "inactive" }
  | { status: "full" }
  | { status: "accepted"; item: ControlInboxItem };

export interface ControlInbox {
  enqueueControl(
    runId: RunId,
    requestId: string,
    kind: ControlInboxItem["kind"],
    content: string,
    capacity: number,
  ): EnqueueControlResult;
  getControlItem(id: string): ControlInboxItem | undefined;
  listControlInbox(runId: RunId): ControlInboxItem[];
  claimControlItem(runId: RunId, attempt: number): ControlInboxItem | undefined;
  completeControlItem(id: string, status: "delivered" | "rejected" | "superseded", error?: string): boolean;
}
