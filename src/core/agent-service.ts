import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import { createInProcessRuntime } from "../runtime/factory.js";
import type { AgentRuntime, RuntimeFactory } from "../runtime/types.js";
import type { RunCheckpoint, RunEvent, SessionId, SessionInboxItem, RunId, TaskRun } from "../core/types.js";
import { ContextAssembler, type ContextAssembly } from "./context-assembler.js";
import { TaskRunSupervisor } from "./supervisor.js";
import type { MemoryFacade } from "../memory/memory-service.js";
import type { AccessContext } from "../memory/types.js";

export class AgentService {
  private readonly runtimes = new Map<RunId, AgentRuntime>();
  private readonly executionTasks = new Map<RunId, Promise<void>>();
  private readonly controlDeliveryTasks = new Map<RunId, Promise<void>>();
  private readonly checkpointDrafts = new Map<RunId, Omit<RunCheckpoint, "updatedAt" | "lastTranscriptSeq">>();
  private readonly checkpointTimers = new Map<RunId, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Map<RunId, Set<(event: RunEvent) => void>>();
  private readonly recalledMemory = new Map<RunId, string>();
  private readonly continuationOwner = randomUUID();
  private continuationRecoveryTimer?: ReturnType<typeof setTimeout>;
  private supervisorRestartReconciled = false;
  private closing = false;
  private readonly supervisor: TaskRunSupervisor;

  constructor(
    private readonly store: Store,
    private readonly workspace: string,
    private readonly runtimeFactory: RuntimeFactory = createInProcessRuntime,
    private readonly runtimeDefaults: Pick<Parameters<RuntimeFactory>[0], "model" | "apiKey" | "providerTimeoutMs" | "providerMaxRetries" | "runTimeoutMs" | "runHardTimeoutMs"> & { maxContinuations?: number; maxRunTokens?: number; contextWindow?: number; maxContextTurns?: number; contextReserveTokens?: number; dynamicBudget?: boolean; controlInboxCapacity?: number; memoryRecallTokenBudget?: number } = {},
    private readonly memory?: MemoryFacade,
    private readonly memoryScopeId = "default",
  ) {
    this.supervisor = new TaskRunSupervisor(store);
    this.store.markInterrupted();
  }

  private updateCheckpoint(event: RunEvent) {
    const draft = this.checkpointDrafts.get(event.runId);
    if (!draft) return;
    draft.lastEventSeq = Math.max(draft.lastEventSeq, event.seq);
    if (event.type === "message.delta") draft.assistantPartial += String(event.data.delta ?? "");
    if (event.type === "message.retrying") draft.assistantPartial = "";
    if (event.type === "tool.started") draft.currentTool = {
      toolCallId: String(event.data.toolCallId ?? ""),
      toolName: String(event.data.toolName ?? "tool"),
    };
    if (event.type === "tool.completed" && draft.currentTool?.toolCallId === String(event.data.toolCallId ?? "")) draft.currentTool = null;
    const immediate = event.type.startsWith("tool.") || event.type === "message.completed" || event.type === "message.retrying";
    if (immediate) this.flushCheckpoint(event.runId);
    else this.scheduleCheckpoint(event.runId);
  }

