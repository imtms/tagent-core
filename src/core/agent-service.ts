import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import { createInProcessRuntime } from "../runtime/factory.js";
import type { AgentRuntime, RuntimeFactory } from "../runtime/types.js";
import type { RunEvent, SessionId, RunId, TaskRun } from "../core/types.js";
import { ContextAssembler, type ContextAssembly } from "./context-assembler.js";

export class AgentService {
  private readonly runtimes = new Map<RunId, AgentRuntime>();
  private readonly listeners = new Map<RunId, Set<(event: RunEvent) => void>>();
  private readonly continuationOwner = randomUUID();

  constructor(
    private readonly store: Store,
    private readonly workspace: string,
    private readonly runtimeFactory: RuntimeFactory = createInProcessRuntime,
    private readonly runtimeDefaults: Pick<Parameters<RuntimeFactory>[0], "model" | "apiKey" | "providerTimeoutMs" | "providerMaxRetries" | "runTimeoutMs" | "runHardTimeoutMs"> & { maxContinuations?: number; maxRunTokens?: number; contextWindow?: number; maxContextTurns?: number; contextReserveTokens?: number; dynamicBudget?: boolean } = {},
  ) {
    this.store.markInterrupted();
  }

  async followUp(runId: RunId, instruction: string) {
    const runtime = this.runtimes.get(runId);
    if (!runtime?.followUp) return "inactive" as const;
    try { await runtime.followUp(instruction); }
    catch (error) {
      this.publish(this.store.appendEvent(runId, "run.follow_up.failed", { error: error instanceof Error ? error.message : String(error) }));
      return "failed" as const;
    }
    this.publish(this.store.appendEvent(runId, "run.follow_up.queued", { instruction }));
    return "accepted" as const;
  }

  async compact(runId: RunId, instructions?: string) {
    const runtime = this.runtimes.get(runId);
    if (!runtime?.compact) return "inactive" as const;
    try { await runtime.compact(instructions); }
    catch (error) {
      this.publish(this.store.appendEvent(runId, "context.compaction.failed", { error: error instanceof Error ? error.message : String(error) }));
      return "failed" as const;
    }
    return "completed" as const;
  }

  private repairTranscript(runId: RunId, reason: "cancelled" | "resume" | "continuation") {
    const repaired = this.store.repairTranscript(runId, reason);
    if (repaired.length) this.publish(this.store.appendEvent(runId, "transcript.repaired", { reason, repaired }));
    return repaired;
  }

  recoverContinuations() {
    const recovered = this.store.recoverContinuationsAfterRestart();
    const runIds = [...new Set(recovered.map((item) => item.runId))];
    for (const runId of runIds) {
      const items = recovered.filter((item) => item.runId === runId);
      this.publish(this.store.appendEvent(runId, "continuation.recovered", { reason: "lease_expired_or_queued", continuations: items.map((item) => ({ id: item.id, ordinal: item.ordinal })) }));
      setImmediate(() => this.startQueuedContinuation(runId));
    }
    return runIds;
  }

