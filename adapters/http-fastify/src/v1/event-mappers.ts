import type { RunEvent } from "@tagent/execution/domain";

export function publicIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function publicText(value: unknown, maxLength = 16_384): string {
  if (typeof value !== "string") return "";
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

function publicInteger(value: unknown, fallback = 1): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function publicToolPayload(data: Record<string, unknown>) {
  return {
    toolCallId: publicIdentifier(data.toolCallId) ?? "unknown",
    toolName: publicText(data.toolName, 256) || "tool",
  };
}

function publicUserInputFields(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const field = candidate as Record<string, unknown>;
    const key = publicText(field.key, 256);
    if (!key) return [];
    return [{
      key,
      label: publicText(field.label, 512),
      description: publicText(field.description, 2_000),
      inputType: field.inputType === "textarea" ? "textarea" as const : "text" as const,
      required: Boolean(field.required),
      placeholder: publicText(field.placeholder, 1_000),
    }];
  });
}

export function publicEventProjection(event: RunEvent): { type: string; payload: Record<string, unknown> } {
  const data = event.data;
  switch (event.type) {
    case "run.started": return { type: "task_run.started", payload: { goal: publicText(data.goal, 4_000), attempt: publicInteger(data.attempt) } };
    case "run.waiting_for_input": return { type: "task_run.waiting_input", payload: { requestId: publicIdentifier(data.requestId) ?? "unknown", prompt: publicText(data.prompt, 8_000), fields: publicUserInputFields(data.fields) } };
    case "run.blocked": return { type: "task_run.blocked", payload: { reason: publicText(data.reason ?? data.error, 4_000), ...(typeof data.action === "string" ? { action: publicText(data.action, 256) } : {}) } };
    case "run.resumed": return { type: "task_run.resumed", payload: { attempt: publicInteger(data.attempt), ...(typeof data.mode === "string" ? { mode: publicText(data.mode, 256) } : {}) } };
    case "run.completed": return { type: "task_run.completed", payload: {} };
    case "run.failed": return { type: "task_run.failed", payload: { reason: publicText(data.reason ?? data.error, 4_000), retryable: Boolean(data.retryable) } };
    case "run.cancelled": return { type: "task_run.cancelled", payload: { reason: publicText(data.reason, 4_000) } };
    case "run.interrupted":
    case "restart.interruption": return { type: "task_run.interrupted", payload: { reason: publicText(data.reason, 4_000) } };
    case "message.started": return { type: "message.started", payload: { ordinal: publicInteger(data.ordinal) } };
    case "message.delta": return { type: "message.delta", payload: { delta: publicText(data.delta), ordinal: publicInteger(data.ordinal) } };
    case "message.completed": return { type: "message.completed", payload: { content: publicText(data.content, 65_536), ordinal: publicInteger(data.ordinal) } };
    case "tool.started": return { type: "tool.started", payload: publicToolPayload(data) };
    case "tool.progress": return { type: "tool.progress", payload: publicToolPayload(data) };
    case "tool.completed": return { type: "tool.completed", payload: { ...publicToolPayload(data), isError: Boolean(data.isError) } };
    case "tool.failed": return { type: "tool.failed", payload: { ...publicToolPayload(data), reason: publicText(data.reason ?? data.error, 2_000) } };
    case "provider.failure": return { type: "provider.failure", payload: { kind: publicText(data.kind, 128), retryable: Boolean(data.retryable), ...(typeof data.stopReason === "string" ? { stopReason: publicText(data.stopReason, 128) } : {}) } };
    case "supervisor.approval.requested": return { type: "approval.requested", payload: { approvalRequestId: publicIdentifier(data.approvalId) ?? "unknown", reason: publicText(data.reason, 4_000) } };
    case "supervisor.approval.approved": return { type: "approval.resolved", payload: { approvalRequestId: publicIdentifier(data.approvalId) ?? "unknown", decision: "approved", resolution: publicText(data.resolution, 4_000) } };
    case "supervisor.approval.rejected": return { type: "approval.resolved", payload: { approvalRequestId: publicIdentifier(data.approvalId) ?? "unknown", decision: "rejected", resolution: publicText(data.resolution, 4_000) } };
    case "run.input.submitted": return { type: "user_input.submitted", payload: { userInputRequestId: publicIdentifier(data.requestId) ?? "unknown", fieldKeys: Array.isArray(data.fieldKeys) ? data.fieldKeys.filter((key): key is string => typeof key === "string" && key.length > 0).slice(0, 64) : [] } };
    default: return { type: "diagnostic.internal", payload: { sourceType: publicText(event.type, 128) || "internal" } };
  }
}