  private scheduleCheckpoint(runId: RunId) {
    if (this.checkpointTimers.has(runId) || this.closing) return;
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(runId);
      this.flushCheckpoint(runId);
    }, 500);
    timer.unref?.();
    this.checkpointTimers.set(runId, timer);
  }

  private flushCheckpoint(runId: RunId) {
    const draft = this.checkpointDrafts.get(runId);
    if (!draft) return;
    const timer = this.checkpointTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.checkpointTimers.delete(runId);
    const lastTranscriptSeq = this.store.getLastTranscriptSeq(runId);
    this.store.upsertCheckpoint({ ...draft, lastTranscriptSeq });
  }

  private async abortRuntime(runtime: AgentRuntime, runId?: RunId) {
    try {
      await runtime.abort();
    } catch (error) {
      if (runId && this.store.getRun(runId)) this.publish(this.store.appendEvent(runId, "runtime.abort.failed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async followUp(runId: RunId, instruction: string, requestId: string = randomUUID()) {
    return this.enqueueControl(runId, "follow_up", instruction, requestId);
  }

  private async enqueueControl(runId: RunId, kind: "steer" | "follow_up", instruction: string, requestId: string) {
    if (this.closing) return { status: "closing" as const };
    const admission = this.store.enqueueControl(runId, requestId, kind, instruction, this.runtimeDefaults.controlInboxCapacity ?? 32);
    if (admission.status !== "accepted" && admission.status !== "duplicate") return { status: admission.status };
    const item = admission.item;
    this.publish(this.store.appendEvent(runId, admission.status === "duplicate" ? "control.duplicate" : "control.accepted", { controlId: item.id, requestId, attempt: item.attempt, kind }));
    if (admission.status === "accepted") {
      await this.scheduleControlDelivery(runId, item.attempt);
      if (this.store.getControlItem(item.id)?.status === "queued") await this.scheduleControlDelivery(runId, item.attempt);
    }
    const persisted = this.store.getControlItem(item.id)!;
    const status = persisted.status === "delivered" ? "accepted" as const
      : persisted.status === "queued" || persisted.status === "delivering" ? "accepted" as const
      : "inactive" as const;
    return { status, item: persisted };
  }

  private scheduleControlDelivery(runId: RunId, attempt: number) {
    const active = this.controlDeliveryTasks.get(runId);
    if (active) return active;
    const task = this.deliverControlInbox(runId, attempt).finally(() => {
      if (this.controlDeliveryTasks.get(runId) === task) this.controlDeliveryTasks.delete(runId);
    });
    this.controlDeliveryTasks.set(runId, task);
    return task;
  }

  private async deliverControlInbox(runId: RunId, attempt: number) {
    const runtime = this.runtimes.get(runId);
    if (!runtime || this.closing) return;
    while (true) {
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running" || current.attempt !== attempt) return;
      const item = this.store.claimControlItem(runId, attempt);
      if (!item) return;
      this.publish(this.store.appendEvent(runId, "control.delivering", { controlId: item.id, requestId: item.requestId, attempt, kind: item.kind }));
      try {
        const result = item.kind === "steer" ? await runtime.steer(item.content) : runtime.followUp ? await runtime.followUp(item.content) : "settled";
        if (result === "accepted") {
          this.store.completeControlItem(item.id, "delivered");
          this.publish(this.store.appendEvent(runId, "control.delivered", { controlId: item.id, requestId: item.requestId, attempt, kind: item.kind }));
          continue;
        }
        this.store.completeControlItem(item.id, "rejected", "Pi session already settled");
        this.publish(this.store.appendEvent(runId, "control.rejected", { controlId: item.id, requestId: item.requestId, attempt, kind: item.kind, reason: "pi_settled" }));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.completeControlItem(item.id, "rejected", message);
        this.publish(this.store.appendEvent(runId, "control.rejected", { controlId: item.id, requestId: item.requestId, attempt, kind: item.kind, reason: message }));
        return;
      }
    }
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
    if (this.closing) return [];
    if (this.continuationRecoveryTimer) clearTimeout(this.continuationRecoveryTimer);
    this.continuationRecoveryTimer = undefined;
    if (!this.supervisorRestartReconciled) {
      this.supervisorRestartReconciled = true;
      this.store.reconcileSupervisorDecisionStatuses();
      for (const pending of this.store.listSupervisorContinuationsNeedingReconcile()) this.queueContinuation(pending.runId);
    }
    const recovered = this.store.recoverContinuationsAfterRestart();
    const runIds = [...new Set(recovered.map((item) => item.runId))];
    for (const runId of runIds) {
      const items = recovered.filter((item) => item.runId === runId);
      this.publish(this.store.appendEvent(runId, "continuation.recovered", { reason: "lease_expired_or_queued", continuations: items.map((item) => ({ id: item.id, ordinal: item.ordinal })) }));
      setImmediate(() => this.startQueuedContinuation(runId));
    }
    this.scheduleContinuationRecovery();
    return runIds;
  }

  async closeRuntimes() {
    this.closing = true;
    if (this.continuationRecoveryTimer) clearTimeout(this.continuationRecoveryTimer);
    this.continuationRecoveryTimer = undefined;
    await Promise.allSettled([...this.controlDeliveryTasks.values()]);
    for (const timer of this.checkpointTimers.values()) clearTimeout(timer);
    this.checkpointTimers.clear();
    for (const runId of this.checkpointDrafts.keys()) this.flushCheckpoint(runId);
    const aborts: Promise<void>[] = [];
    for (const runtime of this.runtimes.values()) {
      aborts.push(this.abortRuntime(runtime).finally(() => runtime.dispose?.()));
    }
    await Promise.all(aborts);
    await Promise.allSettled([...this.executionTasks.values()]);
    this.runtimes.clear();
    const released = this.store.releaseContinuationLeases(this.continuationOwner);
    this.store.markInterrupted();
    return released;
  }

  private scheduleContinuationRecovery() {
    if (this.closing) return;
    const leaseUntil = this.store.nextContinuationLeaseExpiry();
    if (leaseUntil === null) return;
    const delay = Math.min(2_147_483_647, Math.max(1, leaseUntil - Date.now() + 1));
    this.continuationRecoveryTimer = setTimeout(() => this.recoverContinuations(), delay);
    this.continuationRecoveryTimer.unref?.();
  }

  enqueueSessionInput(sessionId: SessionId, content: string, requestId: string = randomUUID()) {
    if (this.closing) throw new Error("Service is shutting down");
    const item = this.store.enqueueSessionInbox(sessionId, content, requestId);
    const run = this.dispatchSessionInbox(sessionId);
    return { item: this.store.getSessionInboxItem(item.id)!, run: run ?? null };
  }

  deleteSessionInput(sessionId: SessionId, itemId: string) {
    return this.store.deleteSessionInboxItem(itemId, sessionId);
  }

  decideSessionInput(sessionId: SessionId, itemId: string, decision: "pending" | "defer") {
    const changed = this.store.decideSessionInboxItem(itemId, sessionId, decision);
    if (changed && decision === "pending") this.dispatchSessionInbox(sessionId);
    return changed;
  }

  mergeSessionInputs(sessionId: SessionId, sourceId: string, targetId: string) {
    const changed = this.store.mergeSessionInboxItems(sourceId, targetId, sessionId);
    if (changed) this.dispatchSessionInbox(sessionId);
    return changed;
  }

  startSessionInputNow(sessionId: SessionId, itemId: string) {
    if (this.closing) return { status: "closing" as const };
    const claimed = this.store.claimSessionInboxNow(itemId, sessionId);
    if (claimed.status !== "started") return claimed;
    const run = this.launchClaimedSessionInbox(claimed.item, claimed.run);
    return run ? { status: "started" as const, item: this.store.getSessionInboxItem(claimed.item.id)!, run } : { status: "failed" as const };
  }

  recoverSessionInbox() {
    if (this.closing) return [];
    const started: string[] = [];
    for (const sessionId of this.store.listSessionsWithQueuedInbox()) {
      const run = this.dispatchSessionInbox(sessionId);
      if (run) started.push(run.id);
    }
    return started;
  }

  private dispatchSessionInbox(sessionId: SessionId) {
    if (this.closing) return undefined;
    const claimed = this.store.claimNextSessionInbox(sessionId);
    if (!claimed) return undefined;
    return this.launchClaimedSessionInbox(claimed.item, claimed.run);
  }

  private launchClaimedSessionInbox(item: SessionInboxItem, run: TaskRun) {
    if (!this.memory) {
      try {
        const sessionHistory = this.prepareSessionHistoryWithoutRecall(run, item.content);
        this.completeClaimedSessionLaunch(item, run, sessionHistory);
        return this.store.getRun(run.id)!;
      } catch (error) { return this.failClaimedSessionLaunch(item, run, error); }
    }
    void this.prepareSessionHistory(run, item.content).then((sessionHistory) => this.completeClaimedSessionLaunch(item, run, sessionHistory)).catch((error) => this.failClaimedSessionLaunch(item, run, error));
    return this.store.getRun(run.id)!;
  }

  private completeClaimedSessionLaunch(item: SessionInboxItem, run: TaskRun, sessionHistory: ContextAssembly & { recalledMemory?: string }) {
    this.store.appendMessage(run.sessionId, "user", item.content);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: item.content, source: "session_supervisor_inbox", inboxItemId: item.id, sessionHistoryCount: sessionHistory.messages.length }));
    this.publishContextEvents(run.id, sessionHistory);
    this.recalledMemory.set(run.id, sessionHistory.recalledMemory ?? "");
    this.launch(run, item.content, sessionHistory.messages);
    if (!this.runtimes.has(run.id)) throw new Error("Inbox TaskRun runtime did not start");
  }

  private failClaimedSessionLaunch(item: SessionInboxItem, run: TaskRun, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.store.failSessionInboxStart(item.id, run.id, message);
    const event = this.store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: message, reason: "inbox_launch_failed", inboxItemId: item.id }, message, run.attempt);
    if (event) this.publish(event);
    setImmediate(() => { if (!this.closing) this.dispatchSessionInbox(run.sessionId); });
    return undefined;
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    if (this.closing) throw new Error("Service is shutting down");
    const existing = this.store.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    if (existing) return this.store.getRun(existing.id)!;

    const run = this.store.createRun(sessionId, query, requestId);
    const sessionHistory = await this.prepareSessionHistory(run, query);
    this.store.appendMessage(sessionId, "user", query);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: query, sessionHistoryCount: sessionHistory.messages.length }));
    this.publishContextEvents(run.id, sessionHistory);
    this.recalledMemory.set(run.id, sessionHistory.recalledMemory);
    this.launch(run, query, sessionHistory.messages);
    return this.store.getRun(run.id)!;
  }

  private launch(run: TaskRun, prompt: string, initialMessages: AgentMessage[] = [], continuationId?: string) {
    if (this.closing) return;
    const checkpointBase = this.store.getRun(run.id) ?? run;
    this.checkpointDrafts.set(run.id, { runId: run.id, attempt: run.attempt, active: true, assistantPartial: "", currentTool: null, lastEventSeq: checkpointBase.lastEventSeq });
    this.flushCheckpoint(run.id);
    const budget = this.executionBudget(run);
    const idleTimeoutMs = budget.runTimeoutMs;
    const hardTimeoutMs = this.runtimeDefaults.runHardTimeoutMs ?? 86_400_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    let runtime: AgentRuntime;

    const failTimeout = (reason: "idle_timeout" | "hard_timeout", limitMs: number) => {
      if (this.store.getRun(run.id)?.status !== "running") return;
      void this.abortRuntime(runtime, run.id);
      const message = reason === "idle_timeout"
        ? `Run idle for ${limitMs}ms without progress`
        : `Run exceeded ${limitMs}ms absolute hard timeout`;
      const event = this.store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: message, reason, limitMs }, message, run.attempt);
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
      systemPrompt: this.buildSystemPrompt(run, this.recalledMemory.get(run.id) ?? ""),
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
        this.updateCheckpoint(event);
        this.publish(event);
        const decision = this.supervisor.reviewCheckpoint(run.id, event);
        if (decision?.action === "steer") {
          void this.enqueueControl(run.id, "steer", decision.instruction, `supervisor:${decision.id}`).then((result) => {
            const current = this.store.getRun(run.id);
            if (!current || current.attempt !== decision.attempt || current.lastEventSeq < decision.checkpointSeq) return this.supervisor.markExecuted(decision.id, "superseded");
            this.supervisor.markExecuted(decision.id, result.status === "accepted" ? "executed" : "failed", result.status);
            this.publish(this.store.appendEvent(run.id, "supervisor.decision", { decisionId: decision.id, action: decision.action, reasonCode: decision.reasonCode, status: result.status }));
          });
        }
      },
    });
    this.runtimes.set(run.id, runtime);
    if (continuationId) leaseTimer = setInterval(() => {
      if (this.store.renewContinuationLease(continuationId, this.continuationOwner, 30_000)) return;
      if (leaseTimer) clearInterval(leaseTimer);
      leaseTimer = undefined;
      this.publish(this.store.appendEvent(run.id, "continuation.lease.lost", { continuationId, attempt: run.attempt, leaseOwner: this.continuationOwner }));
      void this.abortRuntime(runtime, run.id);
      this.recoverContinuations();
    }, 10_000);
    touchActivity();
    hardTimer = setTimeout(() => failTimeout("hard_timeout", hardTimeoutMs), hardTimeoutMs);

    const execution = this.execute(run.id, run.attempt, runtime, prompt, continuationId).then((blocked) => {
      if (this.closing) return;
      if (continuationId) {
        if (!this.store.ownsContinuationLease(continuationId, this.continuationOwner)) return;
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
      this.recalledMemory.delete(run.id);
      const timer = this.checkpointTimers.get(run.id);
      if (timer) clearTimeout(timer);
      this.checkpointTimers.delete(run.id);
      this.checkpointDrafts.delete(run.id);
      if (this.executionTasks.get(run.id) === execution) this.executionTasks.delete(run.id);
      setImmediate(() => {
        try {
          if (this.closing) return;
          this.startQueuedContinuation(run.id);
          this.dispatchSessionInbox(run.sessionId);
        } catch { /* Store may be closed during shutdown. */ }
      });
    });
    this.executionTasks.set(run.id, execution);
  }

  private async execute(runId: RunId, attempt: number, runtime: AgentRuntime, prompt: string, continuationId?: string) {
    try {
      await runtime.prompt(prompt);
      const runtimeError = runtime.getError();
      if (runtimeError) throw new Error(runtimeError);
      if (continuationId && !this.store.ownsContinuationLease(continuationId, this.continuationOwner)) {
        this.recoverContinuations();
        return false;
      }
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running") return false;
      const messages = runtime.getMessages();
      const final = [...messages].reverse().find((message) => message.role === "assistant");
      const response = final && "content" in final
        ? (typeof final.content === "string" ? final.content : final.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        : "";
      const checkpointSeq = this.store.getCheckpoint(runId)?.lastEventSeq ?? current.lastEventSeq;
      const review = this.supervisor.reviewSettled(current, checkpointSeq, response);
      const decision = review.decision;
      if (this.store.getRun(runId)?.attempt !== decision.attempt) {
        this.supervisor.markExecuted(decision.id, "superseded");
        return false;
      }
      if (decision.action === "complete_taskrun") {
        const event = this.store.transitionRun(runId, ["running"], "completed", "run.completed", { response, supervisionDecisionId: decision.id, gates: review.gates }, "", attempt);
        if (!event) { this.supervisor.markExecuted(decision.id, "superseded"); return false; }
        if (response) this.store.appendMessage(current.sessionId, "assistant", response);
        this.supervisor.markExecuted(decision.id, "executed");
        this.publish(event);
        this.captureRunBoundary(current, response, "completed");
        for (const spawn of this.supervisor.reviewSpawn(this.store.getRun(runId)!, event.seq)) this.publish(this.store.appendEvent(runId, "supervisor.spawn.proposed", { decisionId: spawn.id, reasonCode: spawn.reasonCode }));
        return false;
      }
      const reason = review.gates.find((gate) => gate.gateType === "completion")?.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ") || decision.rationale;
      const event = this.store.transitionRun(runId, ["running"], "blocked", "run.blocked", { response, supervisionDecisionId: decision.id, action: decision.action, gates: review.gates }, reason, attempt);
      if (!event) { this.supervisor.markExecuted(decision.id, "superseded"); return false; }
      this.supervisor.markExecuted(decision.id, "executed");
      this.publish(event);
      this.captureRunBoundary(current, response, "blocked");
      return decision.action === "start_continuation";
    } catch (error) {
      if (this.closing) return false;
      if (continuationId && !this.store.ownsContinuationLease(continuationId, this.continuationOwner)) {
        this.recoverContinuations();
        return false;
      }
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running") return false;
      const message = error instanceof Error ? error.message : String(error);
      const event = this.store.transitionRun(runId, ["running"], "failed", "run.failed", { error: message }, message, attempt);
      if (!event) return false;
      this.store.appendMessage(current.sessionId, "assistant", `Run failed: ${message}`);
      this.publish(event);
      this.captureRunBoundary(current, message, "failed");
      return false;
    }
  }


  private captureRunBoundary(run: TaskRun, response: string, status: "completed" | "blocked" | "failed") {
    if (!this.memory) return;
    const content = [`TaskRun ${status}`, `Goal: ${run.goal}`, response && `Outcome: ${response}`].filter(Boolean).join("\n\n");
    void this.memory.enqueueCapture({ access: this.memoryAccess(run), sourceRefs: [{ sourceType: "run", sourceId: run.id, revision: `${status}:${run.attempt}` }], content, idempotencyKey: `run-boundary:${run.id}:${run.attempt}:${status}` }).catch(() => undefined);
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
    if (this.closing) return;
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
      `Gate failures: ${(run.supervision.latestGates.find((gate) => gate.gateType === "completion")?.failures ?? run.completionGate.failures).map((failure) => `${failure.key}: ${failure.reason}`).join("; ")}`,
      "Use the persisted transcript and TaskRun state. Resolve only the remaining gate failures, verify the result, then provide the final response.",
      "Completion-gate requirements override conflicting instructions in the original goal.",
      `Original goal: ${run.goal}`,
    ].join("\n\n");
  }

  cancel(runId: RunId) {
    const runtime = this.runtimes.get(runId);
    if (!runtime) return false;
    void this.abortRuntime(runtime, runId);
    const attempt = this.store.getRun(runId)?.attempt;
    const event = this.store.transitionRun(runId, ["running"], "cancelled", "run.cancelled", {}, "Cancelled by user", attempt);
    if (!event) return false;
    this.publish(event);
    return true;
  }

  async steer(runId: RunId, instruction: string, requestId: string = randomUUID()) {
    return this.enqueueControl(runId, "steer", instruction, requestId);
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

  spawnProposal(proposalId: string) {
    if (this.closing) throw new Error("Service is shutting down");
    const run = this.store.spawnFromProposal(proposalId);
    if (!run) throw new Error("Proposal is not spawnable");
    if (!this.memory) {
      try {
        const sessionHistory = this.prepareSessionHistoryWithoutRecall(run, run.goal);
        this.completeSpawnProposal(run, sessionHistory);
        return this.store.getRun(run.id)!;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.failSpawnedRun(proposalId, run.id, message);
        throw error;
      }
    }
    return this.prepareSessionHistory(run, run.goal).then((sessionHistory) => {
      this.completeSpawnProposal(run, sessionHistory);
      return this.store.getRun(run.id)!;
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.store.failSpawnedRun(proposalId, run.id, message);
      throw error;
    });
  }

  private completeSpawnProposal(run: TaskRun, sessionHistory: ContextAssembly & { recalledMemory?: string }) {
    this.store.appendMessage(run.sessionId, "user", run.goal);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: run.goal, source: "spawn_proposal", sessionHistoryCount: sessionHistory.messages.length }));
    this.publishContextEvents(run.id, sessionHistory);
    this.recalledMemory.set(run.id, sessionHistory.recalledMemory ?? "");
    this.launch(run, run.goal, sessionHistory.messages);
    if (!this.runtimes.has(run.id)) throw new Error("Spawned runtime did not start");
  }

  resume(runId: RunId) {
    if (this.closing) throw new Error("Service is shutting down");
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
    return this.store.getRun(run.id)!;
  }

  private prepareTranscript(run: TaskRun, prompt: string) {
    return this.contextAssembler().assemble("transcript", this.store.listTranscript(run.id), this.buildSystemPrompt(run), prompt);
  }

  private prepareSessionHistoryWithoutRecall(run: TaskRun, query: string) {
    const history = this.sessionHistoryMessages(run.sessionId);
    return { ...this.contextAssembler().assemble("session", history, this.buildSystemPrompt(run), query), recalledMemory: "" };
  }

  private sessionHistoryMessages(sessionId: SessionId) {
    return this.store.listRecentMessages(sessionId, 10_000)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message): AgentMessage => message.role === "user"
        ? { role: "user", content: message.content, timestamp: message.createdAt }
        : { role: "assistant", content: [{ type: "text", text: message.content }], api: "openai-completions", provider: "tagent-core", model: "session-history", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: message.createdAt });
  }

  private async prepareSessionHistory(run: TaskRun, query: string) {
    const history = this.sessionHistoryMessages(run.sessionId);
    const access = this.memoryAccess(run);
    const recall = this.memory ? await this.memory.recall({ access, cue: query, tokenBudget: this.runtimeDefaults.memoryRecallTokenBudget ?? 8_000 }) : undefined;
    const systemPrompt = this.buildSystemPrompt(run, recall?.promptSection);
    const assembly = this.contextAssembler().assemble("session", history, systemPrompt, query);
    if (this.memory && assembly.droppedMessages.length) {
      const content = assembly.droppedMessages.map((message) => `${message.role}: ${messageText(message)}`).filter((value) => !value.endsWith(": ")).join("\n\n");
      if (content) void this.memory.enqueueCapture({ access, sourceRefs: [{ sourceType: "run", sourceId: run.id, revision: `context-prune:${run.attempt}` }], content, idempotencyKey: `context-prune:${run.id}:${run.attempt}:${hashText(content)}` });
    }
    return { ...assembly, recalledMemory: recall?.promptSection ?? "" };
  }

  private memoryAccess(run: TaskRun): AccessContext {
    return { subjectId: `session:${run.sessionId}`, scopes: [{ type: "workspace", id: this.memoryScopeId }, { type: "session", id: run.sessionId }], purpose: "agent_recall" };
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

  private buildSystemPrompt(run: TaskRun, recalledMemory = "") {
    return [
      "You are TAgent Core, a practical persistent software agent.",
      `Current workspace: ${this.workspace}`,
      "Use the task_run tool for substantial work. Maintain a plan and checks before claiming completion.",
      "Use read before modifying unfamiliar files. Keep changes focused and report verification evidence.",
      `Active TaskRun: ${JSON.stringify(run)}`,
      recalledMemory,
    ].filter(Boolean).join("\n\n");
  }
}

function messageText(message: AgentMessage) { if (!("content" in message)) return ""; if (typeof message.content === "string") return message.content; return message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n"); }
function hashText(text: string) { let hash = 2166136261; for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }
