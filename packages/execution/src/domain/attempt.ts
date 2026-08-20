export type AttemptId = string & { readonly __attemptId: unique symbol };

export type AttemptTrigger =
  | "initial"
  | "resume"
  | "continuation"
  | "retry"
  | "input"
  | "recovery";

export const ATTEMPT_STATUSES = Object.freeze([
  "queued",
  "starting",
  "running",
  "settling",
  "waiting_input",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "superseded",
] as const);

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type TerminalAttemptStatus = "completed" | "blocked" | "failed" | "cancelled";

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = Object.freeze({
  queued: ["starting", "failed", "cancelled", "interrupted"],
  starting: ["running", "failed", "cancelled", "interrupted"],
  running: ["settling", "waiting_input", "blocked", "failed", "cancelled", "interrupted"],
  settling: ["completed", "blocked", "failed", "cancelled", "interrupted"],
  waiting_input: ["blocked"],
  blocked: [],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  superseded: [],
});

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!canTransitionAttempt(from, to)) throw new Error(`Attempt cannot transition from ${from} to ${to}`);
}

export function isActiveAttemptStatus(status: AttemptStatus): boolean {
  return status === "queued" || status === "starting" || status === "running" || status === "settling";
}

export interface Attempt {
  id: AttemptId;
  runId: string;
  ordinal: number;
  trigger: AttemptTrigger;
  status: AttemptStatus;
  active: boolean;
  version: number;
  eventSequence: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ExecutionLease {
  attemptId: AttemptId;
  ownerId: string;
  token: string;
  fence: number;
  attemptVersion: number;
  leaseUntil: number;
  heartbeatAt: number;
  releasedAt: number | null;
}

export interface CandidateResult {
  id: string;
  attemptId: AttemptId;
  attemptVersion: number;
  response: string;
  responseHash: string;
  status: "proposed" | "accepted" | "rejected";
  createdAt: number;
  settledAt: number | null;
}

export function attemptIdFor(runId: string, ordinal: number): AttemptId {
  if (!runId.trim()) throw new TypeError("Attempt runId is required");
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new TypeError("Attempt ordinal must be a positive safe integer");
  return `attempt:${runId}:${ordinal}` as AttemptId;
}
