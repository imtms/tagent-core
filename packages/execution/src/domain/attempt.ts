export type AttemptId = string & { readonly __attemptId: unique symbol };

export type AttemptTrigger =
  | "initial"
  | "resume"
  | "continuation"
  | "retry"
  | "input"
  | "recovery"
  | "legacy_backfill";

export const ATTEMPT_STATUSES = Object.freeze([
  "legacy_unknown",
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

export type AttemptReconstructionState = "complete" | "legacy_unknown";

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = Object.freeze({
  legacy_unknown: [],
  queued: ["starting", "failed", "cancelled", "interrupted"],
  starting: ["running", "failed", "cancelled", "interrupted"],
  running: ["settling", "waiting_input", "blocked", "failed", "cancelled", "interrupted"],
  settling: ["completed", "blocked", "failed", "cancelled", "interrupted"],
  waiting_input: [],
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
  legacyEventSeq: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  reconstructionState: AttemptReconstructionState;
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

export interface AttemptTransitionAudit {
  id: string;
  attemptId: AttemptId;
  runId: string;
  ordinal: number;
  fromStatus: AttemptStatus | null;
  toStatus: AttemptStatus;
  trigger: AttemptTrigger;
  scenario: string;
  reason: string;
  version: number;
  legacyEventSeq: number;
  createdAt: number;
}

export interface AttemptShadowComparison {
  id: string;
  attemptId: AttemptId;
  scenario: string;
  legacy: Record<string, unknown>;
  projected: Record<string, unknown>;
  mismatch: boolean;
  createdAt: number;
}

export function attemptIdFor(runId: string, ordinal: number): AttemptId {
  if (!runId.trim()) throw new TypeError("Attempt runId is required");
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new TypeError("Attempt ordinal must be a positive safe integer");
  return `attempt:${runId}:${ordinal}` as AttemptId;
}
