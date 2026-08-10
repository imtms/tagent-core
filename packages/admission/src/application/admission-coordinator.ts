import { randomUUID } from "node:crypto";
import type {
  SessionId,
  SessionInboxItem,
  SessionInputAnalysis,
} from "../domain/index.js";
import type { SessionRepository, SubmissionAuditInput, SubmissionQueue } from "../ports/index.js";
import type { ContextManifestItem, TaskRun } from "@tagent/execution/domain";
import type {
  AttemptRepository,
  RunEventJournal,
  TaskRunRepository,
  TaskRunTransitionPort,
} from "@tagent/execution/ports";
import type { ApprovalRepository } from "@tagent/governance/ports";
import type { WorkspaceGoalRepository } from "@tagent/governance/ports";
import type {
  AttemptLauncherPort,
  AttemptSettlementPort,
  ContinuationControlPort,
  ControlCommandPort,
  ContextAssembly,
  RunContextPort,
  RunEventPublisherPort,
} from "@tagent/execution/composition";
import type { AdmissionRouterPort, AdmissionSupervisorPort } from "./collaboration-ports.js";

interface AdmissionState {
  readonly closing: boolean;
  readonly persistence: {
    approvals: ApprovalRepository;
    attempts: AttemptRepository;
    events: RunEventJournal;
    sessions: SessionRepository;
    submissions: SubmissionQueue;
    taskRuns: TaskRunRepository;
    taskRunTransitions: TaskRunTransitionPort;
    workspaceGoals: Pick<WorkspaceGoalRepository, "linkInbox" | "attachRun" | "recordRunOutcome">;
  };
  readonly recalledMemory: Map<string, string>;
  readonly preparationTasks: Map<string, {
    readonly controller: AbortController;
    readonly promise: Promise<unknown>;
  }>;
  readonly runtimes: ReadonlyMap<string, unknown>;
}

export class AdmissionCoordinator {
  constructor(
    private readonly state: AdmissionState,
    private readonly dependencies: {
      attemptExecutor: AttemptLauncherPort;
      router: AdmissionRouterPort;
      contextService: RunContextPort;
      continuation: ContinuationControlPort;
      controlInbox: ControlCommandPort;
      eventHub: RunEventPublisherPort;
      settlement: AttemptSettlementPort;
      supervisor: AdmissionSupervisorPort;
    },
  ) {}


  public sessionRouterContext(sessionId: SessionId) {
    return {
      recentMessages: this.state.persistence.sessions.listRecentMessages(sessionId, 12),
      recentRuns: this.state.persistence.taskRuns.listRunSummaries?.(sessionId, 5)
        ?? this.state.persistence.taskRuns.listRuns(sessionId, 5),
    };
  }

