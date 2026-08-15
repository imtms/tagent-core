import type Database from "better-sqlite3";
import type {
  AutonomyAuditWrite,
  CanaryOutcomeRecord,
  CanaryPromotionRecord,
  DistillationJobRecord,
  ExperienceObservationRecord,
  ExperienceObservationWrite,
  RunLearningPolicyRecord,
  WorkflowDefinitionWrite,
  WorkflowEvaluationWrite,
  WorkflowGovernanceReceiptWrite,
  WorkflowProposalRecord,
  WorkflowLearningRepository,
  WorkflowRevisionRecord,
  WorkflowRevisionWrite,
} from "@tagent/learning/ports";
import type {
  AutonomyApprovalRequest,
  AutonomyApprovalStatus,
  WorkflowApplicationStatus,
  WorkflowDefinition,
  WorkflowFeedbackSignal,
  WorkflowStatus,
} from "@tagent/learning/domain";
import {
  buildWorkflowExecutedReceipt,
  mapWorkflowApprovalOperation,
} from "./approval-operation-mapper.js";

export class SqliteWorkflowLearningRepository implements WorkflowLearningRepository {
  constructor(private readonly db: Database.Database) {}

  private insertGovernanceReceipt(receipt: WorkflowGovernanceReceiptWrite): void {
    this.db.prepare(`INSERT INTO workflow_governance_receipts
      (id,workflow_id,action,actor,reason,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      receipt.id, receipt.workflowId, receipt.action, receipt.actor, receipt.reason, receipt.metadataJson, receipt.createdAt,
    );
  }

  private insertAudit(audit: AutonomyAuditWrite): void {
    this.db.prepare(`INSERT OR IGNORE INTO autonomy_audit_events
      (id,scope_id,category,action,actor,source_run_id,workflow_id,revision_id,approval_id,evidence_json,metadata_json,receipt_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      audit.id, audit.scopeId, audit.category, audit.action, audit.actor, audit.sourceRunId, audit.workflowId,
      audit.revisionId, audit.approvalId, audit.evidenceJson, audit.metadataJson, audit.receiptHash, audit.createdAt,
    );
  }

  private insertEvaluation(input: WorkflowEvaluationWrite): void {
    this.db.prepare(`INSERT INTO workflow_evaluations
      (id,workflow_id,revision_id,kind,status,sample_size,success_rate,baseline_rate,risk_class,evidence_json,
       evaluator_id,evaluator_version,dataset_id,dataset_hash,baseline_revision_id,candidate_revision_id,
       evaluation_run_ids_json,check_results_json,receipt_hash,signature,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.id, input.workflowId, input.revisionId, input.kind, input.status, input.sampleSize, input.successRate,
      input.baselineRate, input.riskClass, input.evidenceJson, input.evaluatorId, input.evaluatorVersion,
      input.datasetId, input.datasetHash, input.baselineRevisionId, input.candidateRevisionId,
      input.evaluationRunIdsJson, input.checkResultsJson, input.receiptHash, input.signature, input.createdAt,
    );
  }

  private insertRevision(revision: WorkflowRevisionWrite, ordinal: number): void {
    this.db.prepare(`INSERT INTO workflow_revisions
      (id,workflow_id,revision,spec_json,spec_hash,source_type,source_evidence_json,confidence,change_summary,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      revision.id, revision.workflowId, ordinal, revision.specJson, revision.specHash, revision.sourceType,
      revision.sourceEvidenceJson, revision.confidence, revision.changeSummary, revision.createdAt,
    );
  }

  upsertRunLearningPolicy(record: RunLearningPolicyRecord): RunLearningPolicyRecord {
    this.db.prepare(`INSERT INTO run_learning_policies (run_id,policy,reason,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET policy=excluded.policy,reason=excluded.reason,updated_at=excluded.updated_at`).run(
      record.runId, record.policy, record.reason, record.updatedAt,
    );
    return this.getRunLearningPolicy(record.runId)!;
  }

  getRunLearningPolicy(runId: string): RunLearningPolicyRecord | undefined {
    return this.db.prepare(`SELECT run_id as runId,policy,reason,updated_at as updatedAt
      FROM run_learning_policies WHERE run_id=?`).get(runId) as RunLearningPolicyRecord | undefined;
  }

  recordExperienceObservation(record: ExperienceObservationWrite): { id: string } {
    this.db.prepare(`INSERT OR IGNORE INTO experience_observations
      (id,scope_id,run_id,attempt,lifecycle,outcome,event_seq,source_type,task_signature,procedure_summary,
       checks_passed_json,checks_failed_json,source_refs_json,learn_policy,observation_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.scopeId, record.runId, record.attempt, record.lifecycle, record.outcome, record.eventSeq,
      record.sourceType, record.taskSignature, record.procedureSummary, record.checksPassedJson,
      record.checksFailedJson, record.sourceRefsJson, record.learnPolicy, record.observationHash, record.createdAt,
    );
    return this.db.prepare("SELECT id FROM experience_observations WHERE observation_hash=?")
      .get(record.observationHash) as { id: string };
  }

  enqueueDistillationJob(input: { id: string; scopeId: string; taskSignature: string; signatureTermsJson: string; timestamp: number }): unknown {
    this.db.prepare(`INSERT INTO workflow_distillation_jobs
      (id,scope_id,task_signature,signature_terms_json,status,created_at,updated_at)
      VALUES (?,?,?,?,'queued',?,?)
      ON CONFLICT(scope_id,task_signature) DO UPDATE SET
        status=CASE WHEN workflow_distillation_jobs.status='running' THEN 'running' ELSE 'queued' END,
        signature_terms_json=excluded.signature_terms_json,error='',updated_at=excluded.updated_at`).run(
      input.id, input.scopeId, input.taskSignature, input.signatureTermsJson, input.timestamp, input.timestamp,
    );
    return this.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE scope_id=? AND task_signature=?")
      .get(input.scopeId, input.taskSignature);
  }

  claimDistillationJob(input: { owner: string; token: string; timestamp: number; leaseUntil: number }): DistillationJobRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM workflow_distillation_jobs WHERE status='queued'
        OR (status='running' AND (lease_until IS NULL OR lease_until<=?)) ORDER BY created_at LIMIT 1`)
        .get(input.timestamp) as { id: string } | undefined;
      if (!row) return undefined;
      const changed = this.db.prepare(`UPDATE workflow_distillation_jobs SET status='running',attempts=attempts+1,
        lease_owner=?,lease_token=?,lease_until=?,fence=fence+1,updated_at=? WHERE id=?
        AND (status='queued' OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`).run(
        input.owner, input.token, input.leaseUntil, input.timestamp, row.id, input.timestamp,
      ).changes;
      if (changed !== 1) return undefined;
      return this.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE id=?").get(row.id) as DistillationJobRecord;
    })();
  }

