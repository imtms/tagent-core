import type {
  Artifact,
  CompletionGate,
  PlanItem,
  RunCheck,
  SupervisorDecision,
} from "../domain/index.js";

export interface GovernanceRunEventView {
  runId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface GovernanceProgressRunView {
  id: string;
  attempt: number;
}

export interface GovernanceCompletionRunView {
  gateRequired: boolean;
  contract: {
    intent: string;
    objectives: Array<{ id: string; summary: string; timing: string; kind: string }>;
    acceptanceCriteria: string[];
    nonGoals: string[];
  } | null;
  plan: PlanItem[];
  checks: RunCheck[];
}

export interface GovernanceTaskRunView extends GovernanceCompletionRunView, GovernanceProgressRunView {
  status: string;
  goal: string;
  lastEventSeq: number;
  contract: {
    summary: string;
    scope: string;
    intent: string;
    relation: string;
    objectives: Array<{ id: string; summary: string; timing: string; kind: string }>;
    acceptanceCriteria: string[];
    nonGoals: string[];
  } | null;
  artifacts: Artifact[];
  completionGate: CompletionGate;
  supervision: {
    latestDecision: SupervisorDecision | null;
  };
}

export interface GovernanceControlInboxItemView {
  attempt: number;
  status: string;
}

export interface GovernanceContextManifestView {
  id: string;
  runId: string;
  attempt: number;
  source: "session" | "transcript";
  items: Array<{
    kind:
      | "system_prompt"
      | "taskrun_contract"
      | "session_message"
      | "transcript_message"
      | "core_memory"
      | "memory_card"
      | "cold_topic"
      | "workflow_revision"
      | "communication_profile"
      | "project_rule"
      | "user_prompt";
    sourceId: string;
    role?: string;
    selected: boolean;
    reason: string;
    estimatedTokens: number;
    metadata?: Record<string, unknown>;
  }>;
  stats: Record<string, number | string>;
  manifestHash: string;
  createdAt: number;
}
