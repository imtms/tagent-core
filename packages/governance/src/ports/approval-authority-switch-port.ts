import type { GovernanceApprovalAuthoritySwitchEvidence } from "../domain/index.js";

/**
 * Supplies a complete production evidence snapshot to the pure Governance
 * approval-authority switch evaluator. It does not select or mutate authority.
 */
export interface GovernanceApprovalAuthoritySwitchEvidencePort {
  readGovernanceApprovalAuthoritySwitchEvidence(): GovernanceApprovalAuthoritySwitchEvidence;
}
