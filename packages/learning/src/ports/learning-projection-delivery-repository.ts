import type {
  LearningProjectionCheckpoint,
  LearningProjectionAuthorityFence,
  LearningProjectionAuthoritySource,
  LearningProjectionConsumer,
  LearningProjectionDeliveryClaim,
  LearningProjectionDeliveryRole,
} from "../domain/learning-projection.js";

export interface ClaimShadowLearningProjectionInput {
  consumer: LearningProjectionConsumer;
  owner: string;
  leaseMs: number;
  timestamp: number;
}

export interface ClaimActiveLearningProjectionInput {
  consumer: LearningProjectionConsumer;
  source: LearningProjectionAuthoritySource;
  authority: LearningProjectionAuthorityFence;
  owner: string;
  leaseMs: number;
  timestamp: number;
}

export interface AcknowledgeActiveLearningProjectionInput {
  claim: LearningProjectionDeliveryClaim;
  effectHash: string;
  timestamp: number;
}

export interface FailActiveLearningProjectionInput {
  claim: LearningProjectionDeliveryClaim;
  timestamp: number;
}

export interface LearningProjectionDeliveryRepository {
  getCheckpoint(
    consumer: LearningProjectionConsumer,
    deliveryRole: LearningProjectionDeliveryRole,
  ): LearningProjectionCheckpoint | null;
  claimNextShadow(input: ClaimShadowLearningProjectionInput): LearningProjectionDeliveryClaim | null;
  claimNextActive(input: ClaimActiveLearningProjectionInput): LearningProjectionDeliveryClaim | null;
  acknowledgeActive(input: AcknowledgeActiveLearningProjectionInput): LearningProjectionCheckpoint | null;
  failActive(input: FailActiveLearningProjectionInput): boolean;
}
