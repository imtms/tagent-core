import type { Submission } from "@tagent/admission/domain";
import type { AdmissionExternalActionApprovalPort, AdmissionSupervisorPort } from "@tagent/admission/composition";
import type { TaskRun } from "@tagent/execution/domain";
import type { AttemptRepository, RunEventJournal, TaskRunRepository, TaskRunTransitionPort } from "@tagent/execution/ports";
import type { RunEventPublisherPort } from "@tagent/execution/composition";
import { effectiveTaskExecutionPolicy } from "@tagent/governance";
import type { ApprovalRepository, WorkspaceGoalRepository } from "@tagent/governance/ports";

/** Core-owned durable boundary for Attempt-scoped external-action approvals. */
export class CoreExternalActionApprovalApplication implements AdmissionExternalActionApprovalPort {
  constructor(
    private readonly persistence: {
      mutations: { run<T>(work: () => T): T };
      approvals: ApprovalRepository;
      attempts: AttemptRepository;
      events: RunEventJournal;
      taskRuns: TaskRunRepository;
      taskRunTransitions: TaskRunTransitionPort;
      workspaceGoals: Pick<WorkspaceGoalRepository, "recordRunOutcome">;
    },
    private readonly dependencies: {
      supervisor: AdmissionSupervisorPort;
      eventHub: RunEventPublisherPort;
    },
  ) {}

  requestForInitialLaunch(item: Submission, run: TaskRun, retry: boolean): void {
    const reason = `External action requires explicit approval before any mutation-capable tool can execute: ${run.contract?.summary || item.content}`;
    const attempt = this.persistence.attempts.getAttemptForRun(run.id, run.attempt);
    if (!attempt) throw new Error(`TaskRun ${run.id} has no Attempt ${run.attempt} for external approval`);
    this.requireBoundary({
      run, attempt, reason, decisionSummary: run.contract?.summary || item.content,
      metadata: { sessionId: run.sessionId, approvedAttempt: run.attempt + 1 },
      transitionError: `TaskRun ${run.id} external approval transition returned no event`,
      onApprovalEnsured: retry ? undefined : () => {
        return this.persistence.events.appendEvent(run.id, "run.started", {
          goal: run.goal, sourceInput: item.content, contract: run.contract,
          source: "session_supervisor_inbox", inboxItemId: item.id, sessionHistoryCount: 0,
        });
      },
    });
  }

  requestForTool(input: { runId: string; attemptId: string; attempt: number; expectedVersion: number; toolCallId: string; toolName: string }) {
    const toolName = input.toolName.trim();
    const toolCallId = input.toolCallId.trim();
    if (!toolName || toolName.length > 128 || toolName.includes("\0")) throw new Error("External-action approval tool name is invalid");
    if (!toolCallId || toolCallId.length > 512 || toolCallId.includes("\0")) throw new Error("External-action approval tool call identity is invalid");
    const { run, attempt } = this.runningAttempt(input);
    const reason = `Tool ${toolName} requires explicit external-action approval before execution`;
    const approval = this.requireBoundary({
      run, attempt, reason, decisionSummary: reason,
      metadata: {
        sessionId: run.sessionId, approvedAttempt: run.attempt + 1, requestedAttempt: run.attempt,
        requestedToolName: toolName, requestedToolCallId: toolCallId,
      },
      requestedEventData: { toolName, requestedAttempt: run.attempt, approvedAttempt: run.attempt + 1 },
      transitionError: `TaskRun ${run.id} external approval transition returned no event`,
    });
    return { approvalId: approval.id, reason: `Approval requested for ${toolName}; resume will use Attempt ${run.attempt + 1}` };
  }

  requestAfterUserInput(input: { runId: string; attemptId: string; attempt: number; expectedVersion: number; inputRequestId: string }) {
    const run = this.persistence.taskRuns.getRun(input.runId);
    if (!run || run.status !== "waiting_input" || run.attempt !== input.attempt || run.pendingUserInput) {
      throw new Error(`TaskRun ${input.runId} is not ready for approval after submitted user input`);
    }
    const attempt = this.persistence.attempts.getAttempt(input.attemptId);
    if (!attempt || attempt.runId !== run.id || attempt.ordinal !== input.attempt
      || attempt.version !== input.expectedVersion || attempt.active || attempt.status !== "waiting_input") {
      throw new Error(`Attempt ${input.attemptId} cannot request approval after user input`);
    }
    const reason = `A fresh external-action approval is required because submitted user input will resume TaskRun ${run.id} in Attempt ${run.attempt + 1}`;
    const approval = this.requireBoundary({
      run, attempt, reason, decisionSummary: reason,
      metadata: {
        sessionId: run.sessionId, approvedAttempt: run.attempt + 1, requestedAttempt: run.attempt,
        submittedInputRequestId: input.inputRequestId,
      },
      requestedEventData: { requestedAttempt: run.attempt, approvedAttempt: run.attempt + 1, inputRequestId: input.inputRequestId },
      transitionError: `TaskRun ${run.id} post-input approval transition returned no event`,
    });
    return { approvalId: approval.id, reason };
  }

