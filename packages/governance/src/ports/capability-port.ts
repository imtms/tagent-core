import type {
  ApprovalRef,
  AuthorizationReceipt,
  CapabilityCommand,
  CapabilityGrant,
  CanonicalJsonValue,
  PolicyDecision,
} from "../domain/index.js";

export interface CapabilityGrantReadPort {
  listApplicable(command: CapabilityCommand): CapabilityGrant[];
}

export interface CapabilityPolicyPort {
  evaluate(input: { command: CapabilityCommand; grants: CapabilityGrant[] }): PolicyDecision;
}

export interface AuthorizationReceiptReadPort {
  get(id: string): AuthorizationReceipt | undefined;
  listByOperationDigest(operationDigest: string): AuthorizationReceipt[];
}

export interface AuthorizedOperationClaim {
  id: string;
  runId: string;
  attempt: number;
  operationType: string;
}

export interface ApprovalAuthorizationReceiptInput {
  id: string;
  actorId: string;
  details: CanonicalJsonValue;
}

export interface ApprovalAuthorizationTransactionInput {
  approvalRef: ApprovalRef;
  operationDigest: string;
  operation: AuthorizedOperationClaim;
  receipt: ApprovalAuthorizationReceiptInput;
}

export interface ApprovalUseCommit {
  ref: ApprovalRef;
  usedCount: number;
  maxUses: number | null;
}

export interface ApprovalAuthorizationCommit {
  approvalUse: ApprovalUseCommit;
  operation: { id: string; claimed: boolean };
  receipt: AuthorizationReceipt;
}

/**
 * Commits approval usage, operation claim, and the authorization receipt as one
 * storage transaction. Implementations must reject stale writer authority.
 */
export interface CapabilityAuthorizationTransactionPort {
  commitApprovalAuthorization(input: ApprovalAuthorizationTransactionInput): ApprovalAuthorizationCommit;
}