  renewDistillationLease(input: { id: string; owner: string; token: string; fence: number; timestamp: number; leaseUntil: number }): boolean {
    return this.db.prepare(`UPDATE workflow_distillation_jobs SET lease_until=?,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=? AND lease_until>?`).run(
      input.leaseUntil, input.timestamp, input.id, input.owner, input.token, input.fence, input.timestamp,
    ).changes === 1;
  }

  checkpointDistillationJob(input: { id: string; owner: string; token: string; fence: number; checkpointJson: string; timestamp: number; leaseUntil: number }): boolean {
    return this.db.prepare(`UPDATE workflow_distillation_jobs SET checkpoint_json=?,lease_until=?,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=? AND lease_until>?`).run(
      input.checkpointJson, input.leaseUntil, input.timestamp, input.id, input.owner, input.token, input.fence, input.timestamp,
    ).changes === 1;
  }

  updateDistillationCheckpoint(id: string, checkpointJson: string, timestamp: number): void {
    this.db.prepare("UPDATE workflow_distillation_jobs SET checkpoint_json=?,updated_at=? WHERE id=?")
      .run(checkpointJson, timestamp, id);
  }

  getDistillationCheckpoint(id: string): string {
    return String((this.db.prepare("SELECT checkpoint_json value FROM workflow_distillation_jobs WHERE id=?")
      .get(id) as { value?: string } | undefined)?.value ?? "{}");
  }

  completeDistillationJob(input: { id: string; owner: string; token: string; fence: number; workflowId: string | null; checkpointJson: string; timestamp: number }): boolean {
    return this.db.prepare(`UPDATE workflow_distillation_jobs SET status='completed',workflow_id=?,checkpoint_json=?,
      lease_owner='',lease_token='',lease_until=NULL,error='',updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=?`).run(
      input.workflowId, input.checkpointJson, input.timestamp, input.id, input.owner, input.token, input.fence,
    ).changes === 1;
  }

  failDistillationJob(input: { id: string; owner: string; token: string; fence: number; status: "queued" | "dead_letter"; checkpointJson: string; error: string; timestamp: number }): void {
    this.db.prepare(`UPDATE workflow_distillation_jobs SET status=?,checkpoint_json=?,error=?,
      lease_owner='',lease_token='',lease_until=NULL,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=?`).run(
      input.status, input.checkpointJson, input.error, input.timestamp, input.id, input.owner, input.token, input.fence,
    );
  }

  listExperienceCandidates(scopeId: string, limit = 500): ExperienceObservationRecord[] {
    return this.db.prepare(`SELECT id,run_id as runId,source_type as sourceType,task_signature as taskSignature,
      procedure_summary as procedureSummary,checks_passed_json as checksPassedJson,
      checks_failed_json as checksFailedJson,created_at as createdAt
      FROM experience_observations WHERE scope_id=? AND learn_policy='allow' AND run_id IS NOT NULL
      AND source_type IN ('task_experience','task_failure') ORDER BY created_at DESC LIMIT ?`)
      .all(scopeId, limit) as ExperienceObservationRecord[];
  }

  findDistilledWorkflow(evidenceSetHash: string): { workflowId: string } | undefined {
    return this.db.prepare("SELECT workflow_id as workflowId FROM workflow_distillations WHERE evidence_set_hash=?")
      .get(evidenceSetHash) as { workflowId: string } | undefined;
  }

  recordDistillationConflict(input: { id: string; jobId: string; scopeId: string; candidateSignature: string; workflowId: string; revisionId: string; kind: "duplicate" | "conflict"; similarity: number; reasonsJson: string; createdAt: number }): void {
    this.db.prepare(`INSERT OR IGNORE INTO workflow_distillation_conflicts
      (id,job_id,scope_id,candidate_signature,existing_workflow_id,existing_revision_id,kind,similarity,reasons_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?)`).run(
      input.id, input.jobId, input.scopeId, input.candidateSignature, input.workflowId, input.revisionId,
      input.kind, input.similarity, input.reasonsJson, input.createdAt,
    );
  }

  recordWorkflowDistillation(input: { evidenceSetHash: string; workflowId: string; createdAt: number }): void {
    this.db.prepare("INSERT INTO workflow_distillations (evidence_set_hash,workflow_id,created_at) VALUES (?,?,?)")
      .run(input.evidenceSetHash, input.workflowId, input.createdAt);
  }