  async enqueueSessionInput(
    sessionId: SessionId,
    content: string,
    requestId: string = randomUUID(),
    audit?: SubmissionAuditInput,
  ) {
    if (this.state.closing) throw new Error("Service is shutting down");
    const existing = this.state.persistence.submissions.getSessionSubmission(sessionId, requestId);
    if (existing) {
      if (existing.content !== content) throw new Error("Session Inbox request idempotency conflict");
      if (audit) this.state.persistence.submissions.recordSubmissionAudit(existing, audit);
      return { item: existing, run: existing.runId ? this.state.persistence.taskRuns.getRun(existing.runId) ?? null : null };
    }
    const activeRun = this.state.persistence.taskRuns.getActiveRun(sessionId);
    const analysis = await this.dependencies.router.analyze(content, activeRun, this.sessionRouterContext(sessionId));
    const routerUsage = this.dependencies.router.takeUsage(analysis);
    if (activeRun) for (const observed of routerUsage) this.state.persistence.taskRuns.recordModelUsage(activeRun.id, "router", observed.model, observed.usage);
    const duplicate = !activeRun ? this.state.persistence.submissions.findMergeCandidate(sessionId, analysis) : undefined;
    const item = this.state.persistence.submissions.enqueueSessionInbox(sessionId, content, analysis, requestId, audit);
    if (item.content !== content) throw new Error("Session Inbox request idempotency conflict");
    if (analysis.intent === "defer") {
      this.state.persistence.submissions.decideSessionInboxItem(item.id, sessionId, "defer");
      return { item: this.state.persistence.submissions.getSessionInboxItem(item.id)!, run: null };
    }
    if (duplicate) {
      const merged = this.state.persistence.submissions.markSessionInboxDuplicate(item.id, duplicate.id, sessionId)!;
      return { item: merged, run: null, duplicate: true, mergedInto: duplicate.id };
    }

    if (activeRun && analysis.targetRunId === activeRun.id && analysis.confidence >= 0.85) {
      const userMessage = this.state.persistence.sessions.appendMessage(sessionId, "user", content);
      this.dependencies.continuation.captureUserMessage(activeRun, userMessage.id, content, audit?.principalId);
      if (analysis.intent === "steer_active" || analysis.intent === "update_active_context") {
        const currentObjectives = analysis.objectives.filter((objective) => objective.timing === "current");
        const followUpObjectives = analysis.objectives.filter((objective) => objective.timing === "follow_up");
        const parallelObjectives = analysis.objectives.filter((objective) => objective.timing === "parallel");
        const steerContent = currentObjectives.length ? currentObjectives.map((objective) => objective.summary).join("\n") : content;
        const relatedItems = parallelObjectives.map((objective) => this.enqueueRelatedSessionTask(activeRun, item, objective.summary, "parallel", analysis));
        for (const objective of followUpObjectives) void this.dependencies.controlInbox.enqueueControl(activeRun.id, "follow_up", objective.summary, `inbox:${item.id}:follow-up:${objective.id}`);
        const routingNote = [relatedItems.length ? `${relatedItems.length} parallel Inbox task(s)` : "", followUpObjectives.length ? `${followUpObjectives.length} follow-up objective(s)` : ""].filter(Boolean).join("; ");
        const routed = this.state.persistence.submissions.routeSessionInboxItem(item.id, sessionId, "steer", activeRun.id, routingNote)!;
        void this.dependencies.controlInbox.enqueueControl(activeRun.id, "steer", steerContent, `inbox:${item.id}`).then((result) => {
          if (result.status !== "accepted") this.state.persistence.submissions.routeSessionInboxItem(item.id, sessionId, "steer", activeRun.id, `Control delivery: ${result.status}${routingNote ? `; ${routingNote}` : ""}`);
        });
        return { item: routed, run: activeRun, relatedItems };
      }
      if (analysis.intent === "follow_up_active") {
        const routed = this.state.persistence.submissions.routeSessionInboxItem(item.id, sessionId, "follow_up", activeRun.id)!;
        void this.dependencies.controlInbox.enqueueControl(activeRun.id, "follow_up", content, `inbox:${item.id}`);
        return { item: routed, run: activeRun };
      }
      if (analysis.intent === "parallel_task") {
        this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(activeRun.id, "session.inbox.related.queued", { inboxItemId: item.id, goal: analysis.summary, relation: "parallel", parentRunId: activeRun.id }));
        return { item: this.state.persistence.submissions.getSessionInboxItem(item.id)!, run: activeRun, relatedItem: this.state.persistence.submissions.getSessionInboxItem(item.id)! };
      }
    }

