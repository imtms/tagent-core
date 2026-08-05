import type {
  LearningEffectReceipt,
  LearningProjectionConsumer,
} from "../domain/learning-projection.js";

export interface RecordLearningEffectReceiptInput {
  logicalConsumer: LearningProjectionConsumer;
  sourceEventId: string;
  effectHash: string;
  timestamp: number;
}

export interface LearningEffectRepository {
  get(logicalConsumer: LearningProjectionConsumer, sourceEventId: string): LearningEffectReceipt | null;
  record(input: RecordLearningEffectReceiptInput): LearningEffectReceipt;
}
