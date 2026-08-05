import type {
  SessionInputIntent,
  SessionInputRelation,
  TaskObjective,
} from "./session-input.js";

/** Admission decision copied into Execution as an immutable launch snapshot. */
export interface TaskRunContract {
  sourceInput: string;
  summary: string;
  objectives: TaskObjective[];
  acceptanceCriteria: string[];
  scope: string;
  nonGoals: string[];
  sourceInboxIds: string[];
  parentRunId: string | null;
  relation: SessionInputRelation;
  intent: SessionInputIntent;
  decisionReason: string;
  routerVersion: string;
}
