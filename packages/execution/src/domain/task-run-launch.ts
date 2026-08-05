export type TaskRunObjectiveTiming = "current" | "follow_up" | "parallel";
export type TaskRunObjectiveKind = "change" | "investigate" | "verify" | "document" | "release" | "answer" | "other";
export type TaskRunContractRelation = "same_goal" | "correction" | "constraint" | "follow_up" | "parallel" | "derived" | "depends_on" | "independent";
export type TaskRunIntent = "steer_active" | "follow_up_active" | "update_active_context" | "new_task" | "parallel_task" | "merge_candidate" | "discussion" | "clarification" | "defer";

export interface TaskRunObjectiveSnapshot {
  id: string;
  summary: string;
  timing: TaskRunObjectiveTiming;
  kind: TaskRunObjectiveKind;
}

/** Immutable Admission decision copied into the durable Execution aggregate. */
export interface TaskRunContractSnapshot {
  sourceInput: string;
  summary: string;
  objectives: TaskRunObjectiveSnapshot[];
  acceptanceCriteria: string[];
  scope: string;
  nonGoals: string[];
  sourceInboxIds: string[];
  parentRunId: string | null;
  relation: TaskRunContractRelation;
  intent: TaskRunIntent;
  decisionReason: string;
  routerVersion: string;
}

/** Admission-facing command contract. Execution owns this persisted launch representation. */
export interface TaskRunLaunchSpec {
  sessionRef: string;
  goal: string;
  requestId: string;
  contract: TaskRunContractSnapshot | null;
}
