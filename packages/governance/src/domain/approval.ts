export type ApprovalSource = "legacy_run" | "legacy_workflow";

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
  kind: "task_run" | "workflow";
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
export const LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE = "legacy_workflow_scope" as const;

export interface ApprovalReuse {
  mode: "one_time" | "reusable";
  maxUses: number | null;
  usedCount: number;
}

export type CanonicalApprovalAction =
  | "task_run.resume"
  | "task_run.start_parallel"
  | "task_run.execute_external"
  | "workflow.activate"
  | "workflow.revision.apply"
  | "workflow.canary.start"
  | "workflow.execute";

export const LEGACY_APPROVAL_ACTION_MAP = {
  resume_taskrun: "task_run.resume",
  start_parallel_taskrun: "task_run.start_parallel",
  execute_external_action: "task_run.execute_external",
  activate_workflow: "workflow.activate",
  apply_revision: "workflow.revision.apply",
  start_canary: "workflow.canary.start",
  execute_workflow: "workflow.execute",
} as const satisfies Record<string, CanonicalApprovalAction>;

export function canonicalApprovalAction(action: string): CanonicalApprovalAction | undefined {
  return (LEGACY_APPROVAL_ACTION_MAP as Record<string, CanonicalApprovalAction>)[action];
}

const legacyRunActions = new Set(["resume_taskrun", "start_parallel_taskrun", "execute_external_action"]);
const legacyWorkflowActions = new Set(["activate_workflow", "apply_revision", "start_canary", "execute_workflow"]);

export function canonicalApprovalActionForSource(
  source: ApprovalSource,
  action: string,
): CanonicalApprovalAction | undefined {
  const allowed = source === "legacy_run" ? legacyRunActions : legacyWorkflowActions;
  return allowed.has(action) ? canonicalApprovalAction(action) : undefined;
}

export function canonicalApprovalStatus(
  source: ApprovalSource,
  status: string,
  reuse?: Pick<ApprovalReuse, "maxUses" | "usedCount">,
): ApprovalStatus | undefined {
  if (source === "legacy_workflow" && status === "executed") return "consumed";
  const allowed = source === "legacy_run"
    ? ["pending", "approved", "rejected", "superseded", "consumed"]
    : ["pending", "approved", "rejected", "revoked", "expired"];
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

export const LEGACY_RUN_APPROVAL_DEFAULTS = {
  risk: "medium",
  expiresAt: null,
  reuse: { mode: "one_time", maxUses: 1, usedCount: 0 },
} as const satisfies Pick<Approval, "risk" | "expiresAt" | "reuse">;