    const run = this.dispatchSessionInbox(sessionId);
    if (run) for (const observed of routerUsage) this.state.persistence.taskRuns.recordModelUsage(run.id, "router", observed.model, observed.usage);
    return { item: this.state.persistence.submissions.getSessionInboxItem(item.id)!, run: run ?? null };
  }

  public enqueueGoalRoadmapItem(input: {
    workspaceId: SessionId;
    goalId: string;
    goalRevision: number;
    goalOutcome: string;
    roadmapRevisionId: string;
    roadmapItem: { id: string; title: string; outcome: string; verification: string; criterionKeys: string[] };
    requestId?: string;
  }) {
    if (this.state.closing) throw new Error("Service is shutting down");
    const requestId = input.requestId?.trim() || `goal:${input.goalId}:roadmap:${input.roadmapRevisionId}:${input.roadmapItem.id}:${randomUUID()}`;
    const content = [
      `Advance Workspace Goal: ${input.goalOutcome}`,
      `Execute Goal Roadmap item: ${input.roadmapItem.title}`,
      `Expected outcome: ${input.roadmapItem.outcome}`,
      `Verification: ${input.roadmapItem.verification}`,
    ].join("\n");
    const expectedObjectiveId = `roadmap-${input.roadmapItem.id}`;
    const expectedReason = `Explicitly launched from Workspace Goal ${input.goalId} Roadmap item ${input.roadmapItem.id}.`;
    const linkInput = {
      goalId: input.goalId,
      goalRevision: input.goalRevision,
      roadmapRevisionId: input.roadmapRevisionId,
      roadmapItemIds: [input.roadmapItem.id],
      criterionKeys: input.roadmapItem.criterionKeys,
    };
    const existing = this.state.persistence.submissions.getSessionSubmission(input.workspaceId, requestId);
    if (existing) {
      if (existing.content !== content || existing.analysis.routerVersion !== "workspace-goal-roadmap-v1"
        || existing.analysis.objectives[0]?.id !== expectedObjectiveId || existing.analysis.reason !== expectedReason) {
        throw new Error("Workspace Goal Roadmap TaskRun idempotency conflict");
      }
      if (!existing.runId && existing.status === "queued") {
        this.state.persistence.workspaceGoals.linkInbox({ ...linkInput, inboxItemId: existing.id });
        const run = this.dispatchSessionInbox(input.workspaceId) ?? null;
        return { item: this.state.persistence.submissions.getSessionInboxItem(existing.id)!, run };
      }
      return { item: existing, run: existing.runId ? this.state.persistence.taskRuns.getRun(existing.runId) ?? null : null };
    }
    const analysis: SessionInputAnalysis = {
      summary: input.roadmapItem.title,
      objectives: [{ id: expectedObjectiveId, summary: input.roadmapItem.outcome, timing: "current", kind: "change" }],
      intent: "new_task",
      targetRunId: null,
      priority: 700,
      urgency: "normal",
      relation: "independent",
      acceptanceCriteria: [input.roadmapItem.outcome, input.roadmapItem.verification],
      scope: input.roadmapItem.outcome,
      nonGoals: [],
      confidence: 1,
      reason: expectedReason,
      routerVersion: "workspace-goal-roadmap-v1",
    };
    const item = this.state.persistence.submissions.enqueueSessionInbox(input.workspaceId, content, analysis, requestId);
    try {
      this.state.persistence.workspaceGoals.linkInbox({
        inboxItemId: item.id,
        ...linkInput,
      });
    } catch (error) {
      this.state.persistence.submissions.discardSessionInboxItem(item.id, input.workspaceId);
      throw error;
    }
    const run = this.dispatchSessionInbox(input.workspaceId) ?? null;
    return { item: this.state.persistence.submissions.getSessionInboxItem(item.id)!, run };
  }

  public enqueueRelatedSessionTask(parent: TaskRun, sourceItem: SessionInboxItem, summary: string, relation: "parallel" | "follow_up" | "derived", analysis: SessionInputAnalysis) {
    const objective = analysis.objectives.find((item) => item.summary === summary);
    const criteria = analysis.acceptanceCriteria.filter((criterion) => {
      const words = summary.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
      const normalized = criterion.toLocaleLowerCase();
      return words.some((word) => normalized.includes(word));
    });
    const relatedAnalysis: SessionInputAnalysis = {
      ...analysis,
      summary,
      objectives: [{ ...(objective ?? { id: `related-${randomUUID()}`, summary, kind: "other" as const }), timing: relation === "parallel" ? "parallel" : "follow_up" }],
      intent: relation === "parallel" ? "parallel_task" : "new_task",
      targetRunId: parent.id,
      relation,
      acceptanceCriteria: criteria.length ? criteria : analysis.acceptanceCriteria,
      scope: analysis.scope || summary,
      reason: `${relation} objective derived from Session Inbox ${sourceItem.id}: ${analysis.reason}`,
    };
    const related = this.state.persistence.submissions.enqueueSessionInbox(parent.sessionId, summary, relatedAnalysis, `related:${sourceItem.id}:${objective?.id ?? summary}`);
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(parent.id, "session.inbox.related.queued", { inboxItemId: related.id, sourceInboxItemId: sourceItem.id, goal: summary, relation, parentRunId: parent.id }));
    return related;
  }

  async updateSessionInput(sessionId: SessionId, itemId: string, content: string) {
    const item = this.state.persistence.submissions.getSessionInboxItem(itemId);
    if (!item || item.sessionId !== sessionId || item.status !== "queued") return undefined;
    const activeRun = this.state.persistence.taskRuns.getActiveRun(sessionId);
    return this.state.persistence.submissions.updateSessionInboxItem(itemId, sessionId, content, await this.dependencies.router.analyze(content, activeRun, this.sessionRouterContext(sessionId)));
  }

  reorderSessionInputs(sessionId: SessionId, itemIds: string[]) {
    return this.state.persistence.submissions.reorderSessionInbox(sessionId, itemIds);
  }

  deleteSessionInput(sessionId: SessionId, itemId: string) {
    return this.state.persistence.submissions.deleteSessionInboxItem(itemId, sessionId);
  }

  decideSessionInput(sessionId: SessionId, itemId: string, decision: "pending" | "defer") {
    const changed = this.state.persistence.submissions.decideSessionInboxItem(itemId, sessionId, decision);
    if (changed && decision === "pending") this.dispatchSessionInbox(sessionId);
    return changed;
  }

  mergeSessionInputs(sessionId: SessionId, sourceId: string, targetId: string) {
    const changed = this.state.persistence.submissions.mergeSessionInboxItems(sourceId, targetId, sessionId);
    if (changed) this.dispatchSessionInbox(sessionId);
    return changed;
  }

  startSessionInputNow(sessionId: SessionId, itemId: string) {
    if (this.state.closing) return { status: "closing" as const };
    const item = this.state.persistence.submissions.getSessionInboxItem(itemId);
    const active = this.state.persistence.taskRuns.getActiveRun(sessionId);
    if (item && active && item.analysis.relation === "parallel" && item.analysis.targetRunId === active.id) return { status: "approval_required" as const, item, runId: active.id };
    return this.launchSessionInboxNow(sessionId, itemId, false);
  }

  public launchSessionInboxNow(sessionId: SessionId, itemId: string, allowApprovedParallel: boolean) {
    const claimed = this.state.persistence.submissions.claimSessionInboxNow(itemId, sessionId, allowApprovedParallel);
    if (claimed.status !== "started") return claimed;
    const run = this.launchClaimedSessionInbox(claimed.item, claimed.run);
    return run ? { status: "started" as const, item: this.state.persistence.submissions.getSessionInboxItem(claimed.item.id)!, run } : { status: "failed" as const };
  }

  requestParallelSessionInputApproval(
    sessionId: SessionId,
    itemId: string,
    requestedBy = "governor",
    reason = "start related parallel TaskRun",
  ): ReturnType<ApprovalRepository["ensureApprovalRequest"]> {
    const item = this.state.persistence.submissions.getSessionInboxItem(itemId);
    if (!item || item.sessionId !== sessionId || item.status !== "queued" || item.analysis.relation !== "parallel" || !item.analysis.targetRunId) throw new Error("Queued parallel Session Inbox item not found");
    const decision = this.dependencies.supervisor.proposeParallelTaskStart(item.analysis.targetRunId, item.id, item.analysis.summary || item.content);
    return this.state.persistence.approvals.ensureApprovalRequest(item.analysis.targetRunId, decision.id, reason, { actionType: "start_parallel_taskrun", targetType: "session_inbox_item", targetId: item.id, metadata: { sessionId, inboxItemId: item.id, parentRunId: item.analysis.targetRunId, requestedBy } });
  }

  async approveRunApproval(approvalId: string, resolution = "Approved by user") {
    const pending = this.state.persistence.approvals.getApprovalRequest(approvalId);
    if (!pending || pending.status !== "pending") throw new Error("Approval request is not pending");
    const metadata = pending.metadata as {sessionId?:string;inboxItemId?:string};
    if (pending.actionType === "start_parallel_taskrun") {
      if (!metadata.sessionId || !metadata.inboxItemId) throw new Error("Parallel Session Inbox approval metadata is incomplete");
      const launched = this.launchSessionInboxNow(metadata.sessionId, metadata.inboxItemId, true);
      if (launched.status !== "started") throw new Error(`Parallel Session Inbox task could not start: ${launched.status}`);
      const approval = this.state.persistence.approvals.resolveApprovalRequest(approvalId, "approved", "user", resolution);
      if (!approval) throw new Error("Approval request is not pending");
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(approval.runId, "supervisor.approval.approved", { approvalId, resolution }));
      return launched.run;
    }
    const approval = this.state.persistence.approvals.resolveApprovalRequest(approvalId, "approved", "user", resolution);
    if (!approval) throw new Error("Approval request is not pending");
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(approval.runId, "supervisor.approval.approved", { approvalId, resolution }));
    return this.dependencies.contextService.resume(approval.runId, { approvalId });
  }

  public dispatchSessionInbox(sessionId: SessionId) {
    if (this.state.closing) return undefined;
    const claimed = this.state.persistence.submissions.claimNextSessionInbox(sessionId);
    if (!claimed) return undefined;
    return this.launchClaimedSessionInbox(claimed.item, claimed.run);
  }

  public launchClaimedSessionInbox(item: SessionInboxItem, run: TaskRun, retry = false) {
    try {
      this.state.persistence.workspaceGoals.attachRun(run.id, item.id);
      run = this.state.persistence.taskRuns.getRun(run.id) ?? run;
    } catch (error) {
      return this.failClaimedSessionLaunch(item, run, error);
    }
    // Persist the accepted user turn before any asynchronous recall/provider setup.
    // This makes the POST admission response a durable UI visibility boundary and
    // keeps slow memory recall from hiding the message until a refresh or Run end.
    if (!retry) {
      const userMessage = this.state.persistence.sessions.appendMessage(run.sessionId, "user", item.content);
      const principalId = this.state.persistence.submissions.getSubmissionAudit(item.sessionId, item.requestId)?.principalId;
      this.dependencies.continuation.captureUserMessage(run, userMessage.id, item.content, principalId);
    }
    const currentUserAfter = item.startedAt ?? run.createdAt;
    if (!this.dependencies.contextService.requiresAsyncPreparation()) {
      try {
        const sessionHistory = this.dependencies.contextService.prepareSessionHistoryWithoutRecall(run, item.content, currentUserAfter);
        this.completeClaimedSessionLaunch(item, run, sessionHistory, retry);
        return this.state.persistence.taskRuns.getRun(run.id)!;
      } catch (error) { return this.failClaimedSessionLaunch(item, run, error); }
    }
    void this.trackPreparation(run.id, async (signal) => {
      try {
        const sessionHistory = await this.dependencies.contextService.prepareSessionHistory(run, item.content, currentUserAfter, signal);
        if (signal.aborted || !this.currentLaunchRun(run)) return;
        this.completeClaimedSessionLaunch(item, run, sessionHistory, retry);
      } catch (error) {
        if (signal.aborted || this.state.closing) return;
        this.failClaimedSessionLaunch(item, run, error);
      }
    });
    return this.state.persistence.taskRuns.getRun(run.id)!;
  }

  public completeClaimedSessionLaunch(item: SessionInboxItem, run: TaskRun, sessionHistory: ContextAssembly & { recalledMemory?: string; memoryContextItems?: ContextManifestItem[] }, retry: boolean) {
    const current = this.currentLaunchRun(run);
    if (!current) return;
    run = current;
    if (!retry) {
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(run.id, "run.started", { goal: run.goal, sourceInput: item.content, contract: run.contract, source: "session_supervisor_inbox", inboxItemId: item.id, sessionHistoryCount: sessionHistory.messages.length }));
    }
    this.dependencies.contextService.publishContextEvents(run.id, sessionHistory);
    this.state.recalledMemory.set(run.id, sessionHistory.recalledMemory ?? "");
    this.dependencies.attemptExecutor.launch(run, this.buildContractPrompt(run, item.content), sessionHistory.messages, undefined, { initialize: true, inboxItemId: item.id, retry });
    if (!this.state.runtimes.has(run.id)) {
      const current = this.state.persistence.taskRuns.getRun(run.id);
      if (current && current.status !== "running") return;
      throw new Error("Inbox TaskRun runtime did not start");
    }
  }

  public buildContractPrompt(run: TaskRun, sourceInput: string) {
    if (!run.contract) return sourceInput;
    return [
      "Execute the active TaskRun contract from the system context.",
      "Treat the following as the original user request; do not duplicate or reinterpret the already supplied contract:",
      sourceInput,
    ].join("\n\n");
  }

  public failClaimedSessionLaunch(item: SessionInboxItem, run: TaskRun, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !message.startsWith("Model is not allowed:");
    const attempt = this.state.persistence.attempts.getAttemptForRun(run.id, run.attempt);
    if (!attempt) throw new Error(`TaskRun ${run.id} has no Attempt ${run.attempt} for launch failure`);
    const transition = this.state.persistence.taskRunTransitions.transitionSystem({
      kind: "admission_launch_failed",
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      inboxItemId: item.id,
      error: message,
      retryable,
    }, {
      kind: "admission_launch_failure",
      component: "admission_coordinator",
      inboxItemId: item.id,
    }).transitions[0];
    if (!transition?.event) throw new Error(`TaskRun ${run.id} launch failure returned no terminal event`);
    this.dependencies.eventHub.publish(transition.event);
    this.state.persistence.workspaceGoals.recordRunOutcome(run.id);
    this.dependencies.settlement.projectWorkflowExperience(run.id);
    setImmediate(() => { if (!this.state.closing) this.dispatchSessionInbox(run.sessionId); });
    return undefined;
  }

  retryInboxLaunch(runId: string) {
    if (this.state.closing) return { status: "closing" as const };
    if (this.state.runtimes.has(runId)) return { status: "running" as const, runId };
    const claimed = this.state.persistence.submissions.retryInboxLaunch(runId);
    if (claimed.status !== "started") return claimed;
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "run.launch.retrying", {
      attempt: claimed.run.attempt,
      inboxItemId: claimed.item.id,
    }));
    const run = this.launchClaimedSessionInbox(claimed.item, claimed.run, true);
    return run
      ? { status: "started" as const, item: this.state.persistence.submissions.getSessionInboxItem(claimed.item.id)!, run }
      : { status: "failed" as const };
  }

  recoverSessionInbox() {
    if (this.state.closing) return [];
    const started: string[] = [];
    for (const sessionId of this.state.persistence.submissions.listSessionsWithQueuedInbox()) {
      const run = this.dispatchSessionInbox(sessionId);
      if (run) started.push(run.id);
    }
    return started;
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    if (this.state.closing) throw new Error("Service is shutting down");
    const existing = this.state.persistence.taskRuns.getRunByRequestId(requestId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.goal !== query) throw new Error("TaskRun request idempotency conflict");
      return existing;
    }

    let run = this.state.persistence.taskRuns.createRun(sessionId, query, requestId);
    this.state.persistence.workspaceGoals.attachRun(run.id, null);
    run = this.state.persistence.taskRuns.getRun(run.id) ?? run;
    const sessionHistory = await this.trackPreparation(run.id, (signal) =>
      this.dependencies.contextService.prepareSessionHistory(run, query, undefined, signal));
    const current = this.currentLaunchRun(run);
    if (!current) throw new Error(`TaskRun ${run.id} preparation was cancelled`);
    run = current;
    const userMessage = this.state.persistence.sessions.appendMessage(sessionId, "user", query);
    this.dependencies.continuation.captureUserMessage(run, userMessage.id, query);
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(run.id, "run.started", { goal: query, sessionHistoryCount: sessionHistory.messages.length }));
    this.dependencies.contextService.publishContextEvents(run.id, sessionHistory);
    this.state.recalledMemory.set(run.id, sessionHistory.recalledMemory ?? "");
    this.dependencies.attemptExecutor.launch(run, query, sessionHistory.messages);
    return this.state.persistence.taskRuns.getRun(run.id)!;
  }

  private currentLaunchRun(run: TaskRun) {
    if (this.state.closing) return undefined;
    const current = this.state.persistence.taskRuns.getRun(run.id);
    if (!current || current.status !== "running" || current.attempt !== run.attempt) return undefined;
    const attempt = this.state.persistence.attempts.getActiveAttempt(run.id);
    return attempt?.ordinal === run.attempt ? current : undefined;
  }

  private trackPreparation<T>(runId: string, prepare: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const existing = this.state.preparationTasks.get(runId);
    if (existing) throw new Error(`TaskRun ${runId} preparation is already active`);
    const controller = new AbortController();
    let task!: Promise<T>;
    task = Promise.resolve().then(() => prepare(controller.signal)).finally(() => {
      if (this.state.preparationTasks.get(runId)?.promise === task) this.state.preparationTasks.delete(runId);
    });
    this.state.preparationTasks.set(runId, { controller, promise: task });
    return task;
  }
}
