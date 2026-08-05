import type Database from "better-sqlite3";
import type { LearningEffectReceipt } from "@tagent/learning/domain";
import type {
  LearningEffectRepository,
  RecordLearningEffectReceiptInput,
} from "@tagent/learning/ports";

function assertMutationTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw new Error("Learning effect receipt mutation requires a writer-fenced transaction");
  }
}

function assertIdentity(logicalConsumer: string, sourceEventId: string): void {
  if (!logicalConsumer) throw new TypeError("Learning effect logicalConsumer is required");
  if (!sourceEventId) throw new TypeError("Learning effect sourceEventId is required");
}

export class SqliteLearningEffectRepository implements LearningEffectRepository {
  constructor(private readonly db: Database.Database) {}

  get(
    logicalConsumer: Parameters<LearningEffectRepository["get"]>[0],
    sourceEventId: string,
  ): LearningEffectReceipt | null {
    assertIdentity(logicalConsumer, sourceEventId);
    return this.db.prepare(`SELECT logical_consumer as logicalConsumer,
      source_event_id as sourceEventId,effect_hash as effectHash,committed_at as committedAt
      FROM effect_receipts WHERE logical_consumer=? AND source_event_id=?`)
      .get(logicalConsumer, sourceEventId) as LearningEffectReceipt | undefined ?? null;
  }

  record(input: RecordLearningEffectReceiptInput): LearningEffectReceipt {
    assertMutationTransaction(this.db);
    assertIdentity(input.logicalConsumer, input.sourceEventId);
    if (!input.effectHash) throw new TypeError("Learning effect hash is required");
    if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
      throw new TypeError("Learning effect timestamp is invalid");
    }
    const existing = this.get(input.logicalConsumer, input.sourceEventId);
    if (existing) {
      if (existing.effectHash !== input.effectHash) {
        throw new Error(`Learning effect receipt conflict for ${input.sourceEventId}`);
      }
      return existing;
    }
    this.db.prepare(`INSERT INTO effect_receipts
      (logical_consumer,source_event_id,effect_hash,committed_at) VALUES (?,?,?,?)`)
      .run(input.logicalConsumer, input.sourceEventId, input.effectHash, input.timestamp);
    return this.get(input.logicalConsumer, input.sourceEventId)!;
  }
}
