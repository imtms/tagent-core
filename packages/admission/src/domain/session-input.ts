/** Durable classification produced at the Admission boundary. */
export type SessionInputIntent =
  | "steer_active"
  | "follow_up_active"
  | "update_active_context"
  | "new_task"
  | "parallel_task"
  | "merge_candidate"
  | "discussion"
  | "clarification"
  | "defer";

export type TaskObjectiveTiming = "current" | "follow_up" | "parallel";

export type TaskObjectiveKind =
  | "change"
  | "investigate"
  | "verify"
  | "document"
  | "release"
  | "answer"
  | "other";

export interface TaskObjective {
  id: string;
  summary: string;
  timing: TaskObjectiveTiming;
  kind: TaskObjectiveKind;
}

export type SessionInputRelation =
  | "same_goal"
  | "correction"
  | "constraint"
  | "follow_up"
  | "parallel"
  | "derived"
  | "depends_on"
  | "independent";

export interface SessionInputAnalysis {
  summary: string;
  objectives: TaskObjective[];
  intent: SessionInputIntent;
  targetRunId: string | null;
  priority: number;
  urgency: "low" | "normal" | "high" | "critical";
  relation: SessionInputRelation;
  acceptanceCriteria: string[];
  scope: string;
  nonGoals: string[];
  confidence: number;
  reason: string;
  routerVersion: string;
}
