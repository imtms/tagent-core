import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeMessage as AgentMessage } from "@tagent/execution/ports";
import {
  LEGACY_RUN_APPROVAL_DEFAULTS,
  type ApprovalRequest,
  type Artifact,
  type CompletionGate,
  type GateEvaluation,
  type PlanItem,
  type ProgressSnapshot,
  type RunCheck,
  type SupervisorDecision,
} from "@tagent/governance/domain";
import type {
  GovernanceCompletionRunView,
  GovernanceProgressRunView,
  GovernanceRunEventView,
} from "@tagent/governance/ports";
import type {
  ControlInboxItem,
  ContextManifest,
  EventConsumerCursor,
  RunCheckpoint,
  RunContinuation,
  RunEvent,
  RunId,
  RunPhase,
  RunStatus,
  TaskRun,
  TaskRunContractSnapshot,
  TaskRunEdge,
  UserInputField,
  UserInputRequest,
} from "@tagent/execution/domain";
import type {
  Message,
  ReasoningEffort,
  Session,
  SessionId,
  SessionInboxItem,
  SessionInputAnalysis,
  SessionSettingsUpdate,
  TaskObjective,
} from "@tagent/admission/domain";
import {
  ATTEMPT_SCHEMA_V30_SQL,
  migrateAttemptsV30,
} from "./migrations/v30-attempts.js";
import { migrateGovernanceV31 } from "./migrations/v31-governance.js";
import {
  assertCapabilityAuthorizationV32Schema,
  migrateCapabilityAuthorizationV32,
} from "./migrations/v32-capability-authorization.js";
import {
  migrateLearningIntegrationV33,
  prepareLearningIntegrationV33,
} from "./migrations/v33-learning-integration.js";
import {
  assertWorkspaceExecutionProfileV34Schema,
  migrateWorkspaceExecutionProfileV34,
} from "./migrations/v34-workspace-execution-profile.js";
import {
  assertWorkspaceGoalsV35Schema,
  migrateWorkspaceGoalsV35,
} from "./migrations/v35-workspace-goals.js";
import { mapLegacyRunApprovalOperation } from "./sqlite/canonical-approval-mapper.js";
import { appendProjectionPair, finalizeProjectionCheckpoint } from "./sqlite/canonical-integration-event.js";
import { registerInternalUserInputCoordinator } from "./sqlite/internal-user-input-coordinator.js";

const now = () => Date.now();
const SCHEMA_VERSION = 35;
const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

export interface StoreOptions {
  deferPostMigrationRecovery?: boolean;
  /** Concrete Core primary model captured by new Workspaces and v34 migration. */
  defaultModelId?: string;
}

export type StoreSynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface StoreMutationRunner {
  run<T>(work: (db: Database.Database) => T & StoreSynchronousResult<T>): T;
}

export class Store {
  readonly db: Database.Database;
  private readonly defaultModelId: string;

  constructor(filename = process.env.TAGENT_DB ?? "./data/tagent.db", options: StoreOptions = {}) {
    this.defaultModelId = options.defaultModelId?.trim() || "gpt-5.6-sol";
    this.db = new Database(filename);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.migrate();
      if (!options.deferPostMigrationRecovery) this.runPostMigrationRecovery();
      registerInternalUserInputCoordinator(this, (runId, prompt, fields, hook) =>
        this.requestUserInputInternal(runId, prompt, fields, hook));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  getLastTranscriptSeq(runId: RunId) {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) as seq FROM run_transcript WHERE run_id = ?").get(runId) as { seq: number }).seq;
  }

  getTranscriptCount(runId: RunId) {
    return (this.db.prepare("SELECT COUNT(*) as count FROM run_transcript WHERE run_id = ?").get(runId) as { count: number }).count;
  }

  getCheckpoint(runId: RunId): RunCheckpoint | null {
    const row = this.db.prepare(`SELECT run_id as runId, attempt, active,
      assistant_partial as assistantPartial, current_tool_json as currentToolJson,
      last_event_seq as lastEventSeq, last_transcript_seq as lastTranscriptSeq, updated_at as updatedAt
      FROM run_checkpoints WHERE run_id = ?`).get(runId) as (Omit<RunCheckpoint, "active" | "currentTool"> & { active: number; currentToolJson: string }) | undefined;
    if (!row) return null;
    const { currentToolJson, ...checkpoint } = row;
    return { ...checkpoint, active: Boolean(row.active), currentTool: currentToolJson ? JSON.parse(currentToolJson) as RunCheckpoint["currentTool"] : null };
  }

  upsertCheckpoint(checkpoint: Omit<RunCheckpoint, "updatedAt"> & { updatedAt?: number }) {
    const existing = this.getCheckpoint(checkpoint.runId);
    if (existing && existing.attempt === checkpoint.attempt
      && existing.active === checkpoint.active
      && existing.assistantPartial === checkpoint.assistantPartial
      && JSON.stringify(existing.currentTool) === JSON.stringify(checkpoint.currentTool)
      && existing.lastEventSeq === checkpoint.lastEventSeq
      && existing.lastTranscriptSeq === checkpoint.lastTranscriptSeq) return existing;
    const updatedAt = checkpoint.updatedAt ?? now();
    this.db.prepare(`INSERT INTO run_checkpoints
      (run_id, attempt, attempt_id, active, assistant_partial, current_tool_json, last_event_seq, last_transcript_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET attempt = excluded.attempt, active = excluded.active,
        attempt_id = excluded.attempt_id,
        assistant_partial = excluded.assistant_partial, current_tool_json = excluded.current_tool_json,
        last_event_seq = excluded.last_event_seq, last_transcript_seq = excluded.last_transcript_seq,
        updated_at = excluded.updated_at
      WHERE excluded.attempt > run_checkpoints.attempt OR
        (excluded.attempt = run_checkpoints.attempt AND EXISTS (
          SELECT 1 FROM runs WHERE id = excluded.run_id AND status = 'running' AND attempt = excluded.attempt
        ))`).run(
      checkpoint.runId, checkpoint.attempt, this.attemptId(checkpoint.runId, checkpoint.attempt),
      checkpoint.active ? 1 : 0, checkpoint.assistantPartial,
      checkpoint.currentTool ? JSON.stringify(checkpoint.currentTool) : "", checkpoint.lastEventSeq,
      checkpoint.lastTranscriptSeq, updatedAt,
    );
    return this.getCheckpoint(checkpoint.runId)!;
  }

  nextContinuationLeaseExpiry() {
    const row = this.db.prepare(`SELECT MIN(lease_until) as leaseUntil FROM run_continuations
      WHERE status = 'running' AND lease_until IS NOT NULL`).get() as { leaseUntil: number | null };
    return row.leaseUntil;
  }

  ownsContinuationLease(id: string, owner: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM run_continuations
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?`).get(id, owner, now()));
  }

  listRecentMessages(sessionId: SessionId, limit = 200): Message[] {
    return this.db.prepare(`
      SELECT id, sessionId, role, content, createdAt FROM (
        SELECT id, session_id as sessionId, role, content, created_at as createdAt
        FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, limit) as Message[];
  }

  getMessageSource(id: number): Pick<Message, "id" | "role" | "content"> | undefined {
    return this.db.prepare("SELECT id, role, content FROM messages WHERE id = ?").get(id) as
      Pick<Message, "id" | "role" | "content"> | undefined;
  }

  listDurableUserMessages(): Array<Pick<Message, "id" | "content">> {
    return this.db.prepare("SELECT id, content FROM messages WHERE role = 'user' ORDER BY id ASC").all() as
      Array<Pick<Message, "id" | "content">>;
  }

  close() {
    this.db.close();
  }

