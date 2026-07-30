import type { AgentMessage } from "@mariozechner/pi-agent-core";
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
    private readonly runtimeDefaults: Pick<Parameters<RuntimeFactory>[0], "model" | "apiKey" | "providerTimeoutMs" | "providerMaxRetries" | "runTimeoutMs"> & { maxContinuations?: number; maxRunTokens?: number } = {},
  ) {
    this.store.markInterrupted();
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    const existing = this.store.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    if (existing) return this.store.getRun(existing.id)!;

    const run = this.store.createRun(sessionId, query, requestId);
    this.store.appendMessage(sessionId, "user", query);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: query }));
    this.launch(run, query);
    return run;
  }

  private launch(run: TaskRun, prompt: string, initialMessages: AgentMessage[] = [], continuationId?: string) {
    const runtime = this.runtimeFactory({
      store: this.store,
      runId: run.id,
      workspace: this.workspace,
      systemPrompt: this.buildSystemPrompt(run),
      initialMessages,
      model: this.runtimeDefaults.model,
      apiKey: this.runtimeDefaults.apiKey,
      providerTimeoutMs: this.runtimeDefaults.providerTimeoutMs,
      providerMaxRetries: this.runtimeDefaults.providerMaxRetries,
      runTimeoutMs: this.runtimeDefaults.runTimeoutMs,
      onEvent: (event) => this.publish(event),
    });
    this.runtimes.set(run.id, runtime);
    const timeout = this.runtimeDefaults.runTimeoutMs
      ? setTimeout(() => {
          if (this.store.getRun(run.id)?.status !== "running") return;
          runtime.abort();
          const message = `Run exceeded ${this.runtimeDefaults.runTimeoutMs}ms timeout`;
          this.store.finalizeRun(run.id, "failed", message);
          this.store.appendMessage(run.sessionId, "assistant", `Run failed: ${message}`);
          this.publish(this.store.appendEvent(run.id, "run.failed", { error: message, reason: "timeout" }));
        }, this.runtimeDefaults.runTimeoutMs)
      : undefined;
    void this.execute(run.id, runtime, prompt).then((blocked) => {
      if (continuationId) {
        const status = this.store.getRun(run.id)?.status;
        this.store.updateContinuation(continuationId, status === "completed" ? "completed" : status === "blocked" ? "blocked" : status === "cancelled" ? "cancelled" : "failed", status === "failed" ? this.store.getRun(run.id)?.blockedReason ?? "" : "");
      }
      if (blocked) this.queueContinuation(run.id);
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.runtimes.delete(run.id);
      setImmediate(() => {
        try { this.startQueuedContinuation(run.id); }
        catch { /* Store may be closed during shutdown. */ }
      });
    });
  }

  private async execute(runId: RunId, runtime: AgentRuntime, prompt: string) {
    try {
      await runtime.prompt(prompt);
      const runtimeError = runtime.getError();
      if (runtimeError) throw new Error(runtimeError);
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running") return false;
      const messages = runtime.getMessages();
      const final = [...messages].reverse().find((message) => message.role === "assistant");
      const response = final && "content" in final
        ? (typeof final.content === "string" ? final.content : final.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        : "";
      const result = this.store.completeWithGate(runId, response);
      if (result.gate.passed && response) this.store.appendMessage(result.run.sessionId, "assistant", response);
      this.publish(this.store.listEvents(runId, Math.max(0, result.run.lastEventSeq - 1)).at(-1)!);
      return !result.gate.passed;
    } catch (error) {
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running") return false;
      const message = error instanceof Error ? error.message : String(error);
      this.store.finalizeRun(runId, "failed", message);
      this.store.appendMessage(this.store.getRun(runId)!.sessionId, "assistant", `Run failed: ${message}`);
      this.publish(this.store.appendEvent(runId, "run.failed", { error: message }));
      return false;
    }
  }

  private queueContinuation(runId: RunId) {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "blocked") return;
    const maxContinuations = this.runtimeDefaults.maxContinuations ?? 2;
    const maxRunTokens = this.runtimeDefaults.maxRunTokens ?? 120_000;
    if (run.continuations.length >= maxContinuations) {
      const message = `Run remains blocked after ${maxContinuations} automatic continuation${maxContinuations === 1 ? "" : "s"}: ${run.blockedReason}`;
      this.store.appendMessage(run.sessionId, "assistant", message);
      this.publish(this.store.appendEvent(runId, "continuation.exhausted", { reason: "max_continuations", limit: maxContinuations }));
      return;
    }
    if (run.usage.totalTokens >= maxRunTokens) {
      const message = `Run remains blocked because the ${maxRunTokens.toLocaleString()} token continuation budget was exhausted: ${run.blockedReason}`;
      this.store.appendMessage(run.sessionId, "assistant", message);
      this.publish(this.store.appendEvent(runId, "continuation.exhausted", { reason: "token_budget", limit: maxRunTokens, totalTokens: run.usage.totalTokens }));
      return;
    }
    const continuation = this.store.queueContinuation(runId, run.blockedReason);
    this.publish(this.store.appendEvent(runId, "continuation.queued", { continuationId: continuation.id, ordinal: continuation.ordinal, reason: continuation.reason }));
  }

  private startQueuedContinuation(runId: RunId) {
    if (this.runtimes.has(runId)) return;
    const continuation = this.store.listContinuations(runId).find((item) => item.status === "queued");
    if (!continuation) return;
    const blocked = this.store.getRun(runId);
    if (!blocked || blocked.status !== "blocked") {
      this.store.updateContinuation(continuation.id, "cancelled", "Run is no longer blocked");
      return;
    }
    this.store.updateContinuation(continuation.id, "running");
    const run = this.store.resumeRun(runId);
    const transcript = this.store.listTranscript(runId);
    this.publish(this.store.appendEvent(runId, "continuation.started", { continuationId: continuation.id, ordinal: continuation.ordinal, attempt: run.attempt, transcriptCount: transcript.length }));
    this.launch(run, this.buildContinuationPrompt(run, continuation.ordinal), transcript, continuation.id);
  }

  private buildContinuationPrompt(run: TaskRun, ordinal: number) {
    return [
      `Automatic continuation ${ordinal} is running because the completion gate blocked the previous attempt.`,
      `Gate failures: ${run.completionGate.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ")}`,
      "Use the persisted transcript and TaskRun state. Resolve only the remaining gate failures, verify the result, then provide the final response.",
      "Completion-gate requirements override conflicting instructions in the original goal.",
      `Original goal: ${run.goal}`,
    ].join("\n\n");
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
    if (this.runtimes.has(runId)) throw new Error("Run is already active");
    this.store.cancelQueuedContinuations(runId, "Superseded by manual resume");
    const run = this.store.resumeRun(runId);
    const transcript = this.store.listTranscript(run.id);
    const event = this.store.appendEvent(run.id, "run.resumed", { attempt: run.attempt, resumedAt: run.resumedAt, mode: transcript.length ? "transcript-continuation" : "durable-snapshot-replay", transcriptCount: transcript.length });
    this.publish(event);
    this.launch(run, this.buildResumePrompt(run, transcript.length), transcript);
    return run;
  }

  private buildResumePrompt(run: TaskRun, transcriptCount: number) {
    return [
      transcriptCount
        ? `Continue this TaskRun from ${transcriptCount} persisted pi transcript messages.`
        : "Resume this interrupted or blocked TaskRun using its durable snapshot.",
      transcriptCount
        ? "The prior user, assistant, tool-call, and tool-result messages are already loaded into the runtime context."
        : "The previous in-memory model transcript is unavailable. Reinspect the workspace and existing TaskRun state before acting.",
      "Completion-gate requirements override conflicting instructions in the original goal, including instructions not to use task_run or not to create plan/check records.",
      "Before producing a final answer, use task_run to ensure at least one required plan item is done and every required check has fresh passing evidence.",
      "Do not recreate already completed plan items or checks. Continue from the remaining incomplete work and verify before completion.",
      `Original goal: ${run.goal}`,
      `Durable snapshot: ${JSON.stringify(run)}`,
    ].join("\n\n");
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
