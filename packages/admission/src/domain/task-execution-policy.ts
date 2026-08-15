export type TaskExecutionMode =
  | "exact_delivery"
  | "semantic_delivery"
  | "read_only_analysis"
  | "workspace_mutation"
  | "external_action";

export type TaskSideEffectRisk = "none" | "read_only" | "workspace" | "external_high";
export type TaskEvidencePolicy = "none" | "semantic" | "operation_receipt" | "trusted_check";
export type TaskReviewPolicy = "local" | "semantic_lite" | "full";
export type GateProfile = "off" | "relaxed" | "strict";

/** Admission-owned semantic policy proposal copied structurally across the launch boundary. */
export interface TaskExecutionPolicy {
  mode: TaskExecutionMode;
  sideEffectRisk: TaskSideEffectRisk;
  evidencePolicy: TaskEvidencePolicy;
  reviewPolicy: TaskReviewPolicy;
  policyVersion: string;
  confidence: number;
  reason: string;
  /** User-selected completion acceptance style. Missing values remain strict. */
  gateProfile?: GateProfile;
  /** Present only when the user explicitly requested one literal response. */
  exactOutput?: string;
}
