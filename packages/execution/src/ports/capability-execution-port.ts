import type {
  ApprovalRef,
  CanonicalJsonValue,
  CapabilityCommand,
} from "@tagent/governance/domain";

/** Attempt-scoped authority required for every capability state mutation. */
export interface CapabilityExecutionFence {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly leaseToken: string;
  readonly executionFence: number;
}

/**
 * Consumer input intentionally excludes run/attempt ordinals, operation type,
 * hashes, operation IDs, and receipt IDs. The persistence adapter derives and
 * verifies those values from the immutable command and Attempt fence.
 */
export interface CapabilityExecutionRequest {
  readonly command: CapabilityCommand;
  readonly fence: CapabilityExecutionFence;
  readonly approvalRef: ApprovalRef;
  readonly actorId: string;
  readonly details: CanonicalJsonValue;
}

export type CapabilityExecutionStatus =
  | "authorized"
  | "running"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled";

export type CapabilityExecutionAuthorization =
  | { readonly kind: "approval"; readonly approvalRef: ApprovalRef }
  | { readonly kind: "grant"; readonly grantId: string };

export interface CapabilityExecutionState {
  readonly commandId: string;
  readonly status: CapabilityExecutionStatus;
  readonly authorization: CapabilityExecutionAuthorization;
  readonly result?: CanonicalJsonValue;
  readonly error: string;
}

export type CapabilityEffectSettlement =
  | { readonly status: "succeeded"; readonly result: CanonicalJsonValue }
  | { readonly status: "failed"; readonly error: string };

export interface CapabilityEffectBeginResult {
  readonly state: CapabilityExecutionState;
  /** True only for the single authorized -> running compare-and-set winner. */
  readonly started: boolean;
}

/** Writer-fenced, Attempt-bound persistence state machine. */
export interface CapabilityExecutionPersistencePort {
  authorizeAndClaim(request: CapabilityExecutionRequest): CapabilityExecutionState;
  beginEffect(request: CapabilityExecutionRequest): CapabilityEffectBeginResult;
  settleEffect(
    request: CapabilityExecutionRequest,
    settlement: CapabilityEffectSettlement,
  ): CapabilityExecutionState;
  markOutcomeUnknown(
    request: CapabilityExecutionRequest,
    input: { readonly error: string },
  ): CapabilityExecutionState;
}

/** External effects are asynchronous and always run outside SQLite transactions. */
export interface CapabilityEffectPort {
  execute(command: CapabilityCommand): Promise<CanonicalJsonValue>;
}
