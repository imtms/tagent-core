import { Type, type Static } from "typebox";
import type { ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, TaskRunStateMutation, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { currentAttemptOrdinal, previewText, textResult } from "./shared.js";

const BatchSchema = Type.Union([
  Type.Object({ action: Type.Literal("phase"), phase: Type.Union([Type.Literal("discover"), Type.Literal("plan"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("review")]) }),
  Type.Object({ action: Type.Literal("plan"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Integer()) }),
  Type.Object({ action: Type.Literal("check"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), command: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), stale: Type.Optional(Type.Boolean()), sourceOperationId: Type.Optional(Type.String()) }),
  Type.Object({ action: Type.Literal("mark_checks_stale") }),
  Type.Object({ action: Type.Literal("artifact"), id: Type.String(), title: Type.String(), kind: Type.Optional(Type.String()), content: Type.Optional(Type.String()), uri: Type.Optional(Type.String()) }),
]);
const Schema = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("batch"), Type.Literal("phase"), Type.Literal("plan"), Type.Literal("check"), Type.Literal("mark_checks_stale"), Type.Literal("operations"), Type.Literal("artifact"), Type.Literal("request_user_input")]),
  phase: Type.Optional(Type.Union([Type.Literal("discover"), Type.Literal("plan"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("review")])), key: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed")])),
  required: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Integer()), command: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), stale: Type.Optional(Type.Boolean()), sourceOperationId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), content: Type.Optional(Type.String()), uri: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Array(Type.Object({ key: Type.String(), label: Type.String(), description: Type.Optional(Type.String()), inputType: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("textarea")])), required: Type.Optional(Type.Boolean()), placeholder: Type.Optional(Type.String()) }), { minItems: 1, maxItems: 12 })),
  mutations: Type.Optional(Type.Array(BatchSchema, { minItems: 1, maxItems: 50 })),
});

