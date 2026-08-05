export type SessionId = string;
export type SessionRunStatusView = "running" | "waiting_input" | "completed" | "blocked" | "interrupted" | "cancelled" | "failed";
export type SessionRunPhaseView = "discover" | "plan" | "implement" | "verify" | "review" | "waiting_input" | "done" | "blocked";

export interface Session {
  id: SessionId;
  title: string;
  createdAt: number;
  updatedAt: number;
  latestRunStatus: SessionRunStatusView | null;
  latestRunPhase: SessionRunPhaseView | null;
}

export interface Message {
  id: number;
  sessionId: SessionId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
}
