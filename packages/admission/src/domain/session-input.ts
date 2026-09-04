import type { TaskExecutionPolicy } from "./task-execution-policy.js";

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

export interface SessionInputRoutingUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** Durable, non-semantic provenance for how Core produced one routing decision. */
export interface SessionInputRoutingProvenance {
  decisionSource: "deterministic" | "model" | "fallback";
  sourceHash: string;
  sourceChars: number;
  projectionStrategy: "not_sent" | "full" | "head_tail";
  projectedChars: number;
  promptEstimatedTokens: number;
  inputBudgetTokens: number | null;
  modelAttempted: boolean;
  modelSucceeded: boolean;
  usage: SessionInputRoutingUsage[];
  abstention: "none" | "new_task_low_confidence" | "active_control_low_confidence";
  detail?: string;
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
  executionPolicy?: TaskExecutionPolicy;
  routingProvenance?: SessionInputRoutingProvenance;
}
