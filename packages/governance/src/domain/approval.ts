export type ApprovalSource = "run";

export interface ApprovalRef {
  source: ApprovalSource;
  id: string;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired"
  | "consumed"
  | "superseded";

export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalSubject {
  kind: "task_run";
  id: string;
}

export interface ApprovalTarget {
  kind: string;
  id: string;
}

export interface ApprovalScope {
  type: string;
  id: string;
}

export const RUN_APPROVAL_SCOPE_TYPE = "session" as const;

export interface ApprovalReuse {
  mode: "one_time" | "reusable";
  maxUses: number | null;
  usedCount: number;
}

export type CanonicalApprovalAction =
  | "task_run.resume"
  | "task_run.start_parallel"
  | "task_run.execute_external";

export const APPROVAL_ACTION_MAP = {
  resume_taskrun: "task_run.resume",
  start_parallel_taskrun: "task_run.start_parallel",
  execute_external_action: "task_run.execute_external",
} as const satisfies Record<string, CanonicalApprovalAction>;

export function canonicalApprovalAction(action: string): CanonicalApprovalAction | undefined {
  return (APPROVAL_ACTION_MAP as Record<string, CanonicalApprovalAction>)[action];
}

const runApprovalActions = new Set(["resume_taskrun", "start_parallel_taskrun", "execute_external_action"]);

export function canonicalApprovalActionForSource(
  source: ApprovalSource,
  action: string,
): CanonicalApprovalAction | undefined {
  return source === "run" && runApprovalActions.has(action) ? canonicalApprovalAction(action) : undefined;
}

export function canonicalApprovalStatus(
  source: ApprovalSource,
  status: string,
  reuse?: Pick<ApprovalReuse, "maxUses" | "usedCount">,
): ApprovalStatus | undefined {
  const allowed = ["pending", "approved", "rejected", "superseded", "consumed"];
  if (!allowed.includes(status)) return undefined;
  if (status === "approved" && reuse && reuse.maxUses !== null
    && reuse.usedCount >= reuse.maxUses) return "consumed";
  return status as ApprovalStatus;
}

export interface Approval {
  ref: ApprovalRef;
  subject: ApprovalSubject;
  action: CanonicalApprovalAction;
  target: ApprovalTarget;
  scope: ApprovalScope;
  operationDigest: string;
  risk: ApprovalRisk;
  reuse: ApprovalReuse;
  status: ApprovalStatus;
  expiresAt: number | null;
  requestedBy: string;
  decidedBy: string | null;
  reason: string;
  decisionReason: string;
  requestedAt: number;
  decidedAt: number | null;
}

export const RUN_APPROVAL_DEFAULTS = {
  risk: "medium",
  expiresAt: null,
  reuse: { mode: "one_time", maxUses: 1, usedCount: 0 },
} as const satisfies Pick<Approval, "risk" | "expiresAt" | "reuse">;
