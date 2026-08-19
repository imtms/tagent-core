import { randomUUID } from "node:crypto";
import type {
  GateProfile,
  SessionId,
  Submission,
  SessionInputAnalysis,
} from "../domain/index.js";
import { assertSubmissionContent } from "../domain/index.js";
import type {
  ProfileInboxMutationValue,
  ProfileMutationContext,
  ProfileMutationResult,
  SessionRepository,
  SubmissionAuditInput,
  SubmissionQueue,
} from "../ports/index.js";
import type { ContextManifestItem, RunId, TaskRun } from "@tagent/execution/domain";
import type {
  AttemptRepository,
  RunEventJournal,
  TaskRunRepository,
  TaskRunTransitionPort,
} from "@tagent/execution/ports";
import type { ApprovalRepository } from "@tagent/governance/ports";
import type { WorkspaceGoalRepository } from "@tagent/governance/ports";
import { buildGoalRoadmapAdmission, matchesGoalRoadmapAdmission } from "./goal-roadmap-admission.js";
import { effectiveTaskExecutionPolicy } from "@tagent/governance";
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
    workspaceGoals: Pick<WorkspaceGoalRepository, "linkInbox" | "attachRun" | "recordRunOutcome" | "reconcileRunState">;
  };
  readonly recalledMemory: Map<string, string>;
  readonly preparationTasks: Map<string, {
    readonly controller: AbortController;
    readonly promise: Promise<unknown>;
  }>;
  readonly runtimes: ReadonlyMap<string, unknown>;
}

