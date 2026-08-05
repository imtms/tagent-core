import type {
  IntegrationLearningProjectionRecord,
  LearningProjectionCheckpoint,
  LearningProjectionDeliveryClaim,
  LearningProjectionReconciliation,
  LegacyLearningProjectionRecord,
} from "../domain/learning-projection.js";

export interface LearningProjectionPair {
  legacy: LegacyLearningProjectionRecord | null;
  integration: IntegrationLearningProjectionRecord | null;
}

export interface CompleteShadowLearningProjectionInput {
  claim: LearningProjectionDeliveryClaim;
  result: LearningProjectionReconciliation;
  timestamp: number;
}

export interface LearningProjectionReconciliationRepository {
  getProjectionPair(outboxSequence: number): LearningProjectionPair;
  completeShadowClaim(input: CompleteShadowLearningProjectionInput): LearningProjectionCheckpoint | null;
  getContiguousWatermark(): number;
}
