import type {
  LearningProjectionAuthorityFence,
  LearningProjectionAuthorityLease,
  LearningProjectionAuthoritySource,
  LearningProjectionAuthorityState,
} from "../domain/learning-projection.js";

export interface AcquireLearningProjectionAuthorityInput {
  source: LearningProjectionAuthoritySource;
  owner: string;
  leaseMs: number;
  timestamp: number;
}

export interface RenewLearningProjectionAuthorityInput {
  fence: LearningProjectionAuthorityFence;
  leaseMs: number;
  timestamp: number;
}

export interface ReleaseLearningProjectionAuthorityInput {
  fence: LearningProjectionAuthorityFence;
}

export interface PrepareLearningProjectionCutoverInput {
  fence: LearningProjectionAuthorityFence;
  switchWatermark: number;
  timestamp: number;
}

export interface RotateLearningProjectionAuthorityInput {
  fence: LearningProjectionAuthorityFence;
  leaseMs: number;
  timestamp: number;
}

export interface PrepareLearningProjectionRollbackInput {
  fence: LearningProjectionAuthorityFence;
  timestamp: number;
}

export interface LearningProjectionAuthorityRepository {
  getState(): LearningProjectionAuthorityState;
  acquire(input: AcquireLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null;
  renew(input: RenewLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null;
  release(input: ReleaseLearningProjectionAuthorityInput): LearningProjectionAuthorityState | null;
  prepareCutover(input: PrepareLearningProjectionCutoverInput): LearningProjectionAuthorityLease | null;
  activateIntegration(input: RotateLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null;
  prepareRollback(input: PrepareLearningProjectionRollbackInput): LearningProjectionAuthorityLease | null;
  activateLegacy(input: RotateLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null;
}
