import type {
  ContextManifestItem,
  RunEvent,
  RunId,
  TaskRun,
  UserInputRequest,
} from "../domain/task-run.js";
import type { GateEvaluation } from "@tagent/governance/domain";
import type {
  AttemptExecutionToken,
  AttemptRuntimePort,
  RuntimeCapabilityCatalog,
  RuntimeEventSink,
  RuntimeMessage,
} from "../ports/attempt-runtime.js";

export interface RunEventPublisherPort {
  publish(event: RunEvent): void;
  updateCheckpoint(event: RunEvent): void;
  flushCheckpoint(runId: RunId): void;
}

export interface AttemptLauncherPort {
  launch(
    run: TaskRun,
    prompt: string,
    initialMessages?: RuntimeMessage[],
    continuationId?: string,
    launchOptions?: { initialize?: boolean; inboxItemId?: string; retry?: boolean },
  ): void;
}

export interface AttemptSettlementPort {
  execute(
    runId: RunId,
    token: AttemptExecutionToken,
    runtime: AttemptRuntimePort,
    prompt: string,
    continuationId?: string,
    onRuntimeSettled?: () => void,
  ): Promise<boolean>;
  projectWorkflowExperience(runId: RunId): void;
  recoverInterruptedAttempt(token: AttemptExecutionToken, reason: string, supervisorDecisionId?: string): boolean;
  isApprovedCanaryAttempt(token: AttemptExecutionToken): boolean;
}

export interface ContinuationControlPort {
  captureUserMessage(run: TaskRun, messageId: number, content: string, subjectId?: string): void;
  queueContinuation(runId: RunId): void;
  startQueuedContinuation(runId: RunId): void;
}

export interface RecoveryControlPort {
  repairTranscript(runId: RunId, reason: "cancelled" | "resume" | "continuation"): Array<{ toolCallId: string; toolName: string }>;
  recoverContinuations(): RunId[];
  scheduleContinuationRecovery(): void;
}

export interface RuntimeControlPort {
  abortRuntime(runtime: AttemptRuntimePort, runId?: RunId): Promise<void>;
}

export interface RuntimeHostFactoryPort {
  create(input: {
    token: AttemptExecutionToken;
    onActivity: () => void;
    onEvent: (event: RunEvent) => void;
    memorySubjectId: string;
  }): { capabilities: RuntimeCapabilityCatalog; eventSink: RuntimeEventSink };
}

export interface ControlCommandPort {
  enqueueControl(
    runId: RunId,
    kind: "steer" | "follow_up",
    instruction: string,
    requestId: string,
  ): Promise<{ status: string; item?: unknown }>;
}

export interface ExecutionMemoryAccess {
  subjectId: string;
  scopes: Array<{ type: "user" | "workspace" | "project" | "session"; id: string }>;
  purpose: "agent_recall" | "memory_admin" | "capture";
}

export interface PreparedExecutionContext {
  messages: RuntimeMessage[];
  droppedMessages: RuntimeMessage[];
  contextItems: ContextManifestItem[];
  stats: {
    source: "session" | "transcript";
    contextWindow: number;
    systemTokens: number;
    promptTokens: number;
    originalMessages: number;
    originalTurns: number;
    keptMessages: number;
    keptTurns: number;
    estimatedMessageTokens: number;
    compressedTurns: number;
    droppedTurns: number;
  };
  recalledMemory?: string;
  memoryContextItems?: ContextManifestItem[];
  projectContextItems?: ContextManifestItem[];
  projectContextHash?: string;
}

export type RunResumeOptions =
  | { approvalId: string; inputRequest?: never; actorId?: never; reason?: never }
  | { inputRequest: UserInputRequest; approvalId?: never; actorId?: never; reason?: never }
  | { actorId?: string; reason?: string; approvalId?: never; inputRequest?: never };

export interface RunContextPort {
  resume(runId: RunId, options?: RunResumeOptions): Promise<unknown>;
  buildSystemPrompt(run: TaskRun, recalledMemory?: string): string;
  requiresAsyncPreparation(): boolean;
  prepareContinuationTranscript(run: TaskRun, prompt: string): PreparedExecutionContext;
  prepareSessionHistory(run: TaskRun, query: string, excludeCurrentUserAfter?: number, signal?: AbortSignal): Promise<PreparedExecutionContext>;
  prepareSessionHistoryWithoutRecall(run: TaskRun, query: string, excludeCurrentUserAfter?: number): PreparedExecutionContext;
  publishContextEvents(runId: RunId, assembly: PreparedExecutionContext): void;
}

/** Cross-domain follow-up owned by the composition root, not by Execution. */
export interface PostAttemptPort {
  attemptFinalized(run: TaskRun): void;
  attemptLaunchFailed(input: { inboxItemId: string; runId: RunId; message: string }): void;
}

export interface AttemptProjectionPort {
  project(runId: RunId): void;
}

export interface ExecutionBackgroundWorkPort {
  start(): void;
}

export interface UserMessageObserverPort {
  observe(input: {
    run: TaskRun;
    messageId: number;
    content: string;
    context: string;
    subjectId?: string;
  }): void;
}

export interface ExecutionContextEnrichment {
  promptSection: string;
  contextItems: ContextManifestItem[];
}

export interface ContextEnrichmentPort {
  requiresAsyncPreparation(): boolean;
  enrich(run: TaskRun, query: string, signal?: AbortSignal): Promise<ExecutionContextEnrichment>;
  prepareWithoutRecall(run: TaskRun, query: string): ExecutionContextEnrichment;
  capturePrunedUserContext(run: TaskRun, messages: RuntimeMessage[]): void;
}

export interface SupervisorPort {
  reviewCheckpoint(runId: RunId, event: RunEvent): {
    id: string;
    action: string;
    instruction: string;
    attempt: number;
    checkpointSeq: number;
    reasonCode: string;
  } | undefined;
  reviewSettled(
    run: TaskRun,
    checkpointSeq: number,
    response: string,
    options?: { modelOutputTruncated?: boolean },
  ): Promise<{ decision: TaskRun["supervision"]["latestDecision"] & {}; gates: GateEvaluation[] }>;
  reviewAttemptFailure(run: TaskRun, checkpointSeq: number, error: string): Promise<NonNullable<TaskRun["supervision"]["latestDecision"]>>;
  recordReviewFailure(run: TaskRun, checkpointSeq: number, error: string): NonNullable<TaskRun["supervision"]["latestDecision"]>;
  markExecuted(id: string, status: "executed" | "superseded" | "failed", error?: string): unknown;
  isReviewError(error: unknown): boolean;
}