export class AdmissionCoordinator {
  private goalRunStateReconciled = false;

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
    gateProfile?: GateProfile,
  ) {
    if (this.state.closing) throw new Error("Service is shutting down");
    assertSubmissionContent(content);
    const existing = this.state.persistence.submissions.getSessionSubmission(sessionId, requestId);
    if (existing) {
      if (existing.content !== content || (existing.analysis.executionPolicy?.gateProfile ?? "strict") !== (gateProfile ?? "strict")) {
        throw new Error("Session Inbox request idempotency conflict");
      }
      if (audit) this.state.persistence.submissions.recordSubmissionAudit(existing, audit);
      return { item: existing, run: existing.runId ? this.state.persistence.taskRuns.getRun(existing.runId) ?? null : null };
    }
    const activeRun = this.state.persistence.taskRuns.getActiveRun(sessionId);
    const routedAnalysis = await this.dependencies.router.analyze(content, activeRun, this.sessionRouterContext(sessionId));
    // Gate acceptance style is a user choice, not a semantic Router decision.
    // Freeze it after routing so model output cannot override or omit the selection.
    const analysis: SessionInputAnalysis = gateProfile
      ? { ...routedAnalysis, executionPolicy: { ...effectiveTaskExecutionPolicy(routedAnalysis), gateProfile } }
      : routedAnalysis;
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
    const admission = buildGoalRoadmapAdmission(input);
    const { content, analysis } = admission;
    const linkInput = {
      goalId: input.goalId,
      goalRevision: input.goalRevision,
      roadmapRevisionId: input.roadmapRevisionId,
      roadmapItemIds: [input.roadmapItem.id],
      criterionKeys: input.roadmapItem.criterionKeys,
    };
    const existing = this.state.persistence.submissions.getSessionSubmission(input.workspaceId, requestId);
    if (existing) {
      if (!matchesGoalRoadmapAdmission(existing, admission)) {
        throw new Error("Workspace Goal Roadmap TaskRun idempotency conflict");
      }
      this.state.persistence.workspaceGoals.linkInbox({ ...linkInput, inboxItemId: existing.id });
      if (["deleted", "routed"].includes(existing.status)) {
        throw new Error("Workspace Goal Roadmap TaskRun request is no longer launchable");
      }
      if (!existing.runId && existing.status === "queued") {
        const run = this.dispatchSessionInbox(input.workspaceId) ?? null;
        return { item: this.state.persistence.submissions.getSessionInboxItem(existing.id)!, run };
      }
      if (existing.runId) this.state.persistence.workspaceGoals.attachRun(existing.runId, existing.id);
      return { item: existing, run: existing.runId ? this.state.persistence.taskRuns.getRun(existing.runId) ?? null : null };
    }
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

  public enqueueRelatedSessionTask(parent: TaskRun, sourceItem: Submission, summary: string, relation: "parallel" | "follow_up" | "derived", analysis: SessionInputAnalysis) {
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

  async updateSessionInputProfile(
    sessionId: SessionId,
    itemId: string,
    content: string,
    mutation: ProfileMutationContext,
  ): Promise<ProfileMutationResult<ProfileInboxMutationValue>> {
    assertSubmissionContent(content);
    const item = this.state.persistence.submissions.getSessionInboxItem(itemId);
    if (!item || item.sessionId !== sessionId || item.status !== "queued") return { status: "state_conflict" };
    const activeRun = this.state.persistence.taskRuns.getActiveRun(sessionId);
    const routed = await this.dependencies.router.analyze(content, activeRun, this.sessionRouterContext(sessionId));
    const selectedGateProfile = item.analysis.executionPolicy?.gateProfile;
    const analysis = selectedGateProfile
      ? { ...routed, executionPolicy: { ...effectiveTaskExecutionPolicy(routed), gateProfile: selectedGateProfile } }
      : routed;
    return this.state.persistence.submissions.updateSessionInboxItemProfile({
      sessionId, itemId, content, analysis, mutation,
    });
  }

  reorderSessionInputsProfile(sessionId: SessionId, itemIds: string[], mutation: ProfileMutationContext) {
    return this.state.persistence.submissions.reorderSessionInboxProfile({ sessionId, itemIds, mutation });
  }

  deleteSessionInputProfile(sessionId: SessionId, itemId: string, mutation: ProfileMutationContext) {
    return this.state.persistence.submissions.deleteSessionInboxItemProfile({ sessionId, itemId, mutation });
  }

  decideSessionInputProfile(
    sessionId: SessionId,
    itemId: string,
    decision: "pending" | "defer",
    mutation: ProfileMutationContext,
  ) {
    const result = this.state.persistence.submissions.decideSessionInboxItemProfile({
      sessionId, itemId, decision, mutation,
    });
    return result;
  }

  mergeSessionInputsProfile(
    sessionId: SessionId,
    sourceId: string,
    targetId: string,
    mutation: ProfileMutationContext,
  ) {
    const result = this.state.persistence.submissions.mergeSessionInboxItemsProfile({
      sessionId, sourceId, targetId, mutation,
    });
    return result;
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
    if (pending.actionType === "execute_external_action") {
      const approval = this.state.persistence.approvals.resolveApprovalRequest(approvalId, "approved", "user", resolution);
      if (!approval) throw new Error("Approval request is not pending");
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(approval.runId, "supervisor.approval.approved", { approvalId, resolution, actionType: approval.actionType }));
      return this.dependencies.contextService.resume(approval.runId, { actorId: "user", reason: `External action approved by ${approvalId}` });
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

  public launchClaimedSessionInbox(item: Submission, run: TaskRun, retry = false) {
    const claimedRun = this.state.persistence.taskRuns.getRun(run.id);
    if (!claimedRun || claimedRun.status !== "running") return undefined;
    run = claimedRun;
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
    if (effectiveTaskExecutionPolicy(run.contract).mode === "external_action") {
      this.pauseForExternalActionApproval(item, run, retry);
      return this.state.persistence.taskRuns.getRun(run.id)!;
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

  private pauseForExternalActionApproval(item: Submission, run: TaskRun, retry: boolean) {
    const reason = `External action requires explicit approval before any mutation-capable tool can execute: ${run.contract?.summary || item.content}`;
    const decision = this.dependencies.supervisor.proposeExternalActionStart(run.id, run.contract?.summary || item.content);
    const approval = this.state.persistence.approvals.ensureApprovalRequest(run.id, decision.id, reason, {
      actionType: "execute_external_action",
      targetType: "taskrun",
      targetId: run.id,
      metadata: { sessionId: run.sessionId, approvedAttempt: run.attempt + 1 },
    });
    if (!retry) {
      this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(run.id, "run.started", {
        goal: run.goal, sourceInput: item.content, contract: run.contract,
        source: "session_supervisor_inbox", inboxItemId: item.id, sessionHistoryCount: 0,
      }));
    }
    const attempt = this.state.persistence.attempts.getAttemptForRun(run.id, run.attempt);
    if (!attempt) throw new Error(`TaskRun ${run.id} has no Attempt ${run.attempt} for external approval`);
    const transition = this.state.persistence.taskRunTransitions.transitionSystem({
      kind: "require_external_approval", attemptId: attempt.id, expectedVersion: attempt.version,
      approvalId: approval.id, reason,
    }, {
      kind: "external_action_guard", component: "admission_coordinator", approvalId: approval.id,
    }).transitions[0];
    if (!transition?.event) throw new Error(`TaskRun ${run.id} external approval transition returned no event`);
    this.dependencies.supervisor.markExecuted(decision.id, "executed");
    this.dependencies.eventHub.publish(transition.event);
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(run.id, "supervisor.approval.requested", {
      approvalId: approval.id, decisionId: decision.id, reason, actionType: approval.actionType,
    }));
    this.state.persistence.workspaceGoals.recordRunOutcome(run.id);
  }

  public requestExternalActionApproval(input: {
    runId: RunId;
    attemptId: string;
    attempt: number;
    expectedVersion: number;
    toolCallId: string;
    toolName: string;
  }): { approvalId: string; reason: string } {
    const toolName = input.toolName.trim();
    const toolCallId = input.toolCallId.trim();
    if (!toolName || toolName.length > 128 || toolName.includes("\0")) {
      throw new Error("External-action approval tool name is invalid");
    }
    if (!toolCallId || toolCallId.length > 512 || toolCallId.includes("\0")) {
      throw new Error("External-action approval tool call identity is invalid");
    }
    const run = this.state.persistence.taskRuns.getRun(input.runId);
    if (!run || run.status !== "running" || run.attempt !== input.attempt) {
      throw new Error(`TaskRun ${input.runId} is not running Attempt ${input.attempt}`);
    }
    const attempt = this.state.persistence.attempts.getAttempt(input.attemptId);
    if (!attempt || attempt.runId !== run.id || attempt.ordinal !== input.attempt
      || attempt.version !== input.expectedVersion || !attempt.active || attempt.status !== "running") {
      throw new Error(`Attempt ${input.attemptId} cannot request external-action approval`);
    }
    const reason = `Tool ${toolName} requires explicit external-action approval before execution`;
    const decision = this.dependencies.supervisor.proposeExternalActionStart(run.id, reason);
    const approval = this.state.persistence.approvals.ensureApprovalRequest(run.id, decision.id, reason, {
      actionType: "execute_external_action",
      targetType: "taskrun",
      targetId: run.id,
      metadata: {
        sessionId: run.sessionId,
        approvedAttempt: run.attempt + 1,
        requestedAttempt: run.attempt,
        requestedToolName: toolName,
        requestedToolCallId: toolCallId,
      },
    });
    const transition = this.state.persistence.taskRunTransitions.transitionSystem({
      kind: "require_external_approval",
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      approvalId: approval.id,
      reason,
    }, {
      kind: "external_action_guard",
      component: "admission_coordinator",
      approvalId: approval.id,
    }).transitions[0];
    if (!transition?.event) throw new Error(`TaskRun ${run.id} external approval transition returned no event`);
    this.dependencies.supervisor.markExecuted(
      decision.id,
      approval.decisionId === decision.id ? "executed" : "superseded",
    );
    this.dependencies.eventHub.publish(transition.event);
    this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(run.id, "supervisor.approval.requested", {
      approvalId: approval.id,
      decisionId: approval.decisionId,
      reason,
      actionType: approval.actionType,
      toolName,
      requestedAttempt: run.attempt,
      approvedAttempt: run.attempt + 1,
    }));
    this.state.persistence.workspaceGoals.recordRunOutcome(run.id);
    return { approvalId: approval.id, reason: `Approval requested for ${toolName}; resume will use Attempt ${run.attempt + 1}` };
  }

  public completeClaimedSessionLaunch(item: Submission, run: TaskRun, sessionHistory: ContextAssembly & { recalledMemory?: string; memoryContextItems?: ContextManifestItem[] }, retry: boolean) {
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

  public failClaimedSessionLaunch(item: Submission, run: TaskRun, error: unknown) {
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
    if (!this.goalRunStateReconciled) {
      this.state.persistence.workspaceGoals.reconcileRunState();
      this.goalRunStateReconciled = true;
    }
    const started: string[] = [];
    for (const sessionId of this.state.persistence.submissions.listSessionsWithQueuedInbox()) {
      const run = this.dispatchSessionInbox(sessionId);
      if (run) started.push(run.id);
    }
    return started;
  }

  async start(sessionId: SessionId, query: string, requestId: string = randomUUID()) {
    const admitted = await this.enqueueSessionInput(sessionId, query, requestId);
    if (!admitted.run) throw new Error(`Submission ${requestId} did not create a TaskRun`);
    return admitted.run;
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
