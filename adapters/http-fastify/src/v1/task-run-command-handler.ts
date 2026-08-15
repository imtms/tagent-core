import type { TaskRunCommand } from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { V1HttpError } from "./errors.js";
import { conflict } from "./route-support.js";

function commandAdmissionError(status: "inactive" | "closing" | "full"): V1HttpError {
  if (status === "full") return new V1HttpError(429, "task_run.command_capacity_exceeded", "TaskRun control inbox is full", "rate_limited", true);
  if (status === "closing") return new V1HttpError(503, "service.closing", "Service is closing", "unavailable", true);
  return conflict("task_run.invalid_transition", "TaskRun is not active");
}

function resultingTaskRunId(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : fallback;
}

export async function executeTaskRunCommand(
  dependencies: ChannelV1Dependencies,
  taskRunId: string,
  command: TaskRunCommand,
): Promise<Record<string, unknown>> {
  const { service } = dependencies;
  switch (command.type) {
    case "task_run.steer": {
      const result = await service.steer(taskRunId, command.payload.content, command.commandId);
      if (result.status !== "accepted") throw commandAdmissionError(result.status);
      return { accepted: true };
    }
    case "task_run.follow_up": {
      const result = await service.followUp(taskRunId, command.payload.content, command.commandId);
      if (result.status !== "accepted") throw commandAdmissionError(result.status);
      return { accepted: true };
    }
    case "task_run.cancel":
      if (!service.cancel(taskRunId)) throw conflict("task_run.invalid_transition", "TaskRun is not active");
      return { accepted: true, taskRunId };
    case "task_run.resume": {
      const run = await service.resume(taskRunId);
      return { accepted: true, taskRunId: resultingTaskRunId(run, taskRunId) };
    }
    case "task_run.compact": {
      const result = await service.compact(taskRunId, command.payload.reason);
      if (result === "inactive") throw conflict("task_run.invalid_transition", "TaskRun is not active");
      if (result === "failed") throw new V1HttpError(503, "task_run.compaction_failed", "TaskRun compaction failed", "unavailable", true);
      return { accepted: true, taskRunId };
    }
    case "task_run.submit_user_input": {
      const run = await service.submitUserInput(command.payload.requestId, command.payload.response);
      return { accepted: true, taskRunId: resultingTaskRunId(run, taskRunId) };
    }
    case "task_run.resolve_approval": {
      const run = command.payload.decision === "approved"
        ? await service.approveRunApproval(command.payload.approvalRequestId, command.payload.resolution)
        : service.rejectRunApproval(command.payload.approvalRequestId, command.payload.resolution);
      return { accepted: true, taskRunId: resultingTaskRunId(run, taskRunId) };
    }
  }
}