  createWorkflow(
    definition: WorkflowDefinitionWrite,
    revision: WorkflowRevisionWrite,
    distillation?: { evidenceSetHash: string; createdAt: number },
  ): void {
    if (definition.status !== "candidate" || definition.activeRevisionId !== null) {
      throw new Error("Learning repository can only create candidate workflows");
    }
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workflow_definitions
        (id,scope_id,status,active_revision_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(
        definition.id, definition.scopeId, definition.status, definition.activeRevisionId,
        definition.createdAt, definition.updatedAt,
      );
      this.insertRevision(revision, 1);
      if (distillation) {
        this.db.prepare(`INSERT INTO workflow_distillations
          (evidence_set_hash,workflow_id,created_at) VALUES (?,?,?)`).run(
          distillation.evidenceSetHash, definition.id, distillation.createdAt,
        );
      }
    })();
  }

  createWorkflowRevision(revision: WorkflowRevisionWrite): number {
    return this.db.transaction(() => {
      const ordinal = (this.db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM workflow_revisions WHERE workflow_id=?")
        .get(revision.workflowId) as { revision: number }).revision + 1;
      this.insertRevision(revision, ordinal);
      return ordinal;
    })();
  }

  listWorkflowDefinitions(scopeId: string, includeDeleted: boolean): WorkflowDefinition[] {
    const deletionClause = includeDeleted ? "" : "AND deleted_at IS NULL";
    return this.db.prepare(`SELECT id,scope_id as scopeId,status,active_revision_id as activeRevisionId,
      deleted_at as deletedAt,purge_after as purgeAfter,delete_reason as deleteReason,
      previous_status as previousStatus,previous_active_revision_id as previousActiveRevisionId,
      created_at as createdAt,updated_at as updatedAt FROM workflow_definitions
      WHERE scope_id=? ${deletionClause} ORDER BY updated_at DESC`).all(scopeId) as WorkflowDefinition[];
  }

  getWorkflowDefinition(id: string, includeDeleted: boolean): WorkflowDefinition | undefined {
    const deletionClause = includeDeleted ? "" : "AND deleted_at IS NULL";
    return this.db.prepare(`SELECT id,scope_id as scopeId,status,active_revision_id as activeRevisionId,
      deleted_at as deletedAt,purge_after as purgeAfter,delete_reason as deleteReason,
      previous_status as previousStatus,previous_active_revision_id as previousActiveRevisionId,
      created_at as createdAt,updated_at as updatedAt FROM workflow_definitions
      WHERE id=? ${deletionClause}`).get(id) as WorkflowDefinition | undefined;
  }

  listWorkflowRevisionIds(workflowId: string): string[] {
    return (this.db.prepare("SELECT id FROM workflow_revisions WHERE workflow_id=? ORDER BY revision")
      .all(workflowId) as Array<{ id: string }>).map((row) => row.id);
  }

  getWorkflowRevision(id: string): WorkflowRevisionRecord | undefined {
    return this.db.prepare(`SELECT id,workflow_id as workflowId,revision,spec_json as specJson,
      source_type as sourceType,source_evidence_json as sourceEvidenceJson,confidence,
      change_summary as changeSummary,created_at as createdAt FROM workflow_revisions WHERE id=?`)
      .get(id) as WorkflowRevisionRecord | undefined;
  }

  activateWorkflow(input: { workflowId: string; revisionId: string; timestamp: number; receipt: WorkflowGovernanceReceiptWrite }): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE workflow_definitions SET status='active',active_revision_id=?,updated_at=?
        WHERE id=? AND deleted_at IS NULL`).run(input.revisionId, input.timestamp, input.workflowId);
      this.insertGovernanceReceipt(input.receipt);
    })();
  }

  setWorkflowStatus(input: { workflowId: string; previousStatus: WorkflowStatus; status: WorkflowStatus; reason: string; historyId: string; timestamp: number }): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE workflow_definitions SET status=?,
        active_revision_id=CASE WHEN ?='active' THEN active_revision_id ELSE NULL END,updated_at=? WHERE id=?`).run(
        input.status, input.status, input.timestamp, input.workflowId,
      );
      this.db.prepare(`INSERT INTO workflow_status_history
        (id,workflow_id,previous_status,next_status,reason,created_at) VALUES (?,?,?,?,?,?)`).run(
        input.historyId, input.workflowId, input.previousStatus, input.status, input.reason, input.timestamp,
      );
    })();
  }

  forgetWorkflow(input: { workflowId: string; previousStatus: WorkflowStatus; previousActiveRevisionId: string | null; deletedAt: number; purgeAfter: number; reason: string; receipt: WorkflowGovernanceReceiptWrite }): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE workflow_definitions SET status='deprecated',active_revision_id=NULL,
        deleted_at=?,purge_after=?,delete_reason=?,previous_status=?,previous_active_revision_id=?,updated_at=?
        WHERE id=? AND deleted_at IS NULL`).run(
        input.deletedAt, input.purgeAfter, input.reason, input.previousStatus, input.previousActiveRevisionId,
        input.deletedAt, input.workflowId,
      ).changes === 1;
      if (changed) this.insertGovernanceReceipt(input.receipt);
      return changed;
    })();
  }

  getRestorableWorkflow(id: string) {
    return this.db.prepare(`SELECT previous_status as previousStatus,
      previous_active_revision_id as previousActiveRevisionId,purge_after as purgeAfter
      FROM workflow_definitions WHERE id=? AND deleted_at IS NOT NULL`).get(id) as {
      previousStatus: WorkflowStatus | null;
      previousActiveRevisionId: string | null;
      purgeAfter: number | null;
    } | undefined;
  }

  restoreWorkflow(input: { workflowId: string; status: WorkflowStatus; activeRevisionId: string | null; timestamp: number; receipt: WorkflowGovernanceReceiptWrite }): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE workflow_definitions SET status=?,active_revision_id=?,deleted_at=NULL,purge_after=NULL,
        delete_reason='',previous_status=NULL,previous_active_revision_id=NULL,updated_at=? WHERE id=?`).run(
        input.status, input.activeRevisionId, input.timestamp, input.workflowId,
      );
      this.insertGovernanceReceipt(input.receipt);
    })();
  }

  recordGovernanceReceipt(receipt: WorkflowGovernanceReceiptWrite): void {
    this.insertGovernanceReceipt(receipt);
  }

  findActiveApprovalByHash(requestHash: string) {
    return this.db.prepare("SELECT id,status FROM autonomy_approval_requests WHERE request_hash=?")
      .get(requestHash) as { id: string; status: AutonomyApprovalStatus } | undefined;
  }

  createApproval(input: { approval: Omit<AutonomyApprovalRequest, "decidedAt" | "executedAt"> & { decidedAt?: number | null; executedAt?: number | null }; audit: AutonomyAuditWrite }): void {
    const approval = input.approval;
    this.db.transaction(() => {
      if (approval.status === "executed") {
        throw new Error("Canonical approval mapping cannot create an already-executed Workflow approval");
      }
      const canonical = mapWorkflowApprovalOperation(approval);
      this.db.prepare(`INSERT INTO autonomy_approval_requests
        (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,proposal_id,binding_id,status,risk_class,
         impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,request_reason,expires_at,request_hash,created_at,updated_at,
         operation_digest,reuse_mode,max_uses,used_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        approval.id, approval.scopeId, approval.actionType, approval.targetType, approval.targetId, approval.workflowId,
        approval.revisionId, approval.proposalId, approval.bindingId, approval.status, approval.riskClass,
        approval.impactScopeJson, approval.evidenceJson, approval.diffJson, approval.rollbackJson,
        approval.requestedBy, approval.requestReason, approval.expiresAt, approval.requestHash,
        approval.createdAt, approval.updatedAt,
        canonical.operationDigest, "one_time", 1, 0,
      );
      this.insertAudit(input.audit);
    })();
  }

  getApproval(id: string): AutonomyApprovalRequest | undefined {
    return this.db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,target_type as targetType,
      target_id as targetId,workflow_id as workflowId,revision_id as revisionId,proposal_id as proposalId,
      binding_id as bindingId,status,risk_class as riskClass,impact_scope_json as impactScopeJson,
      evidence_json as evidenceJson,diff_json as diffJson,rollback_json as rollbackJson,
      requested_by as requestedBy,request_reason as requestReason,expires_at as expiresAt,
      decided_by as decidedBy,decision_reason as decisionReason,decided_at as decidedAt,
      executed_at as executedAt,execution_receipt_json as executionReceiptJson,request_hash as requestHash,
      created_at as createdAt,updated_at as updatedAt FROM autonomy_approval_requests WHERE id=?`)
      .get(id) as AutonomyApprovalRequest | undefined;
  }

  listApprovals(scopeId: string, limit: number): AutonomyApprovalRequest[] {
    return this.db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,target_type as targetType,
      target_id as targetId,workflow_id as workflowId,revision_id as revisionId,proposal_id as proposalId,
      binding_id as bindingId,status,risk_class as riskClass,impact_scope_json as impactScopeJson,
      evidence_json as evidenceJson,diff_json as diffJson,rollback_json as rollbackJson,
      requested_by as requestedBy,request_reason as requestReason,expires_at as expiresAt,
      decided_by as decidedBy,decision_reason as decisionReason,decided_at as decidedAt,
      executed_at as executedAt,execution_receipt_json as executionReceiptJson,request_hash as requestHash,
      created_at as createdAt,updated_at as updatedAt FROM autonomy_approval_requests
      WHERE scope_id=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scopeId, limit) as AutonomyApprovalRequest[];
  }

  listApprovalsPage(scopeId: string, query: {
    snapshotCreatedAt?: number;
    after?: { createdAt: number; id: string };
    limit: number;
  }): { items: AutonomyApprovalRequest[]; snapshotCreatedAt: number } {
    const snapshotCreatedAt = query.snapshotCreatedAt ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(created_at),0) FROM autonomy_approval_requests WHERE scope_id=?",
    ).pluck().get(scopeId));
    const afterClause = query.after
      ? "AND (created_at < @afterCreatedAt OR (created_at = @afterCreatedAt AND id < @afterId))"
      : "";
    const items = this.db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,target_type as targetType,
      target_id as targetId,workflow_id as workflowId,revision_id as revisionId,proposal_id as proposalId,
      binding_id as bindingId,status,risk_class as riskClass,impact_scope_json as impactScopeJson,
      evidence_json as evidenceJson,diff_json as diffJson,rollback_json as rollbackJson,
      requested_by as requestedBy,request_reason as requestReason,expires_at as expiresAt,
      decided_by as decidedBy,decision_reason as decisionReason,decided_at as decidedAt,
      executed_at as executedAt,execution_receipt_json as executionReceiptJson,request_hash as requestHash,
      created_at as createdAt,updated_at as updatedAt FROM autonomy_approval_requests
      WHERE scope_id=@scopeId AND created_at<=@snapshotCreatedAt ${afterClause}
      ORDER BY created_at DESC,id DESC LIMIT @limit`).all({
      scopeId,
      snapshotCreatedAt,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as AutonomyApprovalRequest[];
    return { items, snapshotCreatedAt };
  }

  decideApproval(input: { id: string; decision: "approved" | "rejected"; actor: string; reason: string; timestamp: number; audit: AutonomyAuditWrite }): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE autonomy_approval_requests SET status=?,decided_by=?,decision_reason=?,decided_at=?,updated_at=?
        WHERE id=? AND status='pending'`).run(
        input.decision, input.actor, input.reason, input.timestamp, input.timestamp, input.id,
      );
      this.insertAudit(input.audit);
    })();
  }

  revokeApproval(input: { id: string; actor: string; reason: string; timestamp: number; audit: AutonomyAuditWrite }): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE autonomy_approval_requests SET status='revoked',decided_by=?,decision_reason=?,decided_at=?,updated_at=?
        WHERE id=? AND status IN ('pending','approved')`).run(
        input.actor, input.reason, input.timestamp, input.timestamp, input.id,
      );
      this.insertAudit(input.audit);
    })();
  }

  completeApprovalExecution(input: { id: string; executedAt: number; receiptJson: string; audit: AutonomyAuditWrite }): void {
    this.db.transaction(() => {
      const approval = this.db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,
        target_type as targetType,target_id as targetId,workflow_id as workflowId,revision_id as revisionId,
        proposal_id as proposalId,binding_id as bindingId,status,impact_scope_json as impactScopeJson,
        diff_json as diffJson,rollback_json as rollbackJson,operation_digest as operationDigest,
        reuse_mode as reuseMode,max_uses as maxUses,used_count as usedCount
        FROM autonomy_approval_requests WHERE id=?`).get(input.id) as {
          id: string;
          scopeId: string;
          actionType: string;
          targetType: string;
          targetId: string;
          workflowId: string | null;
          revisionId: string | null;
          proposalId: string | null;
          bindingId: string | null;
          status: string;
          impactScopeJson: string;
          diffJson: string;
          rollbackJson: string;
          operationDigest: string | null;
          reuseMode: string | null;
          maxUses: number | null;
          usedCount: number | null;
        } | undefined;
      if (!approval || approval.status !== "approved") {
        throw new Error("Approved request is required before Workflow approval settlement");
      }
      const canonical = mapWorkflowApprovalOperation(approval);
      if (approval.operationDigest !== canonical.operationDigest
        || approval.reuseMode !== "one_time"
        || approval.maxUses !== 1
        || approval.usedCount !== 0) {
        throw new Error(`Canonical approval conflict for Workflow approval ${input.id}`);
      }
      const receipt = buildWorkflowExecutedReceipt({
        approvalId: input.id,
        actionType: approval.actionType,
        targetId: approval.targetId,
        operationDigest: canonical.operationDigest,
        executedAt: input.executedAt,
        receiptJson: input.receiptJson,
      });
      const changed = this.db.prepare(`UPDATE autonomy_approval_requests
        SET status='executed',executed_at=?,execution_receipt_json=?,updated_at=?,used_count=1
        WHERE id=? AND status='approved' AND operation_digest=? AND reuse_mode='one_time'
          AND max_uses=1 AND used_count=0`).run(
        input.executedAt,
        input.receiptJson,
        input.executedAt,
        input.id,
        canonical.operationDigest,
      );
      if (changed.changes !== 1) {
        throw new Error(`Canonical approval conflict while settling Workflow approval ${input.id}`);
      }
      this.db.prepare(`INSERT INTO approval_receipts
        (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
        VALUES (@id,@approval_source,@approval_id,@operation_id,@operation_digest,@outcome,@actor_id,@details_json,@created_at)`)
        .run(receipt);
      this.insertAudit(input.audit);
    })();
  }

  expireApprovals(
    timestamp: number,
    createAudits: (rows: Array<{ id: string; scopeId: string; workflowId: string | null; revisionId: string | null }>) => AutonomyAuditWrite[],
  ) {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id,scope_id as scopeId,workflow_id as workflowId,revision_id as revisionId
        FROM autonomy_approval_requests WHERE status IN ('pending','approved') AND expires_at<=?`).all(timestamp) as Array<{
          id: string; scopeId: string; workflowId: string | null; revisionId: string | null;
        }>;
      this.db.prepare(`UPDATE autonomy_approval_requests SET status='expired',updated_at=?
        WHERE status IN ('pending','approved') AND expires_at<=?`).run(timestamp, timestamp);
      for (const audit of createAudits(rows)) this.insertAudit(audit);
      return rows;
    })();
  }

  setBindingMode(bindingId: string, mode: string): boolean {
    return this.db.prepare("UPDATE workflow_bindings SET application_mode=? WHERE id=?").run(mode, bindingId).changes === 1;
  }

  recordApplication(input: { id: string; bindingId: string; status: WorkflowApplicationStatus; mode: string; executedStepIdsJson: string; skippedStepsJson: string; correctionObserved: number; repeatedToolCalls: number; continuationCount: number; verificationMappingJson: string; attributionLevel: string; createdAt: number }): unknown {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE workflow_bindings SET application_mode=? WHERE id=?")
        .run(input.mode, input.bindingId).changes;
      if (changed !== 1) throw new Error("Workflow binding not found");
      this.db.prepare(`INSERT INTO workflow_application_receipts
        (id,binding_id,run_id,attempt,task_outcome,application_status,executed_step_ids_json,skipped_steps_json,
         correction_observed,repeated_tool_calls,continuation_count,verification_mapping_json,required_checks_passed,
         required_checks_failed,attribution_level,receipt_version,created_at)
        SELECT ?,id,run_id,attempt,'in_progress',?,?,?,?,?,?,?,0,0,?,1,? FROM workflow_bindings WHERE id=?
        ON CONFLICT(binding_id,receipt_version) DO UPDATE SET application_status=excluded.application_status,
          executed_step_ids_json=excluded.executed_step_ids_json,skipped_steps_json=excluded.skipped_steps_json,
          correction_observed=excluded.correction_observed,repeated_tool_calls=excluded.repeated_tool_calls,
          continuation_count=excluded.continuation_count,verification_mapping_json=excluded.verification_mapping_json,
          attribution_level=excluded.attribution_level`).run(
        input.id, input.status, input.executedStepIdsJson, input.skippedStepsJson, input.correctionObserved,
        input.repeatedToolCalls, input.continuationCount, input.verificationMappingJson, input.attributionLevel,
        input.createdAt, input.bindingId,
      );
      return this.getApplicationReceipt(input.bindingId);
    })();
  }

  getApplicationReceipt(bindingId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM workflow_application_receipts
      WHERE binding_id=? ORDER BY receipt_version DESC LIMIT 1`).get(bindingId) as Record<string, unknown> | undefined;
  }

  listRunBindings(runId: string, attempt: number) {
    return this.db.prepare(`SELECT id,workflow_id as workflowId,revision_id as revisionId,application_mode as applicationMode
      FROM workflow_bindings WHERE run_id=? AND attempt=?`).all(runId, attempt) as Array<{
        id: string; workflowId: string; revisionId: string; applicationMode: string;
      }>;
  }

  recordRunApplication(input: { id: string; bindingId: string; runId: string; attempt: number; taskOutcome: string; applicationStatus: WorkflowApplicationStatus; passed: number; failed: number; attributionLevel: string; createdAt: number }): void {
    this.db.prepare(`INSERT INTO workflow_application_receipts
      (id,binding_id,run_id,attempt,task_outcome,application_status,required_checks_passed,
       required_checks_failed,attribution_level,receipt_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(binding_id,receipt_version) DO UPDATE SET task_outcome=excluded.task_outcome,
        required_checks_passed=excluded.required_checks_passed,required_checks_failed=excluded.required_checks_failed,
        attribution_level=excluded.attribution_level`).run(
      input.id, input.bindingId, input.runId, input.attempt, input.taskOutcome, input.applicationStatus,
      input.passed, input.failed, input.attributionLevel, input.createdAt,
    );
  }

  recordFeedback(input: { id: string; workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; weight: number; adopted: number; verified: number; idempotencyKey: string; note: string; createdAt: number }) {
    return this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO workflow_feedback
        (id,workflow_id,revision_id,run_id,attempt,signal,weight,adopted,verified,idempotency_key,note,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.id, input.workflowId, input.revisionId, input.runId, input.attempt, input.signal, input.weight,
        input.adopted, input.verified, input.idempotencyKey, input.note, input.createdAt,
      ).changes === 1;
      const receipt = this.db.prepare("SELECT * FROM workflow_feedback WHERE idempotency_key=?")
        .get(input.idempotencyKey) as Record<string, unknown>;
      return { receipt, inserted };
    })();
  }

  workflowQuality(revisionId: string): { samples: number; weight: number } {
    return this.db.prepare(`SELECT COUNT(*) samples,COALESCE(SUM(weight),0) weight
      FROM workflow_feedback WHERE revision_id=? AND adopted=1`).get(revisionId) as { samples: number; weight: number };
  }

  recordSelectorReceipt(input: { id: string; runId: string; attempt: number; workflowId: string; revisionId: string; decision: "selected" | "excluded"; reasonsJson: string; score: number | null; createdAt: number }): void {
    this.db.prepare(`INSERT INTO workflow_selector_receipts
      (id,run_id,attempt,workflow_id,revision_id,decision,reasons_json,score,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,attempt,workflow_id,revision_id) DO UPDATE SET
        decision=excluded.decision,reasons_json=excluded.reasons_json,score=excluded.score,created_at=excluded.created_at`).run(
      input.id, input.runId, input.attempt, input.workflowId, input.revisionId, input.decision,
      input.reasonsJson, input.score, input.createdAt,
    );
  }

  getCanaryPromotion(workflowId: string) {
    return this.db.prepare(`SELECT id,revision_id as revisionId,previous_revision_id as previousRevisionId,
      canary_percent as canaryPercent FROM workflow_promotions
      WHERE workflow_id=? AND status='canary' ORDER BY created_at DESC LIMIT 1`).get(workflowId) as {
        id: string; revisionId: string; previousRevisionId: string; canaryPercent: number;
      } | undefined;
  }

  recordCanaryAssignment(input: { id: string; promotionId: string; workflowId: string; runId: string; attempt: number; scopeId: string; assignmentKey: string; assignmentHash: string; bucket: number; variant: string; revisionId: string; receiptHash: string; createdAt: number }): void {
    this.db.prepare(`INSERT OR IGNORE INTO workflow_canary_bindings
      (id,promotion_id,workflow_id,run_id,attempt,scope_id,assignment_key,assignment_hash,bucket,variant,revision_id,receipt_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.id, input.promotionId, input.workflowId, input.runId, input.attempt, input.scopeId,
      input.assignmentKey, input.assignmentHash, input.bucket, input.variant, input.revisionId,
      input.receiptHash, input.createdAt,
    );
  }

  recordWorkflowBinding(input: { id: string; runId: string; attempt: number; workflowId: string; revisionId: string; score: number; reasonsJson: string; createdAt: number }): string {
    return this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO workflow_bindings
        (id,run_id,attempt,workflow_id,revision_id,selector_version,relevance_score,selected_reason_json,application_mode,created_at)
        VALUES (?,?,?,?,?,'workflow-selector-v1',?,?,'suggested',?)`).run(
        input.id, input.runId, input.attempt, input.workflowId, input.revisionId,
        input.score, input.reasonsJson, input.createdAt,
      );
      return (this.db.prepare(`SELECT id FROM workflow_bindings
        WHERE run_id=? AND attempt=? AND workflow_id=? AND revision_id=?`).get(
        input.runId, input.attempt, input.workflowId, input.revisionId,
      ) as { id: string }).id;
    })();
  }

  listBindings(scopeId: string, limit: number): unknown[] {
    return this.db.prepare(`SELECT b.id,b.run_id as runId,b.attempt,b.workflow_id as workflowId,
      b.revision_id as revisionId,b.relevance_score as relevanceScore,b.application_mode as applicationMode,
      b.created_at as createdAt FROM workflow_bindings b JOIN workflow_definitions w ON w.id=b.workflow_id
      WHERE w.scope_id=? ORDER BY b.created_at DESC LIMIT ?`).all(scopeId, limit);
  }

  listFeedback(scopeId: string, limit: number): unknown[] {
    return this.db.prepare(`SELECT f.id,f.workflow_id as workflowId,f.revision_id as revisionId,
      f.run_id as runId,f.attempt,f.signal,f.weight,f.adopted,f.verified,f.note,f.created_at as createdAt
      FROM workflow_feedback f JOIN workflow_definitions w ON w.id=f.workflow_id
      WHERE w.scope_id=? ORDER BY f.created_at DESC LIMIT ?`).all(scopeId, limit);
  }

  createProposal(input: { id: string; workflowId: string; baseRevisionId: string; reason: string; evidenceJson: string; patchJson: string; baseSpecHash: string; proposedSpecHash: string; changedPathsJson: string; createdAt: number }): unknown {
    this.db.prepare(`INSERT OR IGNORE INTO workflow_revision_proposals
      (id,workflow_id,base_revision_id,reason,evidence_json,patch_json,base_spec_hash,proposed_spec_hash,changed_paths_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'candidate',?)`).run(
      input.id, input.workflowId, input.baseRevisionId, input.reason, input.evidenceJson, input.patchJson,
      input.baseSpecHash, input.proposedSpecHash, input.changedPathsJson, input.createdAt,
    );
    return this.db.prepare(`SELECT * FROM workflow_revision_proposals
      WHERE workflow_id=? AND base_revision_id=? AND reason=?`).get(input.workflowId, input.baseRevisionId, input.reason);
  }

  listProposals(scopeId: string): unknown[] {
    return this.db.prepare(`SELECT p.id,p.workflow_id as workflowId,p.base_revision_id as baseRevisionId,
      p.reason,p.evidence_json as evidenceJson,p.patch_json as patchJson,p.base_spec_hash as baseSpecHash,
      p.proposed_spec_hash as proposedSpecHash,p.changed_paths_json as changedPathsJson,p.status,
      p.decided_by as decidedBy,p.decision_reason as decisionReason,p.decided_at as decidedAt,
      p.applied_revision_id as appliedRevisionId,p.created_at as createdAt
      FROM workflow_revision_proposals p JOIN workflow_definitions w ON w.id=p.workflow_id
      WHERE w.scope_id=? ORDER BY p.created_at DESC`).all(scopeId);
  }

  getProposal(id: string): WorkflowProposalRecord | undefined {
    return this.db.prepare(`SELECT workflow_id as workflowId,base_revision_id as baseRevisionId,
      patch_json as patchJson,base_spec_hash as baseSpecHash,proposed_spec_hash as proposedSpecHash,
      changed_paths_json as changedPathsJson,reason,evidence_json as evidenceJson,status
      FROM workflow_revision_proposals WHERE id=?`).get(id) as WorkflowProposalRecord | undefined;
  }

  decideProposal(input: { id: string; decision: "approved" | "rejected"; actor: string; reason: string; timestamp: number; receipt: WorkflowGovernanceReceiptWrite }): unknown {
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE workflow_revision_proposals SET status=?,decided_by=?,decision_reason=?,decided_at=?
        WHERE id=? AND status='candidate'`).run(input.decision, input.actor, input.reason, input.timestamp, input.id);
      this.insertGovernanceReceipt(input.receipt);
      return this.db.prepare("SELECT * FROM workflow_revision_proposals WHERE id=?").get(input.id);
    })();
  }

  applyProposalRevision(input: { proposalId: string; actor: string; timestamp: number; receipt: WorkflowGovernanceReceiptWrite; revision: WorkflowRevisionWrite }): number {
    return this.db.transaction(() => {
      const ordinal = (this.db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM workflow_revisions WHERE workflow_id=?")
        .get(input.revision.workflowId) as { revision: number }).revision + 1;
      this.insertRevision(input.revision, ordinal);
      this.db.prepare(`UPDATE workflow_revision_proposals SET status='applied',applied_revision_id=?,decided_by=?,decided_at=?
        WHERE id=?`).run(input.revision.id, input.actor, input.timestamp, input.proposalId);
      this.insertGovernanceReceipt(input.receipt);
      return ordinal;
    })();
  }

  listDistillationJobs(scopeId: string): unknown[] {
    return this.db.prepare(`SELECT id,task_signature as taskSignature,status,checkpoint_json as checkpointJson,
      attempts,lease_owner as leaseOwner,lease_until as leaseUntil,fence,workflow_id as workflowId,error,
      created_at as createdAt,updated_at as updatedAt FROM workflow_distillation_jobs
      WHERE scope_id=? ORDER BY updated_at DESC`).all(scopeId);
  }

  listRunLearningPolicies(scopeId: string): unknown[] {
    return this.db.prepare(`SELECT p.run_id as runId,p.policy,p.reason,p.updated_at as updatedAt
      FROM run_learning_policies p JOIN runs r ON r.id=p.run_id
      WHERE r.session_id=? ORDER BY p.updated_at DESC`).all(scopeId);
  }

  listWorkflowQuality(scopeId: string) {
    return this.db.prepare(`SELECT w.id as workflowId,
      COALESCE(w.active_revision_id,(SELECT r.id FROM workflow_revisions r WHERE r.workflow_id=w.id ORDER BY r.revision DESC LIMIT 1)) as revisionId,
      COUNT(f.id) as samples,COALESCE(SUM(f.weight),0) as weight FROM workflow_definitions w
      LEFT JOIN workflow_feedback f ON f.revision_id=COALESCE(w.active_revision_id,
        (SELECT r2.id FROM workflow_revisions r2 WHERE r2.workflow_id=w.id ORDER BY r2.revision DESC LIMIT 1)) AND f.adopted=1
      WHERE w.scope_id=? GROUP BY w.id,w.active_revision_id`).all(scopeId) as Array<{
        workflowId: string; revisionId?: string; samples: number; weight: number;
      }>;
  }

  listEvaluations(scopeId: string): unknown[] {
    return this.db.prepare(`SELECT e.id,e.workflow_id as workflowId,e.revision_id as revisionId,e.kind,e.status,
      e.sample_size as sampleSize,e.success_rate as successRate,e.baseline_rate as baselineRate,e.risk_class as riskClass,
      e.evaluator_id as evaluatorId,e.evaluator_version as evaluatorVersion,e.dataset_id as datasetId,
      e.dataset_hash as datasetHash,e.baseline_revision_id as baselineRevisionId,e.candidate_revision_id as candidateRevisionId,
      e.evaluation_run_ids_json as evaluationRunIdsJson,e.check_results_json as checkResultsJson,
      e.receipt_hash as receiptHash,e.signature,e.created_at as createdAt
      FROM workflow_evaluations e JOIN workflow_definitions w ON w.id=e.workflow_id
      WHERE w.scope_id=? ORDER BY e.created_at DESC`).all(scopeId);
  }

  listCanaryBindings(scopeId: string, limit: number): unknown[] {
    return this.db.prepare(`SELECT c.id,c.promotion_id as promotionId,c.workflow_id as workflowId,c.run_id as runId,
      c.attempt,c.assignment_hash as assignmentHash,c.bucket,c.variant,c.revision_id as revisionId,
      c.receipt_hash as receiptHash,c.outcome_status as outcomeStatus,c.success,c.required_checks as requiredChecks,
      c.passed_checks as passedChecks,c.outcome_recorded_at as outcomeRecordedAt,c.created_at as createdAt
      FROM workflow_canary_bindings c JOIN workflow_definitions w ON w.id=c.workflow_id
      WHERE w.scope_id=? ORDER BY c.created_at DESC LIMIT ?`).all(scopeId, limit);
  }

  getDistillationMetrics(scopeId: string | undefined, timestamp: number): unknown {
    const where = scopeId ? "WHERE scope_id=?" : "";
    const params = scopeId ? [scopeId] : [];
    const rows = this.db.prepare(`SELECT status,COUNT(*) count,MIN(created_at) oldest
      FROM workflow_distillation_jobs ${where} GROUP BY status`).all(...params) as Array<{
        status: string; count: number; oldest: number;
      }>;
    const statusClause = where ? `${where} AND` : "WHERE";
    const outcome = this.db.prepare(`SELECT
      COUNT(*) FILTER (WHERE json_extract(checkpoint_json,'$.result')='candidate') candidates,
      COUNT(*) FILTER (WHERE json_extract(checkpoint_json,'$.result')='withheld') withheld
      FROM workflow_distillation_jobs ${statusClause} status='completed'`).get(...params) as {
        candidates: number; withheld: number;
      };
    const reasonRows = this.db.prepare(`SELECT
      COALESCE(json_extract(checkpoint_json,'$.detail.reason'),'insufficient_evidence') reason,COUNT(*) count
      FROM workflow_distillation_jobs ${statusClause} status='completed'
      AND json_extract(checkpoint_json,'$.result')='withheld' GROUP BY reason`).all(...params) as Array<{
        reason: string; count: number;
      }>;
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const queued = rows.find((row) => row.status === "queued");
    return {
      queued: byStatus.queued ?? 0,
      running: byStatus.running ?? 0,
      completed: byStatus.completed ?? 0,
      deadLetter: byStatus.dead_letter ?? 0,
      failed: byStatus.failed ?? 0,
      candidates: Number(outcome?.candidates ?? 0),
      withheld: Number(outcome?.withheld ?? 0),
      withheldReasons: Object.fromEntries(reasonRows.map((row) => [row.reason, row.count])),
      oldestQueuedAgeMs: queued ? timestamp - queued.oldest : 0,
    };
  }

  listAutonomyAudit(scopeId: string, limit: number): unknown[] {
    return this.db.prepare(`SELECT id,scope_id as scopeId,category,action,actor,source_run_id as sourceRunId,
      workflow_id as workflowId,revision_id as revisionId,approval_id as approvalId,evidence_json as evidenceJson,
      metadata_json as metadataJson,receipt_hash as receiptHash,created_at as createdAt
      FROM autonomy_audit_events WHERE scope_id=? ORDER BY created_at DESC LIMIT ?`).all(scopeId, limit);
  }

  recordAutonomyAudit(audit: AutonomyAuditWrite): void {
    this.insertAudit(audit);
  }

  getEvaluationReceipt(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM workflow_evaluations WHERE id=?").get(id) as Record<string, unknown> | undefined;
  }

  recordEvaluationReceipt(input: WorkflowEvaluationWrite): void {
    this.insertEvaluation(input);
  }

  hasWorkflowBinding(runId: string, workflowId: string, revisionId: string): boolean {
    return Boolean(this.db.prepare(`SELECT id FROM workflow_bindings
      WHERE run_id=? AND workflow_id=? AND revision_id=?`).get(runId, workflowId, revisionId));
  }

  listPassedEvaluations(workflowId: string, revisionId: string) {
    return this.db.prepare(`SELECT id,kind,receipt_hash as receiptHash FROM workflow_evaluations
      WHERE workflow_id=? AND candidate_revision_id=? AND status='passed'`).all(workflowId, revisionId) as Array<{
        id: string; kind: string; receiptHash: string;
      }>;
  }

  startCanary(input: { id: string; workflowId: string; revisionId: string; previousRevisionId: string; canaryPercent: number; maxFailureDelta: number; reason: string; timestamp: number; receipt: WorkflowGovernanceReceiptWrite }): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workflow_promotions
        (id,workflow_id,revision_id,previous_revision_id,status,canary_percent,max_failure_delta,reason,created_at,updated_at)
        VALUES (?,?,?,?,'canary',?,?,?,?,?)`).run(
        input.id, input.workflowId, input.revisionId, input.previousRevisionId, input.canaryPercent,
        input.maxFailureDelta, input.reason, input.timestamp, input.timestamp,
      );
      this.insertGovernanceReceipt(input.receipt);
    })();
  }

  getCanaryPromotionById(id: string): CanaryPromotionRecord | undefined {
    return this.db.prepare(`SELECT workflow_id as workflowId,revision_id as revisionId,
      previous_revision_id as previousRevisionId,max_failure_delta as maxFailureDelta,status
      FROM workflow_promotions WHERE id=?`).get(id) as CanaryPromotionRecord | undefined;
  }

  listCanaryOutcomes(promotionId: string): CanaryOutcomeRecord[] {
    return this.db.prepare(`SELECT variant,success,run_id as runId FROM workflow_canary_bindings
      WHERE promotion_id=? AND outcome_recorded_at IS NOT NULL`).all(promotionId) as CanaryOutcomeRecord[];
  }

  settleCanary(input: { promotionId: string; workflowId: string; activeRevisionId: string; status: "promoted" | "rolled_back"; reason: string; timestamp: number; evaluation: WorkflowEvaluationWrite; receipt: WorkflowGovernanceReceiptWrite }): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE workflow_definitions SET status='active',active_revision_id=?,updated_at=? WHERE id=?`)
        .run(input.activeRevisionId, input.timestamp, input.workflowId);
      this.db.prepare("UPDATE workflow_promotions SET status=?,reason=?,updated_at=? WHERE id=?")
        .run(input.status, input.reason, input.timestamp, input.promotionId);
      this.insertEvaluation(input.evaluation);
      this.insertGovernanceReceipt(input.receipt);
    })();
  }

  listPendingCanaryBindings(runId: string, attempt: number) {
    return this.db.prepare(`SELECT id,promotion_id as promotionId FROM workflow_canary_bindings
      WHERE run_id=? AND attempt=? AND outcome_recorded_at IS NULL`).all(runId, attempt) as Array<{
        id: string; promotionId: string;
      }>;
  }

  recordCanaryOutcome(input: { id: string; outcomeStatus: string; success: number; requiredChecks: number; passedChecks: number; timestamp: number }): void {
    this.db.prepare(`UPDATE workflow_canary_bindings SET outcome_status=?,success=?,required_checks=?,
      passed_checks=?,outcome_recorded_at=? WHERE id=?`).run(
      input.outcomeStatus, input.success, input.requiredChecks, input.passedChecks, input.timestamp, input.id,
    );
  }

  retryDistillationJob(input: { id: string; checkpointJson: string; taskSignature?: string; timestamp: number }): unknown {
    const row = this.db.prepare("SELECT status FROM workflow_distillation_jobs WHERE id=?")
      .get(input.id) as { status: string } | undefined;
    if (!row || !["dead_letter", "failed"].includes(row.status)) throw new Error("Distillation job is not retryable");
    this.db.prepare(`UPDATE workflow_distillation_jobs SET status='queued',attempts=0,error='',checkpoint_json=?,
      task_signature=COALESCE(?,task_signature),lease_owner='',lease_token='',lease_until=NULL,updated_at=? WHERE id=?`).run(
      input.checkpointJson, input.taskSignature ?? null, input.timestamp, input.id,
    );
    return this.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE id=?").get(input.id);
  }

  listDeadLetterJobs(limit: number): unknown[] {
    return this.db.prepare(`SELECT * FROM workflow_distillation_jobs
      WHERE status='dead_letter' ORDER BY updated_at DESC LIMIT ?`).all(limit);
  }
}