export class TaskRunToolProvider implements ToolProvider {
  readonly id = "task-run.tool";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort) {}
  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof Schema>, Record<string, unknown>> = { name: "task_run", label: "Update task", description: "Inspect or update the current durable TaskRun. Passed required checks are bound to an actual successful Bash receipt; self-reported evidence is not trusted. Use action=batch to combine independent mutations in one model round-trip.", parameters: Schema, executionMode: "sequential", execute: (id, params) => this.execute(id, params) };
    return [tool];
  }

  private async execute(toolCallId: string, params: Static<typeof Schema>) {
    const c = this.capabilities, runId = c.runId;
    let operations: ReturnType<ToolCapabilityApplicationPort["listOperations"]> | undefined;
    const normalizeCheck = (value: Extract<Static<typeof BatchSchema>, { action: "check" }>) => {
      const required = value.required ?? true;
      let sourceOperationId = value.sourceOperationId?.trim() || null;
      if (value.status === "passed" && required && !sourceOperationId) {
        const attempt = currentAttemptOrdinal(c), command = value.command?.trim() ?? "";
        const candidates = (operations ??= c.listOperations({ limit: 64 })).filter((operation) => operation.runId === runId && operation.attempt === attempt && operation.operationType === "tool.bash" && operation.status === "succeeded" && (!command || (operation.payload as Record<string, unknown>)?.command === command));
        sourceOperationId = candidates.at(-1)?.id ?? null;
        if (!sourceOperationId) throw new Error("A passed required check must reference a successful Bash operation from this Attempt. Run the verification command first, then provide its command or sourceOperationId.");
      }
      return { key: value.key.trim(), title: value.title.trim(), status: value.status, required, command: value.command ?? "", evidence: value.evidence ?? "", stale: value.stale ?? false, sourceOperationId, observedAt: null };
    };
    const requireText = (name: "key" | "title" | "id" | "prompt") => { const value = params[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`task_run action="${params.action}" requires "${name}".`); return value; };
    const normalize = (mutation: Static<typeof BatchSchema>): TaskRunStateMutation => {
      if (mutation.action === "phase") return { action: "phase", phase: mutation.phase };
      if (mutation.action === "mark_checks_stale") return { action: "mark_checks_stale" };
      if ((mutation.action === "plan" || mutation.action === "check") && (!mutation.key.trim() || !mutation.title.trim())) throw new Error(`task_run action="${mutation.action}" requires non-empty "key" and "title".`);
      if (mutation.action === "plan") return { action: "plan", item: { key: mutation.key, title: mutation.title, status: mutation.status, required: mutation.required ?? true, position: mutation.position ?? 0 } };
      if (mutation.action === "check") return { action: "check", check: normalizeCheck(mutation) };
      if (!mutation.id.trim() || !mutation.title.trim()) throw new Error('task_run action="artifact" requires non-empty "id" and "title".');
      return { action: "artifact", artifact: { id: mutation.id, title: mutation.title, kind: mutation.kind ?? "artifact", content: mutation.content ?? "", uri: mutation.uri ?? "" } };
    };
    if (params.action === "batch") { if (!params.mutations?.length) throw new Error('task_run action="batch" requires "mutations".'); c.applyTaskRunBatch(params.mutations.map(normalize)); }
    if (params.action === "phase") { if (!params.phase) throw new Error('task_run action="phase" requires "phase".'); c.setRunPhase(params.phase); }
    if (params.action === "plan") { if (!params.status || !["pending", "in_progress", "done", "blocked", "skipped"].includes(params.status)) throw new Error('task_run action="plan" requires a plan status.'); c.upsertPlanItem({ key: requireText("key"), title: requireText("title"), status: params.status as "pending", required: params.required ?? true, position: params.position ?? 0 }); }
    if (params.action === "check") { if (!params.status || !["pending", "running", "passed", "failed", "blocked", "skipped"].includes(params.status)) throw new Error('task_run action="check" requires a check status.'); c.upsertCheck(normalizeCheck({ action: "check", key: requireText("key"), title: requireText("title"), status: params.status as "pending", required: params.required, command: params.command, evidence: params.evidence, stale: params.stale, sourceOperationId: params.sourceOperationId })); }
    if (params.action === "mark_checks_stale") c.markChecksStale();
    if (params.action === "operations") { const rows = c.listOperations({ limit: 24 }), serialized = JSON.stringify(rows, null, 2); return textResult(previewText(serialized), { returnedOperations: rows.length, responseTruncated: Buffer.byteLength(serialized) > 24_000 }); }
    if (params.action === "artifact") c.addArtifact({ id: requireText("id"), title: requireText("title"), kind: params.kind ?? "artifact", content: params.content ?? "", uri: params.uri ?? "" });
    if (params.action === "request_user_input") {
      if (!params.fields?.length) throw new Error('task_run action="request_user_input" requires "fields".');
      const keys = new Set<string>(), fields = params.fields.map((field) => { const key = field.key.trim(); if (!key || keys.has(key)) throw new Error("User input field keys must be non-empty and unique"); keys.add(key); return { key, label: field.label.trim() || key, description: field.description?.trim() ?? "", inputType: field.inputType ?? "text" as const, required: field.required ?? true, placeholder: field.placeholder?.trim() ?? "" }; });
      const request = c.requestUserInput(toolCallId, requireText("prompt").trim(), fields);
      return textResult(JSON.stringify({ ok: true, action: params.action, runId, status: "waiting_input", requestId: request.id, requiredFields: request.fields.map((field) => field.key) }), { compact: true });
    }
    if (params.action === "get") return textResult(JSON.stringify(c.getRun(), null, 2));
    const state = c.getRunExecutionState?.(); c.publish("run.updated", { action: params.action, phase: state?.phase ?? params.phase ?? "discover" });
    return textResult(JSON.stringify({ ok: true, action: params.action, runId, status: state?.status, phase: state?.phase, counts: state?.counts }), { compact: true });
  }
}
