import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  CommunicationProfileRecord,
  CommunicationRevisionRecord,
  CommunicationRevisionWrite,
  FeedbackAttributionReceiptWrite,
  FeedbackAttributionWorkItem,
  LearningEventWrite,
  LearningLedgerRepository,
  LearningToolAttemptRow,
} from "@tagent/learning/ports";

export class SqliteLearningLedgerRepository implements LearningLedgerRepository {
  constructor(private readonly db: Database.Database) {}

  updateCommunicationProfile(
    identity: { id: string; subjectId: string; storedSubjectId?: string; scopeType: string; scopeId: string; storedScopeId?: string; timestamp: number },
    update: (profile: { id: string; activeRevisionId: string | null; locked: boolean }, previous: CommunicationRevisionRecord | undefined) => CommunicationRevisionWrite | undefined,
  ): CommunicationProfileRecord {
    return this.db.transaction(() => {
      let profile = this.db.prepare(`SELECT id,active_revision_id as activeRevisionId,locked FROM communication_profiles
        WHERE subject_id=? AND scope_type=? AND scope_id=? AND status='active'`).get(
        identity.subjectId,
        identity.scopeType,
        identity.scopeId,
      ) as { id: string; activeRevisionId: string | null; locked: number } | undefined;
      if (!profile) {
        profile = { id: identity.id, activeRevisionId: null, locked: 0 };
        this.db.prepare(`INSERT INTO communication_profiles
          (id,subject_id,scope_type,scope_id,status,created_at,updated_at)
          VALUES (?,?,?,?,'active',?,?)`).run(
          profile.id,
          identity.storedSubjectId ?? identity.subjectId,
          identity.scopeType,
          identity.storedScopeId ?? identity.scopeId,
          identity.timestamp,
          identity.timestamp,
        );
      }
      const previous = profile.activeRevisionId ? this.getCommunicationRevision(profile.activeRevisionId) : undefined;
      const revision = update({ ...profile, locked: Boolean(profile.locked) }, previous);
      if (revision) {
        const ordinal = (this.db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM communication_profile_revisions WHERE profile_id=?")
          .get(profile.id) as { revision: number }).revision + 1;
        const revisionId = randomUUID();
        this.db.prepare(`INSERT INTO communication_profile_revisions
          (id,profile_id,revision,values_json,evidence_json,source_type,change_summary,created_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          revisionId,
          profile.id,
          ordinal,
          revision.valuesJson,
          revision.evidenceJson,
          revision.sourceType,
          revision.changeSummary,
          identity.timestamp,
        );
        this.db.prepare("UPDATE communication_profiles SET active_revision_id=?,updated_at=? WHERE id=?")
          .run(revisionId, identity.timestamp, profile.id);
      }
      return this.getCommunicationProfile(profile.id)!;
    })();
  }

  findCommunicationProfile(subjectId: string, scopeType: string, scopeId: string) {
    return this.db.prepare(`SELECT id,active_revision_id as activeRevisionId FROM communication_profiles
      WHERE subject_id=? AND scope_type=? AND scope_id=? AND status='active' AND deleted_at IS NULL`)
      .get(subjectId, scopeType, scopeId) as Pick<CommunicationProfileRecord, "id" | "activeRevisionId"> | undefined;
  }

  setCommunicationProfileLocked(profileId: string, locked: boolean, timestamp: number): void {
    this.db.prepare("UPDATE communication_profiles SET locked=?,updated_at=? WHERE id=?")
      .run(Number(locked), timestamp, profileId);
  }

  listCommunicationProfileIds(subjectId: string): string[] {
    return (this.db.prepare(`SELECT id FROM communication_profiles WHERE subject_id=?
      AND deleted_at IS NULL ORDER BY updated_at DESC`).all(subjectId) as Array<{ id: string }>).map((row) => row.id);
  }

  getCommunicationProfile(id: string): CommunicationProfileRecord | undefined {
    const row = this.db.prepare(`SELECT id,subject_id as subjectId,scope_type as scopeType,scope_id as scopeId,status,
      active_revision_id as activeRevisionId,locked,created_at as createdAt,updated_at as updatedAt
      FROM communication_profiles WHERE id=?`).get(id) as (Omit<CommunicationProfileRecord, "locked"> & { locked: number }) | undefined;
    return row ? { ...row, locked: Boolean(row.locked) } : undefined;
  }

  getCommunicationRevision(id: string): CommunicationRevisionRecord | undefined {
    return this.db.prepare(`SELECT id,profile_id as profileId,revision,values_json as valuesJson,
      evidence_json as evidenceJson,source_type as sourceType,change_summary as changeSummary,
      created_at as createdAt FROM communication_profile_revisions WHERE id=?`).get(id) as CommunicationRevisionRecord | undefined;
  }

  recordCorrection(input: Record<string, unknown> & { id: string; idempotencyKey: string; createdAt: number }): unknown {
    this.db.prepare(`INSERT OR IGNORE INTO user_corrections
      (id,session_id,run_id,attempt,message_id,correction_type,target_type,target_id,content,source,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.id, input.sessionId, input.runId, input.attempt, input.messageId, input.correctionType,
      input.targetType, input.targetId, input.content, input.source, input.idempotencyKey, input.createdAt,
    );
    return this.db.prepare("SELECT * FROM user_corrections WHERE idempotency_key=?").get(input.idempotencyKey);
  }

  listLearningToolAttempts(runId: string, attempt: number): LearningToolAttemptRow[] {
    return this.db.prepare(`SELECT tool_name as toolName,args_hash as argsHash,status FROM tool_attempts
      WHERE run_id=? AND attempt=? ORDER BY id`).all(runId, attempt) as LearningToolAttemptRow[];
  }

  countRunCorrections(runId: string, attempt: number): number {
    return (this.db.prepare(`SELECT COUNT(*) count FROM user_corrections
      WHERE run_id=? AND (attempt=? OR attempt IS NULL)`).get(runId, attempt) as { count: number }).count;
  }

  getRunLearningPolicyRecord(runId: string): { policy: string; reason: string } | undefined {
    return this.db.prepare("SELECT policy,reason FROM run_learning_policies WHERE run_id=?").get(runId) as { policy: string; reason: string } | undefined;
  }

  recordLearningEvent(input: LearningEventWrite): string {
    return this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO learning_events
        (id,run_id,attempt,lifecycle,event_seq,task_classification_json,strategy_selected_json,context_used_json,
          execution_trace_json,outcome_json,attribution_json,policy_json,event_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.id, input.runId, input.attempt, input.lifecycle, input.eventSeq, input.taskClassificationJson,
        input.strategySelectedJson, input.contextUsedJson, input.executionTraceJson, input.outcomeJson,
        input.attributionJson, input.policyJson, input.eventHash, input.createdAt,
      );
      const event = this.db.prepare(`SELECT id FROM learning_events
        WHERE run_id=? AND attempt=? AND lifecycle=? AND event_seq=?`).get(
        input.runId, input.attempt, input.lifecycle, input.eventSeq,
      ) as { id: string };
      for (const label of input.labels) this.db.prepare(`INSERT OR IGNORE INTO outcome_labels
        (id,learning_event_id,run_id,attempt,taxonomy_version,label,value,confidence,evidence_json,idempotency_key,created_at)
        VALUES (?,?,?,?,'outcome-v1',?,?,?,?,?,?)`).run(
        label.id, event.id, input.runId, input.attempt, label.label, label.value, label.confidence,
        label.evidenceJson, `outcome:${event.id}:${label.label}`, label.createdAt,
      );
      return event.id;
    })();
  }

  correctionReferencesRecord(runId: string, recordId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM user_corrections
      WHERE run_id=? AND content LIKE ? LIMIT 1`).get(runId, `%${recordId}%`));
  }

  listCorrectionContents(runId: string, attempt: number): string[] {
    return (this.db.prepare(`SELECT content FROM user_corrections
      WHERE run_id=? AND (attempt=? OR attempt IS NULL)`).all(runId, attempt) as Array<{ content: string }>).map((row) => row.content);
  }

  recordFeedbackAttributionReceipt(input: FeedbackAttributionReceiptWrite): void {
    this.db.prepare(`INSERT OR IGNORE INTO feedback_attribution_receipts
      (id,run_id,attempt,actor_id,record_id,signal,weight,basis,context_manifest_id,evidence_json,status,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
      input.id, input.runId, input.attempt, input.actorId, input.recordId, input.signal, input.weight,
      input.basis, input.contextManifestId, input.evidenceJson, input.idempotencyKey, input.createdAt,
    );
  }

  listFeedbackAttributionWork(timestamp: number, limit: number): FeedbackAttributionWorkItem[] {
    return this.db.prepare(`SELECT id,run_id as runId,actor_id as actorId,record_id as recordId,signal,basis,attempts
      FROM feedback_attribution_receipts WHERE status IN ('pending','failed') AND next_retry_at<=?
      ORDER BY created_at LIMIT ?`).all(timestamp, limit) as FeedbackAttributionWorkItem[];
  }

  completeFeedbackAttribution(id: string, timestamp: number): void {
    this.db.prepare(`UPDATE feedback_attribution_receipts SET status='applied',applied_at=?,error='',next_retry_at=0
      WHERE id=? AND status IN ('pending','failed')`).run(timestamp, id);
  }

  failFeedbackAttribution(id: string, status: string, attempts: number, retryAt: number, error: string): void {
    this.db.prepare(`UPDATE feedback_attribution_receipts SET status=?,attempts=?,next_retry_at=?,error=?
      WHERE id=? AND status IN ('pending','failed')`).run(status, attempts, retryAt, error, id);
  }

  getLearningEventRow(id: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT id,run_id as runId,attempt,lifecycle,event_seq as eventSeq,
      task_classification_json as taskClassificationJson,strategy_selected_json as strategySelectedJson,
      context_used_json as contextUsedJson,execution_trace_json as executionTraceJson,outcome_json as outcomeJson,
      attribution_json as attributionJson,policy_json as policyJson,created_at as createdAt
      FROM learning_events WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  }

  listLearningEventIds(sessionId: string, limit: number): string[] {
    return (this.db.prepare(`SELECT e.id FROM learning_events e JOIN runs r ON r.id=e.run_id
      WHERE r.session_id=? ORDER BY e.created_at DESC LIMIT ?`).all(sessionId, limit) as Array<{ id: string }>).map((row) => row.id);
  }

  listCorrectionRows(sessionId: string, limit: number): unknown[] {
    return this.db.prepare(`SELECT id,session_id as sessionId,run_id as runId,attempt,message_id as messageId,
      correction_type as correctionType,target_type as targetType,target_id as targetId,content,source,applied,
      created_at as createdAt FROM user_corrections WHERE session_id=? ORDER BY created_at DESC LIMIT ?`).all(sessionId, limit);
  }

  listFeedbackAttributionRows(sessionId: string, limit: number): unknown[] {
    return this.db.prepare(`SELECT f.id,f.run_id as runId,f.attempt,f.record_id as recordId,f.signal,f.weight,f.basis,
      f.context_manifest_id as contextManifestId,f.status,f.attempts,f.next_retry_at as nextRetryAt,f.error,
      f.created_at as createdAt,f.applied_at as appliedAt FROM feedback_attribution_receipts f
      JOIN runs r ON r.id=f.run_id WHERE r.session_id=? ORDER BY f.created_at DESC LIMIT ?`).all(sessionId, limit);
  }
}
