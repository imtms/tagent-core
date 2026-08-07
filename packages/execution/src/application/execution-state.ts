import { randomUUID } from "node:crypto";
import type { AttemptExecutionToken, AttemptRuntimeFactory, AttemptRuntimePort } from "../ports/attempt-runtime.js";
import type { RunCheckpoint, RunEvent, RunId } from "../domain/task-run.js";
import type { ExecutionPersistencePort } from "../ports/execution-persistence.js";

export interface ExecutionCoordinatorStartupOptions {
  startupMode?: "automatic" | "deferred";
}

export type ExecutionRuntimeDefaults = Pick<
  Parameters<AttemptRuntimeFactory>[0],
  | "model"
  | "fallbackModels"
  | "apiKey"
  | "providerTimeoutMs"
  | "providerMaxRetries"
  | "runTimeoutMs"
  | "runHardTimeoutMs"
> & {
  maxContinuations?: number;
  contextWindow?: number;
  maxContextTurns?: number;
  historicalToolResultChars?: number;
  historicalTaskRunReceiptChars?: number;
  controlInboxCapacity?: number;
  executionLeaseMs?: number;
  executionLeaseHeartbeatMs?: number;
};

export interface ExecutionStateOptions {
  persistence: ExecutionPersistencePort;
  workspace: string;
  runtimeFactory: AttemptRuntimeFactory;
  runtimeDefaults: ExecutionRuntimeDefaults;
}

/** Compile-time capability view used to keep process state and repository access explicit. */
export type ExecutionStateView<
  Key extends keyof ExecutionState,
  PersistenceKey extends keyof ExecutionPersistencePort = never,
> = Pick<ExecutionState, Exclude<Key, "persistence">>
  & ("persistence" extends Key
    ? { readonly persistence: Pick<ExecutionPersistencePort, PersistenceKey> }
    : unknown);

/** Mutable process-local execution state shared by explicitly composed application services. */
export class ExecutionState {
  readonly runtimes = new Map<RunId, AttemptRuntimePort>();
  readonly executionTasks = new Map<RunId, Promise<void>>();
  readonly controlDeliveryTasks = new Map<RunId, Promise<void>>();
  readonly checkpointDrafts = new Map<RunId, Omit<RunCheckpoint, "updatedAt" | "lastTranscriptSeq">>();
  readonly checkpointTokens = new Map<RunId, AttemptExecutionToken>();
  readonly checkpointTimers = new Map<RunId, ReturnType<typeof setTimeout>>();
  readonly lastCheckpointTranscriptSeq = new Map<RunId, number>();
  readonly listeners = new Map<RunId, Set<(event: RunEvent) => void>>();
  readonly recalledMemory = new Map<RunId, string>();
  readonly continuationOwner = randomUUID();
  readonly executionOwner = randomUUID();
  continuationRecoveryTimer?: ReturnType<typeof setTimeout>;
  supervisorRestartReconciled = false;
  closing = false;
  initialized = false;
  backgroundWorkStarted = false;

  readonly persistence: ExecutionPersistencePort;
  readonly workspace: string;
  readonly runtimeFactory: AttemptRuntimeFactory;
  readonly runtimeDefaults: ExecutionRuntimeDefaults;

  constructor(options: ExecutionStateOptions) {
    this.persistence = options.persistence;
    this.workspace = options.workspace;
    this.runtimeFactory = options.runtimeFactory;
    this.runtimeDefaults = options.runtimeDefaults;
  }
}
