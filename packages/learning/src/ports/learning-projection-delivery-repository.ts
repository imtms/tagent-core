import type {
  LearningProjectionCheckpoint,
  LearningProjectionConsumer,
  LearningProjectionDeliveryClaim,
} from "../domain/learning-projection.js";

export interface ClaimLearningProjectionInput {
  consumer: LearningProjectionConsumer;
  owner: string;
  leaseMs: number;
  timestamp: number;
}

export interface AcknowledgeLearningProjectionInput {
  claim: LearningProjectionDeliveryClaim;
  effectHash: string;
  timestamp: number;
}

export interface FailLearningProjectionInput {
  claim: LearningProjectionDeliveryClaim;
  timestamp: number;
}

export interface LearningProjectionDeliveryRepository {
  getCheckpoint(consumer: LearningProjectionConsumer): LearningProjectionCheckpoint | null;
  claimNext(input: ClaimLearningProjectionInput): LearningProjectionDeliveryClaim | null;
  acknowledge(input: AcknowledgeLearningProjectionInput): LearningProjectionCheckpoint | null;
  fail(input: FailLearningProjectionInput): boolean;
}
