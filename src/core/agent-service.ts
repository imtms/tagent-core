import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import { createInProcessRuntime } from "../runtime/factory.js";
import type { AgentRuntime, RuntimeFactory } from "../runtime/types.js";
import type { RunEvent, SessionId, RunId, TaskRun } from "../core/types.js";

export class AgentService {
  private readonly runtimes = new Map<RunId, AgentRuntime>();
  private readonly listeners = new Map<RunId, Set<(event: RunEvent) => void>>();

  constructor(
    private readonly store: Store,
    private readonly workspace: string,
    private readonly runtimeFactory: RuntimeFactory = createInProcessRuntime,
  ) {
    this.store.markInterrupted();
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    const existing = this.store.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    if (existing) return this.store.getRun(existing.id)!;

    const run = this.store.createRun(sessionId, query, requestId);
    this.store.appendMessage(sessionId, "user", query);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: query }));

    const runtime = this.runtimeFactory({
      store: this.store,
      runId: run.id,
      workspace: this.workspace,
      systemPrompt: this.buildSystemPrompt(run),
      onEvent: (event) => this.publish(event),
    });
    this.runtimes.set(run.id, runtime);

    void this.execute(run.id, runtime);
    return run;
  }

  private async execute(runId: RunId, runtime: AgentRuntime) {
    try {
      await runtime.prompt(this.store.getRun(runId)?.goal ?? "");
      const runtimeError = runtime.getError();
      if (runtimeError) throw new Error(runtimeError);
      const messages = runtime.getMessages();
      const final = [...messages].reverse().find((message) => message.role === "assistant");
      const response = final && "content" in final
        ? (typeof final.content === "string" ? final.content : final.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        : "";
      if (response) this.store.appendMessage(this.store.getRun(runId)!.sessionId, "assistant", response);
      const result = this.store.completeWithGate(runId, response);
      this.publish(this.store.listEvents(runId, Math.max(0, result.run.lastEventSeq - 1)).at(-1)!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.finalizeRun(runId, "failed", message);
      this.store.appendMessage(this.store.getRun(runId)!.sessionId, "assistant", `Run failed: ${message}`);
      this.publish(this.store.appendEvent(runId, "run.failed", { error: message }));
    } finally {
      this.runtimes.delete(runId);
    }
  }

  cancel(runId: RunId) {
    const runtime = this.runtimes.get(runId);
    if (!runtime) return false;
    runtime.abort();
    this.store.finalizeRun(runId, "cancelled", "Cancelled by user");
    this.publish(this.store.appendEvent(runId, "run.cancelled", {}));
    return true;
  }

  steer(runId: RunId, instruction: string) {
    const runtime = this.runtimes.get(runId);
    if (!runtime) return false;
    runtime.steer(instruction);
    this.publish(this.store.appendEvent(runId, "run.steered", { instruction }));
    return true;
  }

  subscribe(runId: RunId, listener: (event: RunEvent) => void) {
    let listeners = this.listeners.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(runId);
    };
  }

  replay(runId: RunId, after = 0) {
    return this.store.listEvents(runId, after);
  }

  getRun(runId: RunId) {
    return this.store.getRun(runId);
  }

  resume(runId: RunId) {
    const run = this.store.resumeRun(runId);
    return this.start(run.sessionId, run.goal, run.requestId);
  }

  private publish(event: RunEvent) {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  private buildSystemPrompt(run: TaskRun) {
    return [
      "You are TAgent Core, a practical persistent software agent.",
      `Current workspace: ${this.workspace}`,
      "Use the task_run tool for substantial work. Maintain a plan and checks before claiming completion.",
      "Use read before modifying unfamiliar files. Keep changes focused and report verification evidence.",
      `Active TaskRun: ${JSON.stringify(run)}`,
    ].join("\n\n");
  }
}
