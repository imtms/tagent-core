import type { ContextManifest, ExecutionSessionRef } from "../domain/task-run.js";
import type { ApprovalRepository, SupervisorDecisionJournal, WorkspaceGoalRepository } from "@tagent/governance/ports";
import type { AttemptRepository, FencedRuntimeMutationPort } from "./attempt-repository.js";
import type { CheckpointRepository } from "./checkpoint-repository.js";
import type { ContinuationQueue } from "./continuation-queue.js";
import type { ControlInbox } from "./control-inbox.js";
import type { RunEventJournal } from "./run-event-journal.js";
import type { RuntimePersistencePort } from "./runtime-persistence-port.js";
import type { TaskRunRepository } from "./task-run-repository.js";
import type { TaskRunTransitionPort } from "./task-run-transition-port.js";
import type { TranscriptRepository } from "./transcript-repository.js";
import type { AttemptRequestEnvelopeRepository } from "./attempt-request-envelope-repository.js";

export interface ExecutionMessage {
  id: number;
  sessionId: ExecutionSessionRef;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
}

/** Consumer-owned conversation capability used by Execution without importing Admission. */
export interface ExecutionConversationPort {
  listRecentMessages(sessionId: ExecutionSessionRef, limit?: number): ExecutionMessage[];
  appendMessage(sessionId: ExecutionSessionRef, role: ExecutionMessage["role"], content: string): ExecutionMessage;
}

/** Consumer-owned Governance capabilities needed by Execution settlement and recovery. */
export type ExecutionApprovalPort = Pick<
  ApprovalRepository,
  "ensureApprovalRequest" | "getApprovalRequest" | "resolveApprovalRequest" | "hasPendingApproval"
  | "inspectExternalActionAuthorization" | "activateExternalActionAuthorization"
>;

export interface ExecutionContextManifestPort {
  recordContextManifest(manifest: ContextManifest): ContextManifest;
}

export type ExecutionSupervisorDecisionPort = Pick<
  SupervisorDecisionJournal,
  "listSupervisorContinuationsNeedingReconcile" | "reconcileSupervisorDecisionStatuses"
>;

/** Persistence surface owned by Execution; adapters may implement additional context ports. */
export interface ExecutionPersistencePort {
  readonly attempts: AttemptRepository;
  readonly runtimeMutations: FencedRuntimeMutationPort;
  readonly taskRuns: TaskRunRepository;
  readonly taskRunTransitions: TaskRunTransitionPort;
  readonly continuations: ContinuationQueue;
  readonly controlInbox: ControlInbox;
  readonly events: RunEventJournal;
  readonly transcript: TranscriptRepository;
  readonly checkpoints: CheckpointRepository;
  readonly runtime: RuntimePersistencePort;
  readonly sessions: ExecutionConversationPort;
  readonly approvals: ExecutionApprovalPort;
  readonly contextManifests: ExecutionContextManifestPort;
  readonly requestEnvelopes: AttemptRequestEnvelopeRepository;
  readonly supervisorDecisions: ExecutionSupervisorDecisionPort;
  readonly workspaceGoals: Pick<WorkspaceGoalRepository, "authorizeRunMutation">;
}