  closeRuntimes() {
    for (const runtime of this.runtimes.values()) runtime.abort();
    this.runtimes.clear();
    return this.store.releaseContinuationLeases(this.continuationOwner);
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    const existing = this.store.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    if (existing) return this.store.getRun(existing.id)!;

    const run = this.store.createRun(sessionId, query, requestId);
    const sessionHistory = this.prepareSessionHistory(run, query);
    this.store.appendMessage(sessionId, "user", query);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: query, sessionHistoryCount: sessionHistory.messages.length }));
    this.publishContextEvents(run.id, sessionHistory);
    this.launch(run, query, sessionHistory.messages);
    return run;
  }

  private launch(run: TaskRun, prompt: string, initialMessages: AgentMessage[] = [], continuationId?: string) {
    const budget = this.executionBudget(run);
    const idleTimeoutMs = budget.runTimeoutMs;
    const hardTimeoutMs = this.runtimeDefaults.runHardTimeoutMs ?? 86_400_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    let runtime: AgentRuntime;

    const failTimeout = (reason: "idle_timeout" | "hard_timeout", limitMs: number) => {
      if (this.store.getRun(run.id)?.status !== "running") return;
      runtime.abort();
      const message = reason === "idle_timeout"
        ? `Run idle for ${limitMs}ms without progress`
        : `Run exceeded ${limitMs}ms absolute hard timeout`;
      const event = this.store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: message, reason, limitMs }, message);
      if (!event) return;
      this.store.appendMessage(run.sessionId, "assistant", `Run failed: ${message}`);
      this.publish(event);
    };
    const touchActivity = () => {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => failTimeout("idle_timeout", idleTimeoutMs), idleTimeoutMs);
    };

    runtime = this.runtimeFactory({
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
      runHardTimeoutMs: this.runtimeDefaults.runHardTimeoutMs,
      onActivity: touchActivity,
      onEvent: (event) => {
        touchActivity();
        this.publish(event);
      },
    });
    this.runtimes.set(run.id, runtime);
    if (continuationId) leaseTimer = setInterval(() => this.store.renewContinuationLease(continuationId, this.continuationOwner, 30_000), 10_000);
    touchActivity();
    hardTimer = setTimeout(() => failTimeout("hard_timeout", hardTimeoutMs), hardTimeoutMs);

    void this.execute(run.id, runtime, prompt).then((blocked) => {
      if (continuationId) {
        const status = this.store.getRun(run.id)?.status;
        this.store.updateContinuation(continuationId, status === "completed" ? "completed" : status === "blocked" ? "blocked" : status === "cancelled" ? "cancelled" : "failed", status === "failed" ? this.store.getRun(run.id)?.blockedReason ?? "" : "", this.continuationOwner);
      }
      if (blocked) this.queueContinuation(run.id);
    }).finally(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (leaseTimer) clearInterval(leaseTimer);
      if (this.store.getRun(run.id)?.status === "cancelled") this.repairTranscript(run.id, "cancelled");
      runtime.dispose?.();
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
      this.publish(result.event);
      return !result.gate.passed;
    } catch (error) {
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running") return false;
      const message = error instanceof Error ? error.message : String(error);
      const event = this.store.transitionRun(runId, ["running"], "failed", "run.failed", { error: message }, message);
      if (!event) return false;
      this.store.appendMessage(current.sessionId, "assistant", `Run failed: ${message}`);
      this.publish(event);
      return false;
    }
  }

  private executionBudget(run: TaskRun) {
    const hardContinuations = this.runtimeDefaults.maxContinuations ?? 128;
    const hardTokens = this.runtimeDefaults.maxRunTokens ?? 2_000_000;
    if (this.runtimeDefaults.dynamicBudget === false) return { tier: "fixed", maxContinuations: hardContinuations, maxTokens: hardTokens, runTimeoutMs: this.runtimeDefaults.runTimeoutMs ?? 900_000 };

    let score = Math.min(6, Math.ceil(run.goal.length / 240));
    if (/(implement|develop|refactor|migrate|audit|debug|test|build|deploy|实现|开发|重构|迁移|审计|调试|测试|构建|部署)/i.test(run.goal)) score += 3;
    if (/(multi|multiple|across|end[- ]to[- ]end|architecture|database|frontend|backend|多轮|多个|跨|架构|数据库|前端|后端)/i.test(run.goal)) score += 3;
    score += Math.min(8, run.plan.filter((item) => item.required).length);
    score += Math.min(6, run.checks.filter((item) => item.required).length * 2);
    score += Math.min(6, run.plan.filter((item) => item.required && item.status !== "done").length);
    score += Math.min(4, Math.floor(run.continuations.length / 3));

    const tier = score >= 16 ? "extended" : score >= 10 ? "complex" : score >= 5 ? "standard" : "simple";
    const presets = {
      simple: { maxContinuations: 4, maxTokens: 80_000, runTimeoutMs: 300_000 },
      standard: { maxContinuations: 12, maxTokens: 240_000, runTimeoutMs: 900_000 },
      complex: { maxContinuations: 32, maxTokens: 640_000, runTimeoutMs: 2_700_000 },
      extended: { maxContinuations: 96, maxTokens: 1_600_000, runTimeoutMs: 7_200_000 },
    } as const;
    return {
      tier,
      maxContinuations: Math.min(hardContinuations, presets[tier].maxContinuations),
      maxTokens: Math.min(hardTokens, presets[tier].maxTokens),
      runTimeoutMs: Math.min(this.runtimeDefaults.runTimeoutMs ?? 7_200_000, presets[tier].runTimeoutMs),
    };
  }

  private queueContinuation(runId: RunId) {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "blocked") return;
    const budget = this.executionBudget(run);
    const maxContinuations = budget.maxContinuations;
    const maxRunTokens = budget.maxTokens;
    if (run.continuations.length >= maxContinuations) {
      const message = `Run remains blocked after ${maxContinuations} automatic continuation${maxContinuations === 1 ? "" : "s"}: ${run.blockedReason}`;
      this.store.appendMessage(run.sessionId, "assistant", message);
      this.publish(this.store.appendEvent(runId, "continuation.exhausted", { reason: "max_continuations", tier: budget.tier, limit: maxContinuations }));
      return;
    }
    if (run.usage.totalTokens >= maxRunTokens) {
      const message = `Run remains blocked because the ${maxRunTokens.toLocaleString()} token continuation budget was exhausted: ${run.blockedReason}`;
      this.store.appendMessage(run.sessionId, "assistant", message);
      this.publish(this.store.appendEvent(runId, "continuation.exhausted", { reason: "token_budget", tier: budget.tier, limit: maxRunTokens, totalTokens: run.usage.totalTokens }));
      return;
    }
    const continuation = this.store.queueContinuation(runId, run.blockedReason);
    this.publish(this.store.appendEvent(runId, "continuation.queued", { continuationId: continuation.id, ordinal: continuation.ordinal, reason: continuation.reason, budget }));
  }

  private startQueuedContinuation(runId: RunId) {
    if (this.runtimes.has(runId)) return;
    this.repairTranscript(runId, "continuation");
    const claimed = this.store.claimContinuation(runId, this.continuationOwner, 30_000);
    if (!claimed) return;
    const { continuation, run, event } = claimed;
    const prompt = this.buildContinuationPrompt(run, continuation.ordinal);
    const transcript = this.prepareTranscript(run, prompt);
    this.publishContextEvents(runId, transcript);
    this.publish(event);
    this.launch(run, prompt, transcript.messages, continuation.id);
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
    const event = this.store.transitionRun(runId, ["running"], "cancelled", "run.cancelled", {}, "Cancelled by user");
    if (!event) return false;
    this.publish(event);
    return true;
  }

  async steer(runId: RunId, instruction: string) {
    const runtime = this.runtimes.get(runId);
    if (!runtime) return "inactive" as const;
    try { await runtime.steer(instruction); }
    catch (error) {
      this.publish(this.store.appendEvent(runId, "run.steer.failed", { error: error instanceof Error ? error.message : String(error) }));
      return "failed" as const;
    }
    this.publish(this.store.appendEvent(runId, "run.steered", { instruction }));
    return "accepted" as const;
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

  getBudget(runId: RunId) {
    const run = this.store.getRun(runId);
    return run ? this.executionBudget(run) : undefined;
  }

  getRun(runId: RunId) {
    return this.store.getRun(runId);
  }

  resume(runId: RunId) {
    if (this.runtimes.has(runId)) throw new Error("Run is already active");
    this.store.cancelQueuedContinuations(runId, "Superseded by manual resume");
    this.repairTranscript(runId, "resume");
    const run = this.store.resumeRun(runId);
    const provisionalPrompt = this.buildResumePrompt(run, this.store.listTranscript(run.id).length);
    const transcript = this.prepareTranscript(run, provisionalPrompt);
    const prompt = this.buildResumePrompt(run, transcript.messages.length);
    this.publishContextEvents(run.id, transcript);
    const event = this.store.appendEvent(run.id, "run.resumed", { attempt: run.attempt, resumedAt: run.resumedAt, mode: transcript.messages.length ? "transcript-continuation" : "durable-snapshot-replay", transcriptCount: transcript.messages.length });
    this.publish(event);
    this.launch(run, prompt, transcript.messages);
    return run;
  }

  private prepareTranscript(run: TaskRun, prompt: string) {
    return this.contextAssembler().assemble("transcript", this.store.listTranscript(run.id), this.buildSystemPrompt(run), prompt);
  }

  private prepareSessionHistory(run: TaskRun, query: string) {
    const history = this.store.listRecentMessages(run.sessionId, 10_000)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message): AgentMessage => message.role === "user"
        ? { role: "user", content: message.content, timestamp: message.createdAt }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            api: "openai-completions",
            provider: "tagent-core",
            model: "session-history",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: message.createdAt,
          });
    return this.contextAssembler().assemble("session", history, this.buildSystemPrompt(run), query);
  }

  private contextAssembler() {
    const contextWindow = this.runtimeDefaults.contextWindow ?? this.runtimeDefaults.model?.contextWindow ?? 200_000;
    return new ContextAssembler({
      contextWindow,
      maxOutputTokens: this.runtimeDefaults.model?.maxTokens ?? Math.min(32_768, Math.floor(contextWindow * 0.2)),
      maxTurns: this.runtimeDefaults.maxContextTurns ?? 20,
      reserveTokens: this.runtimeDefaults.contextReserveTokens,
    });
  }

  private publishContextEvents(runId: RunId, assembly: ContextAssembly) {
    const { source, ...stats } = assembly.stats;
    this.publish(this.store.appendEvent(runId, "context.loaded", { source, ...stats }));
    if (stats.droppedTurns > 0 || stats.compressedTurns > 0) {
      this.publish(this.store.appendEvent(runId, "context.pruned", { source, ...stats }));
    }
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
