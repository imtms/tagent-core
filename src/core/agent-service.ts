import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import { createInProcessRuntime } from "../runtime/factory.js";
import type { AgentRuntime, RuntimeFactory } from "../runtime/types.js";
import type { ContextManifestItem, RunCheckpoint, RunEvent, SessionId, SessionInboxItem, RunId, TaskRun } from "../core/types.js";
import { ContextAssembler, type ContextAssembly } from "./context-assembler.js";
import { runtimeRunContext } from "./llm-payload.js";
import { TaskRunSupervisor } from "./supervisor.js";
import { OpenAiSupervisorReviewer, SupervisorReviewError, TestSupervisorReviewer, type SupervisorReviewer } from "./supervisor-reviewer.js";
import { SessionInputRouter } from "./session-input-router.js";
import type { MemoryFacade } from "../memory/memory-service.js";
import type { AccessContext, MemoryProvenance } from "../memory/types.js";
import { WorkflowService, type WorkflowSpec, type WorkflowFeedbackSignal } from "../learning/workflow-service.js";
import { LearningService, type CommunicationApplicability, type CommunicationDimension } from "../learning/learning-service.js";
import type { LearningFeatureControl } from "../learning/feature-control.js";
import type { SemanticJudge } from "../learning/semantic-judge.js";

export class AgentService {
  private readonly runtimes = new Map<RunId, AgentRuntime>();
  private readonly executionTasks = new Map<RunId, Promise<void>>();
  private readonly controlDeliveryTasks = new Map<RunId, Promise<void>>();
  private readonly checkpointDrafts = new Map<RunId, Omit<RunCheckpoint, "updatedAt" | "lastTranscriptSeq">>();
  private readonly checkpointTimers = new Map<RunId, ReturnType<typeof setTimeout>>();
  private readonly lastCheckpointTranscriptSeq = new Map<RunId, number>();
  private readonly listeners = new Map<RunId, Set<(event: RunEvent) => void>>();
  private readonly recalledMemory = new Map<RunId, string>();
  private readonly workflowService: WorkflowService;
  private readonly learningService: LearningService;
  private readonly continuationOwner = randomUUID();
  private continuationRecoveryTimer?: ReturnType<typeof setTimeout>;
  private supervisorRestartReconciled = false;
  private closing = false;
  private readonly supervisor: TaskRunSupervisor;
  private readonly sessionRouter: SessionInputRouter;

  constructor(
    private readonly store: Store,
    private readonly workspace: string,
    private readonly runtimeFactory: RuntimeFactory = createInProcessRuntime,
    private readonly runtimeDefaults: Pick<Parameters<RuntimeFactory>[0], "model" | "apiKey" | "providerTimeoutMs" | "providerMaxRetries" | "runTimeoutMs" | "runHardTimeoutMs"> & { routerModel?: import("@earendil-works/pi-ai/compat").Model<"openai-completions">; routerTimeoutMs?: number; supervisorModel?: import("@earendil-works/pi-ai/compat").Model<"openai-completions">; supervisorTimeoutMs?: number; maxContinuations?: number; contextWindow?: number; maxContextTurns?: number; controlInboxCapacity?: number; supervisorReviewer?: SupervisorReviewer } = {},
    private readonly memory?: MemoryFacade,
    private readonly memoryScopeId = "default",
    private readonly learningControl?: LearningFeatureControl,
    private readonly semanticJudge?: SemanticJudge,
  ) {
    const reviewer = runtimeDefaults.supervisorReviewer ?? (runtimeDefaults.model && runtimeDefaults.apiKey ? new OpenAiSupervisorReviewer({ model: runtimeDefaults.supervisorModel ?? runtimeDefaults.model as import("@earendil-works/pi-ai/compat").Model<"openai-completions">, fallbackModel: runtimeDefaults.supervisorModel ? runtimeDefaults.model as import("@earendil-works/pi-ai/compat").Model<"openai-completions"> : undefined, apiKey: runtimeDefaults.apiKey, timeoutMs: runtimeDefaults.supervisorTimeoutMs ?? runtimeDefaults.providerTimeoutMs }) : process.env.VITEST ? new TestSupervisorReviewer() : undefined);
    if (!reviewer) throw new Error("LLM Supervisor reviewer requires a configured model and API key");
    this.supervisor = new TaskRunSupervisor(store, reviewer);
    this.sessionRouter = new SessionInputRouter({ model: runtimeDefaults.routerModel ?? runtimeDefaults.model as import("@earendil-works/pi-ai/compat").Model<"openai-completions"> | undefined, apiKey: runtimeDefaults.apiKey, timeoutMs: runtimeDefaults.routerTimeoutMs ?? 15_000 });
    this.workflowService = new WorkflowService(store, undefined, learningControl, semanticJudge);
    this.learningService = new LearningService(store, memory, memoryScopeId, semanticJudge);
    this.store.markInterrupted();
    if (learningControl?.snapshot().learningEnabled ?? true) {
      void this.workflowService.drainProjectionOutbox();
      this.learningService.drainLearningProjectionLedger();
      void this.learningService.drainFeedbackAttribution();
    }
  }