  requestForResume(input: { runId: string; attemptId: string; attempt: number; expectedVersion: number; actorId: string; reason: string }) {
    const run = this.persistence.taskRuns.getRun(input.runId);
    const externalAction = run && (effectiveTaskExecutionPolicy(run.contract).mode === "external_action"
      || run.supervision.approvalRequests.some((approval) => approval.actionType === "execute_external_action"));
    if (!run || !run.resumable || run.attempt !== input.attempt || !externalAction) {
      throw new Error(`TaskRun ${input.runId} is not an external-action resume boundary`);
    }
    const attempt = this.persistence.attempts.getAttempt(input.attemptId);
    if (!attempt || attempt.runId !== run.id || attempt.ordinal !== input.attempt
      || attempt.version !== input.expectedVersion || attempt.active) {
      throw new Error(`Attempt ${input.attemptId} cannot request external-action resume approval`);
    }
    const actorId = input.actorId.trim();
    if (!actorId || actorId.includes("\0")) throw new Error("External-action resume actor is invalid");
    const resumeReason = input.reason.trim();
    if (!resumeReason || resumeReason.includes("\0")) throw new Error("External-action resume reason is invalid");
    const reason = `A fresh external-action approval is required before user-requested resume of TaskRun ${run.id} in Attempt ${run.attempt + 1}`;
    const approval = this.requireBoundary({
      run, attempt, reason, decisionSummary: resumeReason,
      metadata: {
        sessionId: run.sessionId, approvedAttempt: run.attempt + 1, requestedAttempt: run.attempt,
        manualResumeRequested: true, resumeActorId: actorId, resumeReason,
      },
      requestedEventData: { requestedAttempt: run.attempt, approvedAttempt: run.attempt + 1, manualResumeRequested: true },
      transitionError: `TaskRun ${run.id} external resume approval transition returned no event`,
    });
    return { approvalId: approval.id, reason };
  }

  private runningAttempt(input: { runId: string; attemptId: string; attempt: number; expectedVersion: number }) {
    const run = this.persistence.taskRuns.getRun(input.runId);
    if (!run || run.status !== "running" || run.attempt !== input.attempt) throw new Error(`TaskRun ${input.runId} is not running Attempt ${input.attempt}`);
    const attempt = this.persistence.attempts.getAttempt(input.attemptId);
    if (!attempt || attempt.runId !== run.id || attempt.ordinal !== input.attempt
      || attempt.version !== input.expectedVersion || !attempt.active || attempt.status !== "running") {
      throw new Error(`Attempt ${input.attemptId} cannot request external-action approval`);
    }
    return { run, attempt };
  }

  private requireBoundary(input: {
    run: TaskRun;
    attempt: { id: string; version: number };
    reason: string;
    decisionSummary: string;
    metadata: Record<string, unknown>;
    requestedEventData?: Record<string, unknown>;
    transitionError: string;
    onApprovalEnsured?: () => ReturnType<RunEventJournal["appendEvent"]> | undefined;
  }) {
    const outcome = this.persistence.mutations.run(() => {
      const decision = this.dependencies.supervisor.proposeExternalActionStart(input.run.id, input.decisionSummary);
      const approval = this.persistence.approvals.ensureApprovalRequest(input.run.id, decision.id, input.reason, {
        actionType: "execute_external_action", targetType: "taskrun", targetId: input.run.id, metadata: input.metadata,
      });
      const initialEvent = input.onApprovalEnsured?.();
      const transition = this.persistence.taskRunTransitions.transitionSystem({
        kind: "require_external_approval", attemptId: input.attempt.id,
        expectedVersion: input.attempt.version, approvalId: approval.id, reason: input.reason,
      }, { kind: "external_action_guard", component: "core_external_action_approval_application", approvalId: approval.id }).transitions[0];
      if (!transition?.event) throw new Error(input.transitionError);
      if (approval.decisionId === decision.id) this.dependencies.supervisor.markExecuted(decision.id, "executed");
      else {
        this.dependencies.supervisor.markExecuted(decision.id, "superseded");
        this.dependencies.supervisor.markExecuted(approval.decisionId, "executed");
      }
      const approvalEvent = this.persistence.events.appendEvent(input.run.id, "supervisor.approval.requested", {
        approvalId: approval.id, decisionId: approval.decisionId, reason: input.reason,
        actionType: approval.actionType, ...input.requestedEventData,
      });
      this.persistence.workspaceGoals.recordRunOutcome(input.run.id);
      return { approval, events: [initialEvent, transition.event, approvalEvent].filter(Boolean) as ReturnType<RunEventJournal["appendEvent"]>[] };
    });
    for (const event of outcome.events) this.dependencies.eventHub.publish(event);
    return outcome.approval;
  }
}