  private migrate() {
    let previousVersion: number | undefined;
    const foundationMigration = this.db.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_writer_lease (
        lock_name TEXT PRIMARY KEY CHECK (lock_name = 'core-writer'),
        owner_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK (fence > 0),
        pid INTEGER NOT NULL CHECK (pid > 0),
        host TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER,
        CHECK (expires_at >= heartbeat_at),
        CHECK (released_at IS NULL OR released_at >= acquired_at)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
        reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('minimal','low','medium','high','xhigh','max')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        goal TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
        reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('minimal','low','medium','high','xhigh','max')),
        gate_required INTEGER NOT NULL DEFAULT 1,
        blocked_reason TEXT NOT NULL DEFAULT '',
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 1,
        resumed_at INTEGER,
        usage_input INTEGER NOT NULL DEFAULT 0,
        usage_output INTEGER NOT NULL DEFAULT 0,
        usage_cache_read INTEGER NOT NULL DEFAULT 0,
        usage_cache_write INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cost REAL NOT NULL DEFAULT 0,
        contract_json TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, updated_at);
      CREATE TABLE IF NOT EXISTS run_model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        component TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        usage_input INTEGER NOT NULL DEFAULT 0,
        usage_output INTEGER NOT NULL DEFAULT 0,
        usage_cache_read INTEGER NOT NULL DEFAULT 0,
        usage_cache_write INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cost REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_model_usage_run ON run_model_usage(run_id, component);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        attempt_id TEXT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS run_continuations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        ordinal INTEGER NOT NULL,
        source_attempt_id TEXT,
        scheduled_attempt_id TEXT,
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_until INTEGER,
        heartbeat_at INTEGER,
        UNIQUE(run_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_continuations_run ON run_continuations(run_id, ordinal);
      CREATE TABLE IF NOT EXISTS run_transcript (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_run ON run_transcript(run_id, seq);
      CREATE TABLE IF NOT EXISTS session_supervisor_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        run_id TEXT REFERENCES runs(id),
        error TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER,
        started_at INTEGER,
        summary TEXT NOT NULL DEFAULT '',
        objectives_json TEXT NOT NULL DEFAULT '[]',
        intent TEXT NOT NULL DEFAULT 'new_task',
        target_run_id TEXT,
        priority INTEGER NOT NULL DEFAULT 500,
        urgency TEXT NOT NULL DEFAULT 'normal',
        relation TEXT NOT NULL DEFAULT 'independent',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT '',
        non_goals_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        decision_reason TEXT NOT NULL DEFAULT '',
        router_version TEXT NOT NULL DEFAULT '',
        manual_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_supervisor_inbox_queue ON session_supervisor_inbox(session_id,status,position,created_at);
      CREATE TABLE IF NOT EXISTS supervisor_decisions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, trigger TEXT NOT NULL, action TEXT NOT NULL, reason_code TEXT NOT NULL,
        rationale TEXT NOT NULL, confidence REAL NOT NULL, instruction TEXT NOT NULL DEFAULT '',
        candidate_response_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, executed_at INTEGER, evaluator TEXT NOT NULL DEFAULT 'system',
        evaluator_model TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_run ON supervisor_decisions(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS gate_evaluations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, gate_type TEXT NOT NULL, evaluator TEXT NOT NULL DEFAULT 'system',
        evaluator_model TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', passed INTEGER NOT NULL,
        failures_json TEXT NOT NULL, criterion_coverage_json TEXT NOT NULL DEFAULT '[]', input_manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gate_evaluations_run ON gate_evaluations(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS progress_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), attempt INTEGER NOT NULL, checkpoint_seq INTEGER NOT NULL,
        meaningful_changes INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        repeated_operations INTEGER NOT NULL DEFAULT 0, last_progress_at INTEGER NOT NULL,
        last_decision_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS taskrun_edges (
        from_run_id TEXT NOT NULL REFERENCES runs(id), to_run_id TEXT NOT NULL REFERENCES runs(id),
        relation TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        PRIMARY KEY(from_run_id, to_run_id, relation)
      );
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), decision_id TEXT NOT NULL REFERENCES supervisor_decisions(id),
        action_type TEXT NOT NULL DEFAULT 'resume_taskrun', target_type TEXT NOT NULL DEFAULT 'taskrun', target_id TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, requested_at INTEGER NOT NULL, resolved_at INTEGER,
        resolved_by TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(run_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id, requested_at);
      CREATE TABLE IF NOT EXISTS user_input_requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        prompt TEXT NOT NULL, fields_json TEXT NOT NULL, status TEXT NOT NULL,
        response_json TEXT NOT NULL DEFAULT '{}', requested_at INTEGER NOT NULL, submitted_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_input_requests_pending ON user_input_requests(run_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_user_input_requests_run ON user_input_requests(run_id, requested_at);
      CREATE TABLE IF NOT EXISTS context_manifests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        source TEXT NOT NULL, items_json TEXT NOT NULL, stats_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_manifests_run ON context_manifests(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS control_inbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        request_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('steer', 'follow_up')),
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER,
        UNIQUE(run_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_control_inbox_delivery ON control_inbox(run_id, attempt, status, created_at);
      CREATE TABLE IF NOT EXISTS event_consumers (
        run_id TEXT NOT NULL REFERENCES runs(id),
        consumer_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        acked_seq INTEGER NOT NULL DEFAULT 0,
        terminal_acked_seq INTEGER,
        claimed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, consumer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_consumers_updated ON event_consumers(updated_at);
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        assistant_partial TEXT NOT NULL DEFAULT '',
        current_tool_json TEXT NOT NULL DEFAULT '',
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_transcript_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        operation_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        effects_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_operations_run ON operations(run_id, created_at);
      CREATE TABLE IF NOT EXISTS tool_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(run_id, attempt, tool_call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_attempts_guard ON tool_attempts(run_id, tool_name, args_hash, id);
      CREATE TABLE IF NOT EXISTS plan_items (
        run_id TEXT NOT NULL REFERENCES runs(id),
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, item_key)
      );
      CREATE TABLE IF NOT EXISTS run_checks (
        run_id TEXT NOT NULL REFERENCES runs(id),
        check_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        command TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        stale INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, check_key)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        uri TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_learning_policies (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        policy TEXT NOT NULL CHECK (policy IN ('allow','metadata_only','deny')),
        reason TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experience_observations (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id),
        attempt INTEGER,
        lifecycle TEXT NOT NULL DEFAULT 'manual',
        outcome TEXT NOT NULL DEFAULT '',
        event_seq INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user','task_experience','task_failure','user_correction')),
        task_signature TEXT NOT NULL,
        procedure_summary TEXT NOT NULL,
        checks_passed_json TEXT NOT NULL DEFAULT '[]',
        checks_failed_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        learn_policy TEXT NOT NULL CHECK (learn_policy IN ('allow','metadata_only','deny')),
        observation_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_experience_scope_signature ON experience_observations(scope_id, task_signature, source_type, created_at);
      CREATE TABLE IF NOT EXISTS workflow_definitions (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('candidate','active','suspended','deprecated')),
        active_revision_id TEXT,
        deleted_at INTEGER,
        purge_after INTEGER,
        delete_reason TEXT NOT NULL DEFAULT '',
        previous_status TEXT,
        previous_active_revision_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_definitions_scope ON workflow_definitions(scope_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS workflow_revisions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user','task_experience','task_failure','user_correction')),
        source_evidence_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(workflow_id, revision)
      );
      CREATE TABLE IF NOT EXISTS workflow_bindings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        selector_version TEXT NOT NULL,
        relevance_score REAL NOT NULL,
        selected_reason_json TEXT NOT NULL DEFAULT '[]',
        application_mode TEXT NOT NULL DEFAULT 'suggested',
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, attempt, workflow_id, revision_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_application_receipts (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES workflow_bindings(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        task_outcome TEXT NOT NULL,
        application_status TEXT NOT NULL DEFAULT 'exposed' CHECK (application_status IN ('exposed','adopted','partial','rejected')),
        executed_step_ids_json TEXT NOT NULL DEFAULT '[]',
        skipped_steps_json TEXT NOT NULL DEFAULT '[]',
        correction_observed INTEGER NOT NULL DEFAULT 0,
        repeated_tool_calls INTEGER NOT NULL DEFAULT 0,
        continuation_count INTEGER NOT NULL DEFAULT 0,
        verification_mapping_json TEXT NOT NULL DEFAULT '[]',
        required_checks_passed INTEGER NOT NULL,
        required_checks_failed INTEGER NOT NULL,
        attribution_level TEXT NOT NULL CHECK (attribution_level IN ('exposed','adopted','verified_contribution')),
        receipt_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(binding_id, receipt_version)
      );
      CREATE TABLE IF NOT EXISTS workflow_feedback (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        signal TEXT NOT NULL,
        weight REAL NOT NULL,
        adopted INTEGER NOT NULL DEFAULT 1,
        verified INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_revision_proposals (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        base_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        patch_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('candidate','approved','rejected','applied')),
        decided_by TEXT NOT NULL DEFAULT '',
        decision_reason TEXT NOT NULL DEFAULT '',
        decided_at INTEGER,
        applied_revision_id TEXT REFERENCES workflow_revisions(id),
        created_at INTEGER NOT NULL,
        UNIQUE(workflow_id, base_revision_id, reason)
      );
      CREATE TABLE IF NOT EXISTS workflow_status_history (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        previous_status TEXT NOT NULL,
        next_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_distillations (
        evidence_set_hash TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_projection_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        outcome TEXT NOT NULL,
        event_seq INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id, attempt, lifecycle, event_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_learning_projection_pending ON learning_projection_outbox(status, created_at);
      CREATE TABLE IF NOT EXISTS semantic_learning_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('user_message','workflow_eligibility','feedback_attribution')),
        run_id TEXT REFERENCES runs(id),
        attempt INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','failed','completed','dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_learning_jobs_pending ON semantic_learning_jobs(status, next_retry_at, created_at);
      CREATE TABLE IF NOT EXISTS workflow_selector_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        decision TEXT NOT NULL CHECK (decision IN ('selected','excluded')),
        reasons_json TEXT NOT NULL DEFAULT '[]',
        score REAL,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, attempt, workflow_id, revision_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_governance_receipts (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_feature_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        memory_enabled INTEGER NOT NULL DEFAULT 0,
        learning_enabled INTEGER NOT NULL DEFAULT 0,
        auto_execution_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS autonomy_approval_requests (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN ('activate_workflow','apply_revision','start_canary','execute_workflow')),
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        workflow_id TEXT REFERENCES workflow_definitions(id),
        revision_id TEXT REFERENCES workflow_revisions(id),
        proposal_id TEXT REFERENCES workflow_revision_proposals(id),
        binding_id TEXT REFERENCES workflow_bindings(id),
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','revoked','expired','executed')),
        risk_class TEXT NOT NULL CHECK (risk_class IN ('low','medium','high')),
        impact_scope_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        diff_json TEXT NOT NULL DEFAULT '{}',
        rollback_json TEXT NOT NULL DEFAULT '{}',
        requested_by TEXT NOT NULL,
        request_reason TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        decided_by TEXT NOT NULL DEFAULT '',
        decision_reason TEXT NOT NULL DEFAULT '',
        decided_at INTEGER,
        executed_at INTEGER,
        execution_receipt_json TEXT NOT NULL DEFAULT '{}',
        request_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_approvals_scope_status ON autonomy_approval_requests(scope_id,status,created_at);
      CREATE INDEX IF NOT EXISTS idx_autonomy_approvals_target ON autonomy_approval_requests(action_type,target_id,status);
      CREATE TABLE IF NOT EXISTS autonomy_audit_events (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('observe','learn','distill','evolve','approval','execute')),
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        source_run_id TEXT REFERENCES runs(id),
        workflow_id TEXT REFERENCES workflow_definitions(id),
        revision_id TEXT REFERENCES workflow_revisions(id),
        approval_id TEXT REFERENCES autonomy_approval_requests(id),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        receipt_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_audit_scope ON autonomy_audit_events(scope_id,created_at);
      CREATE TABLE IF NOT EXISTS workflow_distillation_jobs (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        signature_terms_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','dead_letter')),
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_token TEXT NOT NULL DEFAULT '',
        lease_until INTEGER,
        fence INTEGER NOT NULL DEFAULT 0,
        workflow_id TEXT REFERENCES workflow_definitions(id),
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(scope_id, task_signature)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_distillation_jobs_claim ON workflow_distillation_jobs(status, lease_until, created_at);
      CREATE TABLE IF NOT EXISTS workflow_distillation_conflicts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES workflow_distillation_jobs(id),
        scope_id TEXT NOT NULL,
        candidate_signature TEXT NOT NULL,
        existing_workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        existing_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        kind TEXT NOT NULL CHECK (kind IN ('duplicate','conflict')),
        similarity REAL NOT NULL,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, existing_workflow_id, existing_revision_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_distillation_conflicts_scope ON workflow_distillation_conflicts(scope_id, status, created_at);
      CREATE TABLE IF NOT EXISTS workflow_evaluations (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        kind TEXT NOT NULL CHECK (kind IN ('shadow','offline_replay','canary')),
        status TEXT NOT NULL CHECK (status IN ('pending','passed','failed','rolled_back')),
        sample_size INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        baseline_rate REAL NOT NULL DEFAULT 0,
        risk_class TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        evaluator_id TEXT NOT NULL DEFAULT '',
        evaluator_version TEXT NOT NULL DEFAULT '',
        dataset_id TEXT NOT NULL DEFAULT '',
        dataset_hash TEXT NOT NULL DEFAULT '',
        baseline_revision_id TEXT REFERENCES workflow_revisions(id),
        candidate_revision_id TEXT REFERENCES workflow_revisions(id),
        evaluation_run_ids_json TEXT NOT NULL DEFAULT '[]',
        check_results_json TEXT NOT NULL DEFAULT '[]',
        receipt_hash TEXT NOT NULL DEFAULT '',
        signature TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_promotions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        previous_revision_id TEXT REFERENCES workflow_revisions(id),
        status TEXT NOT NULL CHECK (status IN ('candidate','canary','promoted','rolled_back','rejected')),
        canary_percent INTEGER NOT NULL DEFAULT 0,
        max_failure_delta REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_canary_bindings (
        id TEXT PRIMARY KEY,
        promotion_id TEXT NOT NULL REFERENCES workflow_promotions(id),
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        scope_id TEXT NOT NULL,
        assignment_key TEXT NOT NULL,
        assignment_hash TEXT NOT NULL,
        bucket INTEGER NOT NULL CHECK (bucket >= 0 AND bucket < 10000),
        variant TEXT NOT NULL CHECK (variant IN ('baseline','candidate')),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        receipt_hash TEXT NOT NULL UNIQUE,
        outcome_status TEXT,
        success INTEGER,
        required_checks INTEGER NOT NULL DEFAULT 0,
        passed_checks INTEGER NOT NULL DEFAULT 0,
        outcome_recorded_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(promotion_id, run_id, attempt)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_canary_outcomes ON workflow_canary_bindings(promotion_id, variant, outcome_recorded_at);
      CREATE TABLE IF NOT EXISTS communication_profiles (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','session','task')),
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','superseded','deleted')),
        active_revision_id TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        previous_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(subject_id, scope_type, scope_id)
      );
      CREATE TABLE IF NOT EXISTS communication_profile_revisions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES communication_profiles(id),
        revision INTEGER NOT NULL,
        values_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user','inferred','governance')),
        change_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(profile_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_communication_profiles_resolve ON communication_profiles(subject_id, scope_type, scope_id, status);
      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        event_seq INTEGER NOT NULL DEFAULT 0,
        task_classification_json TEXT NOT NULL DEFAULT '{}',
        strategy_selected_json TEXT NOT NULL DEFAULT '[]',
        context_used_json TEXT NOT NULL DEFAULT '{}',
        execution_trace_json TEXT NOT NULL DEFAULT '{}',
        outcome_json TEXT NOT NULL DEFAULT '{}',
        attribution_json TEXT NOT NULL DEFAULT '{}',
        policy_json TEXT NOT NULL DEFAULT '{}',
        event_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, attempt, lifecycle, event_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_learning_events_run ON learning_events(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS outcome_labels (
        id TEXT PRIMARY KEY,
        learning_event_id TEXT NOT NULL REFERENCES learning_events(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        taxonomy_version TEXT NOT NULL,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outcome_labels_run ON outcome_labels(run_id, attempt, label);
      CREATE TABLE IF NOT EXISTS user_corrections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT REFERENCES runs(id),
        attempt INTEGER,
        message_id INTEGER REFERENCES messages(id),
        correction_type TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'run',
        target_id TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('explicit_user','router','governance')),
        applied INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_corrections_run ON user_corrections(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS feedback_attribution_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        weight REAL NOT NULL,
        basis TEXT NOT NULL,
        context_manifest_id TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('pending','applied','skipped','failed','dead_letter')),
        error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        applied_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_attribution_run ON feedback_attribution_receipts(run_id, attempt, status);
      CREATE TABLE IF NOT EXISTS semantic_judgment_cache (
        cache_key TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_judgment_cache_expiry ON semantic_judgment_cache(expires_at);
      ${ATTEMPT_SCHEMA_V30_SQL}
    `);
    const current = this.db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as { version: number } | undefined;
    previousVersion = current?.version;
    if (current && current.version > SCHEMA_VERSION) throw new Error(`Database schema version ${current.version} is newer than supported version ${SCHEMA_VERSION}`);
    this.ensureColumn("runs", "attempt", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("runs", "resumed_at", "INTEGER");
    this.ensureColumn("runs", "usage_input", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_output", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_cache_read", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_cache_write", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_total_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_cost", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("run_continuations", "lease_owner", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("run_continuations", "lease_until", "INTEGER");
    this.ensureColumn("run_continuations", "heartbeat_at", "INTEGER");
    this.ensureColumn("runs", "contract_json", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("experience_observations", "lifecycle", "TEXT NOT NULL DEFAULT 'manual'");
    this.ensureColumn("experience_observations", "outcome", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("experience_observations", "event_seq", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("learning_projection_outbox", "snapshot_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("feedback_attribution_receipts", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("feedback_attribution_receipts", "next_retry_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("semantic_learning_jobs", "lease_owner", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("semantic_learning_jobs", "lease_token", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("semantic_learning_jobs", "lease_until", "INTEGER");
    this.ensureColumn("semantic_learning_jobs", "fence", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_semantic_learning_jobs_claim ON semantic_learning_jobs(status, next_retry_at, lease_until, created_at)");
    this.ensureColumn("workflow_definitions", "deleted_at", "INTEGER");
    this.ensureColumn("workflow_definitions", "purge_after", "INTEGER");
    this.ensureColumn("workflow_definitions", "delete_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_definitions", "previous_status", "TEXT");
    this.ensureColumn("workflow_definitions", "previous_active_revision_id", "TEXT");
    this.ensureColumn("workflow_application_receipts", "application_status", "TEXT NOT NULL DEFAULT 'exposed'");
    this.ensureColumn("workflow_application_receipts", "executed_step_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("workflow_application_receipts", "skipped_steps_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("workflow_application_receipts", "correction_observed", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workflow_application_receipts", "repeated_tool_calls", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workflow_application_receipts", "continuation_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workflow_application_receipts", "verification_mapping_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("workflow_revision_proposals", "patch_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("workflow_revision_proposals", "decided_by", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_revision_proposals", "decision_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_revision_proposals", "decided_at", "INTEGER");
    this.ensureColumn("workflow_revision_proposals", "applied_revision_id", "TEXT");
    this.ensureColumn("workflow_revision_proposals", "base_spec_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_revision_proposals", "proposed_spec_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_revision_proposals", "changed_paths_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("workflow_revisions", "spec_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_evaluations", "evaluator_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_evaluations", "evaluator_version", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_evaluations", "dataset_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_evaluations", "dataset_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_evaluations", "baseline_revision_id", "TEXT");
    this.ensureColumn("workflow_evaluations", "candidate_revision_id", "TEXT");
    this.ensureColumn("workflow_evaluations", "evaluation_run_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("workflow_evaluations", "check_results_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("workflow_evaluations", "receipt_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("workflow_evaluations", "signature", "TEXT NOT NULL DEFAULT ''");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_evaluations_receipt_hash ON workflow_evaluations(receipt_hash) WHERE receipt_hash <> ''");
    this.db.prepare(`UPDATE workflow_revisions SET spec_hash=lower(hex(randomblob(32))) WHERE spec_hash=''`).run();
    this.db.prepare(`UPDATE workflow_revision_proposals SET status='rejected',decision_reason='Legacy empty proposal invalidated by schema v20',decided_at=? WHERE trim(patch_json) IN ('','{}') AND status IN ('candidate','approved')`).run(now());
    this.ensureColumn("session_supervisor_inbox", "summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("session_supervisor_inbox", "objectives_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("session_supervisor_inbox", "intent", "TEXT NOT NULL DEFAULT 'new_task'");
    this.ensureColumn("session_supervisor_inbox", "target_run_id", "TEXT");
    this.ensureColumn("session_supervisor_inbox", "priority", "INTEGER NOT NULL DEFAULT 500");
    this.ensureColumn("session_supervisor_inbox", "urgency", "TEXT NOT NULL DEFAULT 'normal'");
    this.ensureColumn("session_supervisor_inbox", "relation", "TEXT NOT NULL DEFAULT 'independent'");
    this.ensureColumn("session_supervisor_inbox", "acceptance_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("session_supervisor_inbox", "scope", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("session_supervisor_inbox", "non_goals_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("session_supervisor_inbox", "confidence", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("session_supervisor_inbox", "decision_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("session_supervisor_inbox", "router_version", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("session_supervisor_inbox", "manual_order", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("gate_evaluations", "evaluator", "TEXT NOT NULL DEFAULT 'system'");
    this.ensureColumn("gate_evaluations", "evaluator_model", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("gate_evaluations", "summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("gate_evaluations", "criterion_coverage_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("approval_requests", "action_type", "TEXT NOT NULL DEFAULT 'resume_taskrun'");
    this.ensureColumn("approval_requests", "target_type", "TEXT NOT NULL DEFAULT 'taskrun'");
    this.ensureColumn("approval_requests", "target_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("approval_requests", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.db.prepare("UPDATE approval_requests SET target_id=run_id WHERE target_id=''").run();
    this.ensureColumn("supervisor_decisions", "evaluator", "TEXT NOT NULL DEFAULT 'system'");
    this.ensureColumn("supervisor_decisions", "evaluator_model", "TEXT NOT NULL DEFAULT ''");
    this.migrateSpawnProposalsToSessionInbox();
    this.db.prepare(`UPDATE run_continuations SET status = 'cancelled',
      error = 'Superseded while enforcing one active continuation per Run', completed_at = ?,
      lease_owner = '', lease_until = NULL, heartbeat_at = NULL
      WHERE status IN ('queued', 'running') AND id NOT IN (
        SELECT id FROM run_continuations active
        WHERE active.run_id = run_continuations.run_id AND active.status IN ('queued', 'running')
        ORDER BY active.ordinal LIMIT 1
      )`).run(now());
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_continuations_one_active
      ON run_continuations(run_id) WHERE status IN ('queued', 'running')`);
    migrateAttemptsV30(this.db, current?.version, now());
    if (current?.version === undefined || current.version <= 31) {
      migrateGovernanceV31(this.db, current?.version, now());
    }
    if (current?.version === undefined || current.version <= 32) {
      migrateCapabilityAuthorizationV32(
        this.db,
        current?.version === undefined || current.version < 31 ? 31 : current.version,
        now(),
      );
    } else {
      assertCapabilityAuthorizationV32Schema(this.db);
    }
    this.db.prepare(`INSERT INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
      .run(current?.version === SCHEMA_VERSION ? SCHEMA_VERSION : 32, now());
    });
    foundationMigration();

    const v33PreviousVersion = previousVersion !== undefined && previousVersion >= 33 ? 33 : 32;
    prepareLearningIntegrationV33(this.db, v33PreviousVersion, now());
    const learningIntegrationMigration = this.db.transaction(() => {
      migrateLearningIntegrationV33(this.db, v33PreviousVersion, now());
      this.db.prepare(`UPDATE schema_meta SET version=33,updated_at=? WHERE id=1`).run(now());
    });
    learningIntegrationMigration();

    const workspaceExecutionProfileMigration = this.db.transaction(() => {
      migrateWorkspaceExecutionProfileV34(this.db, previousVersion !== undefined && previousVersion >= 34 ? 34 : 33, this.defaultModelId);
      this.db.prepare(`UPDATE schema_meta SET version=34,updated_at=? WHERE id=1`).run(now());
    });
    workspaceExecutionProfileMigration();
    assertWorkspaceExecutionProfileV34Schema(this.db);

    const workspaceGoalsMigration = this.db.transaction(() => {
      migrateWorkspaceGoalsV35(this.db, previousVersion === 35 ? 35 : 34);
      this.db.prepare(`UPDATE schema_meta SET version=?,updated_at=? WHERE id=1`).run(SCHEMA_VERSION, now());
    });
    workspaceGoalsMigration();
    assertWorkspaceGoalsV35Schema(this.db);
  }

  private attemptId(runId: string, ordinal: number) {
    return `attempt:${runId}:${ordinal}`;
  }

  private projectAttempt(input: {
    runId: RunId;
    ordinal: number;
    trigger: "initial" | "resume" | "continuation" | "retry" | "input" | "recovery";
    status: RunStatus | "superseded";
    scenario: "initial" | "resume" | "continuation" | "retry" | "input" | "recovery" | "terminal";
    reason?: string;
    legacyEventSeq?: number;
    timestamp?: number;
  }) {
    const timestamp = input.timestamp ?? now();
    const attemptId = this.attemptId(input.runId, input.ordinal);
    const existing = this.db.prepare(`SELECT status,trigger,version,started_at as startedAt FROM attempts WHERE id=?`)
      .get(attemptId) as { status: string; trigger: string; version: number; startedAt: number } | undefined;
    const active = input.status === "running";
    if (active) {
      this.db.prepare(`UPDATE attempts SET active=0,status=CASE WHEN status='running' THEN 'superseded' ELSE status END,
        completed_at=COALESCE(completed_at,?),updated_at=? WHERE run_id=? AND id<>? AND active=1`)
        .run(timestamp, timestamp, input.runId, attemptId);
    }
    if (existing) {
      this.db.prepare(`UPDATE attempts SET status=?,active=?,version=version+1,legacy_event_seq=?,updated_at=?,
        completed_at=CASE WHEN ?=1 THEN NULL ELSE COALESCE(completed_at,?) END,
        reconstruction_state='complete' WHERE id=?`)
        .run(input.status, Number(active), input.legacyEventSeq ?? 0, timestamp, Number(active), timestamp, attemptId);
    } else {
      this.db.prepare(`INSERT INTO attempts
        (id,run_id,ordinal,trigger,status,active,version,legacy_event_seq,started_at,updated_at,completed_at,reconstruction_state)
        VALUES (?,?,?,?,?,?,1,?,?,?,?,'complete')`).run(
        attemptId, input.runId, input.ordinal, input.trigger, input.status, Number(active), input.legacyEventSeq ?? 0,
        timestamp, timestamp, active ? null : timestamp,
      );
    }
    const projected = this.db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
      legacy_event_seq as legacyEventSeq FROM attempts WHERE id=?`).get(attemptId) as Record<string, unknown>;
    const run = this.db.prepare("SELECT id as runId,attempt as ordinal,status,last_event_seq as legacyEventSeq FROM runs WHERE id=?")
      .get(input.runId) as Record<string, unknown> | undefined;
    const legacy = { ...run, active: run?.status === "running" };
    const comparable = { runId: projected.runId, ordinal: projected.ordinal, status: projected.status, legacyEventSeq: projected.legacyEventSeq, active: Boolean(projected.active) };
    const mismatch = JSON.stringify(legacy) !== JSON.stringify(comparable);
    const version = Number(projected.version);
    this.db.prepare(`INSERT INTO attempt_transition_audit
      (id,attempt_id,run_id,ordinal,from_status,to_status,trigger,scenario,reason,version,legacy_event_seq,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), attemptId, input.runId, input.ordinal, existing?.status ?? null, input.status,
      String(projected.trigger), input.scenario, input.reason ?? "", version, input.legacyEventSeq ?? 0, timestamp,
    );
    this.db.prepare(`INSERT INTO attempt_shadow_comparisons
      (id,attempt_id,scenario,legacy_json,projected_json,mismatch,gate_sample,created_at)
      VALUES (?,?,?,?,?,?,0,?)`).run(
      randomUUID(), attemptId, input.scenario, JSON.stringify(legacy), JSON.stringify(comparable), Number(mismatch), timestamp,
    );
  }

  /**
   * Reconciles in-flight work before runtime startup.
   *
   * Receipt-bound capability operations use a fail-closed protocol: an effect
   * that started becomes outcome_unknown, while an authorized effect that did
   * not start becomes cancelled/restart_before_effect. Both are terminal exact
   * replays and retain their append-only allow receipt and approval use. Legacy
   * running operations retain the historical outcome_unknown/service_restart
   * projection. Production supplies the current WriterFenceGuard as `guard`.
   */
  runPostMigrationRecovery(guard?: StoreMutationRunner) {
    const recover = (db: Database.Database) => {
      const timestamp = now();
      const malformedCapability = db.prepare(`SELECT operation.id FROM operations operation
        WHERE operation.status IN ('authorized','running')
          AND operation.attempt_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM approval_receipts receipt
            WHERE receipt.operation_id=operation.id AND receipt.outcome='allow')
          AND NOT (
            operation.status='authorized' AND operation.stage='authorization_committed'
            OR operation.status='running' AND operation.stage='effect_started'
          ) LIMIT 1`).get() as { id: string } | undefined;
      if (malformedCapability) {
        throw new Error(`Capability operation ${malformedCapability.id} has invalid restart state`);
      }
      const capabilityRunning = db.prepare(`UPDATE operations SET
        status='outcome_unknown',stage='outcome_unknown',
        error='Service restarted after capability effect began; outcome is unknown',
        updated_at=?,completed_at=?
        WHERE status='running' AND stage='effect_started' AND attempt_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM approval_receipts receipt
            WHERE receipt.operation_id=operations.id AND receipt.outcome='allow')`)
        .run(timestamp, timestamp).changes;
      const capabilityAuthorized = db.prepare(`UPDATE operations SET
        status='cancelled',stage='restart_before_effect',
        error='Service restarted before capability effect began; execution was cancelled',
        updated_at=?,completed_at=?
        WHERE status='authorized' AND stage='authorization_committed' AND attempt_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM approval_receipts receipt
            WHERE receipt.operation_id=operations.id AND receipt.outcome='allow')`)
        .run(timestamp, timestamp).changes;
      const legacyOperations = db.prepare(`UPDATE operations SET
        status='outcome_unknown',stage='service_restart',
        error='Service restarted before operation outcome was recorded',updated_at=?
        WHERE status='running' AND NOT (
          attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM approval_receipts receipt
            WHERE receipt.operation_id=operations.id AND receipt.outcome='allow')
        )`).run(timestamp).changes;
      const operations = capabilityRunning + capabilityAuthorized + legacyOperations;
      const controlInbox = db.prepare("UPDATE control_inbox SET status = 'outcome_unknown', error = 'Service restarted while Pi delivery outcome was unknown', completed_at = ? WHERE status = 'delivering'").run(timestamp).changes;
      return { operations, controlInbox };
    };
    if (guard) return guard.run(recover);
    return this.db.transaction(() => recover(this.db)).immediate();
  }

  getSchemaVersion() {
    return (this.db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as { version: number }).version;
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private migrateSpawnProposalsToSessionInbox() {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spawn_proposals'").get();
    if (!exists) return;
    const rows = this.db.prepare(`SELECT p.id,p.run_id as runId,p.goal,p.acceptance_json as acceptanceJson,p.relation,p.status,
      p.spawned_run_id as spawnedRunId,p.created_at as createdAt,p.updated_at as updatedAt,r.session_id as sessionId
      FROM spawn_proposals p JOIN runs r ON r.id=p.run_id ORDER BY p.created_at,p.id`).all() as Array<{id:string;runId:string;goal:string;acceptanceJson:string;relation:string;status:string;spawnedRunId:string;createdAt:number;updatedAt:number;sessionId:string}>;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO session_supervisor_inbox
      (id,session_id,request_id,content,status,decision,run_id,error,position,created_at,updated_at,claimed_at,started_at,summary,objectives_json,intent,target_run_id,priority,urgency,relation,acceptance_json,scope,non_goals_json,confidence,decision_reason,router_version,manual_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
    for (const row of rows) {
      if (row.status === "spawned" && row.spawnedRunId) continue;
      const status = row.status === "rejected" ? "deleted" : "queued";
      const decision = row.status === "rejected" ? "delete" : "pending";
      const relation = ["parallel","follow_up"].includes(row.relation) ? row.relation : "independent";
      const timing = row.relation === "parallel" ? "parallel" : "follow_up";
      const position = (this.db.prepare("SELECT COALESCE(MAX(position),0)+1 as position FROM session_supervisor_inbox WHERE session_id=?").get(row.sessionId) as {position:number}).position;
      insert.run(`migrated:${row.id}`,row.sessionId,`spawn-migration:${row.id}`,row.goal,status,decision,null,`Migrated from legacy SpawnProposal ${row.id} (${row.status})`,position,row.createdAt,row.updatedAt,null,null,row.goal,JSON.stringify([{id:"objective-1",summary:row.goal,timing,kind:"other"}]),row.relation === "parallel" ? "parallel_task" : "new_task",row.runId,500,"normal",relation,row.acceptanceJson,row.goal,"[]",1,"Migrated from legacy SpawnProposal into Session Inbox","spawn-proposal-migration-v1");
    }
    this.db.exec("DROP TABLE spawn_proposals");
  }

  createSession(title = "New workspace", requestId?: string): Session {
    const transaction = this.db.transaction(() => {
      if (requestId) {
        const existing = this.db.prepare("SELECT session_id as sessionId FROM session_requests WHERE request_id = ?").get(requestId) as { sessionId: string } | undefined;
        if (existing) return this.getSession(existing.sessionId)!;
      }
      const session: Session = { id: randomUUID(), title, modelId: this.defaultModelId, reasoningEffort: "high", createdAt: now(), updatedAt: now(), latestRunStatus: null, latestRunPhase: null };
      this.db.prepare("INSERT INTO sessions (id, title, model_id, reasoning_effort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(session.id, session.title, session.modelId, session.reasoningEffort, session.createdAt, session.updatedAt);
      if (requestId) this.db.prepare("INSERT INTO session_requests (request_id,session_id,created_at) VALUES (?,?,?)").run(requestId, session.id, session.createdAt);
      return session;
    });
    return transaction();
  }

  listSessions(): Session[] {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.model_id as modelId, sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.rowid DESC LIMIT 1
      )
      ORDER BY sessions.updated_at DESC
    `).all() as Session[];
  }

  getSession(id: SessionId): Session | undefined {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.model_id as modelId, sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.rowid DESC LIMIT 1
      )
      WHERE sessions.id = ?
    `).get(id) as Session | undefined;
  }

  updateSession(id: SessionId, settings: SessionSettingsUpdate): Session | undefined {
    const current = this.getSession(id);
    if (!current) return undefined;
    const title = settings.title === undefined ? current.title : settings.title.trim();
    const modelId = settings.modelId === undefined ? current.modelId : settings.modelId.trim();
    const reasoningEffort = settings.reasoningEffort ?? current.reasoningEffort;
    if (!title || !modelId || !REASONING_EFFORTS.has(reasoningEffort)) return undefined;
    this.db.prepare("UPDATE sessions SET title = ?, model_id = ?, reasoning_effort = ?, updated_at = ? WHERE id = ?")
      .run(title, modelId, reasoningEffort, now(), id);
    return this.getSession(id);
  }

  renameSession(id: SessionId, title: string): Session | undefined {
    return this.updateSession(id, { title });
  }

  private touchSession(id: SessionId) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  listMessages(sessionId: SessionId, limit = 200, beforeId?: number): Message[] {
    const boundary = beforeId && Number.isFinite(beforeId) ? Math.max(1, Math.floor(beforeId)) : Number.MAX_SAFE_INTEGER;
    return this.db.prepare(`
      SELECT id, sessionId, role, content, createdAt FROM (
        SELECT id, session_id as sessionId, role, content, created_at as createdAt
        FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, boundary, limit) as Message[];
  }

  appendMessage(sessionId: SessionId, role: Message["role"], content: string): Message {
    const createdAt = now();
    const result = this.db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, role, content, createdAt);
    this.touchSession(sessionId);
    return { id: Number(result.lastInsertRowid), sessionId, role, content, createdAt };
  }

  enqueueSessionInbox(sessionId: SessionId, content: string, analysis: SessionInputAnalysis, requestId: string = randomUUID()): SessionInboxItem {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id = ? AND request_id = ?").get(sessionId, requestId) as { id: string } | undefined;
      if (existing) return this.getSessionInboxItem(existing.id)!;
      const timestamp = now();
      const position = (this.db.prepare("SELECT COALESCE(MAX(position),0)+1 as position FROM session_supervisor_inbox WHERE session_id = ? AND status = 'queued'").get(sessionId) as { position: number }).position;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO session_supervisor_inbox
        (id,session_id,request_id,content,status,decision,position,created_at,updated_at,summary,objectives_json,intent,target_run_id,priority,urgency,relation,acceptance_json,scope,non_goals_json,confidence,decision_reason,router_version)
        VALUES (?,?,?,?,'queued','pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, sessionId, requestId, content, position, timestamp, timestamp, analysis.summary, JSON.stringify(analysis.objectives ?? [{ id: "objective-1", summary: analysis.summary, timing: "current", kind: "other" }]), analysis.intent, analysis.targetRunId, analysis.priority, analysis.urgency, analysis.relation, JSON.stringify(analysis.acceptanceCriteria), analysis.scope, JSON.stringify(analysis.nonGoals), analysis.confidence, analysis.reason, analysis.routerVersion);
      return this.getSessionInboxItem(id)!;
    });
    return transaction();
  }

  private hydrateSessionInbox(row: Record<string, unknown> | undefined): SessionInboxItem | undefined {
    if (!row) return undefined;
    const acceptanceCriteria = JSON.parse(String(row.acceptanceJson || "[]")) as string[];
    const nonGoals = JSON.parse(String(row.nonGoalsJson || "[]")) as string[];
    const objectives = JSON.parse(String(row.objectivesJson || "[]")) as TaskObjective[];
    const fallbackObjective = { id: "objective-1", summary: String(row.summary || row.content || ""), timing: row.relation === "parallel" ? "parallel" : row.relation === "follow_up" ? "follow_up" : "current", kind: "other" } as const;
    return { ...row, manualOrder: Boolean(row.manualOrder), analysis: { summary: String(row.summary || row.content || ""), objectives: objectives.length ? objectives : [fallbackObjective], intent: row.intent, targetRunId: row.targetRunId || null, priority: Number(row.priority || 0), urgency: row.urgency, relation: row.relation, acceptanceCriteria, scope: String(row.scope || row.summary || ""), nonGoals, confidence: Number(row.confidence || 0), reason: String(row.decisionReason || ""), routerVersion: String(row.routerVersion || "") } } as SessionInboxItem;
  }

  private sessionInboxSelect(where: string) {
    return `SELECT id,session_id as sessionId,request_id as requestId,content,status,decision,run_id as runId,error,position,
      created_at as createdAt,updated_at as updatedAt,claimed_at as claimedAt,started_at as startedAt,
      summary,objectives_json as objectivesJson,intent,target_run_id as targetRunId,priority,urgency,relation,acceptance_json as acceptanceJson,scope,
      non_goals_json as nonGoalsJson,confidence,decision_reason as decisionReason,router_version as routerVersion,manual_order as manualOrder
      FROM session_supervisor_inbox ${where}`;
  }

  getSessionInboxItem(id: string): SessionInboxItem | undefined {
    return this.hydrateSessionInbox(this.db.prepare(this.sessionInboxSelect("WHERE id = ?")).get(id) as Record<string, unknown> | undefined);
  }

  getSessionSubmission(sessionId: SessionId, requestId: string): SessionInboxItem | undefined {
    return this.hydrateSessionInbox(this.db.prepare(this.sessionInboxSelect("WHERE session_id = ? AND request_id = ?")).get(sessionId, requestId) as Record<string, unknown> | undefined);
  }

  listSessionInbox(sessionId: SessionId, includeTerminal = false): SessionInboxItem[] {
    const rows = this.db.prepare(`${this.sessionInboxSelect(`WHERE session_id = ? ${includeTerminal ? "" : "AND status IN ('queued','claimed')"}`)} ORDER BY
      manual_order DESC, CASE WHEN manual_order=1 THEN position END ASC, CASE urgency WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
      priority DESC, position, created_at, id`).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateSessionInbox(row)!);
  }

  routeSessionInboxItem(id: string, sessionId: SessionId, decision: "steer" | "follow_up" | "discussion", runId: RunId | null, error = "") {
    const timestamp = now();
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET status='routed',decision=?,run_id=?,error=?,claimed_at=COALESCE(claimed_at,?),started_at=COALESCE(started_at,?),updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(decision, runId, error, timestamp, timestamp, timestamp, id, sessionId);
    return changed.changes === 1 ? this.getSessionInboxItem(id) : undefined;
  }

  findMergeCandidate(sessionId: SessionId, analysis: SessionInputAnalysis) {
    const normalized = analysis.summary.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!normalized) return undefined;
    return this.listSessionInbox(sessionId).find((item) => item.status === "queued" && item.decision === "pending" && item.analysis.intent === analysis.intent && item.analysis.summary.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === normalized);
  }

  markSessionInboxDuplicate(sourceId: string, targetId: string, sessionId: SessionId) {
    const timestamp = now();
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET status='deleted',decision='merge',error=?,updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(`Duplicate of ${targetId}`, timestamp, sourceId, sessionId);
    return changed.changes === 1 ? this.getSessionInboxItem(sourceId) : undefined;
  }

  updateSessionInboxItem(id: string, sessionId: SessionId, content: string, analysis?: SessionInputAnalysis) {
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    const resolved = analysis ?? { ...this.getSessionInboxItem(id)?.analysis, summary: trimmed.slice(0, 120), scope: trimmed.slice(0, 120) } as SessionInputAnalysis;
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET content=?,summary=?,objectives_json=?,intent=?,target_run_id=?,priority=?,urgency=?,relation=?,
      acceptance_json=?,scope=?,non_goals_json=?,confidence=?,decision_reason=?,router_version=?,updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`)
      .run(trimmed, resolved.summary, JSON.stringify(resolved.objectives), resolved.intent, resolved.targetRunId, resolved.priority, resolved.urgency, resolved.relation,
        JSON.stringify(resolved.acceptanceCriteria), resolved.scope, JSON.stringify(resolved.nonGoals), resolved.confidence, resolved.reason,
        resolved.routerVersion, now(), id, sessionId).changes;
    return changed === 1 ? this.getSessionInboxItem(id) : undefined;
  }

  reorderSessionInbox(sessionId: SessionId, itemIds: string[]) {
    const transaction = this.db.transaction(() => {
      const queued = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id=? AND status='queued' ORDER BY position,created_at,id")
        .all(sessionId) as Array<{ id: string }>;
      const currentIds = queued.map((item) => item.id);
      if (itemIds.length !== currentIds.length || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !currentIds.includes(id))) return undefined;
      const timestamp = now();
      const update = this.db.prepare("UPDATE session_supervisor_inbox SET position=?,updated_at=? WHERE id=? AND session_id=? AND status='queued'");
      itemIds.forEach((id, index) => update.run(index + 1, timestamp, id, sessionId));
      this.db.prepare("UPDATE session_supervisor_inbox SET manual_order=1 WHERE session_id=? AND status='queued'").run(sessionId);
      return this.listSessionInbox(sessionId);
    });
    return transaction();
  }

  deleteSessionInboxItem(id: string, sessionId: SessionId) {
    const timestamp = now();
    return this.db.prepare(`UPDATE session_supervisor_inbox SET status='deleted',decision='delete',updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(timestamp, id, sessionId).changes === 1;
  }

  decideSessionInboxItem(id: string, sessionId: SessionId, decision: "pending" | "defer") {
    return this.db.prepare("UPDATE session_supervisor_inbox SET decision=?,updated_at=? WHERE id=? AND session_id=? AND status='queued'").run(decision,now(),id,sessionId).changes === 1;
  }

  mergeSessionInboxItems(sourceId: string, targetId: string, sessionId: SessionId) {
    if (sourceId === targetId) return false;
    const transaction = this.db.transaction(() => {
      const source = this.getSessionInboxItem(sourceId); const target = this.getSessionInboxItem(targetId);
      if (!source || !target || source.sessionId !== sessionId || target.sessionId !== sessionId || source.status !== "queued" || target.status !== "queued") return false;
      const content = `${target.content}

Additional queued instruction:
${source.content}`;
      const timestamp = now();
      const mergedCriteria = [...new Set([...target.analysis.acceptanceCriteria, ...source.analysis.acceptanceCriteria])];
      const mergedSources = [target.analysis.summary, source.analysis.summary].filter(Boolean);
      const summary = mergedSources.join(" + ").slice(0, 120);
      const scope = [target.analysis.scope, source.analysis.scope].filter(Boolean).join("; ");
      const priority = Math.max(target.analysis.priority, source.analysis.priority);
      const urgencyOrder = { low: 1, normal: 2, high: 3, critical: 4 } as const;
      const urgency = urgencyOrder[source.analysis.urgency] > urgencyOrder[target.analysis.urgency] ? source.analysis.urgency : target.analysis.urgency;
      this.db.prepare(`UPDATE session_supervisor_inbox SET content=?,summary=?,acceptance_json=?,scope=?,priority=?,urgency=?,
        confidence=?,decision_reason=?,decision='pending',updated_at=? WHERE id=? AND status='queued'`)
        .run(content, summary, JSON.stringify(mergedCriteria), scope, priority, urgency,
          Math.min(target.analysis.confidence, source.analysis.confidence), `Merged queued instructions ${target.id} and ${source.id}`, timestamp, targetId);
      this.db.prepare("UPDATE session_supervisor_inbox SET status='deleted',decision='merge',error=?,updated_at=? WHERE id=? AND status='queued'").run(`Merged into ${targetId}`,timestamp,sourceId);
      return true;
    });
    return transaction();
  }

  claimNextSessionInbox(sessionId: SessionId) {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT 1 FROM runs
        WHERE session_id = ? AND (
          status IN ('running','waiting_input') OR (
            status IN ('blocked','interrupted') AND id = (
              SELECT latest.id FROM runs latest WHERE latest.session_id = ? ORDER BY latest.rowid DESC LIMIT 1
            )
          )
        ) LIMIT 1`).get(sessionId, sessionId);
      if (active) return undefined;
      const item = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id = ? AND status = 'queued' AND decision = 'pending' ORDER BY manual_order DESC, CASE WHEN manual_order=1 THEN position END ASC, CASE urgency WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC, priority DESC, position, created_at, id LIMIT 1").get(sessionId) as { id: string } | undefined;
      if (!item) return undefined;
      return this.claimSessionInboxItem(item.id, sessionId);
    });
    return transaction();
  }

  claimSessionInboxNow(itemId: string, sessionId: SessionId, allowApprovedParallel = false) {
    const transaction = this.db.transaction(() => {
      const item = this.getSessionInboxItem(itemId);
      if (!item || item.sessionId !== sessionId || item.status !== "queued") return { status: "not_queued" as const };
      const running = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
      if (running && !(allowApprovedParallel && item.analysis.relation === "parallel" && item.analysis.targetRunId === running.id)) return { status: "running" as const, runId: running.id };
      const continuation = this.db.prepare(`SELECT c.id FROM run_continuations c
        JOIN runs r ON r.id = c.run_id
        WHERE r.session_id = ? AND r.status IN ('blocked','interrupted') AND c.status IN ('queued','running') LIMIT 1`).get(sessionId) as { id: string } | undefined;
      if (continuation) return { status: "continuation" as const, continuationId: continuation.id };
      const claimed = this.claimSessionInboxItem(itemId, sessionId);
      return claimed ? { status: "started" as const, ...claimed } : { status: "not_queued" as const };
    });
    return transaction();
  }

  private claimSessionInboxItem(itemId: string, sessionId: SessionId) {
    const timestamp = now();
    const claimed = this.db.prepare("UPDATE session_supervisor_inbox SET status='claimed',decision='start_taskrun',claimed_at=?,updated_at=? WHERE id=? AND session_id=? AND status='queued'").run(timestamp,timestamp,itemId,sessionId);
    if (claimed.changes !== 1) return undefined;
    const inbox = this.getSessionInboxItem(itemId)!;
    const contract: TaskRunContractSnapshot = { sourceInput: inbox.content, summary: inbox.analysis.summary, objectives: inbox.analysis.objectives, acceptanceCriteria: inbox.analysis.acceptanceCriteria, scope: inbox.analysis.scope, nonGoals: inbox.analysis.nonGoals, sourceInboxIds: [inbox.id], parentRunId: inbox.analysis.targetRunId, relation: inbox.analysis.relation, intent: inbox.analysis.intent, decisionReason: inbox.analysis.reason, routerVersion: inbox.analysis.routerVersion };
    const run = this.createRun(sessionId, inbox.analysis.summary || inbox.content, `inbox:${inbox.id}`, contract);
    if (contract.parentRunId && contract.parentRunId !== run.id) {
      const edgeRelation = contract.relation === "parallel" || contract.relation === "follow_up" || contract.relation === "derived" || contract.relation === "depends_on" ? contract.relation : "derived";
      this.db.prepare("INSERT OR IGNORE INTO taskrun_edges (from_run_id,to_run_id,relation,reason,created_at) VALUES (?,?,?,?,?)")
        .run(contract.parentRunId,run.id,edgeRelation,`Session Inbox ${inbox.id}: ${contract.decisionReason}`,timestamp);
    }
    this.db.prepare("UPDATE session_supervisor_inbox SET status='started',run_id=?,started_at=?,updated_at=? WHERE id=? AND status='claimed'").run(run.id,timestamp,timestamp,inbox.id);
    return { item: this.getSessionInboxItem(inbox.id)!, run };
  }

  recordSessionInboxLaunchFailure(itemId: string, runId: RunId, error: string) {
    const timestamp = now();
    this.db.prepare("UPDATE session_supervisor_inbox SET status='started',error=?,updated_at=? WHERE id=? AND run_id=?").run(error,timestamp,itemId,runId);
  }

  private isInboxLaunchRetryable(runId: RunId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_supervisor_inbox i
      JOIN runs r ON r.id = i.run_id
      JOIN run_events e ON e.run_id = i.run_id
      WHERE i.run_id = ? AND i.status = 'started' AND r.status = 'failed' AND e.type = 'run.failed'
        AND json_extract(e.data, '$.reason') = 'runtime_initialization_failed'
        AND json_extract(e.data, '$.retryable') = 1
        AND NOT EXISTS (SELECT 1 FROM run_events newer WHERE newer.run_id = e.run_id AND newer.type = 'run.failed' AND newer.seq > e.seq)
      ORDER BY e.seq DESC LIMIT 1`).get(runId));
  }

  retryInboxLaunch(runId: RunId) {
    const transaction = this.db.transaction(() => {
      const target = this.db.prepare(`SELECT r.id, r.session_id as sessionId, r.status, r.attempt, i.id as inboxItemId, i.content
        FROM runs r JOIN session_supervisor_inbox i ON i.run_id = r.id
        WHERE r.id = ? AND i.status = 'started'`).get(runId) as { id: RunId; sessionId: SessionId; status: RunStatus; attempt: number; inboxItemId: string; content: string } | undefined;
      if (!target) return { status: "not_retryable" as const };
      if (target.status !== "failed" || !this.isInboxLaunchRetryable(runId)) return { status: "not_retryable" as const };
      const running = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' AND id <> ? LIMIT 1").get(target.sessionId, runId) as { id: string } | undefined;
      if (running) return { status: "running" as const, runId: running.id };
      const continuation = this.db.prepare(`SELECT c.id FROM run_continuations c
        JOIN runs r ON r.id = c.run_id
        WHERE r.session_id = ? AND c.run_id <> ? AND r.status IN ('blocked','interrupted') AND c.status IN ('queued','running') LIMIT 1`).get(target.sessionId, runId) as { id: string } | undefined;
      if (continuation) return { status: "continuation" as const, continuationId: continuation.id };
      const resumedAt = now();
      const nextAttempt = target.attempt + 1;
      const updated = this.db.prepare(`UPDATE runs SET status='running', phase='discover', blocked_reason='', completed_at=NULL,
        attempt=?, resumed_at=?, updated_at=? WHERE id=? AND status='failed' AND attempt=?`).run(nextAttempt,resumedAt,resumedAt,runId,target.attempt);
      if (updated.changes !== 1) return { status: "not_retryable" as const };
      this.db.prepare("UPDATE session_supervisor_inbox SET error='',updated_at=? WHERE id=? AND run_id=? AND status='started'").run(resumedAt,target.inboxItemId,runId);
      this.projectAttempt({
        runId, ordinal: nextAttempt, trigger: "retry", status: "running", scenario: "retry",
        legacyEventSeq: this.getRun(runId)?.lastEventSeq ?? 0, timestamp: resumedAt,
      });
      return { status: "started" as const, item: this.getSessionInboxItem(target.inboxItemId)!, run: this.getRun(runId)! };
    });
    return transaction();
  }

  listSessionsWithQueuedInbox() {
    return (this.db.prepare("SELECT DISTINCT session_id as sessionId FROM session_supervisor_inbox WHERE status='queued'").all() as Array<{sessionId:string}>).map((row)=>row.sessionId);
  }

  createRun(sessionId: SessionId, goal: string, requestId: string = randomUUID(), contract: TaskRunContractSnapshot | null = null): TaskRun {
    const transaction = this.db.transaction(() => {
      const id = randomUUID();
      const timestamp = now();
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      this.db.prepare(`
        INSERT INTO runs (id, session_id, request_id, status, phase, goal, model_id, reasoning_effort, created_at, updated_at, contract_json)
        VALUES (?, ?, ?, 'running', 'discover', ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, requestId, goal, session.modelId, session.reasoningEffort, timestamp, timestamp, contract ? JSON.stringify(contract) : "");
      this.projectAttempt({
        runId: id, ordinal: 1, trigger: "initial", status: "running", scenario: "initial",
        legacyEventSeq: 0, timestamp,
      });
      return this.getRun(id)!;
    });
    return transaction();
  }

  getRun(id: RunId): TaskRun | undefined {
    type RunRow = Omit<TaskRun, "plan" | "checks" | "artifacts" | "continuations" | "completionGate" | "gateRequired" | "usage" | "transcriptCount" | "checkpoint" | "supervision" | "userInputRequests" | "pendingUserInput"> & {
      gateRequired: number;
      usageInput: number;
      usageOutput: number;
      usageCacheRead: number;
      usageCacheWrite: number;
      usageTotalTokens: number;
      usageCost: number;
      transcriptCount: number;
    };
    const row = this.db.prepare(`
      SELECT id, session_id as sessionId, request_id as requestId, status, phase, goal,
             model_id as modelId, reasoning_effort as reasoningEffort, contract_json as contractJson,
             gate_required as gateRequired, blocked_reason as blockedReason,
             last_event_seq as lastEventSeq, created_at as createdAt,
             updated_at as updatedAt, completed_at as completedAt,
             attempt, resumed_at as resumedAt,
             usage_input as usageInput, usage_output as usageOutput,
             usage_cache_read as usageCacheRead, usage_cache_write as usageCacheWrite,
             usage_total_tokens as usageTotalTokens, usage_cost as usageCost,
             (SELECT COUNT(*) FROM run_transcript t WHERE t.run_id = runs.id) as transcriptCount
      FROM runs WHERE id = ?
    `).get(id) as RunRow | undefined;
    if (!row) return undefined;
    const planRows = this.db.prepare(`SELECT item_key as key, title, status, required, position FROM plan_items WHERE run_id = ? ORDER BY position`).all(id) as Array<Omit<PlanItem, "required"> & { required: number }>;
    const checkRows = this.db.prepare(`SELECT check_key as key, title, status, required, command, evidence, stale FROM run_checks WHERE run_id = ? ORDER BY check_key`).all(id) as Array<Omit<RunCheck, "required" | "stale"> & { required: number; stale: number }>;
    const plan = planRows.map((item) => ({ ...item, required: Boolean(item.required) }));
    const checks = checkRows.map((item) => ({ ...item, required: Boolean(item.required), stale: Boolean(item.stale) }));
    const artifacts = this.db.prepare(`SELECT id, run_id as runId, kind, title, content, uri, created_at as createdAt FROM artifacts WHERE run_id = ? ORDER BY created_at`).all(id) as Artifact[];
    const continuations = this.listContinuations(id);
    const { usageInput, usageOutput, usageCacheRead, usageCacheWrite, usageTotalTokens, usageCost, transcriptCount, contractJson, ...runRow } = row as RunRow & { contractJson: string };
    const task: TaskRun = {
      ...runRow,
      contract: contractJson ? JSON.parse(contractJson) as TaskRunContractSnapshot : null,
      gateRequired: Boolean(row.gateRequired),
      usage: { input: usageInput, output: usageOutput, cacheRead: usageCacheRead, cacheWrite: usageCacheWrite, totalTokens: usageTotalTokens, cost: usageCost },
      transcriptCount,
      checkpoint: this.getCheckpoint(id),
      continuations,
      plan,
      checks,
      artifacts,
      completionGate: { passed: true, failures: [] },
      supervision: { latestDecision: this.listSupervisorDecisions(id).at(-1) ?? null, latestGates: this.listLatestGateEvaluations(id), progress: this.getProgressSnapshot(id) ?? null, approvalRequests: this.listApprovalRequests(id), latestContextManifest: this.getLatestContextManifest(id) ?? null },
      userInputRequests: this.listUserInputRequests(id),
      pendingUserInput: this.getPendingUserInputRequest(id) ?? null,
      launchRetryable: this.isInboxLaunchRetryable(id),
      resumable: this.isRunResumable(id),
    };
    task.completionGate = this.evaluateGate(task);
    return task;
  }

  getRunByRequestId(requestId: string): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: RunId } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  listRuns(sessionId: SessionId, limit = 50): TaskRun[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?").all(sessionId, limit) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  getLatestRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  getActiveRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  private listUserInputRequests(runId: RunId): UserInputRequest[] {
    const rows = this.db.prepare(`SELECT id, run_id as runId, attempt, prompt, fields_json as fieldsJson,
      status, response_json as responseJson, requested_at as requestedAt, submitted_at as submittedAt
      FROM user_input_requests WHERE run_id = ? ORDER BY requested_at`).all(runId) as Array<Omit<UserInputRequest, "fields" | "response"> & { fieldsJson: string; responseJson: string }>;
    return rows.map(({ fieldsJson, responseJson, ...row }) => ({ ...row, fields: JSON.parse(fieldsJson) as UserInputField[], response: JSON.parse(responseJson) as Record<string, string> }));
  }

  getPendingUserInputRequest(runId: RunId) {
    return this.listUserInputRequests(runId).find((item) => item.status === "pending");
  }

  getPendingUserInputRequestById(requestId: string): UserInputRequest | undefined {
    const row = this.db.prepare(`SELECT run_id as runId FROM user_input_requests
      WHERE id = ? AND status = 'pending'`).get(requestId) as { runId: RunId } | undefined;
    return row ? this.getPendingUserInputRequest(row.runId) : undefined;
  }

  requestUserInput(runId: RunId, prompt: string, fields: UserInputField[]): UserInputRequest {
    return this.requestUserInputInternal(runId, prompt, fields);
  }

  private requestUserInputInternal(
    runId: RunId,
    prompt: string,
    fields: UserInputField[],
    internalHook?: (input: { request: UserInputRequest; event: RunEvent }) => void,
  ): UserInputRequest {
    const transaction = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== "running") throw new Error("Run is not active");
      const existing = this.getPendingUserInputRequest(runId);
      if (existing) return existing;
      const request: UserInputRequest = { id: randomUUID(), runId, attempt: run.attempt, prompt, fields, status: "pending", response: {}, requestedAt: now(), submittedAt: null };
      const seq = run.lastEventSeq + 1;
      this.db.prepare("INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at) VALUES (?,?,?,?,?,?)").run(
        runId,
        seq,
        this.attemptId(runId, run.attempt),
        "run.waiting_for_input",
        JSON.stringify({ requestId: request.id, prompt, fields }),
        request.requestedAt,
      );
      this.db.prepare(`INSERT INTO user_input_requests
        (id, run_id, attempt, attempt_id, prompt, fields_json, status, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
        request.id, runId, run.attempt, this.attemptId(runId, run.attempt), prompt,
        JSON.stringify(fields), request.requestedAt,
      );
      this.db.prepare(`UPDATE runs SET status = 'waiting_input', phase = 'waiting_input', blocked_reason = ?,
        completed_at = NULL, last_event_seq = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .run(prompt, seq, request.requestedAt, runId);
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?").run(request.requestedAt, runId);
      this.projectAttempt({
        runId, ordinal: run.attempt, trigger: "input", status: "waiting_input", scenario: "input",
        reason: prompt, legacyEventSeq: seq, timestamp: request.requestedAt,
      });
      finalizeProjectionCheckpoint(this.db, { runId, attemptId: this.attemptId(runId, run.attempt), attemptOrdinal: run.attempt, eventSeq: seq, timestamp: request.requestedAt });
      internalHook?.({ request, event: { runId, seq, type: "run.waiting_for_input", data: { requestId: request.id, prompt, fields }, createdAt: request.requestedAt } });
      this.enqueueLearningProjection(runId, run.attempt, "run.waiting_input", "waiting_input", seq, { requestId: request.id, prompt }, request.requestedAt, "run.waiting_for_input");
      return request;
    });
    return transaction();
  }

  submitUserInput(requestId: string, response: Record<string, string>) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id, run_id as runId, fields_json as fieldsJson FROM user_input_requests
        WHERE id = ? AND status = 'pending'`).get(requestId) as { id: string; runId: RunId; fieldsJson: string } | undefined;
      if (!row) throw new Error("User input request is not pending");
      const fields = JSON.parse(row.fieldsJson) as UserInputField[];
      for (const field of fields) if (field.required && !String(response[field.key] ?? "").trim()) throw new Error(`${field.label} is required`);
      const submittedAt = now();
      const normalized = Object.fromEntries(fields.map((field) => [field.key, String(response[field.key] ?? "").trim()]));
      this.db.prepare("UPDATE user_input_requests SET status = 'submitted', response_json = ?, submitted_at = ? WHERE id = ? AND status = 'pending'")
        .run(JSON.stringify(normalized), submittedAt, requestId);
      return { request: this.listUserInputRequests(row.runId).find((item) => item.id === requestId)!, run: this.getRun(row.runId)! };
    });
    return transaction();
  }

  listSupervisorContinuationsNeedingReconcile() {
    return this.db.prepare(`SELECT d.run_id as runId, d.id as decisionId FROM supervisor_decisions d
      JOIN runs r ON r.id = d.run_id
      WHERE d.action = 'start_continuation' AND d.status = 'executed' AND r.status = 'blocked'
        AND d.attempt = r.attempt
        AND NOT EXISTS (SELECT 1 FROM run_continuations c WHERE c.run_id = d.run_id AND c.status IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = d.run_id AND e.type = 'continuation.exhausted' AND e.created_at >= d.created_at)
      ORDER BY d.created_at`).all() as Array<{ runId: string; decisionId: string }>;
  }

  reconcileSupervisorDecisionStatuses() {
    const transaction = this.db.transaction(() => {
      const proposed = this.db.prepare("SELECT id, run_id as runId, attempt FROM supervisor_decisions WHERE status = 'proposed'").all() as Array<{ id: string; runId: string; attempt: number }>;
      let executed = 0;
      let superseded = 0;
      for (const decision of proposed) {
        const event = this.db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type IN ('run.completed','run.blocked')
          AND json_extract(data, '$.supervisionDecisionId') = ? LIMIT 1`).get(decision.runId, decision.id);
        if (event) {
          this.db.prepare("UPDATE supervisor_decisions SET status = 'executed', executed_at = COALESCE(executed_at, ?) WHERE id = ? AND status = 'proposed'").run(now(), decision.id);
          executed += 1;
        } else {
          this.db.prepare("UPDATE supervisor_decisions SET status = 'superseded', error = 'Service restarted before decision execution completed' WHERE id = ? AND status = 'proposed'").run(decision.id);
          superseded += 1;
        }
      }
      return { executed, superseded };
    });
    return transaction();
  }


  recoverContinuationsAfterRestart(timestamp = now()) {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT continuation.id, continuation.run_id as runId, continuation.ordinal,
          run.attempt, run.last_event_seq as lastEventSeq FROM run_continuations continuation
        JOIN runs run ON run.id=continuation.run_id
        WHERE continuation.status = 'queued' OR (continuation.status = 'running'
          AND (continuation.lease_until IS NULL OR continuation.lease_until <= ?))
        ORDER BY continuation.created_at`).all(timestamp) as Array<{ id: string; runId: RunId; ordinal: number; attempt: number; lastEventSeq: number }>;
      for (const item of active) {
        this.db.prepare(`UPDATE run_continuations SET status = 'queued', error = 'Recovered after lease expiry',
          started_at = NULL, completed_at = NULL, lease_owner = '', lease_until = NULL, heartbeat_at = NULL WHERE id = ?`).run(item.id);
        this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = 'Continuation recovered after service restart', completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')")
          .run(timestamp, item.runId);
        this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
          .run(timestamp, item.runId);
        this.projectAttempt({
          runId: item.runId, ordinal: item.attempt, trigger: "recovery", status: "blocked", scenario: "recovery",
          reason: "Continuation recovered after service restart", legacyEventSeq: item.lastEventSeq, timestamp,
        });
      }
      return active.map(({ id, runId, ordinal }) => ({ id, runId, ordinal }));
    });
    return transaction();
  }

  releaseContinuationLeases(owner: string, reason = "Continuation owner stopped") {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const active = this.db.prepare(`SELECT continuation.id, continuation.run_id as runId, continuation.ordinal,
          run.attempt, run.last_event_seq as lastEventSeq FROM run_continuations continuation
        JOIN runs run ON run.id=continuation.run_id
        WHERE continuation.status = 'running' AND continuation.lease_owner = ?
        ORDER BY continuation.created_at`).all(owner) as Array<{ id: string; runId: RunId; ordinal: number; attempt: number; lastEventSeq: number }>;
      for (const item of active) {
        this.db.prepare(`UPDATE run_continuations SET status = 'queued', error = ?, started_at = NULL,
          completed_at = NULL, lease_owner = '', lease_until = NULL, heartbeat_at = NULL
          WHERE id = ? AND status = 'running' AND lease_owner = ?`).run(reason, item.id, owner);
        this.db.prepare(`UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = ?,
          completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')`)
          .run(reason, timestamp, item.runId);
        this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
          .run(timestamp, item.runId);
        this.projectAttempt({
          runId: item.runId, ordinal: item.attempt, trigger: "recovery", status: "blocked", scenario: "recovery",
          reason, legacyEventSeq: item.lastEventSeq, timestamp,
        });
      }
      return active.map(({ id, runId, ordinal }) => ({ id, runId, ordinal }));
    });
    return transaction();
  }

  renewContinuationLease(id: string, owner: string, leaseMs: number) {
    const timestamp = now();
    const result = this.db.prepare(`UPDATE run_continuations SET lease_until = ?, heartbeat_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?`).run(timestamp + leaseMs, timestamp, id, owner, timestamp);
    return result.changes === 1;
  }

  listContinuations(runId: RunId): RunContinuation[] {
    return this.db.prepare(`SELECT id, run_id as runId, ordinal, status, reason, error,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt,
      lease_owner as leaseOwner, lease_until as leaseUntil, heartbeat_at as heartbeatAt
      FROM run_continuations WHERE run_id = ? ORDER BY ordinal`).all(runId) as RunContinuation[];
  }

  queueContinuation(runId: RunId, reason: string): RunContinuation {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare("SELECT id FROM run_continuations WHERE run_id = ? AND status IN ('queued', 'running')").get(runId) as { id: string } | undefined;
      if (active) throw new Error("Run already has an active continuation");
      const timestamp = now();
      const row = this.db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 as ordinal FROM run_continuations WHERE run_id = ?").get(runId) as { ordinal: number };
      const continuation: RunContinuation = { id: randomUUID(), runId, ordinal: row.ordinal, status: "queued", reason, error: "", createdAt: timestamp, startedAt: null, completedAt: null, leaseOwner: "", leaseUntil: null, heartbeatAt: null };
      this.db.prepare("INSERT INTO run_continuations (id, run_id, ordinal, status, reason, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
        .run(continuation.id, runId, continuation.ordinal, reason, timestamp);
      return continuation;
    });
    return transaction();
  }

  claimContinuation(runId: RunId, owner: string, leaseMs: number) {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const continuation = this.db.prepare(`SELECT id, ordinal FROM run_continuations
        WHERE run_id = ? AND status = 'queued' ORDER BY ordinal LIMIT 1`).get(runId) as { id: string; ordinal: number } | undefined;
      if (!continuation) return undefined;
      const run = this.db.prepare("SELECT session_id as sessionId, status, last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { sessionId: SessionId; status: RunStatus; seq: number } | undefined;
      if (!run || run.status !== "blocked") return undefined;
      const otherRunning = this.db.prepare("SELECT 1 FROM runs WHERE session_id = ? AND id <> ? AND status = 'running' LIMIT 1").get(run.sessionId, runId);
      if (otherRunning) return undefined;
      const leaseUntil = timestamp + leaseMs;
      const claimed = this.db.prepare(`UPDATE run_continuations SET status = 'running', error = '',
        started_at = COALESCE(started_at, ?), completed_at = NULL, lease_owner = ?, lease_until = ?, heartbeat_at = ?
        WHERE id = ? AND status = 'queued'`).run(timestamp, owner, leaseUntil, timestamp, continuation.id);
      if (claimed.changes !== 1) return undefined;
      const attempt = (this.db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId) as { attempt: number }).attempt + 1;
      const seq = run.seq + 1;
      const data = { continuationId: continuation.id, ordinal: continuation.ordinal, attempt, leaseOwner: owner, leaseUntil };
      const attemptId = this.attemptId(runId, attempt);
      this.db.prepare("INSERT INTO run_events (run_id, seq, attempt_id, type, data, created_at) VALUES (?, ?, ?, 'continuation.started', ?, ?)")
        .run(runId, seq, attemptId, JSON.stringify(data), timestamp);
      const resumed = this.db.prepare(`UPDATE runs SET status = 'running', phase = CASE WHEN phase = 'blocked' THEN 'implement' ELSE phase END,
        blocked_reason = '', completed_at = NULL, attempt = ?, resumed_at = ?, updated_at = ?, last_event_seq = ?
        WHERE id = ? AND status = 'blocked'`).run(attempt, timestamp, timestamp, seq, runId);
      if (resumed.changes !== 1) throw new Error("Continuation claim lost its Run compare-and-set race");
      this.db.prepare(`UPDATE run_continuations SET
        source_attempt_id=?,scheduled_attempt_id=? WHERE id=?`).run(
        this.attemptId(runId, attempt - 1), attemptId, continuation.id,
      );
      this.projectAttempt({
        runId, ordinal: attempt, trigger: "continuation", status: "running", scenario: "continuation",
        legacyEventSeq: seq, timestamp,
      });
      return { continuation: this.listContinuations(runId).find((item) => item.id === continuation.id)!, run: this.getRun(runId)!, event: { runId, seq, type: "continuation.started", data, createdAt: timestamp } satisfies RunEvent };
    });
    return transaction();
  }

  updateContinuation(id: string, status: RunContinuation["status"], error = "", owner?: string) {
    const timestamp = now();
    const startedAt = status === "running" ? timestamp : null;
    const completedAt = ["completed", "blocked", "failed", "cancelled"].includes(status) ? timestamp : null;
    const result = this.db.prepare(`UPDATE run_continuations SET status = ?, error = ?,
      started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at),
      lease_owner = CASE WHEN ? = 'running' THEN lease_owner ELSE '' END,
      lease_until = CASE WHEN ? = 'running' THEN lease_until ELSE NULL END,
      heartbeat_at = CASE WHEN ? = 'running' THEN heartbeat_at ELSE NULL END
      WHERE id = ? AND (? IS NULL OR lease_owner = ?)`)
      .run(status, error, startedAt, completedAt, status, status, status, id, owner ?? null, owner ?? null);
    return result.changes === 1;
  }

  cancelQueuedContinuations(runId: RunId, reason: string) {
    const timestamp = now();
    this.db.prepare("UPDATE run_continuations SET status = 'cancelled', error = ?, completed_at = ? WHERE run_id = ? AND status = 'queued'")
      .run(reason, timestamp, runId);
  }


  recordModelUsage(runId: RunId, component: string, model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; totalTokens: number; cost?: number }) {
    const timestamp = now();
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const cost = usage.cost ?? 0;
    const transaction = this.db.transaction(() => {
      this.db.prepare("INSERT INTO run_model_usage (run_id,component,model,usage_input,usage_output,usage_cache_read,usage_cache_write,usage_total_tokens,usage_cost,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(runId, component, model, usage.input, usage.output, cacheRead, cacheWrite, usage.totalTokens, cost, timestamp);
      this.db.prepare("UPDATE runs SET usage_input=usage_input+?,usage_output=usage_output+?,usage_cache_read=usage_cache_read+?,usage_cache_write=usage_cache_write+?,usage_total_tokens=usage_total_tokens+?,usage_cost=usage_cost+?,updated_at=? WHERE id=?").run(usage.input, usage.output, cacheRead, cacheWrite, usage.totalTokens, cost, timestamp, runId);
    });
    transaction();
  }

  appendTranscript(runId: RunId, attempt: number, message: AgentMessage) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM run_transcript WHERE run_id = ?").get(runId) as { seq: number };
      this.db.prepare("INSERT INTO run_transcript (run_id, seq, attempt, attempt_id, role, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, row.seq, attempt, this.attemptId(runId, attempt), message.role, JSON.stringify(message), now());
      if (message.role === "assistant") {
        this.db.prepare(`UPDATE runs SET
          usage_input = usage_input + ?, usage_output = usage_output + ?,
          usage_cache_read = usage_cache_read + ?, usage_cache_write = usage_cache_write + ?,
          usage_total_tokens = usage_total_tokens + ?, usage_cost = usage_cost + ?, updated_at = ?
          WHERE id = ?`).run(
          message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite,
          message.usage.totalTokens, message.usage.cost.total, now(), runId,
        );
      }
      return row.seq;
    });
    return transaction();
  }

  listTranscriptEntries(runId: RunId) {
    const rows = this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ seq: number; attempt: number; role: string; messageJson: string; createdAt: number }>;
    return rows.map(({ messageJson, ...row }) => ({ ...row, message: JSON.parse(messageJson) as AgentMessage }));
  }

  listTranscript(runId: RunId): AgentMessage[] {
    return this.listTranscriptEntries(runId).map((entry) => entry.message);
  }

  repairTranscript(runId: RunId, reason: "cancelled" | "resume" | "continuation") {
    const transaction = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      const pending = new Map<string, string>();
      for (const message of this.listTranscript(runId)) {
        if (message.role === "assistant") {
          for (const part of message.content) if (part.type === "toolCall") pending.set(part.id, part.name);
        } else if (message.role === "toolResult") {
          pending.delete(message.toolCallId);
        }
      }
      const repaired: Array<{ toolCallId: string; toolName: string }> = [];
      for (const [toolCallId, toolName] of pending) {
        const message: AgentMessage = {
          role: "toolResult", toolCallId, toolName,
          content: [{ type: "text", text: `Tool result synthesized by TAgent Core because the ${reason} boundary interrupted this call.` }],
          details: { synthetic: true, reason }, isError: true, timestamp: now(),
        };
        this.appendTranscript(runId, run.attempt, message);
        repaired.push({ toolCallId, toolName });
      }
      return repaired;
    });
    return transaction();
  }

  listTranscriptView(runId: RunId) {
    type TranscriptViewItem =
      | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "thinking"; text: string; redacted: boolean; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; status: "pending" | "completed" | "failed"; createdAt: number };
    const toolResults = new Map<string, { content: string; isError: boolean; toolName: string }>();
    const entries = this.listTranscriptEntries(runId);
    for (const entry of entries) {
      const message = entry.message;
      if (message.role !== "toolResult") continue;
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      toolResults.set(message.toolCallId, { content, isError: message.isError, toolName: message.toolName });
    }
    const view: TranscriptViewItem[] = [];
    for (const entry of entries) {
      const message = entry.message;
      if (message.role === "user") {
        view.push({ seq: entry.seq, attempt: entry.attempt, kind: "user", text: typeof message.content === "string" ? message.content : "", createdAt: entry.createdAt });
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const [index, part] of message.content.entries()) {
        if (part.type === "text" && part.text) {
          view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "assistant", text: part.text, createdAt: entry.createdAt });
          continue;
        }
        if (part.type === "thinking" && (part.thinking || part.redacted)) {
          view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "thinking", text: part.redacted ? "Reasoning was redacted by the model provider." : part.thinking, redacted: Boolean(part.redacted), createdAt: entry.createdAt });
          continue;
        }
        if (part.type !== "toolCall") continue;
        const result = toolResults.get(part.id);
        view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "tool", toolCallId: part.id, toolName: part.name, arguments: part.arguments, result: result?.content ?? "", isError: result?.isError ?? false, status: result ? (result.isError ? "failed" : "completed") : "pending", createdAt: entry.createdAt });
      }
    }
    return view;
  }

  private canonicalHash(payload: unknown) {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
      return value;
    };
    return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
  }

  claimOperation(id: string, runId: RunId, attempt: number, operationType: string, payload: unknown) {
    const payloadHash = this.canonicalHash(payload);
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO operations
        (id, run_id, attempt, attempt_id, operation_type, payload_hash, status, stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', 'executing', ?, ?)`).run(
        id, runId, attempt, this.attemptId(runId, attempt), operationType, payloadHash, timestamp, timestamp,
      );
      const receipt = this.getOperation(id)!;
      if (receipt.operationType !== operationType || receipt.payloadHash !== payloadHash || receipt.runId !== runId) throw new Error("Operation ID already exists with a different payload or scope");
      return { ...receipt, claimed: inserted.changes === 1 };
    });
    return transaction();
  }

  updateOperation(id: string, update: { status: string; stage?: string; effects?: unknown[]; result?: unknown; error?: string; expectedStatuses?: string[] }) {
    const timestamp = now();
    const completedAt = ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(update.status) ? timestamp : null;
    const current = this.getOperation(id);
    if (!current) throw new Error(`Unknown operation ${id}`);
    const expected = update.expectedStatuses ?? (completedAt ? ["running"] : [current.status]);
    if (!expected.includes(current.status)) throw new Error(`Operation ${id} cannot transition from ${current.status} to ${update.status}`);
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db.prepare(`UPDATE operations SET status = ?, stage = ?, effects_json = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(update.status, update.stage ?? current.stage, JSON.stringify(update.effects ?? current.effects), update.result === undefined ? (current.result === undefined ? "" : JSON.stringify(current.result)) : JSON.stringify(update.result), update.error ?? current.error, timestamp, completedAt, id, ...expected);
    if (result.changes !== 1) throw new Error(`Operation ${id} transition lost its compare-and-set race`);
    return this.getOperation(id)!;
  }

  getOperation(id: string) {
    const row = this.db.prepare(`SELECT id, run_id as runId, attempt, operation_type as operationType, payload_hash as payloadHash,
      status, stage, effects_json as effectsJson, result_json as resultJson, error, created_at as createdAt,
      updated_at as updatedAt, completed_at as completedAt FROM operations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const { effectsJson, resultJson, ...receipt } = row;
    return { ...receipt, effects: JSON.parse(String(effectsJson || "[]")), result: resultJson ? JSON.parse(String(resultJson)) : undefined } as {
      id: string; runId: string; attempt: number; operationType: string; payloadHash: string; status: string; stage: string; effects: unknown[]; result?: unknown; error: string; createdAt: number; updatedAt: number; completedAt: number | null;
    };
  }

  listOperations(runId: RunId) {
    const rows = this.db.prepare("SELECT id FROM operations WHERE run_id = ? ORDER BY created_at, id").all(runId) as Array<{ id: string }>;
    return rows.map((row) => this.getOperation(row.id)!);
  }

  recordToolAttempt(runId: RunId, attempt: number, toolCallId: string, toolName: string, args: unknown) {
    const argsHash = this.canonicalHash(args);
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO tool_attempts
      (run_id, attempt, attempt_id, tool_call_id, tool_name, args_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`).run(
      runId, attempt, this.attemptId(runId, attempt), toolCallId, toolName, argsHash, timestamp,
    );
    return { argsHash, guard: this.evaluateToolGuard(runId, toolName, argsHash) };
  }

  completeToolAttempt(runId: RunId, attempt: number, toolCallId: string, success: boolean, error = "") {
    this.db.prepare("UPDATE tool_attempts SET status = ?, error = ?, completed_at = ? WHERE run_id = ? AND attempt = ? AND tool_call_id = ?")
      .run(success ? "succeeded" : "failed", error, now(), runId, attempt, toolCallId);
  }

  private evaluateToolGuard(runId: RunId, toolName: string, argsHash: string) {
    const recent = this.db.prepare(`SELECT tool_name as toolName, args_hash as argsHash, status FROM tool_attempts
      WHERE run_id = ? AND status != 'running' ORDER BY id DESC LIMIT 50`).all(runId) as Array<{ toolName: string; argsHash: string; status: string }>;
    let sameArgs = 0;
    let sameArgsFailures = 0;
    let sameToolFailures = 0;
    for (const item of recent) {
      if (item.toolName === toolName && item.argsHash === argsHash) sameArgs += 1;
      else break;
    }
    for (const item of recent) {
      if (item.toolName !== toolName || item.argsHash !== argsHash || item.status !== "failed") break;
      sameArgsFailures += 1;
    }
    for (const item of recent) {
      if (item.toolName !== toolName || item.status !== "failed") break;
      sameToolFailures += 1;
    }
    if (sameArgs >= 5) return { blocked: true, reason: `Tool ${toolName} repeated the same arguments ${sameArgs} times` };
    if (toolName === "bash" && sameArgsFailures >= 1) return { blocked: true, reason: "Bash already failed or timed out with identical arguments. Inspect its durable output and change the command, timeout, or stage instead of repeating it." };
    if (sameArgsFailures >= 3) return { blocked: true, reason: `Tool ${toolName} failed with the same arguments ${sameArgsFailures} times` };
    if (sameToolFailures >= 6) return { blocked: true, reason: `Tool ${toolName} failed consecutively ${sameToolFailures} times` };
    return { blocked: false, reason: "" };
  }

  setRunPhase(runId: RunId, phase: RunPhase) {
    if (phase === "done" || phase === "blocked" || phase === "waiting_input") return false;
    return this.advanceRunPhase(runId, phase);
  }

  advanceRunPhase(runId: RunId, phase: Exclude<RunPhase, "done" | "blocked" | "waiting_input">) {
    const rank: Record<Exclude<RunPhase, "done" | "blocked" | "waiting_input">, number> = { discover: 0, plan: 1, implement: 2, verify: 3, review: 4 };
    return this.db.prepare(`UPDATE runs SET phase = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND CASE phase
        WHEN 'discover' THEN 0 WHEN 'plan' THEN 1 WHEN 'implement' THEN 2
        WHEN 'verify' THEN 3 WHEN 'review' THEN 4 ELSE 99 END < ?`)
      .run(phase, now(), runId, rank[phase]).changes === 1;
  }

  upsertPlanItem(runId: RunId, item: Omit<PlanItem, "runId">) {
    this.db.prepare(`
      INSERT INTO plan_items (run_id, item_key, title, status, required, position) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, item_key) DO UPDATE SET title=excluded.title, status=excluded.status, required=excluded.required, position=excluded.position
    `).run(runId, item.key, item.title, item.status, Number(item.required), item.position);
    this.advanceRunPhase(runId, item.status === "pending" ? "plan" : "implement");
  }

  markChecksStale(runId: RunId) {
    const result = this.db.prepare("UPDATE run_checks SET stale = 1 WHERE run_id = ? AND status = 'passed'").run(runId);
    if (result.changes) this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now(), runId);
    return result.changes;
  }

  upsertCheck(runId: RunId, check: RunCheck) {
    this.db.prepare(`
      INSERT INTO run_checks (run_id, check_key, title, status, required, command, evidence, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, check_key) DO UPDATE SET title=excluded.title, status=excluded.status, required=excluded.required, command=excluded.command, evidence=excluded.evidence, stale=excluded.stale
    `).run(runId, check.key, check.title, check.status, Number(check.required), check.command, check.evidence, Number(check.stale));
    this.advanceRunPhase(runId, check.status === "pending" ? "implement" : "verify");
  }

  getArtifact(runId: RunId, artifactId: string): Artifact | undefined {
    return this.db.prepare(`SELECT id, run_id as runId, kind, title, content, uri, created_at as createdAt
      FROM artifacts WHERE run_id = ? AND id = ?`).get(runId, artifactId) as Artifact | undefined;
  }

  addArtifact(runId: RunId, artifact: Omit<Artifact, "runId" | "createdAt">): Artifact {
    const createdAt = now();
    this.db.prepare("INSERT INTO artifacts (id, run_id, kind, title, content, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(artifact.id, runId, artifact.kind, artifact.title, artifact.content, artifact.uri, createdAt);
    return { ...artifact, runId, createdAt };
  }

  appendEvent(runId: RunId, type: string, data: Record<string, unknown>): RunEvent {
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT attempt,last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { attempt: number; seq: number } | undefined;
      if (!run) throw new Error(`Unknown run ${runId}`);
      const seq = run.seq + 1;
      const createdAt = now();
      this.db.prepare("INSERT INTO run_events (run_id, seq, attempt_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, seq, this.attemptId(runId, run.attempt), type, JSON.stringify(data), createdAt);
      this.db.prepare("UPDATE runs SET last_event_seq = ?, updated_at = ? WHERE id = ?").run(seq, createdAt, runId);
      return { runId, seq, type, data, createdAt } satisfies RunEvent;
    });
    return transaction();
  }

  claimEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor {
    const transaction = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) throw new Error(`Unknown run ${runId}`);
      const timestamp = now();
      this.db.prepare(`INSERT INTO event_consumers
        (run_id, consumer_id, generation, acked_seq, terminal_acked_seq, claimed_at, updated_at)
        VALUES (?, ?, 1, 0, NULL, ?, ?)
        ON CONFLICT(run_id, consumer_id) DO UPDATE SET generation = event_consumers.generation + 1,
          claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`).run(runId, consumerId, timestamp, timestamp);
      return this.getEventConsumer(runId, consumerId)!;
    });
    return transaction();
  }

  getEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor | undefined {
    return this.db.prepare(`SELECT run_id as runId, consumer_id as consumerId, generation,
      acked_seq as ackedSeq, terminal_acked_seq as terminalAckedSeq,
      claimed_at as claimedAt, updated_at as updatedAt FROM event_consumers
      WHERE run_id = ? AND consumer_id = ?`).get(runId, consumerId) as EventConsumerCursor | undefined;
  }

  ackEventConsumer(runId: RunId, consumerId: string, generation: number, seq: number) {
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT last_event_seq as lastEventSeq FROM runs WHERE id = ?").get(runId) as { lastEventSeq: number } | undefined;
      if (!run) return "missing" as const;
      const cursor = this.getEventConsumer(runId, consumerId);
      if (!cursor || cursor.generation !== generation) return "stale" as const;
      if (!Number.isSafeInteger(seq) || seq < cursor.ackedSeq || seq > run.lastEventSeq) return "invalid" as const;
      const terminal = this.db.prepare(`SELECT seq FROM run_events WHERE run_id = ? AND seq <= ?
        AND type IN ('run.completed','run.blocked','run.failed','run.cancelled') ORDER BY seq DESC LIMIT 1`).get(runId, seq) as { seq: number } | undefined;
      this.db.prepare(`UPDATE event_consumers SET acked_seq = ?, terminal_acked_seq = COALESCE(?, terminal_acked_seq), updated_at = ?
        WHERE run_id = ? AND consumer_id = ? AND generation = ?`).run(seq, terminal?.seq ?? null, now(), runId, consumerId, generation);
      return "accepted" as const;
    });
    return transaction();
  }

  enqueueControl(runId: RunId, requestId: string, kind: ControlInboxItem["kind"], content: string, capacity: number) {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM control_inbox WHERE run_id = ? AND request_id = ?").get(runId, requestId) as { id: string } | undefined;
      if (existing) return { status: "duplicate" as const, item: this.getControlItem(existing.id)! };
      const run = this.db.prepare("SELECT status, attempt FROM runs WHERE id = ?").get(runId) as { status: RunStatus; attempt: number } | undefined;
      if (!run || run.status !== "running") return { status: "inactive" as const };
      const active = (this.db.prepare("SELECT COUNT(*) as count FROM control_inbox WHERE run_id = ? AND attempt = ? AND status IN ('queued','delivering')").get(runId, run.attempt) as { count: number }).count;
      if (active >= capacity) return { status: "full" as const };
      const item: ControlInboxItem = { id: randomUUID(), runId, requestId, attempt: run.attempt, kind, content, status: "queued", error: "", createdAt: now(), claimedAt: null, completedAt: null };
      this.db.prepare(`INSERT INTO control_inbox (id, run_id, request_id, attempt, attempt_id, kind, content, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(
        item.id, runId, requestId, item.attempt, this.attemptId(runId, item.attempt), kind, content, item.createdAt,
      );
      return { status: "accepted" as const, item };
    });
    return transaction();
  }

  getControlItem(id: string): ControlInboxItem | undefined {
    return this.db.prepare(`SELECT id, run_id as runId, request_id as requestId, attempt, kind, content, status, error,
      created_at as createdAt, claimed_at as claimedAt, completed_at as completedAt FROM control_inbox WHERE id = ?`).get(id) as ControlInboxItem | undefined;
  }

  listControlInbox(runId: RunId): ControlInboxItem[] {
    return this.db.prepare(`SELECT id, run_id as runId, request_id as requestId, attempt, kind, content, status, error,
      created_at as createdAt, claimed_at as claimedAt, completed_at as completedAt FROM control_inbox WHERE run_id = ? ORDER BY created_at, rowid`).all(runId) as ControlInboxItem[];
  }

  claimControlItem(runId: RunId, attempt: number) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE control_inbox SET status = 'superseded', error = 'Run attempt advanced before delivery', completed_at = ?
        WHERE run_id = ? AND status = 'queued' AND attempt <> ?`).run(now(), runId, attempt);
      const row = this.db.prepare(`SELECT id FROM control_inbox WHERE run_id = ? AND attempt = ? AND status = 'queued'
        ORDER BY created_at, rowid LIMIT 1`).get(runId, attempt) as { id: string } | undefined;
      if (!row) return undefined;
      const claimedAt = now();
      const result = this.db.prepare("UPDATE control_inbox SET status = 'delivering', claimed_at = ? WHERE id = ? AND status = 'queued'").run(claimedAt, row.id);
      return result.changes === 1 ? this.getControlItem(row.id) : undefined;
    });
    return transaction();
  }

  completeControlItem(id: string, status: "delivered" | "rejected" | "superseded", error = "") {
    return this.db.prepare(`UPDATE control_inbox SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'delivering'`)
      .run(status, error, now(), id).changes === 1;
  }

  recordContextManifest(manifest: ContextManifest) {
    this.db.prepare(`INSERT INTO context_manifests
      (id,run_id,attempt,attempt_id,source,items_json,stats_json,manifest_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      manifest.id, manifest.runId, manifest.attempt, this.attemptId(manifest.runId, manifest.attempt),
      manifest.source, JSON.stringify(manifest.items), JSON.stringify(manifest.stats), manifest.manifestHash,
      manifest.createdAt,
    );
    return manifest;
  }

  listContextManifests(runId: RunId, limit = 20): ContextManifest[] {
    const rows = this.db.prepare(`SELECT id,run_id as runId,attempt,source,items_json as itemsJson,stats_json as statsJson,manifest_hash as manifestHash,created_at as createdAt FROM context_manifests WHERE run_id = ? ORDER BY created_at DESC,id DESC LIMIT ?`).all(runId, limit) as Array<Omit<ContextManifest,"items"|"stats"> & {itemsJson:string;statsJson:string}>;
    return rows.map(({itemsJson,statsJson,...row}) => ({...row,items:JSON.parse(itemsJson) as ContextManifest["items"],stats:JSON.parse(statsJson) as ContextManifest["stats"]}));
  }

  getLatestContextManifest(runId: RunId) { return this.listContextManifests(runId, 1)[0]; }

  getContextManifestForAttempt(runId: RunId, attempt: number) {
    const row = this.db.prepare(`SELECT id,run_id as runId,attempt,source,items_json as itemsJson,stats_json as statsJson,manifest_hash as manifestHash,created_at as createdAt
      FROM context_manifests WHERE run_id=? AND attempt=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(runId, attempt) as (Omit<ContextManifest,"items"|"stats"> & {itemsJson:string;statsJson:string}) | undefined;
    if (!row) return undefined;
    const { itemsJson, statsJson, ...manifest } = row;
    return { ...manifest, items: JSON.parse(itemsJson) as ContextManifest["items"], stats: JSON.parse(statsJson) as ContextManifest["stats"] };
  }

  recordSupervisorDecision(decision: SupervisorDecision) {
    this.db.prepare(`INSERT INTO supervisor_decisions
      (id,run_id,attempt,attempt_id,checkpoint_seq,trigger,action,reason_code,rationale,confidence,instruction,candidate_response_hash,status,error,created_at,executed_at,evaluator,evaluator_model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      decision.id, decision.runId, decision.attempt, this.attemptId(decision.runId, decision.attempt),
      decision.checkpointSeq, decision.trigger, decision.action, decision.reasonCode, decision.rationale,
      decision.confidence, decision.instruction, decision.candidateResponseHash, decision.status,
      decision.error, decision.createdAt, decision.executedAt, decision.evaluator, decision.evaluatorModel,
    );
    return decision;
  }

  listSupervisorDecisions(runId: RunId, attempt?: number): SupervisorDecision[] {
    const rows = this.db.prepare(`SELECT id,run_id as runId,attempt,checkpoint_seq as checkpointSeq,trigger,action,reason_code as reasonCode,
      rationale,confidence,instruction,candidate_response_hash as candidateResponseHash,status,error,created_at as createdAt,executed_at as executedAt,evaluator,evaluator_model as evaluatorModel
      FROM supervisor_decisions WHERE run_id = ? ${attempt === undefined ? "" : "AND attempt = ?"} ORDER BY created_at,id`).all(runId, ...(attempt === undefined ? [] : [attempt])) as SupervisorDecision[];
    return rows;
  }

  updateSupervisorDecision(id: string, status: SupervisorDecision["status"], error = "") {
    const executedAt = status === "executed" || status === "failed" ? now() : null;
    this.db.prepare("UPDATE supervisor_decisions SET status = ?, error = ?, executed_at = COALESCE(?, executed_at) WHERE id = ?").run(status, error, executedAt, id);
    return this.db.prepare("SELECT run_id as runId FROM supervisor_decisions WHERE id = ?").get(id) as { runId: string } | undefined;
  }

  recordGateEvaluation(gate: GateEvaluation) {
    this.db.prepare(`INSERT INTO gate_evaluations
      (id,run_id,attempt,attempt_id,checkpoint_seq,gate_type,evaluator,evaluator_model,summary,passed,failures_json,criterion_coverage_json,input_manifest_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      gate.id, gate.runId, gate.attempt, this.attemptId(gate.runId, gate.attempt), gate.checkpointSeq,
      gate.gateType, gate.evaluator, gate.evaluatorModel, gate.summary, Number(gate.passed),
      JSON.stringify(gate.failures), JSON.stringify(gate.criterionCoverage ?? []), gate.inputManifestHash,
      gate.createdAt,
    );
    return gate;
  }

  listLatestGateEvaluations(runId: RunId): GateEvaluation[] {
    const rows = this.db.prepare(`SELECT id,run_id as runId,attempt,checkpoint_seq as checkpointSeq,gate_type as gateType,evaluator,evaluator_model as evaluatorModel,summary,passed,
      failures_json as failuresJson,criterion_coverage_json as criterionCoverageJson,input_manifest_hash as inputManifestHash,created_at as createdAt FROM gate_evaluations
      WHERE run_id = ? AND (attempt,checkpoint_seq) = (SELECT attempt,checkpoint_seq FROM gate_evaluations WHERE run_id = ? ORDER BY attempt DESC,checkpoint_seq DESC,created_at DESC LIMIT 1) ORDER BY gate_type`).all(runId, runId) as Array<Omit<GateEvaluation,"passed"|"failures"|"criterionCoverage"> & {passed:number;failuresJson:string;criterionCoverageJson:string}>;
    return rows.map(({ failuresJson, criterionCoverageJson, ...row }) => ({ ...row, passed: Boolean(row.passed), failures: JSON.parse(failuresJson) as GateEvaluation["failures"], criterionCoverage: JSON.parse(criterionCoverageJson) as GateEvaluation["criterionCoverage"] }));
  }

  getProgressSnapshot(runId: RunId): ProgressSnapshot | undefined {
    return this.db.prepare(`SELECT run_id as runId,attempt,checkpoint_seq as checkpointSeq,meaningful_changes as meaningfulChanges,
      consecutive_failures as consecutiveFailures,repeated_operations as repeatedOperations,last_progress_at as lastProgressAt,
      last_decision_id as lastDecisionId,updated_at as updatedAt FROM progress_snapshots WHERE run_id = ?`).get(runId) as ProgressSnapshot | undefined;
  }

  ensureApprovalRequest(runId: RunId, decisionId: string, reason: string, options: { actionType?: ApprovalRequest["actionType"]; targetType?: ApprovalRequest["targetType"]; targetId?: string; metadata?: Record<string, unknown> } = {}) {
    return this.db.transaction(() => {
      const actionType = options.actionType ?? "resume_taskrun";
      const targetType = options.targetType ?? "taskrun";
      const targetId = options.targetId ?? runId;
      const existing = this.db.prepare(`SELECT id FROM approval_requests
        WHERE run_id=? AND action_type=? AND target_id=? AND status='pending'`)
        .get(runId, actionType, targetId) as { id: string } | undefined;
      if (existing) return this.getApprovalRequest(existing.id)!;
      const request: ApprovalRequest = {
        id: randomUUID(),
        runId,
        decisionId,
        actionType,
        targetType,
        targetId,
        reason,
        metadata: options.metadata ?? {},
        status: "pending",
        requestedAt: now(),
        resolvedAt: null,
        resolvedBy: "",
        resolution: "",
      };
      const run = this.db.prepare("SELECT session_id as sessionId FROM runs WHERE id=?")
        .get(runId) as { sessionId: string } | undefined;
      const canonical = mapLegacyRunApprovalOperation({
        id: request.id,
        runId,
        decisionId,
        actionType,
        targetType,
        targetId,
        metadata: request.metadata,
        runSessionId: run?.sessionId ?? null,
        enforceScopeConsistency: true,
      });
      this.db.prepare(`INSERT INTO approval_requests
        (id,run_id,decision_id,action_type,target_type,target_id,reason,metadata_json,status,requested_at,
         scope_type,scope_id,operation_digest,risk_class,expires_at,reuse_mode,max_uses,used_count)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)`).run(
        request.id,
        runId,
        decisionId,
        actionType,
        targetType,
        targetId,
        reason,
        JSON.stringify(request.metadata),
        request.requestedAt,
        canonical.operation.scope.type,
        canonical.operation.scope.id,
        canonical.operationDigest,
        LEGACY_RUN_APPROVAL_DEFAULTS.risk,
        LEGACY_RUN_APPROVAL_DEFAULTS.expiresAt,
        LEGACY_RUN_APPROVAL_DEFAULTS.reuse.mode,
        LEGACY_RUN_APPROVAL_DEFAULTS.reuse.maxUses,
        LEGACY_RUN_APPROVAL_DEFAULTS.reuse.usedCount,
      );
      return request;
    })();
  }

  private hydrateApprovalRequest(row: (Omit<ApprovalRequest,"metadata"> & {metadataJson:string})|undefined) {
    if (!row) return undefined; const {metadataJson,...request}=row; return {...request,metadata:JSON.parse(metadataJson||"{}")} as ApprovalRequest;
  }

  getApprovalRequest(id: string) {
    return this.hydrateApprovalRequest(this.db.prepare(`SELECT id,run_id as runId,decision_id as decisionId,action_type as actionType,target_type as targetType,target_id as targetId,reason,metadata_json as metadataJson,status,requested_at as requestedAt,
      resolved_at as resolvedAt,resolved_by as resolvedBy,resolution FROM approval_requests WHERE id = ?`).get(id) as Omit<ApprovalRequest,"metadata"> & {metadataJson:string}|undefined);
  }

  listApprovalRequests(runId: RunId) {
    const rows=this.db.prepare(`SELECT id,run_id as runId,decision_id as decisionId,action_type as actionType,target_type as targetType,target_id as targetId,reason,metadata_json as metadataJson,status,requested_at as requestedAt,
      resolved_at as resolvedAt,resolved_by as resolvedBy,resolution FROM approval_requests WHERE run_id = ? ORDER BY requested_at,id`).all(runId) as Array<Omit<ApprovalRequest,"metadata"> & {metadataJson:string}>;
    return rows.map((row)=>this.hydrateApprovalRequest(row)!);
  }

  resolveApprovalRequest(id: string, status: "approved" | "rejected", resolvedBy = "user", resolution = "") {
    const timestamp = now();
    const changed = this.db.prepare(`UPDATE approval_requests SET status=?,resolved_at=?,resolved_by=?,resolution=? WHERE id=? AND status='pending'`)
      .run(status, timestamp, resolvedBy, resolution, id);
    return changed.changes === 1 ? this.getApprovalRequest(id) : undefined;
  }

  hasPendingApproval(runId: RunId) {
    return Boolean(this.db.prepare("SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending'").get(runId));
  }

  updateProgressSnapshot(run: GovernanceProgressRunView, event: GovernanceRunEventView): ProgressSnapshot {
    const previous = this.getProgressSnapshot(run.id);
    const toolName = String(event.data.toolName ?? "");
    const progressEvent = event.type === "run.updated" || event.type === "tool.completed" && !event.data.isError && ["write", "edit", "task_run"].includes(toolName);
    const failureEvent = event.type === "tool.completed" && Boolean(event.data.isError) || event.type === "tool.guard.blocked";
    let repeatedOperations = previous?.attempt === run.attempt ? previous.repeatedOperations : 0;
    const toolCallId = String(event.data.toolCallId ?? "");
    if (event.type === "tool.completed" && toolCallId) {
      const current = this.db.prepare("SELECT tool_name as toolName,args_hash as argsHash FROM tool_attempts WHERE run_id=? AND attempt=? AND tool_call_id=?").get(run.id, run.attempt, toolCallId) as { toolName: string; argsHash: string } | undefined;
      if (current) {
        const recent = this.db.prepare(`SELECT tool_name as toolName,args_hash as argsHash FROM tool_attempts WHERE run_id=? AND attempt=? AND id <= (SELECT id FROM tool_attempts WHERE run_id=? AND attempt=? AND tool_call_id=?) ORDER BY id DESC LIMIT 8`).all(run.id,run.attempt,run.id,run.attempt,toolCallId) as Array<{toolName:string;argsHash:string}>;
        repeatedOperations = 0;
        for (const item of recent) { if (item.toolName === current.toolName && item.argsHash === current.argsHash) repeatedOperations += 1; else break; }
      }
    }
    const snapshot: ProgressSnapshot = { runId: run.id, attempt: run.attempt, checkpointSeq: event.seq,
      meaningfulChanges: (previous?.attempt === run.attempt ? previous.meaningfulChanges : 0) + (progressEvent ? 1 : 0),
      consecutiveFailures: failureEvent ? (previous?.attempt === run.attempt ? previous.consecutiveFailures : 0) + 1 : progressEvent ? 0 : previous?.consecutiveFailures ?? 0,
      repeatedOperations,
      lastProgressAt: progressEvent ? event.createdAt : previous?.lastProgressAt ?? event.createdAt,
      lastDecisionId: previous?.lastDecisionId ?? "", updatedAt: event.createdAt };
    this.db.prepare(`INSERT INTO progress_snapshots (run_id,attempt,checkpoint_seq,meaningful_changes,consecutive_failures,repeated_operations,last_progress_at,last_decision_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET attempt=excluded.attempt,checkpoint_seq=excluded.checkpoint_seq,
      meaningful_changes=excluded.meaningful_changes,consecutive_failures=excluded.consecutive_failures,repeated_operations=excluded.repeated_operations,
      last_progress_at=excluded.last_progress_at,last_decision_id=excluded.last_decision_id,updated_at=excluded.updated_at`).run(snapshot.runId,snapshot.attempt,snapshot.checkpointSeq,snapshot.meaningfulChanges,snapshot.consecutiveFailures,snapshot.repeatedOperations,snapshot.lastProgressAt,snapshot.lastDecisionId,snapshot.updatedAt);
    return snapshot;
  }

  listTaskRunEdges(runId: RunId): TaskRunEdge[] { return this.db.prepare(`SELECT from_run_id as fromRunId,to_run_id as toRunId,relation,reason,created_at as createdAt FROM taskrun_edges WHERE from_run_id=? OR to_run_id=? ORDER BY created_at`).all(runId,runId) as TaskRunEdge[]; }

  listEvents(runId: RunId, after = 0): RunEvent[] {
    const rows = this.db.prepare(`SELECT run_id as runId, seq, type, data, created_at as createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq`).all(runId, after) as Array<Omit<RunEvent, "data"> & { data: string }>;
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
  }

  transitionRun(runId: RunId, expected: RunStatus[], nextStatus: RunStatus, type: string, data: Record<string, unknown>, reason = "", expectedAttempt?: number) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT status, attempt, last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { status: RunStatus; attempt: number; seq: number } | undefined;
      if (!row || !expected.includes(row.status) || (expectedAttempt !== undefined && row.attempt !== expectedAttempt)) return undefined;
      const createdAt = now();
      const seq = row.seq + 1;
      const phase = nextStatus === "completed" ? "done" : nextStatus === "blocked" ? "blocked" : undefined;
      const completedAt = ["completed", "cancelled", "failed"].includes(nextStatus) ? createdAt : null;
      this.db.prepare("INSERT INTO run_events (run_id, seq, attempt_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, seq, this.attemptId(runId, row.attempt), type, JSON.stringify(data), createdAt);
      const placeholders = expected.map(() => "?").join(", ");
      const attemptClause = expectedAttempt === undefined ? "" : " AND attempt = ?";
      const result = this.db.prepare(`UPDATE runs SET status = ?, phase = COALESCE(?, phase), blocked_reason = ?,
        last_event_seq = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})${attemptClause}`)
        .run(nextStatus, phase, reason, seq, completedAt, createdAt, runId, ...expected, ...(expectedAttempt === undefined ? [] : [expectedAttempt]));
      if (result.changes !== 1) throw new Error("Run transition lost its compare-and-set race");
      if (nextStatus !== "running") this.db.prepare(`UPDATE run_checkpoints SET active = 0, current_tool_json = '',
        last_event_seq = MAX(last_event_seq, ?), updated_at = ? WHERE run_id = ? AND attempt = ?`)
        .run(seq, createdAt, runId, row.attempt);
      this.projectAttempt({
        runId, ordinal: row.attempt, trigger: "recovery", status: nextStatus,
        scenario: nextStatus === "running" ? "recovery" : "terminal",
        reason, legacyEventSeq: seq, timestamp: createdAt,
      });
      finalizeProjectionCheckpoint(this.db, { runId, attemptId: this.attemptId(runId, row.attempt), attemptOrdinal: row.attempt, eventSeq: seq, timestamp: createdAt });
      this.enqueueLearningProjection(runId, row.attempt, type, nextStatus, seq, { ...data, reason }, createdAt);
      return { runId, seq, type, data, createdAt } satisfies RunEvent;
    });
    return transaction();
  }

  private enqueueLearningProjection(runId: RunId, attempt: number, lifecycle: string, outcome: string, eventSeq: number, payload: Record<string, unknown>, timestamp = now(), runEventType = lifecycle) {
    if (eventSeq <= 0) throw new Error("New Learning projections require a real run event");
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found for Learning projection`);
    appendProjectionPair(this.db, { runId, attemptId: this.attemptId(runId, attempt), attemptOrdinal: attempt,
      lifecycle, outcome, eventSeq, payload, taskRunSnapshot: run as unknown as Record<string, unknown>, timestamp, runEventType });
  }

  listPendingLearningProjections(limit = 100) {
    return this.db.prepare(`SELECT id, run_id as runId, attempt, lifecycle, outcome, event_seq as eventSeq,
      payload_json as payloadJson, snapshot_json as snapshotJson, status, error, created_at as createdAt, updated_at as updatedAt
      FROM learning_projection_outbox WHERE status IN ('pending','failed') ORDER BY created_at LIMIT ?`).all(limit) as Array<{ id: string; runId: string; attempt: number; lifecycle: string; outcome: string; eventSeq: number; payloadJson: string; snapshotJson: string; status: string; error: string; createdAt: number; updatedAt: number }>;
  }

  completeLearningProjection(id: string) { this.db.prepare("UPDATE learning_projection_outbox SET status='completed', error='', updated_at=? WHERE id=?").run(now(), id); }
  failLearningProjection(id: string, error: string) { this.db.prepare("UPDATE learning_projection_outbox SET status='failed', error=?, updated_at=? WHERE id=?").run(error.slice(0, 4000), now(), id); }

  finalizeRun(runId: RunId, status: Exclude<RunStatus, "running" | "interrupted" | "blocked">, reason = "") {
    const timestamp = now();
    const completedAt = status === "completed" || status === "cancelled" || status === "failed" ? timestamp : null;
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT attempt FROM runs WHERE id=?").get(runId) as { attempt: number } | undefined;
      if (!run) return;
      const seq = (this.db.prepare("SELECT last_event_seq as seq FROM runs WHERE id=?").get(runId) as { seq: number }).seq + 1;
      this.db.prepare("INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at) VALUES (?,?,?,?,?,?)").run(runId, seq, this.attemptId(runId, run.attempt), `run.${status}`, JSON.stringify({ reason }), timestamp);
      this.db.prepare("UPDATE runs SET status = ?, blocked_reason = ?, completed_at = ?, last_event_seq=?, updated_at = ? WHERE id = ?")
        .run(status, reason, completedAt, seq, timestamp, runId);
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
        .run(timestamp, runId);
      this.projectAttempt({ runId, ordinal: run.attempt, trigger: "recovery", status, scenario: "terminal", reason, legacyEventSeq: seq, timestamp });
      finalizeProjectionCheckpoint(this.db, { runId, attemptId: this.attemptId(runId, run.attempt), attemptOrdinal: run.attempt, eventSeq: seq, timestamp });
      this.enqueueLearningProjection(runId, run.attempt, `run.${status}`, status, seq, { reason }, timestamp);
    });
    transaction();
  }

  blockRun(runId: RunId, reason: string) {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT attempt FROM runs WHERE id=?").get(runId) as { attempt: number } | undefined;
      if (!run) return;
      const seq = (this.db.prepare("SELECT last_event_seq as seq FROM runs WHERE id=?").get(runId) as { seq: number }).seq + 1;
      this.db.prepare("INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at) VALUES (?,?,?,?,?,?)").run(runId, seq, this.attemptId(runId, run.attempt), "run.blocked", JSON.stringify({ reason }), timestamp);
      this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = ?, last_event_seq=?, updated_at = ? WHERE id = ?")
        .run(reason, seq, timestamp, runId);
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
        .run(timestamp, runId);
      this.projectAttempt({ runId, ordinal: run.attempt, trigger: "recovery", status: "blocked", scenario: "terminal", reason, legacyEventSeq: seq, timestamp });
      finalizeProjectionCheckpoint(this.db, { runId, attemptId: this.attemptId(runId, run.attempt), attemptOrdinal: run.attempt, eventSeq: seq, timestamp });
      this.enqueueLearningProjection(runId, run.attempt, "run.blocked", "blocked", seq, { reason }, timestamp);
    });
    transaction();
  }

  markInterrupted() {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const interrupted = this.db.prepare("SELECT id, attempt FROM runs WHERE status='running'").all() as Array<{ id: string; attempt: number }>;
      for (const run of interrupted) {
        const seq = (this.db.prepare("SELECT last_event_seq as seq FROM runs WHERE id=?").get(run.id) as { seq: number }).seq + 1;
        this.db.prepare("INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at) VALUES (?,?,?,?,?,?)").run(run.id, seq, this.attemptId(run.id, run.attempt), "restart.interruption", JSON.stringify({ reason: "service_restart" }), timestamp);
        this.db.prepare("UPDATE runs SET status='interrupted', blocked_reason='Service restarted before the run reached a terminal state', last_event_seq=?, updated_at=? WHERE id=? AND status='running'").run(seq, timestamp, run.id);
        this.db.prepare("UPDATE run_checkpoints SET active=0,current_tool_json='',updated_at=? WHERE run_id=?").run(timestamp, run.id);
        this.projectAttempt({
          runId: run.id, ordinal: run.attempt, trigger: "recovery", status: "interrupted", scenario: "recovery",
          reason: "service_restart", legacyEventSeq: seq, timestamp,
        });
        finalizeProjectionCheckpoint(this.db, { runId: run.id, attemptId: this.attemptId(run.id, run.attempt), attemptOrdinal: run.attempt, eventSeq: seq, timestamp });
        this.enqueueLearningProjection(run.id, run.attempt, "restart.interruption", "interrupted", seq, { reason: "service_restart" }, timestamp);
      }
      this.db.prepare(`UPDATE runs SET blocked_reason = COALESCE((SELECT prompt FROM user_input_requests input WHERE input.run_id = runs.id AND input.status = 'pending'), blocked_reason),
        phase = 'waiting_input', updated_at = ? WHERE status = 'waiting_input'`).run(timestamp);
    });
    transaction();
  }

  isRunResumable(runId: RunId) {
    const row = this.db.prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: RunStatus } | undefined;
    if (!row) return false;
    if (["interrupted", "blocked"].includes(row.status)) return true;
    if (row.status !== "failed") return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type = 'run.failed'
      AND json_extract(data, '$.reason') IN ('idle_timeout', 'hard_timeout') ORDER BY seq DESC LIMIT 1`).get(runId));
  }

  resumeRun(runId: RunId) {
    const transaction = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run || !this.isRunResumable(runId) && run.status !== "waiting_input") throw new Error("Run is not resumable");
      if (run.status === "waiting_input" && run.pendingUserInput) throw new Error("Run is waiting for the requested user input");
      const resumedAt = now();
      const resumedFromInput = Boolean(this.db.prepare(`SELECT 1 FROM user_input_requests
        WHERE run_id=? AND attempt=? AND status='submitted' LIMIT 1`).get(runId, run.attempt));
      this.db.prepare("UPDATE runs SET status = 'running', phase = CASE WHEN phase IN ('blocked','waiting_input') THEN 'implement' ELSE phase END, blocked_reason = '', completed_at = NULL, attempt = attempt + 1, resumed_at = ?, updated_at = ? WHERE id = ?")
        .run(resumedAt, resumedAt, runId);
      this.projectAttempt({
        runId, ordinal: run.attempt + 1, trigger: resumedFromInput ? "input" : "resume", status: "running",
        scenario: resumedFromInput ? "input" : "resume", legacyEventSeq: run.lastEventSeq, timestamp: resumedAt,
      });
      return this.getRun(runId)!;
    });
    return transaction();
  }

  getLearningSettings(): {
    memoryEnabled: boolean;
    learningEnabled: boolean;
    autoExecutionEnabled: boolean;
    updatedAt: number;
    reason: string;
  } | undefined {
    const row = this.db.prepare(`SELECT memory_enabled as memoryEnabled,
      learning_enabled as learningEnabled, auto_execution_enabled as autoExecutionEnabled,
      updated_at as updatedAt, reason FROM learning_feature_settings WHERE id = 1`).get() as {
        memoryEnabled: number;
        learningEnabled: number;
        autoExecutionEnabled: number;
        updatedAt: number;
        reason: string;
      } | undefined;
    return row ? {
      ...row,
      memoryEnabled: Boolean(row.memoryEnabled),
      learningEnabled: Boolean(row.learningEnabled),
      autoExecutionEnabled: Boolean(row.autoExecutionEnabled),
    } : undefined;
  }

  saveLearningSettings(settings: {
    memoryEnabled: boolean;
    learningEnabled: boolean;
    autoExecutionEnabled: boolean;
    updatedAt: number;
    reason: string;
  }): void {
    this.db.prepare(`INSERT INTO learning_feature_settings
      (id, memory_enabled, learning_enabled, auto_execution_enabled, updated_at, reason)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET memory_enabled = excluded.memory_enabled,
        learning_enabled = excluded.learning_enabled,
        auto_execution_enabled = excluded.auto_execution_enabled,
        updated_at = excluded.updated_at, reason = excluded.reason`).run(
      Number(settings.memoryEnabled),
      Number(settings.learningEnabled),
      Number(settings.autoExecutionEnabled),
      settings.updatedAt,
      settings.reason,
    );
  }

  getSemanticCacheEntry(cacheKey: string, timestamp = now()): {
    cacheKey: string;
    task: string;
    inputHash: string;
    model: string;
    result: unknown;
    createdAt: number;
    expiresAt: number;
  } | undefined {
    const row = this.db.prepare(`SELECT cache_key as cacheKey, task, input_hash as inputHash,
      model, result_json as resultJson, created_at as createdAt, expires_at as expiresAt
      FROM semantic_judgment_cache WHERE cache_key = ?`).get(cacheKey) as {
        cacheKey: string;
        task: string;
        inputHash: string;
        model: string;
        resultJson: string;
        createdAt: number;
        expiresAt: number;
      } | undefined;
    if (!row || row.expiresAt <= timestamp) return undefined;
    try {
      const { resultJson, ...entry } = row;
      return { ...entry, result: JSON.parse(resultJson) as unknown };
    } catch {
      return undefined;
    }
  }

  putSemanticCacheEntry(entry: {
    cacheKey: string;
    task: string;
    inputHash: string;
    model: string;
    result: unknown;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db.prepare(`INSERT INTO semantic_judgment_cache
      (cache_key, task, input_hash, model, result_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json,
        created_at = excluded.created_at, expires_at = excluded.expires_at`).run(
      entry.cacheKey,
      entry.task,
      entry.inputHash,
      entry.model,
      JSON.stringify(entry.result),
      entry.createdAt,
      entry.expiresAt,
    );
  }

  deleteExpiredSemanticCacheEntries(timestamp = now(), limit = 1_000): number {
    return this.db.prepare(`DELETE FROM semantic_judgment_cache WHERE cache_key IN
      (SELECT cache_key FROM semantic_judgment_cache WHERE expires_at <= ? LIMIT ?)`).run(timestamp, limit).changes;
  }

  enqueueSemanticLearningJob(kind: "user_message" | "workflow_eligibility" | "feedback_attribution", payload: Record<string, unknown>, idempotencyKey: string, runId?: RunId, attempt?: number) {
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO semantic_learning_jobs
      (id,kind,run_id,attempt,idempotency_key,payload_json,status,attempts,next_retry_at,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',0,0,'',?,?)`).run(randomUUID(), kind, runId ?? null, attempt ?? null, idempotencyKey, JSON.stringify(payload), timestamp, timestamp);
    return this.db.prepare("SELECT * FROM semantic_learning_jobs WHERE idempotency_key=?").get(idempotencyKey);
  }

  claimSemanticLearningJobs(owner: string, kinds: Array<"user_message" | "workflow_eligibility" | "feedback_attribution">, limit = 100, leaseMs = 30_000) {
    if (!kinds.length || limit <= 0) return [];
    const timestamp = now(); const claimed: Array<{id:string;kind:"user_message"|"workflow_eligibility"|"feedback_attribution";runId?:string;attempt?:number;idempotencyKey:string;payloadJson:string;status:string;attempts:number;nextRetryAt:number;error:string;createdAt:number;updatedAt:number;leaseOwner:string;leaseToken:string;leaseUntil:number;fence:number}> = [];
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM semantic_learning_jobs WHERE kind IN (${kinds.map(()=>"?").join(",")}) AND next_retry_at<=?
        AND (status IN ('pending','failed') OR (status='processing' AND (lease_until IS NULL OR lease_until<=?))) ORDER BY created_at LIMIT ?`).all(...kinds, timestamp, timestamp, limit) as Array<{id:string}>;
      const select = this.db.prepare(`SELECT id,kind,run_id as runId,attempt,idempotency_key as idempotencyKey,payload_json as payloadJson,status,attempts,next_retry_at as nextRetryAt,error,created_at as createdAt,updated_at as updatedAt,lease_owner as leaseOwner,lease_token as leaseToken,lease_until as leaseUntil,fence FROM semantic_learning_jobs WHERE id=?`);
      for (const row of rows) {
        const token = randomUUID();
        const changed = this.db.prepare(`UPDATE semantic_learning_jobs SET status='processing',attempts=attempts+1,lease_owner=?,lease_token=?,lease_until=?,fence=fence+1,updated_at=? WHERE id=?
          AND (status IN ('pending','failed') OR (status='processing' AND (lease_until IS NULL OR lease_until<=?)))`).run(owner, token, timestamp + leaseMs, timestamp, row.id, timestamp).changes;
        if (changed) claimed.push(select.get(row.id) as typeof claimed[number]);
      }
    });
    claim(); return claimed;
  }

  renewSemanticLearningJob(id:string, owner:string, token:string, fence:number, leaseMs=30_000) { const timestamp=now(); return this.db.prepare(`UPDATE semantic_learning_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND fence=? AND lease_until>?`).run(timestamp+leaseMs,timestamp,id,owner,token,fence,timestamp).changes===1; }

  completeSemanticLearningJob(id:string, owner:string, token:string, fence:number) { const timestamp=now(); return this.db.prepare(`UPDATE semantic_learning_jobs SET status='completed',error='',completed_at=?,lease_owner='',lease_token='',lease_until=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND fence=?`).run(timestamp,timestamp,id,owner,token,fence).changes===1; }

  failSemanticLearningJob(id:string, owner:string, token:string, fence:number, attempts:number, error:string) {
    const status=attempts>=5?"dead_letter":"failed",timestamp=now(),retryAt=status==="dead_letter"?0:timestamp+Math.min(60*60_000,2**attempts*5_000);
    const changed=this.db.prepare(`UPDATE semantic_learning_jobs SET status=?,next_retry_at=?,error=?,lease_owner='',lease_token='',lease_until=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND fence=?`).run(status,retryAt,error.slice(0,4000),timestamp,id,owner,token,fence).changes;
    return {attempts,status,nextRetryAt:retryAt,changed:changed===1};
  }

  evaluateGate(run: GovernanceCompletionRunView): CompletionGate {
    if (!run.gateRequired) return { passed: true, failures: [] };
    const failures: CompletionGate["failures"] = [];
    const requiredPlan = run.plan.filter((item) => item.required);
    const lightweightDiscussion = run.contract?.intent === "discussion"
      && run.contract.objectives.length === 1
      && run.contract.objectives[0]?.timing === "current"
      && run.contract.objectives[0]?.kind === "answer"
      && run.contract.acceptanceCriteria.length <= 1
      && run.contract.nonGoals.length === 0;
    if (requiredPlan.length === 0 && !lightweightDiscussion) failures.push({ kind: "plan", key: "plan", reason: "No required plan items" });
    for (const item of requiredPlan) if (item.status !== "done") failures.push({ kind: "plan_item", key: item.key, reason: `Required plan item is ${item.status}` });
    for (const check of run.checks.filter((item) => item.required)) {
      if (check.status !== "passed") failures.push({ kind: "check", key: check.key, reason: `Required check is ${check.status}` });
      else if (check.stale) failures.push({ kind: "check", key: check.key, reason: "Evidence is stale" });
    }
    return { passed: failures.length === 0, failures };
  }

  completeWithGate(runId: RunId, response: string, expectedAttempt?: number) {
    const run = this.getRun(runId);
    if (!run) throw new Error("Run not found");
    const gate = this.evaluateGate(run);
    const reason = gate.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ");
    const event = this.transitionRun(runId, ["running"], gate.passed ? "completed" : "blocked", gate.passed ? "run.completed" : "run.blocked", { response, gate }, reason, expectedAttempt);
    if (!event) throw new Error("Run is no longer running");
    return { gate, run: this.getRun(runId)!, event };
  }
}
