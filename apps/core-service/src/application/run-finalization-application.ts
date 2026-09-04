import type { TaskRun } from "@tagent/execution/domain";
import type { PostAttemptPort } from "@tagent/execution/composition";
import type { TaskRunRepository } from "@tagent/execution/ports";
import type { SubmissionQueue } from "@tagent/admission/ports";
import type { WorkspaceGoalRepository } from "@tagent/governance/ports";

interface RunFinalizationCollaborators {
  dispatchSessionInbox(sessionId: string): unknown;
  recordWorkspaceGoalRunOutcome(runId: string, options?: { autoStart?: boolean }): unknown;
}

/** One Core-owned home for post-Attempt Run transitions and their in-process follow-ups. */
export class CoreRunFinalizationApplication implements PostAttemptPort {
  private collaborators?: RunFinalizationCollaborators;

  constructor(private readonly persistence: {
    submissions: Pick<SubmissionQueue, "recordSessionInboxLaunchFailure">;
    taskRuns: Pick<TaskRunRepository, "getRun">;
    workspaceGoals: Pick<WorkspaceGoalRepository, "recordRunOutcome">;
  }) {}

  bind(collaborators: RunFinalizationCollaborators): void {
    if (this.collaborators) throw new Error("CoreRunFinalizationApplication is already bound");
    this.collaborators = collaborators;
  }

  assertBound(): void {
    if (!this.collaborators) throw new Error("CoreRunFinalizationApplication is not bound");
  }

  attemptLaunchFailed({ inboxItemId, runId, message }: { inboxItemId: string; runId: string; message: string }): void {
    this.persistence.submissions.recordSessionInboxLaunchFailure(inboxItemId, runId, message);
  }

  attemptFinalized(run: TaskRun, context: { shuttingDown: boolean }): void {
    const current = this.persistence.taskRuns.getRun(run.id);
    if (current) this.recordGoalOutcome(current.id, !context.shuttingDown);
    if (!context.shuttingDown) this.requiredCollaborators().dispatchSessionInbox(run.sessionId);
  }

  continuationStarted(runId: string): void {
    const continued = this.persistence.taskRuns.getRun(runId);
    if (continued?.status === "running") this.persistence.workspaceGoals.recordRunOutcome(continued.id);
  }

  taskFinalized(runId: string): void {
    const completed = this.persistence.taskRuns.getRun(runId);
    if (!completed) return;
    this.recordGoalOutcome(runId, true);
    this.requiredCollaborators().dispatchSessionInbox(completed.sessionId);
  }

  workspaceGoalRunReconciled(runId: string): void {
    this.requiredCollaborators().recordWorkspaceGoalRunOutcome(runId);
  }

  private recordGoalOutcome(runId: string, autoStart: boolean): void {
    if (this.collaborators) this.collaborators.recordWorkspaceGoalRunOutcome(runId, { autoStart });
    else this.persistence.workspaceGoals.recordRunOutcome(runId);
  }

  private requiredCollaborators(): RunFinalizationCollaborators {
    if (!this.collaborators) throw new Error("CoreRunFinalizationApplication is not bound");
    return this.collaborators;
  }
}
