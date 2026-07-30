export type SessionId = string;
export type RunId = string;

export type RunStatus = "running" | "completed" | "blocked" | "interrupted" | "cancelled" | "failed";
export type RunPhase = "discover" | "plan" | "implement" | "verify" | "review" | "done" | "blocked";
export type PlanStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";
export type CheckStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";

export interface Session {
  id: SessionId;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: number;
  sessionId: SessionId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
}

export interface PlanItem {
  key: string;
  title: string;
  status: PlanStatus;
  required: boolean;
  position: number;
}

export interface RunCheck {
  key: string;
  title: string;
  status: CheckStatus;
  required: boolean;
  command: string;
  evidence: string;
  stale: boolean;
}

export interface Artifact {
  id: string;
  runId: RunId;
  kind: string;
  title: string;
  content: string;
  uri: string;
  createdAt: number;
}

export interface RunContinuation {
  id: string;
  runId: RunId;
  ordinal: number;
  status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  reason: string;
  error: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  leaseOwner: string;
  leaseUntil: number | null;
  heartbeatAt: number | null;
}

export interface TaskRun {
  id: RunId;
  sessionId: SessionId;
  requestId: string;
  status: RunStatus;
  phase: RunPhase;
  goal: string;
  gateRequired: boolean;
  blockedReason: string;
  lastEventSeq: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  attempt: number;
  resumedAt: number | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
  transcriptCount: number;
  continuations: RunContinuation[];
  plan: PlanItem[];
  checks: RunCheck[];
  artifacts: Artifact[];
  completionGate: CompletionGate;
}

export interface CompletionGate {
  passed: boolean;
  failures: Array<{ kind: string; key: string; reason: string }>;
}

export interface RunEvent {
  runId: RunId;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ChatEvent {
  type: "run.started" | "message.delta" | "message.completed" | "tool.started" | "tool.completed" | "run.completed" | "run.failed" | "run.cancelled" | "run.blocked";
  runId: RunId;
  data: Record<string, unknown>;
}