  private updateCheckpoint(event: RunEvent) {
    const draft = this.checkpointDrafts.get(event.runId);
    if (!draft) return;
    const relevant = event.type.startsWith("message.") || event.type.startsWith("tool.") || event.type === "provider.failure";
    if (!relevant) return;
    draft.lastEventSeq = Math.max(draft.lastEventSeq, event.seq);
    if (event.type === "message.started") draft.assistantPartial = "";
    if (event.type === "message.delta") draft.assistantPartial += String(event.data.delta ?? "");
    if (event.type === "message.retrying") draft.assistantPartial = "";
    if (event.type === "tool.started") draft.currentTool = {
      toolCallId: String(event.data.toolCallId ?? ""),
      toolName: String(event.data.toolName ?? "tool"),
      startedAt: event.createdAt,
      lastActivityAt: event.createdAt,
    };
    if (event.type === "tool.progress" && draft.currentTool?.toolCallId === String(event.data.toolCallId ?? "")) {
      draft.currentTool.lastActivityAt = event.createdAt;
    }
    if (event.type === "provider.failure" && draft.currentTool) draft.currentTool.lastActivityAt = event.createdAt;
    if ((event.type === "tool.completed" || event.type === "tool.failed") && draft.currentTool?.toolCallId === String(event.data.toolCallId ?? "")) draft.currentTool = null;
    const transcriptBoundary = event.type === "tool.completed" || event.type === "tool.failed" || event.type === "message.completed";
    if (transcriptBoundary) this.lastCheckpointTranscriptSeq.set(event.runId, this.store.getLastTranscriptSeq(event.runId));
    const immediate = event.type === "tool.started" || transcriptBoundary
      || event.type === "message.started" || event.type === "message.retrying";
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
    const lastTranscriptSeq = this.lastCheckpointTranscriptSeq.get(runId) ?? this.store.getLastTranscriptSeq(runId);
    this.lastCheckpointTranscriptSeq.set(runId, lastTranscriptSeq);
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
    this.lastCheckpointTranscriptSeq.clear();
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

  private sessionRouterContext(sessionId: SessionId) {
    return {
      recentMessages: this.store.listRecentMessages(sessionId, 12),
      recentRuns: this.store.listRuns(sessionId, 5),
    };
  }

  async enqueueSessionInput(sessionId: SessionId, content: string, requestId: string = randomUUID()) {
    if (this.closing) throw new Error("Service is shutting down");
    const existing = this.store.getSessionSubmission(sessionId, requestId);
    if (existing) return { item: existing, run: existing.runId ? this.store.getRun(existing.runId) ?? null : null };
    const activeRun = this.store.getActiveRun(sessionId);
    const analysis = await this.sessionRouter.analyze(content, activeRun, this.sessionRouterContext(sessionId));
    const duplicate = !activeRun ? this.store.findMergeCandidate(sessionId, analysis) : undefined;
    const item = this.store.enqueueSessionInbox(sessionId, content, analysis, requestId);
    if (analysis.intent === "defer") {
      this.store.decideSessionInboxItem(item.id, sessionId, "defer");
      return { item: this.store.getSessionInboxItem(item.id)!, run: null };
    }
    if (duplicate) {
      const merged = this.store.markSessionInboxDuplicate(item.id, duplicate.id, sessionId)!;
      return { item: merged, run: null, duplicate: true, mergedInto: duplicate.id };
    }

    if (activeRun && analysis.targetRunId === activeRun.id && analysis.confidence >= 0.85) {
      const userMessage = this.store.appendMessage(sessionId, "user", content);
      this.captureUserMessage(activeRun, userMessage.id, content);
      if (analysis.intent === "steer_active" || analysis.intent === "update_active_context") {
        const currentObjectives = analysis.objectives.filter((objective) => objective.timing === "current");
        const followUpObjectives = analysis.objectives.filter((objective) => objective.timing === "follow_up");
        const parallelObjectives = analysis.objectives.filter((objective) => objective.timing === "parallel");
        const steerContent = currentObjectives.length ? currentObjectives.map((objective) => objective.summary).join("\n") : content;
        const proposals = parallelObjectives.map((objective) => this.store.createSpawnProposal(activeRun.id, objective.summary, analysis.acceptanceCriteria.filter((criterion) => criterion.includes(objective.summary)), "parallel"));
        for (const proposal of proposals) this.publish(this.store.appendEvent(activeRun.id, "supervisor.spawn.proposed", { proposalId: proposal.id, inboxItemId: item.id, goal: proposal.goal, relation: proposal.relation }));
        for (const objective of followUpObjectives) void this.enqueueControl(activeRun.id, "follow_up", objective.summary, `inbox:${item.id}:follow-up:${objective.id}`);
        const routingNote = [proposals.length ? `${proposals.length} parallel proposal(s)` : "", followUpObjectives.length ? `${followUpObjectives.length} follow-up objective(s)` : ""].filter(Boolean).join("; ");
        const routed = this.store.routeSessionInboxItem(item.id, sessionId, "steer", activeRun.id, routingNote)!;
        void this.enqueueControl(activeRun.id, "steer", steerContent, `inbox:${item.id}`).then((result) => {
          if (result.status !== "accepted") this.store.routeSessionInboxItem(item.id, sessionId, "steer", activeRun.id, `Control delivery: ${result.status}${routingNote ? `; ${routingNote}` : ""}`);
        });
        return { item: routed, run: activeRun, proposals };
      }
      if (analysis.intent === "follow_up_active") {
        const routed = this.store.routeSessionInboxItem(item.id, sessionId, "follow_up", activeRun.id)!;
        void this.enqueueControl(activeRun.id, "follow_up", content, `inbox:${item.id}`);
        return { item: routed, run: activeRun };
      }
      if (analysis.intent === "parallel_task") {
        const proposal = this.store.createSpawnProposal(activeRun.id, analysis.summary, analysis.acceptanceCriteria, "parallel");
        const routed = this.store.routeSessionInboxItem(item.id, sessionId, "spawn_proposal", activeRun.id, `Proposal ${proposal.id}`)!;
        this.publish(this.store.appendEvent(activeRun.id, "supervisor.spawn.proposed", { proposalId: proposal.id, inboxItemId: item.id, goal: proposal.goal, relation: proposal.relation }));
        return { item: routed, run: activeRun, proposal };
      }
    }

    const run = this.dispatchSessionInbox(sessionId);
    return { item: this.store.getSessionInboxItem(item.id)!, run: run ?? null };
  }

  async updateSessionInput(sessionId: SessionId, itemId: string, content: string) {
    const item = this.store.getSessionInboxItem(itemId);
    if (!item || item.sessionId !== sessionId || item.status !== "queued") return undefined;
    const activeRun = this.store.getActiveRun(sessionId);
    return this.store.updateSessionInboxItem(itemId, sessionId, content, await this.sessionRouter.analyze(content, activeRun, this.sessionRouterContext(sessionId)));
  }

  reorderSessionInputs(sessionId: SessionId, itemIds: string[]) {
    return this.store.reorderSessionInbox(sessionId, itemIds);
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

  retryInboxLaunch(runId: RunId) {
    if (this.closing) return { status: "closing" as const };
    if (this.runtimes.has(runId)) return { status: "running" as const, runId };
    const claimed = this.store.retryInboxLaunch(runId);
    if (claimed.status !== "started") return claimed;
    const event = this.store.appendEvent(runId, "run.launch.retrying", { attempt: claimed.run.attempt, inboxItemId: claimed.item.id });
    this.publish(event);
    const run = this.launchClaimedSessionInbox(claimed.item, claimed.run, true);
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

  private launchClaimedSessionInbox(item: SessionInboxItem, run: TaskRun, retry = false) {
    // Persist the accepted user turn before any asynchronous recall/provider setup.
    // This makes the POST admission response a durable UI visibility boundary and
    // keeps slow memory recall from hiding the message until a refresh or Run end.
    if (!retry) {
      const userMessage = this.store.appendMessage(run.sessionId, "user", item.content);
      this.captureUserMessage(run, userMessage.id, item.content);
    }
    const currentUserAfter = item.startedAt ?? run.createdAt;
    if (!this.memory) {
      try {
        const sessionHistory = this.prepareSessionHistoryWithoutRecall(run, item.content, currentUserAfter);
        this.completeClaimedSessionLaunch(item, run, sessionHistory, retry);
        return this.store.getRun(run.id)!;
      } catch (error) { return this.failClaimedSessionLaunch(item, run, error); }
    }
    void this.prepareSessionHistory(run, item.content, currentUserAfter).then((sessionHistory) => this.completeClaimedSessionLaunch(item, run, sessionHistory, retry)).catch((error) => this.failClaimedSessionLaunch(item, run, error));
    return this.store.getRun(run.id)!;
  }

  private completeClaimedSessionLaunch(item: SessionInboxItem, run: TaskRun, sessionHistory: ContextAssembly & { recalledMemory?: string; memoryContextItems?: ContextManifestItem[] }, retry: boolean) {
    if (!retry) {
      this.publish(this.store.appendEvent(run.id, "run.started", { goal: run.goal, sourceInput: item.content, contract: run.contract, source: "session_supervisor_inbox", inboxItemId: item.id, sessionHistoryCount: sessionHistory.messages.length }));
    }
    this.publishContextEvents(run.id, sessionHistory);
    this.recalledMemory.set(run.id, sessionHistory.recalledMemory ?? "");
    this.launch(run, this.buildContractPrompt(run, item.content), sessionHistory.messages, undefined, { initialize: true, inboxItemId: item.id, retry });
    if (!this.runtimes.has(run.id)) throw new Error("Inbox TaskRun runtime did not start");
  }

  private buildContractPrompt(run: TaskRun, sourceInput: string) {
    if (!run.contract) return sourceInput;
    return [`TaskRun goal: ${run.contract.summary}`, `Semantic objectives:
${run.contract.objectives.map((item) => `- [${item.timing}/${item.kind}] ${item.summary}`).join("\n")}`, `Scope: ${run.contract.scope}`, run.contract.nonGoals.length ? `Non-goals:
${run.contract.nonGoals.map((item) => `- ${item}`).join("\n")}` : "", `Acceptance criteria:
${run.contract.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, `Original user input:
${sourceInput}`].filter(Boolean).join("\n\n");
  }

  private failClaimedSessionLaunch(item: SessionInboxItem, run: TaskRun, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !message.startsWith("Model is not allowed:");
    this.store.recordSessionInboxLaunchFailure(item.id, run.id, message);
    const event = this.store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: message, reason: "runtime_initialization_failed", stage: "launch_setup", retryable, inboxItemId: item.id }, message, run.attempt);
    if (event) { this.publish(event); this.projectWorkflowExperience(run.id); }
    setImmediate(() => { if (!this.closing) this.dispatchSessionInbox(run.sessionId); });
    return undefined;
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    if (this.closing) throw new Error("Service is shutting down");
    const existing = this.store.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    if (existing) return this.store.getRun(existing.id)!;

    const run = this.store.createRun(sessionId, query, requestId);
    const sessionHistory = await this.prepareSessionHistory(run, query);
    const userMessage = this.store.appendMessage(sessionId, "user", query);
    this.captureUserMessage(run, userMessage.id, query);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: query, sessionHistoryCount: sessionHistory.messages.length }));
    this.publishContextEvents(run.id, sessionHistory);
    this.recalledMemory.set(run.id, sessionHistory.recalledMemory ?? "");
    this.launch(run, query, sessionHistory.messages);
    return this.store.getRun(run.id)!;
  }

  private launch(run: TaskRun, prompt: string, initialMessages: AgentMessage[] = [], continuationId?: string, launchOptions?: { initialize?: boolean; inboxItemId?: string; retry?: boolean }) {
    if (this.closing) return;
    const checkpointBase = this.store.getRun(run.id) ?? run;
    this.checkpointDrafts.set(run.id, { runId: run.id, attempt: run.attempt, active: true, assistantPartial: "", currentTool: null, lastEventSeq: checkpointBase.lastEventSeq });
    this.lastCheckpointTranscriptSeq.set(run.id, checkpointBase.checkpoint?.lastTranscriptSeq ?? this.store.getLastTranscriptSeq(run.id));
    this.flushCheckpoint(run.id);
    const idleTimeoutMs = this.runtimeDefaults.runTimeoutMs ?? 120_000;
    const hardTimeoutMs = this.runtimeDefaults.runHardTimeoutMs ?? 86_400_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    let runtime: AgentRuntime;
    let lastActivityAt = Date.now();
    let runtimeSettled = false;

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
      this.projectWorkflowExperience(run.id);
    };
    const checkIdle = () => {
      idleTimer = undefined;
      if (runtimeSettled || this.store.getRun(run.id)?.status !== "running") return;
      const remaining = idleTimeoutMs - (Date.now() - lastActivityAt);
      if (remaining > 0) {
        idleTimer = setTimeout(checkIdle, remaining);
        return;
      }
      failTimeout("idle_timeout", idleTimeoutMs);
    };
    const touchActivity = () => {
      if (!idleTimeoutMs || runtimeSettled) return;
      lastActivityAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(checkIdle, idleTimeoutMs);
    };
    const stopIdleWatchdog = () => {
      runtimeSettled = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
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
      memory: this.memory,
      memoryScopeId: this.memoryScopeId,
      memorySubjectId: `session:${run.sessionId}`,
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

    const execution = (async () => {
      if (launchOptions?.initialize && runtime.initialize) {
        try {
          await runtime.initialize();
          this.publish(this.store.appendEvent(run.id, "runtime.initialized", { inboxItemId: launchOptions.inboxItemId, retry: Boolean(launchOptions.retry), attempt: run.attempt }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!this.closing && this.store.getRun(run.id)?.status === "running") {
            if (launchOptions.inboxItemId) this.store.recordSessionInboxLaunchFailure(launchOptions.inboxItemId, run.id, message);
            const event = this.store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: message, reason: "runtime_initialization_failed", stage: "runtime_initialize", retryable: true, inboxItemId: launchOptions.inboxItemId }, message, run.attempt);
            if (event) { this.publish(event); this.projectWorkflowExperience(run.id); }
          }
          return false;
        }
      }
      return this.execute(run.id, run.attempt, runtime, prompt, continuationId, stopIdleWatchdog);
    })().then((blocked) => {
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
      this.lastCheckpointTranscriptSeq.delete(run.id);
      void this.workflowService.drainProjectionOutbox();
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

  private projectWorkflowExperience(runId: RunId) {
    if (this.learningControl && !this.learningControl.snapshot().learningEnabled) return;
    const run = this.store.getRun(runId);
    if (!run) return;
    try {
      this.workflowService.recordRunApplications(run);
      this.workflowService.recordCanaryOutcome(run);
      void this.workflowService.drainProjectionOutbox();
      this.learningService.drainLearningProjectionLedger();
      this.learningService.projectRun(run);
      void this.learningService.drainFeedbackAttribution().catch((error: unknown) => this.publish(this.store.appendEvent(runId, "memory.feedback.attribution.failed", { error: error instanceof Error ? error.message : String(error) })));
    } catch (error) { this.publish(this.store.appendEvent(runId, "workflow.learning.failed", { error: error instanceof Error ? error.message : String(error) })); }
  }

  private async execute(runId: RunId, attempt: number, runtime: AgentRuntime, prompt: string, continuationId?: string, onRuntimeSettled: () => void = () => {}) {
    try {
      try {
        await runtime.prompt(prompt);
      } finally {
        // The Run idle watchdog covers active Agent/runtime work only. Supervisor
        // review has its own bounded SSE idle timeout and must not be raced by it.
        onRuntimeSettled();
      }
      const runtimeError = runtime.getError();
      if (runtimeError) throw new Error(runtimeError);
      if (continuationId && !this.store.ownsContinuationLease(continuationId, this.continuationOwner)) {
        this.recoverContinuations();
        return false;
      }
      const current = this.store.getRun(runId);
      if (!current || current.status === "waiting_input") return false;
      if (current.status !== "running") return false;
      const messages = runtime.getMessages();
      const checkpointResponse = this.store.getCheckpoint(runId)?.assistantPartial.trim() ?? "";
      const assistantMessages = messages.filter((message) => message.role === "assistant" && "content" in message);
      const assistantResponses = assistantMessages
        .map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        .map((value) => value.trim())
        .filter(Boolean);
      const response = checkpointResponse || assistantResponses.at(-1) || "";
      const finalAssistant = assistantMessages.at(-1);
      const modelOutputTruncated = finalAssistant && "stopReason" in finalAssistant && finalAssistant.stopReason === "length";
      const checkpointSeq = this.store.getCheckpoint(runId)?.lastEventSeq ?? current.lastEventSeq;
      const review = await this.supervisor.reviewSettled(current, checkpointSeq, response, { modelOutputTruncated });
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
        this.projectWorkflowExperience(runId);
        for (const spawn of this.supervisor.reviewSpawn(this.store.getRun(runId)!, event.seq)) this.publish(this.store.appendEvent(runId, "supervisor.spawn.proposed", { decisionId: spawn.id, reasonCode: spawn.reasonCode }));
        return false;
      }
      const reason = review.gates.find((gate) => gate.gateType === "completion")?.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ") || decision.rationale;
      this.publish(this.store.appendEvent(runId, "message.rejected", { response, reason, supervisionDecisionId: decision.id, action: decision.action }));
      const event = this.store.transitionRun(runId, ["running"], "blocked", "run.blocked", { response, supervisionDecisionId: decision.id, action: decision.action, gates: review.gates }, reason, attempt);
      if (!event) { this.supervisor.markExecuted(decision.id, "superseded"); return false; }
      this.supervisor.markExecuted(decision.id, "executed");
      this.publish(event);
      this.projectWorkflowExperience(runId);
      if (decision.action === "pause_for_approval") {
        const approval = this.store.ensureApprovalRequest(runId, decision.id, reason);
        this.publish(this.store.appendEvent(runId, "supervisor.approval.requested", { approvalId: approval.id, decisionId: decision.id, reason }));
      }
      return decision.action === "start_continuation" || decision.action === "request_evidence" || decision.action === "wait_for_runtime";
    } catch (error) {
      if (this.closing) return false;
      if (continuationId && !this.store.ownsContinuationLease(continuationId, this.continuationOwner)) {
        this.recoverContinuations();
        return false;
      }
      const current = this.store.getRun(runId);
      if (!current || current.status !== "running") return false;
      const message = error instanceof Error ? error.message : String(error);
      const checkpointSeq = this.store.getCheckpoint(runId)?.lastEventSeq ?? current.lastEventSeq;
      if (error instanceof SupervisorReviewError) {
        const decision = this.supervisor.recordReviewFailure(current, checkpointSeq, message);
        const event = this.store.transitionRun(runId, ["running"], "blocked", "run.blocked", {
          error: message, reason: decision.reasonCode, action: decision.action, supervisionDecisionId: decision.id,
        }, "Supervisor review failed after bounded internal retries. The candidate result was preserved and the Agent was not rerun.", attempt);
        if (!event) { this.supervisor.markExecuted(decision.id, "superseded"); return false; }
        this.supervisor.markExecuted(decision.id, "executed");
        this.store.appendMessage(current.sessionId, "assistant", "Run blocked: Supervisor quality review failed after bounded internal retries. The Agent result was preserved for audit; no automatic continuation was started.");
        this.publish(event);
        this.projectWorkflowExperience(runId);
        return false;
      }
      const decision = await this.supervisor.reviewAttemptFailure(current, checkpointSeq, message);
      const recoverable = decision.action === "start_continuation";
      const event = this.store.transitionRun(runId, ["running"], "blocked", "run.blocked", {
        error: message, reason: decision.reasonCode, action: decision.action, supervisionDecisionId: decision.id,
      }, message, attempt);
      if (!event) { this.supervisor.markExecuted(decision.id, "superseded"); return false; }
      this.supervisor.markExecuted(decision.id, "executed");
      if (decision.action === "pause_for_approval") {
        const approval = this.store.ensureApprovalRequest(runId, decision.id, message);
        this.publish(this.store.appendEvent(runId, "supervisor.approval.requested", { approvalId: approval.id, decisionId: decision.id, reason: message }));
      }
      this.store.appendMessage(current.sessionId, "assistant", decision.action === "pause_for_approval" ? `Run paused for approval: ${message}` : `Run blocked: ${message}`);
      this.publish(event);
      this.projectWorkflowExperience(runId);
      return recoverable;
    }
  }

  private captureUserMessage(run: TaskRun, messageId: number, content: string) {
    const context = this.store.listRecentMessages(run.sessionId, 8).filter((message) => message.id < messageId).slice(-4).map((message) => `${message.role}: ${message.content}`).join("\n");
    if (this.learningControl?.snapshot().learningEnabled ?? true) void this.learningService.analyzeUserMessage({subjectId:`session:${run.sessionId}`,scopeId:run.sessionId,messageId,content,context,runId:run.id,attempt:run.attempt});
    if (!this.memory) return;
    void this.memory.enqueueCapture({ access: this.memoryAccess(run), sourceRefs: [{ sourceType: "message", sourceId: String(messageId), revision: "user" }], content: `<context>\n${context}\n</context>\n<focus_user>\n${content}\n</focus_user>`, idempotencyKey: `user-message:${messageId}`, captureSource: { kind: "user_message", role: "user" } }).then(({ jobId }) => this.publish(this.store.appendEvent(run.id, "memory.capture.queued", { jobId, sourceType: "message", sourceId: String(messageId) }))).catch((error: unknown) => this.publish(this.store.appendEvent(run.id, "memory.capture.failed", { sourceType: "message", sourceId: String(messageId), error: error instanceof Error ? error.message : String(error) })));
  }



  private queueContinuation(runId: RunId) {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "blocked") return;
    const maxContinuations = this.runtimeDefaults.maxContinuations ?? 128;
    if (run.continuations.length >= maxContinuations) {
      const message = `Run remains blocked after ${maxContinuations} automatic continuation${maxContinuations === 1 ? "" : "s"}: ${run.blockedReason}`;
      this.store.appendMessage(run.sessionId, "assistant", message);
      this.publish(this.store.appendEvent(runId, "continuation.exhausted", { reason: "max_continuations", limit: maxContinuations }));
      return;
    }
    const continuation = this.store.queueContinuation(runId, run.blockedReason);
    this.publish(this.store.appendEvent(runId, "continuation.queued", { continuationId: continuation.id, ordinal: continuation.ordinal, reason: continuation.reason }));
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
      "The previous candidate response was rejected by Supervisor and was not delivered as the final chat answer. Do not merely acknowledge this continuation or repeat a short conclusion.",
      "Use the persisted transcript and TaskRun state. Resolve only the remaining gate failures, verify the result, then provide a complete standalone final response that directly addresses the original contract.",
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
    this.projectWorkflowExperience(runId);
    return true;
  }

  async steer(runId: RunId, instruction: string, requestId: string = randomUUID()) {
    return this.enqueueControl(runId, "steer", instruction, requestId);
  }

  teachWorkflow(sessionId: SessionId, spec: WorkflowSpec, sourceId = `manual:${randomUUID()}`) { return this.workflowService.teach(sessionId, spec, sourceId); }
  listWorkflows(sessionId: SessionId) { return this.workflowService.listWorkflows(sessionId); }
  getWorkflow(workflowId: string) { return this.workflowService.getWorkflow(workflowId); }
  requestWorkflowActivation(workflowId: string, revisionId?: string, actor?: string, reason?: string) { return this.workflowService.requestActivation(workflowId, revisionId, actor, reason); }
  activateWorkflow(workflowId: string, revisionId?: string, approvalId?: string) { return this.workflowService.activate(workflowId, revisionId, approvalId); }
  suspendWorkflow(workflowId: string, reason?: string) { return this.workflowService.suspend(workflowId, reason); }
  rollbackWorkflow(workflowId: string, revisionId: string) { return this.workflowService.rollback(workflowId, revisionId); }
  forgetWorkflow(workflowId: string, reason?: string, gracePeriodMs?: number) { return this.workflowService.forget(workflowId, reason, gracePeriodMs); }
  restoreWorkflow(workflowId: string) { return this.workflowService.restore(workflowId); }
  setWorkflowBindingMode(bindingId: string, mode: "suggested" | "adopted" | "partially_adopted" | "rejected") { return this.workflowService.setBindingMode(bindingId, mode); }
  recordWorkflowApplication(input: Parameters<WorkflowService["recordApplication"]>[0]) { return this.workflowService.recordApplication(input); }
  getLearningCenter(sessionId: SessionId) { return this.workflowService.getLearningCenter(sessionId); }
  decideWorkflowProposal(id: string, decision: "approved" | "rejected", actor: string, reason?: string) { return this.workflowService.decideProposal(id, decision, actor, reason); }
  requestWorkflowProposalApplication(id: string, actor: string, reason?: string) { return this.workflowService.requestProposalApplication(id, actor, reason); }
  applyWorkflowProposal(id: string, actor: string, approvalId?: string) { return this.workflowService.applyProposal(id, actor, approvalId); }
  runWorkflowDistiller(owner?: string) { return this.workflowService.runNextDistillationJob(owner); }
  retryWorkflowDistillation(id:string,repair?:{taskSignature?:string}) { return this.workflowService.retryDistillationJob(id,repair); }
  listDeadLetterDistillations(limit?:number) { return this.workflowService.listDeadLetterJobs(limit); }
  executeWorkflowEvaluation(input: Parameters<WorkflowService["executeEvaluation"]>[0]) { return this.workflowService.executeEvaluation(input); }
  verifyWorkflowEvaluation(id:string) { return this.workflowService.verifyEvaluationReceipt(id); }
  requestWorkflowPromotion(workflowId: string, revisionId: string, canaryPercent?: number, maxFailureDelta?: number, actor?: string) { return this.workflowService.requestPromotion(workflowId, revisionId, canaryPercent, maxFailureDelta, actor); }
  promoteWorkflow(workflowId: string, revisionId: string, canaryPercent?: number, maxFailureDelta?: number, approvalId?: string) { return this.workflowService.promote(workflowId, revisionId, canaryPercent, maxFailureDelta, approvalId); }
  listAutonomyApprovals(scopeId: string, limit?: number) { return this.workflowService.listApprovals(scopeId, limit); }
  decideAutonomyApproval(id: string, decision: "approved" | "rejected", actor: string, reason?: string) { return this.workflowService.decideApproval(id, decision, actor, reason); }
  revokeAutonomyApproval(id: string, actor: string, reason?: string) { return this.workflowService.revokeApproval(id, actor, reason); }
  executeAutonomyApproval(id: string, actor: string) { return this.workflowService.executeApproval(id, actor); }
  reviseWorkflow(workflowId: string, patch: Partial<WorkflowSpec>, sourceId: string, changeSummary: string) { return this.workflowService.revise(workflowId, patch, "user_correction", [sourceId], changeSummary); }
  setRunLearningPolicy(runId: RunId, policy: "allow" | "metadata_only" | "deny", reason?: string) { return this.workflowService.setRunLearningPolicy(runId, policy, reason); }
  recordWorkflowFeedback(input: { workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; idempotencyKey: string; note?: string; adopted?: boolean; verified?: boolean }) { return this.workflowService.feedback(input); }
  setCommunicationPreference(input: { subjectId: string; scopeType: CommunicationApplicability; scopeId: string; dimension: CommunicationDimension; value: string | string[]; sourceType: "explicit_user" | "inferred" | "governance"; sourceRef: string; confidence?: number; expiresAt?: number }) { return this.learningService.recordCommunicationPreference(input); }
  listCommunicationProfiles(subjectId: string) { return this.learningService.listCommunicationProfiles(subjectId); }
  lockCommunicationProfile(profileId: string, locked: boolean) { return this.learningService.lockCommunicationProfile(profileId, locked); }
  listLearningEvents(sessionId: string, limit?: number) { return this.learningService.listLearningEvents(sessionId, limit); }
  listCorrections(sessionId: string, limit?: number) { return this.learningService.listCorrections(sessionId, limit); }
  recordCorrection(input: Parameters<LearningService["recordCorrection"]>[0]) { return this.learningService.recordCorrection(input); }
  listFeedbackAttribution(sessionId: string, limit?: number) { return this.learningService.listFeedbackAttribution(sessionId, limit); }
  drainFeedbackAttribution(limit?: number) { return this.learningService.drainFeedbackAttribution(limit); }

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

  approveSpawnProposal(proposalId: string) {
    if (!this.store.updateSpawnProposalStatus(proposalId, "approved")) throw new Error("Proposal is not pending approval");
    return { ok: true as const };
  }

  rejectSpawnProposal(proposalId: string) {
    if (!this.store.updateSpawnProposalStatus(proposalId, "rejected")) throw new Error("Proposal is not pending approval");
    return { ok: true as const };
  }

  spawnProposal(proposalId: string) {
    if (this.closing) throw new Error("Service is shutting down");
    const run = this.store.spawnFromProposal(proposalId);
    if (!run) throw new Error("Proposal is not spawnable");
    if (!this.memory) {
      try { const history = this.prepareSessionHistoryWithoutRecall(run, run.goal); this.completeSpawnProposal(run, history); return this.store.getRun(run.id)!; }
      catch (error) { this.store.failSpawnedRun(proposalId, run.id, error instanceof Error ? error.message : String(error)); void this.workflowService.drainProjectionOutbox(); throw error; }
    }
    return this.prepareSessionHistory(run, run.goal).then((history) => { this.completeSpawnProposal(run, history); return this.store.getRun(run.id)!; }).catch((error) => { this.store.failSpawnedRun(proposalId, run.id, error instanceof Error ? error.message : String(error)); void this.workflowService.drainProjectionOutbox(); throw error; });
  }

  private completeSpawnProposal(run: TaskRun, history: ContextAssembly & { recalledMemory?: string; memoryContextItems?: ContextManifestItem[] }) {
    const userMessage = this.store.appendMessage(run.sessionId, "user", run.goal);
    this.captureUserMessage(run, userMessage.id, run.goal);
    this.publish(this.store.appendEvent(run.id, "run.started", { goal: run.goal, source: "spawn_proposal", sessionHistoryCount: history.messages.length }));
    this.publishContextEvents(run.id, history);
    this.recalledMemory.set(run.id, history.recalledMemory ?? "");
    this.launch(run, run.goal, history.messages);
    if (!this.runtimes.has(run.id)) throw new Error("Spawned runtime did not start");
  }

  approveRunApproval(approvalId: string, resolution = "Approved by user") {
    const approval = this.store.resolveApprovalRequest(approvalId, "approved", "user", resolution);
    if (!approval) throw new Error("Approval request is not pending");
    this.publish(this.store.appendEvent(approval.runId, "supervisor.approval.approved", { approvalId, resolution }));
    return this.resume(approval.runId);
  }

  rejectRunApproval(approvalId: string, resolution = "Rejected by user") {
    const approval = this.store.resolveApprovalRequest(approvalId, "rejected", "user", resolution);
    if (!approval) throw new Error("Approval request is not pending");
    this.publish(this.store.appendEvent(approval.runId, "supervisor.approval.rejected", { approvalId, resolution }));
    return this.store.getRun(approval.runId)!;
  }

  async submitUserInput(requestId: string, response: Record<string, string>) {
    if (this.closing) throw new Error("Service is shutting down");
    const pending = this.store.db.prepare("SELECT run_id as runId FROM user_input_requests WHERE id = ? AND status = 'pending'").get(requestId) as { runId: RunId } | undefined;
    if (!pending) throw new Error("User input request is not pending");
    const runtime = this.runtimes.get(pending.runId);
    if (runtime) {
      await this.abortRuntime(runtime, pending.runId);
      await this.executionTasks.get(pending.runId);
    }
    const submitted = this.store.submitUserInput(requestId, response);
    const run = submitted.run;
    const summary = submitted.request.fields.map((field) => `${field.label}: ${submitted.request.response[field.key] ?? ""}`).join("\n");
    const message = this.store.appendMessage(run.sessionId, "user", summary);
    this.captureUserMessage(run, message.id, summary);
    this.publish(this.store.appendEvent(run.id, "run.input.submitted", { requestId, fieldKeys: submitted.request.fields.map((field) => field.key), submittedAt: submitted.request.submittedAt }));
    return this.resume(run.id, { inputRequest: submitted.request });
  }

  async resume(runId: RunId, options?: { inputRequest?: import("./types.js").UserInputRequest }) {
    if (this.closing) throw new Error("Service is shutting down");
    if (this.runtimes.has(runId)) {
      if (this.store.getRun(runId)?.status === "running") throw new Error("Run is already active");
      // Timeout state is persisted before abort/cleanup necessarily settles. Wait for
      // that stale runtime so an immediate Resume cannot race its finally handlers.
      await this.executionTasks.get(runId);
    }
    if (this.runtimes.has(runId)) throw new Error("Run is already active");
    if (this.store.hasPendingApproval(runId)) throw new Error("Run requires an approval decision before resume");
    this.store.cancelQueuedContinuations(runId, "Superseded by manual resume");
    this.repairTranscript(runId, "resume");
    const run = this.store.resumeRun(runId);
    const provisionalPrompt = options?.inputRequest ? this.buildUserInputResumePrompt(run, options.inputRequest) : this.buildResumePrompt(run, this.store.getTranscriptCount(run.id));
    const transcript = this.prepareTranscript(run, provisionalPrompt);
    const prompt = options?.inputRequest ? this.buildUserInputResumePrompt(run, options.inputRequest) : this.buildResumePrompt(run, transcript.messages.length);
    this.publishContextEvents(run.id, transcript);
    const event = this.store.appendEvent(run.id, "run.resumed", { attempt: run.attempt, resumedAt: run.resumedAt, mode: transcript.messages.length ? "transcript-continuation" : "durable-snapshot-replay", transcriptCount: transcript.messages.length });
    this.publish(event);
    this.launch(run, prompt, transcript.messages);
    return this.store.getRun(run.id)!;
  }

  private prepareTranscript(run: TaskRun, prompt: string) {
    const entries = this.store.listTranscriptEntries(run.id);
    return this.contextAssembler().assemble(
      "transcript",
      entries.map((entry) => entry.message),
      this.buildSystemPrompt(run),
      prompt,
      entries.map((entry) => `transcript:${run.id}:${entry.seq}`),
    );
  }

  private sessionHistoryMessages(sessionId: SessionId, query?: string, excludeCurrentUserAfter?: number) {
    const recent = this.store.listRecentMessages(sessionId, 10_000).filter((message) => message.role === "user" || message.role === "assistant");
    if (query !== undefined && excludeCurrentUserAfter !== undefined) { const index = recent.findIndex((message) => message.role === "user" && message.content === query && message.createdAt >= excludeCurrentUserAfter); if (index >= 0) recent.splice(index, 1); }
    return {
      messages: recent.map((message): AgentMessage => message.role === "user" ? { role: "user", content: message.content, timestamp: message.createdAt } : { role: "assistant", content: [{ type: "text", text: message.content }], api: "openai-completions", provider: "tagent-core", model: "session-history", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: message.createdAt }),
      sourceIds: recent.map((message) => `message:${message.id}`),
    };
  }

  private prepareSessionHistoryWithoutRecall(run: TaskRun, query: string, excludeCurrentUserAfter?: number) {
    const history = this.sessionHistoryMessages(run.sessionId, query, excludeCurrentUserAfter);
    const workflows = this.workflowService.recall(run.sessionId, query, run.id, run.attempt);
    const profile = (this.learningControl?.snapshot().learningEnabled ?? true) ? this.learningService.resolveCommunicationProfile(`session:${run.sessionId}`, [{ type: "workspace", id: this.memoryScopeId }, { type: "session", id: run.sessionId }, { type: "task", id: run.id }]) : { promptSection: "", contextItems: [], profileIds: [], revisionIds: [], values: {} };
    const injected = [profile.promptSection, workflows.promptSection].filter(Boolean).join("\n\n");
    return { ...this.contextAssembler().assemble("session", history.messages, this.buildSystemPrompt(run, injected), query, history.sourceIds), recalledMemory: injected, memoryContextItems: [...profile.contextItems, ...workflows.contextItems] };
  }

  private async prepareSessionHistory(run: TaskRun, query: string, excludeCurrentUserAfter?: number) {
    const access = this.memoryAccess(run);
    const [recall,coreSnapshot] = this.memory ? await Promise.all([this.memory.recall({ access, cue: query }),this.memory.getCoreSnapshot?.(access)]) : [undefined,undefined];
    const workflows = this.workflowService.recall(run.sessionId, query, run.id, run.attempt);
    const profile = (this.learningControl?.snapshot().learningEnabled ?? true) ? this.learningService.resolveCommunicationProfile(`session:${run.sessionId}`, [{ type: "workspace", id: this.memoryScopeId }, { type: "session", id: run.sessionId }, { type: "task", id: run.id }]) : { promptSection: "", contextItems: [], profileIds: [], revisionIds: [], values: {} };
    const coreSection=coreSnapshot?.markdown?`<core_memory revision="${coreSnapshot.revision}">
${coreSnapshot.markdown}
</core_memory>`:"";
    const memorySection=[coreSection,profile.promptSection,recall?.promptSection,workflows.promptSection].filter(Boolean).join("\n\n");
    const history = this.sessionHistoryMessages(run.sessionId, query, excludeCurrentUserAfter);
    const assembly = this.contextAssembler().assemble("session", history.messages, this.buildSystemPrompt(run, memorySection), query, history.sourceIds);
    this.capturePrunedUserContext(run, assembly.droppedMessages);
    const memoryContextItems: ContextManifestItem[] = [
      ...(coreSnapshot?.markdown ? [{ kind: "core_memory" as const, sourceId: `${coreSnapshot.scope.type}:${coreSnapshot.scope.id}:revision:${coreSnapshot.revision}`, selected: true, reason: "stable core-memory injection", estimatedTokens: coreSnapshot.tokenCount, metadata: { revision: coreSnapshot.revision, sourceRecordIds: coreSnapshot.sourceRecordIds } }] : []),
      ...(recall?.cards.map((card) => ({ kind: "memory_card" as const, sourceId: card.id, selected: true, reason: `selected by Recall Trace v${recall.trace.version}`, estimatedTokens: estimateContextTokens(`${card.title}: ${card.content}`), metadata: { score: card.score, channels: card.retrievalChannels, topicIds: card.topicIds } })) ?? []),
      ...(recall?.coldTopics.map((topic) => ({ kind: "cold_topic" as const, sourceId: topic.descriptor.topicId, selected: true, reason: "selected by topic routing", estimatedTokens: topic.revision.tokenCount, metadata: { revision: topic.revision.revision } })) ?? []),
      ...(recall?.trace?.candidates?.filter((candidate) => candidate.outcome !== "selected").map((candidate) => ({ kind: "memory_card" as const, sourceId: candidate.id, selected: false, reason: candidate.reason ?? candidate.outcome, estimatedTokens: 0, metadata: { outcome: candidate.outcome, channels: candidate.channels, finalScore: candidate.finalScore } })) ?? []),
      ...profile.contextItems,
      ...workflows.contextItems,
    ];
    return { ...assembly, recalledMemory: memorySection, memoryContextItems };
  }

  private capturePrunedUserContext(run: TaskRun, messages: AgentMessage[]) {
    if (!this.memory) return;
    const durable = messages.filter((message) => message.role === "user").flatMap((message) => summarizeDurableUserContext(memoryMessageText(message))).slice(-20);
    if (!durable.length) return;
    const summary = durable.map((text) => `user: ${text}`).join("\n");
    void this.memory.enqueueCapture({ access: this.memoryAccess(run), sourceRefs: [{ sourceType: "transcript", sourceId: run.id, revision: `context-prune:${run.attempt}:${stableTextHash(summary)}` }], content: summary, idempotencyKey: `context-prune:${run.id}:${run.attempt}:${stableTextHash(summary)}`, provenance: userContextSummaryProvenance })
      .then(({ jobId }) => this.publish(this.store.appendEvent(run.id, "memory.capture.queued", { jobId, sourceType: "user_context_summary" })))
      .catch((error: unknown) => this.publish(this.store.appendEvent(run.id, "memory.capture.failed", { sourceType: "user_context_summary", error: error instanceof Error ? error.message : String(error) })));
  }

  private memoryAccess(run: TaskRun): AccessContext { return { subjectId: `session:${run.sessionId}`, scopes: [{ type: "workspace", id: this.memoryScopeId }, { type: "session", id: run.sessionId }], purpose: "agent_recall" }; }

  private contextAssembler() {
    const contextWindow = this.runtimeDefaults.contextWindow ?? this.runtimeDefaults.model?.contextWindow ?? 200_000;
    return new ContextAssembler({
      contextWindow,
      maxOutputTokens: this.runtimeDefaults.model?.maxTokens ?? Math.min(32_768, Math.floor(contextWindow * 0.2)),
      maxTurns: this.runtimeDefaults.maxContextTurns ?? 20,
    });
  }

  private publishContextEvents(runId: RunId, assembly: ContextAssembly & { memoryContextItems?: ContextManifestItem[] }) {
    const { source, ...stats } = assembly.stats;
    const run = this.store.getRun(runId);
    if (run) {
      const items: ContextManifestItem[] = [
        { kind: "system_prompt", sourceId: `run:${runId}:attempt:${run.attempt}`, selected: true, reason: "required runtime instruction", estimatedTokens: stats.systemTokens },
        ...(run.contract ? [{ kind: "taskrun_contract" as const, sourceId: run.requestId, selected: true, reason: "active TaskRun execution contract", estimatedTokens: estimateContextTokens(JSON.stringify(run.contract)) }] : []),
        ...assembly.contextItems,
        ...(assembly.memoryContextItems ?? []),
        { kind: "user_prompt", sourceId: `run:${runId}:attempt:${run.attempt}:prompt`, selected: true, reason: "current runtime instruction", estimatedTokens: stats.promptTokens },
      ];
      const manifestHash = createHash("sha256").update(JSON.stringify({ runId, attempt: run.attempt, source, items, stats })).digest("hex");
      const manifest = this.store.recordContextManifest({ id: randomUUID(), runId, attempt: run.attempt, source, items, stats: { source, ...stats }, manifestHash, createdAt: Date.now() });
      void manifest;
    }
    this.publish(this.store.appendEvent(runId, "context.loaded", { source, ...stats }));
    if (stats.droppedTurns > 0 || stats.compressedTurns > 0) {
      this.publish(this.store.appendEvent(runId, "context.pruned", { source, ...stats }));
    }
  }

  private buildUserInputResumePrompt(run: TaskRun, request: import("./types.js").UserInputRequest) {
    return [
      "The user supplied the information requested by this TaskRun. Resume the same task from the persisted transcript and durable state.",
      `Original request for information: ${request.prompt}`,
      "Submitted fields:",
      ...request.fields.map((field) => `- ${field.label} (${field.key}): ${request.response[field.key] ?? ""}`),
      "Use these values as user-provided task context. Do not ask for them again unless the submission is genuinely insufficient. Continue execution, update the existing plan/checks, verify, and provide a complete standalone final response.",
      `Original goal: ${run.goal}`,
      `Durable snapshot: ${JSON.stringify(runtimeRunContext(run))}`,
    ].join("\n\n");
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
      `Durable snapshot: ${JSON.stringify(runtimeRunContext(run))}`,
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
      "If execution cannot continue without specific user-provided information, call task_run with action=request_user_input, a concise prompt, and only the necessary typed fields. Do not guess, continue, or fail the task after requesting input; the TaskRun will pause and resume when the user submits the form. Do not request input for information available from the workspace, tools, transcript, or durable state.",
      "Assistant text streamed while a TaskRun is active is provisional. Only a Supervisor-approved final candidate is persisted to chat, so make the final candidate complete and standalone.",
      "Use read before modifying unfamiliar files. Keep changes focused and report verification evidence.",
      `Active TaskRun: ${JSON.stringify(runtimeRunContext(run))}`,
      recalledMemory,
    ].filter(Boolean).join("\n\n");
  }
}

function memoryMessageText(message: AgentMessage) { if (!("content" in message)) return ""; if (typeof message.content === "string") return message.content.trim(); return message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n").trim(); }
function summarizeDurableUserContext(text: string) { return text.split(/\n+|(?<=[。！？.!?])\s*/).map((part) => part.trim()).filter((part) => part.length >= 2 && !/[?？]$/.test(part) && !/^(?:请|帮我|麻烦|检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)/i.test(part) && /(?:记住|我叫|我的名字|叫我|称呼我|我.{0,20}(?:喜欢|偏好|希望|不喜欢|习惯)|我们(?:已经|已)?(?:决定|确定|采用|改为|迁移)|以后|始终|必须|住在|家在|是邻居|my name|call me|i prefer|we decided|from now on)/i.test(part)); }
function stableTextHash(text: string) { let hash = 2166136261; for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }
const userContextSummaryProvenance: MemoryProvenance = { evidenceClass: "user_context_summary", trustLevel: "medium", sourceRole: "user", verificationState: "structured" };

function estimateContextTokens(text: string) { if (!text) return 0; let nonAscii = 0; for (const character of text) if (character.charCodeAt(0) > 127) nonAscii += 1; return Math.max(1, Math.ceil(nonAscii * 1.5 + (text.length - nonAscii) * 0.25)); }
