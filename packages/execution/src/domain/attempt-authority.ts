import type { AttemptId } from "./attempt.js";

export const ATTEMPT_AUTHORITY_SCENARIOS = Object.freeze([
  "initial",
  "resume",
  "continuation",
  "retry",
  "input",
  "recovery",
  "terminal",
] as const);

export type AttemptAuthorityScenario = (typeof ATTEMPT_AUTHORITY_SCENARIOS)[number];
/** `canary` approves only one Attempt token; it never claims a process-wide production authority switch. */
export type AttemptAuthorityMode = "shadow" | "canary";
export type AttemptAuthorityStatus = "blocked" | "approved";

export interface AttemptAuthorityState {
  mode: AttemptAuthorityMode;
  status: AttemptAuthorityStatus;
  approvedAttemptId: AttemptId | null;
  receiptId: string | null;
  sampleCount: number;
  mismatchCount: number;
  scenarioCoverage: AttemptAuthorityScenario[];
  /** Exclusive comparison rowid floor established by an explicit Governance rollback/reset receipt. */
  comparisonEpochStart: number;
  comparisonWatermark: number;
  lastMismatchId: string | null;
  updatedAt: number;
}

export interface AttemptAuthorityReceipt {
  id: string;
  requestedAttemptId: AttemptId;
  decision: "approved" | "rejected" | "rollback";
  actor: string;
  reason: string;
  createdAt: number;
}

export interface AttemptAuthorityGate {
  eligible: boolean;
  sampleCount: number;
  mismatchCount: number;
  scenarioCoverage: AttemptAuthorityScenario[];
  missingScenarios: AttemptAuthorityScenario[];
  comparisonWatermark: number;
  lastMismatchId: string | null;
  reasons: string[];
}
