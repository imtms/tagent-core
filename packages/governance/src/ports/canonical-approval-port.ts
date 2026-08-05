import type {
  Approval,
  ApprovalRef,
  ApprovalSource,
  ApprovalStatus,
} from "../domain/index.js";

export type ApprovalProjectionReason =
  | "id_collision"
  | "invalid_json"
  | "legacy_field_conflict"
  | "missing_scope"
  | "missing_subject"
  | "missing_target"
  | "unknown_action"
  | "unknown_risk"
  | "unknown_status"
  | "run_approved_without_receipt"
  | "workflow_receipt_missing"
  | "workflow_receipt_mismatch"
  | "reuse_status_conflict"
  | "unknown_digest_version";

export type ApprovalProjection =
  | { state: "resolved"; approval: Approval }
  | {
    state: "unresolved";
    ref: ApprovalRef;
    legacyStatus: string;
    active: boolean;
    reasonCodes: ApprovalProjectionReason[];
  };

export type ApprovalIdResolution =
  | { state: "not_found"; id: string }
  | { state: "resolved"; ref: ApprovalRef }
  | { state: "conflict"; id: string; refs: [ApprovalRef, ApprovalRef] };

export interface ApprovalReadQuery {
  source: ApprovalSource;
  scope?: { type: string; id: string };
  status?: ApprovalStatus;
  limit?: number;
}

export interface CanonicalApprovalReadPort {
  get(ref: ApprovalRef): ApprovalProjection | undefined;
  resolveLegacyId(id: string): ApprovalIdResolution;
  list(query: ApprovalReadQuery): ApprovalProjection[];
}

export interface ApprovalShadowExpectation {
  ref: ApprovalRef;
  operationDigest: string;
  status: ApprovalStatus;
}

export type ApprovalShadowMismatch = "operation_digest" | "status";

export type ApprovalShadowComparison =
  | { state: "match"; approval: Approval }
  | { state: "mismatch"; approval: Approval; mismatches: ApprovalShadowMismatch[] }
  | Extract<ApprovalProjection, { state: "unresolved" }>;

export interface ApprovalUnresolvedQuery extends Omit<ApprovalReadQuery, "status"> {
  activeOnly?: boolean;
}

export interface ApprovalUnresolvedCursor {
  source: ApprovalSource;
  id: string;
}

export interface ApprovalUnresolvedPageQuery extends Omit<ApprovalUnresolvedQuery, "limit"> {
  cursor?: ApprovalUnresolvedCursor;
  pageSize?: number;
}

export interface ApprovalUnresolvedPage {
  items: Array<Extract<ApprovalProjection, { state: "unresolved" }>>;
  nextCursor: ApprovalUnresolvedCursor | null;
  hasMore: boolean;
}

export interface ApprovalUnresolvedSummary {
  total: number;
  active: number;
  bySource: Record<ApprovalSource, number>;
  activeBySource: Record<ApprovalSource, number>;
  byReason: Partial<Record<ApprovalProjectionReason, number>>;
}

export interface ApprovalShadowSummary {
  total: number;
  match: number;
  mismatch: number;
  unresolved: number;
  activeUnresolved: number;
  missing: number;
  comparisons: ApprovalShadowComparison[];
}

export interface CanonicalApprovalShadowPort {
  compare(expectation: ApprovalShadowExpectation): ApprovalShadowComparison | undefined;
  listUnresolvedPage(query: ApprovalUnresolvedPageQuery): ApprovalUnresolvedPage;
  summarizeAllUnresolved(): ApprovalUnresolvedSummary;
  summarizeComparisons(expectations: ApprovalShadowExpectation[]): ApprovalShadowSummary;
}
