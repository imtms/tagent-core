import type {
  DecodedLearningProjection,
} from "../domain/learning-projection.js";

export interface ApplyActiveLearningProjectionEffectInput {
  source: "integration";
  outboxSequence: number;
  sourceEventId: string;
  effectHash: string;
  projection: DecodedLearningProjection;
}

/** Runs synchronously inside the Learning projection writer UnitOfWork. */
export interface ActiveLearningProjectionEffectApplier {
  apply(input: ApplyActiveLearningProjectionEffectInput): void;
}
