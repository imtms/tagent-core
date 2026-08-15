import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeMessage as AgentMessage } from "@tagent/execution/ports";
import {
  RUN_APPROVAL_DEFAULTS,
  effectiveGateProfile,
  effectiveTaskExecutionPolicy,
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
  OperationRecord,
  WorkspaceGoalOperationReceipt,
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
  TaskRunCommandReceipt,
  TaskRunContractSnapshot,
  TaskRunEdge,
  TaskRunExecutionState,
  UserInputField,
  UserInputRequest,
} from "@tagent/execution/domain";
import type {
  Message,
  ReasoningEffort,
  Session,
  SessionId,
  Submission,
  SessionInputAnalysis,
  SessionSettingsUpdate,
  TaskObjective,
  CreateSkillRevisionInput,
  SkillRevision,
  SkillSummary,
} from "@tagent/admission/domain";
import { assertControlContent } from "@tagent/execution/domain";
import type {
  ProfileInboxMutationValue,
  ProfileInboxItemRecord,
  ProfileMutationContext,
  ProfileMutationResult,
  ProfilePageQuery,
  ProfileSkillCatalogPage,
  ProfileSkillDeleteValue,
  ProfileSkillMutationValue,
  ProfileSkillRevisionPage,
  ProfileWorkspaceSkillPage,
  ProfileWorkspaceSkillsMutationValue,
  SubmissionAuditInput,
  SubmissionAuditReceipt,
} from "@tagent/admission/ports";
import { CURRENT_SCHEMA_ID, CURRENT_SCHEMA_SQL } from "./current-schema.js";
import { mapRunApprovalOperation } from "./sqlite/approval-operation-mapper.js";
import { appendLearningProjection, finalizeProjectionCheckpoint } from "./sqlite/learning-integration-event.js";
import { registerInternalUserInputCoordinator } from "./sqlite/internal-user-input-coordinator.js";

const now = () => Date.now();
const MAX_SUBMISSION_CONTENT_CHARS = 200_000;
const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

function assertSubmissionContentBound(content: string): void {
  if (!content.trim()) throw new Error("Submission content is required");
  if (content.length > MAX_SUBMISSION_CONTENT_CHARS) {
    throw new Error(`Submission content cannot exceed ${MAX_SUBMISSION_CONTENT_CHARS} characters`);
  }
}

export interface StoreOptions {
  deferStartupRecovery?: boolean;
  /** Concrete Core primary model captured by new Workspaces. */
  defaultModelId?: string;
}

export type StoreSynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface StoreMutationRunner {
  run<T>(work: (db: Database.Database) => T & StoreSynchronousResult<T>): T;
}

export interface OperatorSessionReadRow {
  id: string;
  title: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  createdAt: number;
  updatedAt: number;
  latestTaskRunId: string | null;
  latestTaskRunStatus: RunStatus | null;
  latestTaskRunPhase: RunPhase | null;
  latestActivityAt: number;
}

export interface OperatorTaskRunReadRow {
  id: string;
  sessionId: string;
  status: RunStatus;
  phase: RunPhase;
  attempt: number;
  goalSummary: string;
  blockedReason: string | null;
  pendingApproval: number;
  pendingUserInput: number;
  lastEventSequence: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  resumable: number;
}

export interface OperatorReadPageQuery {
  snapshotRowId?: number;
  after?: { createdAt: number; id: string };
  limit: number;
}

export class Store {
  readonly db: Database.Database;
  private readonly defaultModelId: string;

  constructor(filename = process.env.TAGENT_DB ?? "./data/tagent.db", options: StoreOptions = {}) {
    this.defaultModelId = options.defaultModelId?.trim() || "gpt-5.6-sol";
    this.db = new Database(filename);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.initializeSchema();
      if (!options.deferStartupRecovery) this.runStartupRecovery();
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
    const timestamp = now();
    const row = this.db.prepare(`SELECT MIN(wake_at) as leaseUntil FROM (
      SELECT lease_until AS wake_at FROM run_continuations
        WHERE status = 'running' AND lease_until IS NOT NULL
      UNION ALL
      SELECT CASE WHEN not_before > ? THEN not_before ELSE ? + 1000 END AS wake_at
        FROM run_continuations WHERE status = 'queued'
    )`).get(timestamp, timestamp) as { leaseUntil: number | null };
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

  listDurableUserMessages(): Array<Pick<Message, "id" | "content"> & { sessionId: string; principalId: string | null }> {
    return this.db.prepare(`
      SELECT messages.id, messages.content, messages.session_id AS sessionId,
        COALESCE(
          (SELECT principal_id FROM session_create_receipts WHERE session_id = messages.session_id ORDER BY created_at LIMIT 1),
          (SELECT principal_id FROM submission_audit_receipts WHERE session_id = messages.session_id ORDER BY created_at LIMIT 1)
        ) AS principalId
      FROM messages WHERE role = 'user' ORDER BY messages.id ASC
    `).all() as Array<Pick<Message, "id" | "content"> & { sessionId: string; principalId: string | null }>;
  }

  close() {
    this.db.close();
  }

  private initializeSchema(): void {
    const objectCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'`).get() as { count: number }).count;
    if (objectCount === 0) {
      this.db.transaction(() => this.db.exec(CURRENT_SCHEMA_SQL))();
    }
    this.assertCurrentSchema();

    // A process restart loses the executor for operations that only reached started.
    // Surface uncertainty explicitly; never replay an effect that may have escaped Core.
    this.db.prepare("UPDATE task_run_command_receipts SET status='outcome_unknown',updated_at=? WHERE status='started'").run(now());
    this.db.prepare("UPDATE workspace_goal_operation_receipts SET status='outcome_unknown',updated_at=? WHERE status='started'").run(now());
    this.db.prepare(`UPDATE profile_operation_receipts SET status='outcome_unknown',updated_at=?,completed_at=?
      WHERE status='started'`).run(now(), now());
  }

  private assertCurrentSchema(): void {
    let marker: { schemaId: string } | undefined;
    try {
      marker = this.db.prepare("SELECT schema_id AS schemaId FROM core_schema WHERE id=1")
        .get() as { schemaId: string } | undefined;
    } catch {
      marker = undefined;
    }
    if (marker?.schemaId !== CURRENT_SCHEMA_ID) {
      throw new Error(`Unsupported SQLite schema. Core accepts only an empty database or ${CURRENT_SCHEMA_ID}; discard the existing database instead of upgrading it.`);
    }

    const snapshot = (db: Database.Database) => db.prepare(`SELECT type,name,tbl_name AS tableName,sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,name`).all();
    const reference = new Database(":memory:");
    try {
      reference.pragma("foreign_keys = ON");
      reference.exec(CURRENT_SCHEMA_SQL);
      if (JSON.stringify(snapshot(this.db)) !== JSON.stringify(snapshot(reference))) {
        throw new Error(`SQLite schema does not match ${CURRENT_SCHEMA_ID}; recreate the database from the current Core release.`);
      }
    } finally {
      reference.close();
    }
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
    eventSequence?: number;
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
      this.db.prepare(`UPDATE attempts SET status=?,active=?,version=version+1,event_sequence=?,updated_at=?,
        completed_at=CASE WHEN ?=1 THEN NULL ELSE COALESCE(completed_at,?) END WHERE id=?`)
        .run(input.status, Number(active), input.eventSequence ?? 0, timestamp, Number(active), timestamp, attemptId);
    } else {
      this.db.prepare(`INSERT INTO attempts
        (id,run_id,ordinal,trigger,status,active,version,event_sequence,started_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,1,?,?,?,?)`).run(
        attemptId, input.runId, input.ordinal, input.trigger, input.status, Number(active), input.eventSequence ?? 0,
        timestamp, timestamp, active ? null : timestamp,
      );
    }
    const projected = this.db.prepare("SELECT version FROM attempts WHERE id=?").get(attemptId) as { version: number };
    this.db.prepare(`INSERT INTO attempt_transition_audit
      (id,attempt_id,run_id,ordinal,from_status,to_status,trigger,scenario,reason,version,event_sequence,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), attemptId, input.runId, input.ordinal, existing?.status ?? null, input.status,
      existing?.trigger ?? input.trigger, input.scenario, input.reason ?? "", projected.version, input.eventSequence ?? 0, timestamp,
    );
  }

  /**
   * Reconciles in-flight work before runtime startup.
   *
   * Receipt-bound capability operations use a fail-closed protocol: an effect
   * that started becomes outcome_unknown, while an authorized effect that did
   * not start becomes cancelled/restart_before_effect. Both are terminal exact
   * replays and retain their append-only allow receipt and approval use. Other
   * running operations use the outcome_unknown/service_restart projection.
   * Production supplies the current WriterFenceGuard as `guard`.
   */
  runStartupRecovery(guard?: StoreMutationRunner) {
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
      const ordinaryOperations = db.prepare(`UPDATE operations SET
        status='outcome_unknown',stage='service_restart',
        error='Service restarted before operation outcome was recorded',updated_at=?
        WHERE status='running' AND NOT (
          attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM approval_receipts receipt
            WHERE receipt.operation_id=operations.id AND receipt.outcome='allow')
        )`).run(timestamp).changes;
      const operations = capabilityRunning + capabilityAuthorized + ordinaryOperations;
      const controlInbox = db.prepare("UPDATE control_inbox SET status = 'outcome_unknown', error = 'Service restarted while Pi delivery outcome was unknown', completed_at = ? WHERE status = 'delivering'").run(timestamp).changes;
      return { operations, controlInbox };
    };
    if (guard) return guard.run(recover);
    return this.db.transaction(() => recover(this.db)).immediate();
  }

  getSchemaVersion(): number {
    return 1;
  }

  createSession(title = "New workspace", requestId?: string): Session {
    const transaction = this.db.transaction(() => {
      if (requestId) {
        const existing = this.db.prepare("SELECT session_id as sessionId FROM session_requests WHERE request_id = ?").get(requestId) as { sessionId: string } | undefined;
        if (existing) return this.getSession(existing.sessionId)!;
      }
      const session: Session = { id: randomUUID(), title, modelId: this.defaultModelId, reasoningEffort: "medium", createdAt: now(), updatedAt: now(), latestRunStatus: null, latestRunPhase: null };
      this.db.prepare("INSERT INTO sessions (id, title, model_id, reasoning_effort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(session.id, session.title, session.modelId, session.reasoningEffort, session.createdAt, session.updatedAt);
      this.initializeSessionProfileRevisions(session.id, session.createdAt);
      if (requestId) this.db.prepare("INSERT INTO session_requests (request_id,session_id,created_at) VALUES (?,?,?)").run(requestId, session.id, session.createdAt);
      return session;
    });
    return transaction();
  }

  createSessionIdempotent(input: {
    title: string;
    principalId: string;
    idempotencyKey: string;
    canonicalPayload: string;
    provenance?: Record<string, unknown>;
  }): { session: Session; replayed: boolean } {
    const payloadHash = createHash("sha256").update(input.canonicalPayload).digest("hex");
    const readReceipt = () => this.db.prepare(`SELECT payload_hash as payloadHash,session_id as sessionId
      FROM session_create_receipts WHERE principal_id=? AND idempotency_key=?`)
      .get(input.principalId, input.idempotencyKey) as { payloadHash: string; sessionId: string } | undefined;
    const replay = (existing: { payloadHash: string; sessionId: string }) => {
      if (existing.payloadHash !== payloadHash) throw new Error("Session idempotency conflict: key is bound to a different canonical payload");
      const session = this.getSession(existing.sessionId);
      if (!session) throw new Error("Session idempotency receipt references a missing Session");
      return { session, replayed: true };
    };
    const create = this.db.transaction(() => {
      const existing = readReceipt();
      if (existing) return replay(existing);
      const timestamp = now();
      const session: Session = {
        id: randomUUID(), title: input.title, modelId: this.defaultModelId, reasoningEffort: "medium",
        createdAt: timestamp, updatedAt: timestamp, latestRunStatus: null, latestRunPhase: null,
      };
      this.db.prepare("INSERT INTO sessions (id,title,model_id,reasoning_effort,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(session.id, session.title, session.modelId, session.reasoningEffort, timestamp, timestamp);
      this.initializeSessionProfileRevisions(session.id, timestamp);
      this.db.prepare(`INSERT INTO session_create_receipts
        (principal_id,idempotency_key,payload_hash,canonical_payload_json,session_id,provenance_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        input.principalId, input.idempotencyKey, payloadHash, input.canonicalPayload, session.id,
        JSON.stringify(input.provenance ?? {}), timestamp, timestamp,
      );
      return { session, replayed: false };
    });
    try {
      return create();
    } catch (error) {
      // A second SQLite connection may commit the same principal/key between
      // this transaction's first read and insert. The unique key is the
      // authority; reread it so a valid concurrent replay never leaks as 500.
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        const existing = readReceipt();
        if (existing) return replay(existing);
      }
      throw error;
    }
  }

  claimTaskRunCommand(input: {
    principalId: string;
    taskRunId: string;
    commandId: string;
    commandType: string;
    canonicalPayload: string;
    targetAttemptId: string | null;
    provenance?: Record<string, unknown>;
    requestId: string;
  }): { receipt: TaskRunCommandReceipt; claimed: boolean } {
    const payloadHash = createHash("sha256").update(input.canonicalPayload).digest("hex");
    return this.db.transaction(() => {
      const existing = this.getTaskRunCommand(input.principalId, input.taskRunId, input.commandId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new Error("Command idempotency conflict: commandId is bound to a different canonical payload");
        return { receipt: existing, claimed: false };
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO task_run_command_receipts
        (principal_id,task_run_id,command_id,command_type,payload_hash,payload_json,target_attempt_id,status,
         result_json,error_json,provenance_json,request_id,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
        input.principalId, input.taskRunId, input.commandId, input.commandType, payloadHash, input.canonicalPayload,
        input.targetAttemptId, "started", "", "", JSON.stringify(input.provenance ?? {}), input.requestId, timestamp, timestamp,
      );
      return { receipt: this.getTaskRunCommand(input.principalId, input.taskRunId, input.commandId)!, claimed: true };
    })();
  }

  getTaskRunCommand(principalId: string, taskRunId: string, commandId: string): TaskRunCommandReceipt | undefined {
    const row = this.db.prepare(`SELECT principal_id as principalId,task_run_id as taskRunId,command_id as commandId,
      command_type as commandType,payload_hash as payloadHash,payload_json as payloadJson,target_attempt_id as targetAttemptId,
      status as state,result_json as resultJson,error_json as errorJson,provenance_json as provenanceJson,request_id as requestId,
      created_at as createdAt,updated_at as updatedAt,completed_at as completedAt
      FROM task_run_command_receipts WHERE principal_id=? AND task_run_id=? AND command_id=?`)
      .get(principalId, taskRunId, commandId) as (Omit<TaskRunCommandReceipt, "payload" | "result" | "error" | "provenance"> & {
        payloadJson: string; resultJson: string; errorJson: string; provenanceJson: string;
      }) | undefined;
    if (!row) return undefined;
    const { payloadJson, resultJson, errorJson, provenanceJson, ...receipt } = row;
    return {
      ...receipt,
      payload: JSON.parse(payloadJson) as Record<string, unknown>,
      result: resultJson ? JSON.parse(resultJson) as Record<string, unknown> : null,
      error: errorJson ? JSON.parse(errorJson) as Record<string, unknown> : null,
      provenance: JSON.parse(provenanceJson) as Record<string, unknown>,
    };
  }

  settleTaskRunCommand(
    principalId: string,
    taskRunId: string,
    commandId: string,
    state: "succeeded" | "failed" | "outcome_unknown",
    result: Record<string, unknown> = {},
    error: Record<string, unknown> = {},
  ): TaskRunCommandReceipt {
    const timestamp = now();
    const update = this.db.prepare(`UPDATE task_run_command_receipts SET status=?,result_json=?,error_json=?,updated_at=?,completed_at=?
      WHERE principal_id=? AND task_run_id=? AND command_id=? AND status='started'`).run(
      state, Object.keys(result).length ? JSON.stringify(result) : "", Object.keys(error).length ? JSON.stringify(error) : "",
      timestamp, timestamp, principalId, taskRunId, commandId,
    );
    const receipt = this.getTaskRunCommand(principalId, taskRunId, commandId);
    if (!receipt) throw new Error("TaskRun command receipt not found");
    if (update.changes === 0 && receipt.state === "started") throw new Error("TaskRun command receipt could not be settled");
    return receipt;
  }

  claimWorkspaceGoalOperation(input: {
    goalId: string; requestId: string; operationType: string; canonicalPayload: string;
  }): { receipt: WorkspaceGoalOperationReceipt; claimed: boolean } {
    const payloadHash = createHash("sha256").update(input.canonicalPayload).digest("hex");
    return this.db.transaction(() => {
      const existing = this.getWorkspaceGoalOperation(input.goalId, input.requestId);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.operationType !== input.operationType) {
          throw new Error("workspace Goal operation idempotency conflict");
        }
        return { receipt: existing, claimed: false };
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO workspace_goal_operation_receipts
        (goal_id,request_id,operation_type,payload_hash,payload_json,status,result_json,error_json,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,'started','','',?,?,NULL)`).run(
        input.goalId, input.requestId, input.operationType, payloadHash, input.canonicalPayload, timestamp, timestamp,
      );
      return { receipt: this.getWorkspaceGoalOperation(input.goalId, input.requestId)!, claimed: true };
    })();
  }

  getWorkspaceGoalOperation(goalId: string, requestId: string): WorkspaceGoalOperationReceipt | undefined {
    const row = this.db.prepare(`SELECT goal_id as goalId,request_id as requestId,operation_type as operationType,payload_hash as payloadHash,
      payload_json as payloadJson,status as state,result_json as resultJson,error_json as errorJson,
      created_at as createdAt,updated_at as updatedAt,completed_at as completedAt
      FROM workspace_goal_operation_receipts WHERE goal_id=? AND request_id=?`).get(goalId, requestId) as
      (Omit<WorkspaceGoalOperationReceipt, "payload" | "result" | "error"> & { payloadJson: string; resultJson: string; errorJson: string }) | undefined;
    if (!row) return undefined;
    const { payloadJson, resultJson, errorJson, ...receipt } = row;
    return {
      ...receipt,
      payload: JSON.parse(payloadJson) as Record<string, unknown>,
      result: resultJson ? JSON.parse(resultJson) as Record<string, unknown> : null,
      error: errorJson ? JSON.parse(errorJson) as Record<string, unknown> : null,
    };
  }

  settleWorkspaceGoalOperation(
    goalId: string, requestId: string, state: "succeeded" | "failed" | "outcome_unknown",
    result: Record<string, unknown> = {}, error: Record<string, unknown> = {},
  ): WorkspaceGoalOperationReceipt {
    const timestamp = now();
    this.db.prepare(`UPDATE workspace_goal_operation_receipts SET status=?,result_json=?,error_json=?,updated_at=?,completed_at=?
      WHERE goal_id=? AND request_id=? AND status='started'`).run(
      state, Object.keys(result).length ? JSON.stringify(result) : "", Object.keys(error).length ? JSON.stringify(error) : "",
      timestamp, timestamp, goalId, requestId,
    );
    const receipt = this.getWorkspaceGoalOperation(goalId, requestId);
    if (!receipt) throw new Error("workspace Goal operation receipt not found");
    return receipt;
  }

  listSessions(): Session[] {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.model_id as modelId, sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.id DESC LIMIT 1
      )
      ORDER BY sessions.updated_at DESC
    `).all() as Session[];
  }

  listOperatorSessionsPage(query: OperatorReadPageQuery): { items: OperatorSessionReadRow[]; snapshotRowId: number } {
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) FROM sessions").pluck().get());
    const afterClause = query.after
      ? "AND (sessions.created_at < @afterCreatedAt OR (sessions.created_at = @afterCreatedAt AND sessions.id < @afterId))"
      : "";
    const items = this.db.prepare(`
      SELECT sessions.id,sessions.title,sessions.model_id as modelId,sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt,sessions.updated_at as updatedAt,
        latest.id as latestTaskRunId,latest.status as latestTaskRunStatus,latest.phase as latestTaskRunPhase,
        CASE WHEN latest.updated_at IS NOT NULL AND latest.updated_at > sessions.updated_at
          THEN latest.updated_at ELSE sessions.updated_at END as latestActivityAt
      FROM sessions
      LEFT JOIN runs latest ON latest.rowid = (
        SELECT candidate.rowid FROM runs candidate WHERE candidate.session_id=sessions.id
        ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT 1
      )
      WHERE sessions.rowid <= @snapshotRowId ${afterClause}
      ORDER BY sessions.created_at DESC,sessions.id DESC LIMIT @limit
    `).all({
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as OperatorSessionReadRow[];
    return { items, snapshotRowId };
  }

  getSession(id: SessionId): Session | undefined {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.model_id as modelId, sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.id DESC LIMIT 1
      )
      WHERE sessions.id = ?
    `).get(id) as Session | undefined;
  }

  getSessionPrincipalId(sessionId: SessionId): string | undefined {
    const row = this.db.prepare(`
      SELECT principalId FROM (
        SELECT principal_id AS principalId, 0 AS sourcePriority, created_at AS createdAt
        FROM session_create_receipts WHERE session_id = ?
        UNION ALL
        SELECT principal_id AS principalId, 1 AS sourcePriority, created_at AS createdAt
        FROM submission_audit_receipts WHERE session_id = ?
      )
      ORDER BY sourcePriority ASC, createdAt ASC
      LIMIT 1
    `).get(sessionId, sessionId) as { principalId: string } | undefined;
    return row?.principalId;
  }

  updateSession(id: SessionId, settings: SessionSettingsUpdate): Session | undefined {
    const current = this.getSession(id);
    if (!current) return undefined;
    const title = settings.title === undefined ? current.title : settings.title.trim();
    const modelId = settings.modelId === undefined ? current.modelId : settings.modelId.trim();
    const reasoningEffort = settings.reasoningEffort ?? current.reasoningEffort;
    if (!title || !modelId || !REASONING_EFFORTS.has(reasoningEffort)) return undefined;
    this.db.prepare("UPDATE sessions SET title = ?, model_id = ?, reasoning_effort = ?, revision=revision+1, updated_at = ? WHERE id = ?")
      .run(title, modelId, reasoningEffort, now(), id);
    return this.getSession(id);
  }

  renameSession(id: SessionId, title: string): Session | undefined {
    return this.updateSession(id, { title });
  }

  createSkillRevision(input: CreateSkillRevisionInput): SkillRevision {
    return this.db.transaction(() => {
      const timestamp = now();
      let skill = input.skillId
        ? this.db.prepare("SELECT id,name FROM skills WHERE id=?").get(input.skillId) as { id: string; name: string } | undefined
        : this.db.prepare("SELECT id,name FROM skills WHERE name=?").get(input.name) as { id: string; name: string } | undefined;
      const createdSkill = !skill;
      if (input.skillId && !skill) throw new Error("Skill not found");
      if (!skill) {
        skill = { id: randomUUID(), name: input.name };
        this.db.prepare("INSERT INTO skills (id,name,created_at,updated_at) VALUES (?,?,?,?)")
          .run(skill.id, input.name, timestamp, timestamp);
      }
      const duplicate = this.db.prepare("SELECT id FROM skill_revisions WHERE skill_id=? AND sha256=?")
        .get(skill.id, input.sha256) as { id: string } | undefined;
      if (duplicate) {
        if (skill.name !== input.name) {
          this.db.prepare("UPDATE skills SET name=?,revision=revision+1,updated_at=? WHERE id=?")
            .run(input.name, timestamp, skill.id);
          this.touchSkillCatalogRevision(timestamp);
        }
        return this.getSkillRevision(duplicate.id)!;
      }
      if (skill.name !== input.name) {
        this.db.prepare("UPDATE skills SET name=?,updated_at=? WHERE id=?").run(input.name, timestamp, skill.id);
      }
      const revision = (this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM skill_revisions WHERE skill_id=?")
        .get(skill.id) as { revision: number }).revision;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO skill_revisions
        (id,skill_id,revision,description,content,file_path,sha256,disable_model_invocation,source_filename,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, skill.id, revision, input.description, input.content, input.filePath, input.sha256,
        Number(input.disableModelInvocation ?? false), input.sourceFilename, timestamp,
      );
      this.db.prepare(`UPDATE skills SET revision=revision+?,updated_at=? WHERE id=?`)
        .run(createdSkill ? 0 : 1, timestamp, skill.id);
      this.touchSkillCatalogRevision(timestamp);
      return this.getSkillRevision(id)!;
    })();
  }

  getSkillRevision(revisionId: string): SkillRevision | undefined {
    const row = this.db.prepare(`SELECT r.id,r.skill_id AS skillId,r.revision,s.name,r.description,r.content,
      r.file_path AS filePath,r.sha256,r.disable_model_invocation AS disableModelInvocation,
      r.source_filename AS sourceFilename,r.created_at AS createdAt
      FROM skill_revisions r JOIN skills s ON s.id=r.skill_id WHERE r.id=?`).get(revisionId) as
      (Omit<SkillRevision, "disableModelInvocation"> & { disableModelInvocation: number }) | undefined;
    return row ? { ...row, disableModelInvocation: Boolean(row.disableModelInvocation) } : undefined;
  }

  listSkills(): SkillSummary[] {
    return this.db.prepare(`SELECT s.id,s.name,r.revision AS latestRevision,r.id AS latestRevisionId,
      r.description,r.sha256,(SELECT COUNT(*) FROM workspace_skill_bindings bindings WHERE bindings.skill_id=s.id) AS workspaceCount,
      s.updated_at AS updatedAt FROM skills s JOIN skill_revisions r ON r.skill_id=s.id
      WHERE r.revision=(SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=s.id)
      ORDER BY s.updated_at DESC,s.name`).all() as SkillSummary[];
  }

  getCatalogRevision(): number {
    return Number(this.db.prepare("SELECT revision FROM skill_catalog_state WHERE id=1").pluck().get());
  }

  getSkillResourceRevision(skillId: string): number | undefined {
    return (this.db.prepare("SELECT revision FROM skills WHERE id=?").get(skillId) as { revision: number } | undefined)?.revision;
  }

  getWorkspaceSkillRevision(workspaceId: string): number | undefined {
    return (this.db.prepare("SELECT revision FROM workspace_skill_revisions WHERE workspace_id=?").get(workspaceId) as
      { revision: number } | undefined)?.revision;
  }

  listProfileSkillsPage(query: ProfilePageQuery): ProfileSkillCatalogPage {
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) FROM skills").pluck().get());
    const afterClause = query.after
      ? "AND (s.created_at < @afterCreatedAt OR (s.created_at = @afterCreatedAt AND s.id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT s.id,s.name,r.revision AS latestRevision,r.id AS latestRevisionId,
      r.description,r.sha256,(SELECT COUNT(*) FROM workspace_skill_bindings bindings WHERE bindings.skill_id=s.id) AS workspaceCount,
      s.updated_at AS updatedAt,s.created_at AS orderCreatedAt FROM skills s JOIN skill_revisions r ON r.skill_id=s.id
      WHERE s.rowid<=@snapshotRowId AND r.revision=(SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=s.id)
      ${afterClause} ORDER BY s.created_at DESC,s.id DESC LIMIT @limit`).all({
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<SkillSummary & { orderCreatedAt: number }>;
    return {
      items: rows.map(({ orderCreatedAt: _orderCreatedAt, ...item }) => item),
      orderKeys: rows.map((item) => ({ createdAt: item.orderCreatedAt, id: item.id })),
      snapshotRowId,
      collectionRevision: this.getCatalogRevision(),
    };
  }

  listProfileSkillRevisionsPage(skillId: string, query: ProfilePageQuery): ProfileSkillRevisionPage | undefined {
    const resourceRevision = this.getSkillResourceRevision(skillId);
    if (resourceRevision === undefined) return undefined;
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(rowid),0) FROM skill_revisions WHERE skill_id=?",
    ).pluck().get(skillId));
    const afterClause = query.after
      ? "AND (created_at < @afterCreatedAt OR (created_at = @afterCreatedAt AND id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT id FROM skill_revisions WHERE skill_id=@skillId AND rowid<=@snapshotRowId
      ${afterClause} ORDER BY created_at DESC,id DESC LIMIT @limit`).all({
      skillId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<{ id: string }>;
    return { items: rows.map((row) => this.getSkillRevision(row.id)!), snapshotRowId, resourceRevision };
  }

  listProfileWorkspaceSkillsPage(workspaceId: string, query: ProfilePageQuery): ProfileWorkspaceSkillPage | undefined {
    const bindingRevision = this.getWorkspaceSkillRevision(workspaceId);
    if (bindingRevision === undefined) return undefined;
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(rowid),0) FROM workspace_skill_bindings WHERE session_id=?",
    ).pluck().get(workspaceId));
    const afterClause = query.after
      ? "AND (bindings.bound_at < @afterCreatedAt OR (bindings.bound_at = @afterCreatedAt AND bindings.skill_id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT revisions.id,bindings.bound_at AS orderCreatedAt,bindings.skill_id AS orderId
      FROM workspace_skill_bindings bindings
      JOIN skill_revisions revisions ON revisions.skill_id=bindings.skill_id
      WHERE bindings.session_id=@workspaceId AND bindings.rowid<=@snapshotRowId AND revisions.revision=(
        SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=bindings.skill_id
      ) ${afterClause} ORDER BY bindings.bound_at DESC,bindings.skill_id DESC LIMIT @limit`).all({
      workspaceId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<{ id: string; orderCreatedAt: number; orderId: string }>;
    return {
      items: rows.map((row) => this.getSkillRevision(row.id)!),
      orderKeys: rows.map((row) => ({ createdAt: row.orderCreatedAt, id: row.orderId })),
      snapshotRowId,
      bindingRevision,
    };
  }

  getSkill(skillId: string): SkillRevision | undefined {
    const row = this.db.prepare("SELECT id FROM skill_revisions WHERE skill_id=? ORDER BY revision DESC LIMIT 1")
      .get(skillId) as { id: string } | undefined;
    return row ? this.getSkillRevision(row.id) : undefined;
  }

  listSkillRevisions(skillId: string): SkillRevision[] {
    const rows = this.db.prepare("SELECT id FROM skill_revisions WHERE skill_id=? ORDER BY revision DESC")
      .all(skillId) as Array<{ id: string }>;
    return rows.map((row) => this.getSkillRevision(row.id)!);
  }

  listWorkspaceSkills(workspaceId: string): SkillRevision[] {
    const rows = this.db.prepare(`SELECT revisions.id FROM workspace_skill_bindings bindings
      JOIN skill_revisions revisions ON revisions.skill_id=bindings.skill_id
      WHERE bindings.session_id=? AND revisions.revision=(
        SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=bindings.skill_id
      ) ORDER BY bindings.bound_at,bindings.skill_id`).all(workspaceId) as Array<{ id: string }>;
    return rows.map((row) => this.getSkillRevision(row.id)!);
  }

  replaceWorkspaceSkills(workspaceId: string, skillIds: readonly string[]): SkillRevision[] | undefined {
    return this.db.transaction(() => {
      if (!this.getSession(workspaceId)) return undefined;
      const uniqueIds = [...new Set(skillIds)];
      for (const skillId of uniqueIds) if (!this.getSkill(skillId)) return undefined;
      this.db.prepare("DELETE FROM workspace_skill_bindings WHERE session_id=?").run(workspaceId);
      const insert = this.db.prepare("INSERT INTO workspace_skill_bindings (session_id,skill_id,bound_at) VALUES (?,?,?)");
      const timestamp = now();
      uniqueIds.forEach((skillId, index) => insert.run(workspaceId, skillId, timestamp + index));
      this.db.prepare(`INSERT INTO workspace_skill_revisions (workspace_id,revision,updated_at) VALUES (?,2,?)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_skill_revisions.revision+1,updated_at=excluded.updated_at`)
        .run(workspaceId, timestamp);
      this.touchSession(workspaceId);
      return this.listWorkspaceSkills(workspaceId);
    })();
  }

  deleteSkill(skillId: string): SkillRevision[] | undefined {
    return this.db.transaction(() => {
      const revisions = this.listSkillRevisions(skillId);
      if (!revisions.length) return undefined;
      const workspaceIds = (this.db.prepare("SELECT session_id AS workspaceId FROM workspace_skill_bindings WHERE skill_id=?")
        .all(skillId) as Array<{ workspaceId: string }>).map((row) => row.workspaceId);
      this.db.prepare("DELETE FROM workspace_skill_bindings WHERE skill_id=?").run(skillId);
      this.db.prepare("DELETE FROM skill_revisions WHERE skill_id=?").run(skillId);
      this.db.prepare("DELETE FROM skills WHERE id=?").run(skillId);
      const timestamp = now();
      this.touchSkillCatalogRevision(timestamp);
      for (const workspaceId of workspaceIds) {
        this.db.prepare("UPDATE workspace_skill_revisions SET revision=revision+1,updated_at=? WHERE workspace_id=?")
          .run(timestamp, workspaceId);
        this.touchSession(workspaceId);
      }
      return revisions;
    })();
  }

  createRevisionProfile(
    input: CreateSkillRevisionInput,
    mutation: ProfileMutationContext,
  ): ProfileMutationResult<ProfileSkillMutationValue> {
    const skillId = input.skillId;
    return this.runSkillProfileMutation({
      mutation,
      endpointId: skillId ? "operator.skills.update" : "operator.skills.create",
      resourceType: skillId ? "skill" : "skill_catalog",
      resourceId: skillId ?? "catalog",
      operation: skillId ? "update" : "create",
      currentRevision: () => skillId ? this.getSkillResourceRevision(skillId) : this.getCatalogRevision(),
      perform: () => {
        const skill = this.createSkillRevision(input);
        const resourceRevision = this.getSkillResourceRevision(skill.skillId)!;
        return {
          value: { skill, resourceRevision, catalogRevision: this.getCatalogRevision() },
          resultingRevision: skillId ? resourceRevision : this.getCatalogRevision(),
        };
      },
    });
  }

  deleteSkillProfile(skillId: string, mutation: ProfileMutationContext): ProfileMutationResult<ProfileSkillDeleteValue> {
    return this.runSkillProfileMutation({
      mutation,
      endpointId: "operator.skills.delete",
      resourceType: "skill",
      resourceId: skillId,
      operation: "delete",
      currentRevision: () => this.getSkillResourceRevision(skillId),
      perform: () => {
        if (!this.deleteSkill(skillId)) throw new Error("Skill disappeared during deletion");
        const catalogRevision = this.getCatalogRevision();
        return { value: { ok: true, skillId, catalogRevision }, resultingRevision: catalogRevision };
      },
    });
  }

  replaceWorkspaceSkillsProfile(
    workspaceId: string,
    skillIds: readonly string[],
    mutation: ProfileMutationContext,
  ): ProfileMutationResult<ProfileWorkspaceSkillsMutationValue> {
    return this.runSkillProfileMutation({
      mutation,
      endpointId: "operator.workspace_skills.replace",
      resourceType: "workspace",
      resourceId: workspaceId,
      operation: "replace",
      currentRevision: () => this.getWorkspaceSkillRevision(workspaceId),
      perform: () => {
        const skills = this.replaceWorkspaceSkills(workspaceId, skillIds);
        if (!skills) throw new Error("Workspace Skill replacement became invalid");
        const bindingRevision = this.getWorkspaceSkillRevision(workspaceId)!;
        return { value: { skills, bindingRevision }, resultingRevision: bindingRevision };
      },
    }, () => skillIds.some((skillId) => !this.getSkill(skillId)) ? "state_conflict" : undefined);
  }

  private runSkillProfileMutation<T>(input: {
    mutation: ProfileMutationContext;
    endpointId: string;
    resourceType: string;
    resourceId: string;
    operation: string;
    currentRevision: () => number | undefined;
    perform: () => { value: T; resultingRevision: number };
  }, precondition?: () => "state_conflict" | undefined): ProfileMutationResult<T> {
    const identity = {
      principalId: input.mutation.principalId,
      profileId: "operator.skills.v1",
      endpointId: input.endpointId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      idempotencyKey: input.mutation.idempotencyKey,
    };
    const payloadHash = createHash("sha256").update(input.mutation.canonicalPayload).digest("hex");
    return this.db.transaction((): ProfileMutationResult<T> => {
      const existing = this.db.prepare(`SELECT payload_hash AS payloadHash,expected_revision AS expectedRevision,
        result_json AS resultJson FROM profile_mutation_receipts
        WHERE principal_id=@principalId AND profile_id=@profileId AND endpoint_id=@endpointId
          AND resource_type=@resourceType AND resource_id=@resourceId AND idempotency_key=@idempotencyKey`)
        .get(identity) as { payloadHash: string; expectedRevision: number; resultJson: string } | undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.expectedRevision !== input.mutation.expectedRevision) {
          return { status: "idempotency_conflict" };
        }
        return { status: "succeeded", value: JSON.parse(existing.resultJson) as T, replayed: true };
      }
      const currentRevision = input.currentRevision();
      if (currentRevision === undefined) return { status: "not_found" };
      if (currentRevision !== input.mutation.expectedRevision) {
        return { status: "concurrency_conflict", currentRevision };
      }
      const rejected = precondition?.();
      if (rejected) return { status: rejected };
      const timestamp = now();
      const result = input.perform();
      this.db.prepare(`INSERT INTO profile_mutation_receipts
        (principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key,payload_hash,
         expected_revision,resulting_revision,result_json,created_at,updated_at)
        VALUES (@principalId,@profileId,@endpointId,@resourceType,@resourceId,@idempotencyKey,@payloadHash,
          @expectedRevision,@resultingRevision,@resultJson,@timestamp,@timestamp)`).run({
        ...identity,
        payloadHash,
        expectedRevision: input.mutation.expectedRevision,
        resultingRevision: result.resultingRevision,
        resultJson: JSON.stringify(result.value),
        timestamp,
      });
      this.db.prepare(`INSERT INTO profile_audit_events
        (id,principal_id,granted_scopes_json,delegated_actor_id,delegated_request_id,request_id,profile_id,
         endpoint_id,resource_type,resource_id,operation,outcome,error_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'succeeded','',?)`).run(
        randomUUID(), input.mutation.principalId, JSON.stringify([...input.mutation.grantedScopes]),
        input.mutation.delegatedActorId ?? null, input.mutation.delegatedRequestId ?? null,
        input.mutation.requestId, identity.profileId, identity.endpointId, identity.resourceType,
        identity.resourceId, input.operation, timestamp,
      );
      return { status: "succeeded", value: result.value, replayed: false };
    })();
  }

  private touchSession(id: SessionId) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  private touchSkillCatalogRevision(timestamp = now()) {
    this.db.prepare("UPDATE skill_catalog_state SET revision=revision+1,updated_at=? WHERE id=1").run(timestamp);
  }

  private initializeSessionProfileRevisions(id: SessionId, timestamp: number) {
    this.db.prepare("INSERT OR IGNORE INTO workspace_skill_revisions (workspace_id,revision,updated_at) VALUES (?,1,?)")
      .run(id, timestamp);
    this.db.prepare("INSERT OR IGNORE INTO session_inbox_revisions (session_id,revision,updated_at) VALUES (?,1,?)")
      .run(id, timestamp);
  }

  private touchSessionInboxRevision(sessionId: SessionId, timestamp = now()) {
    this.db.prepare(`INSERT INTO session_inbox_revisions (session_id,revision,updated_at) VALUES (?,2,?)
      ON CONFLICT(session_id) DO UPDATE SET revision=session_inbox_revisions.revision+1,updated_at=excluded.updated_at`)
      .run(sessionId, timestamp);
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

  enqueueSessionInbox(
    sessionId: SessionId,
    content: string,
    analysis: SessionInputAnalysis,
    requestId: string = randomUUID(),
    audit?: SubmissionAuditInput,
  ): Submission {
    assertSubmissionContentBound(content);
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id = ? AND request_id = ?").get(sessionId, requestId) as { id: string } | undefined;
      if (existing) {
        const item = this.getSessionInboxItem(existing.id)!;
        if (item.content !== content) throw new Error("Session Inbox request idempotency conflict");
        if (audit) this.recordSubmissionAudit(item, audit);
        return item;
      }
      const timestamp = now();
      const position = (this.db.prepare("SELECT COALESCE(MAX(position),0)+1 as position FROM session_supervisor_inbox WHERE session_id = ? AND status = 'queued'").get(sessionId) as { position: number }).position;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO session_supervisor_inbox
        (id,session_id,request_id,content,status,decision,position,created_at,updated_at,summary,objectives_json,intent,target_run_id,priority,urgency,relation,acceptance_json,scope,non_goals_json,confidence,decision_reason,router_version,execution_policy_json)
        VALUES (?,?,?,?,'queued','pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, sessionId, requestId, content, position, timestamp, timestamp, analysis.summary, JSON.stringify(analysis.objectives ?? [{ id: "objective-1", summary: analysis.summary, timing: "current", kind: "other" }]), analysis.intent, analysis.targetRunId, analysis.priority, analysis.urgency, analysis.relation, JSON.stringify(analysis.acceptanceCriteria), analysis.scope, JSON.stringify(analysis.nonGoals), analysis.confidence, analysis.reason, analysis.routerVersion, JSON.stringify(analysis.executionPolicy ?? null));
      this.touchSessionInboxRevision(sessionId, timestamp);
      const item = this.getSessionInboxItem(id)!;
      if (audit) this.recordSubmissionAudit(item, audit);
      return item;
    });
    return transaction();
  }

  private hydrateSessionInbox(row: Record<string, unknown> | undefined): Submission | undefined {
    if (!row) return undefined;
    const acceptanceCriteria = JSON.parse(String(row.acceptanceJson || "[]")) as string[];
    const nonGoals = JSON.parse(String(row.nonGoalsJson || "[]")) as string[];
    const objectives = JSON.parse(String(row.objectivesJson || "[]")) as TaskObjective[];
    const fallbackObjective = { id: "objective-1", summary: String(row.summary || row.content || ""), timing: row.relation === "parallel" ? "parallel" : row.relation === "follow_up" ? "follow_up" : "current", kind: "other" } as const;
    const executionPolicy = row.executionPolicyJson ? JSON.parse(String(row.executionPolicyJson)) : undefined;
    return { ...row, manualOrder: Boolean(row.manualOrder), analysis: { summary: String(row.summary || row.content || ""), objectives: objectives.length ? objectives : [fallbackObjective], intent: row.intent, targetRunId: row.targetRunId || null, priority: Number(row.priority || 0), urgency: row.urgency, relation: row.relation, acceptanceCriteria, scope: String(row.scope || row.summary || ""), nonGoals, confidence: Number(row.confidence || 0), reason: String(row.decisionReason || ""), routerVersion: String(row.routerVersion || ""), ...(executionPolicy ? { executionPolicy } : {}) } } as Submission;
  }

  private sessionInboxSelect(where: string) {
    return `SELECT id,session_id as sessionId,request_id as requestId,content,status,decision,run_id as runId,error,position,
      created_at as createdAt,updated_at as updatedAt,claimed_at as claimedAt,started_at as startedAt,
      summary,objectives_json as objectivesJson,intent,target_run_id as targetRunId,priority,urgency,relation,acceptance_json as acceptanceJson,scope,
      non_goals_json as nonGoalsJson,confidence,decision_reason as decisionReason,router_version as routerVersion,execution_policy_json as executionPolicyJson,manual_order as manualOrder
      FROM session_supervisor_inbox ${where}`;
  }

  getSessionInboxItem(id: string): Submission | undefined {
    return this.hydrateSessionInbox(this.db.prepare(this.sessionInboxSelect("WHERE id = ?")).get(id) as Record<string, unknown> | undefined);
  }

  getSessionSubmission(sessionId: SessionId, requestId: string): Submission | undefined {
    return this.hydrateSessionInbox(this.db.prepare(this.sessionInboxSelect("WHERE session_id = ? AND request_id = ?")).get(sessionId, requestId) as Record<string, unknown> | undefined);
  }

  recordSubmissionAudit(item: Submission, audit: SubmissionAuditInput): SubmissionAuditReceipt {
    const payloadHash = createHash("sha256").update(audit.canonicalPayload).digest("hex");
    const existing = this.getSubmissionAudit(item.sessionId, item.requestId);
    if (existing) {
      if (existing.submissionId !== item.id || existing.payloadHash !== payloadHash) {
        throw new Error("Submission idempotency conflict: key is bound to a different canonical payload");
      }
      return existing;
    }
    const timestamp = now();
    try {
      this.db.prepare(`INSERT INTO submission_audit_receipts
        (session_id,idempotency_key,submission_id,principal_id,payload_hash,canonical_payload_json,provenance_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        item.sessionId, item.requestId, item.id, audit.principalId, payloadHash, audit.canonicalPayload,
        JSON.stringify(audit.provenance ?? {}), timestamp, timestamp,
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (!(typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))) throw error;
    }
    const recorded = this.getSubmissionAudit(item.sessionId, item.requestId);
    if (!recorded || recorded.submissionId !== item.id || recorded.payloadHash !== payloadHash) {
      throw new Error("Submission idempotency conflict: key is bound to a different canonical payload");
    }
    return recorded;
  }

  getSubmissionAudit(sessionId: SessionId, requestId: string): SubmissionAuditReceipt | undefined {
    const row = this.db.prepare(`SELECT session_id as sessionId,idempotency_key as idempotencyKey,submission_id as submissionId,
      principal_id as principalId,payload_hash as payloadHash,canonical_payload_json as canonicalPayload,
      provenance_json as provenanceJson,created_at as createdAt,updated_at as updatedAt
      FROM submission_audit_receipts WHERE session_id=? AND idempotency_key=?`).get(sessionId, requestId) as
      (Omit<SubmissionAuditReceipt, "provenance"> & { provenanceJson: string }) | undefined;
    if (!row) return undefined;
    const { provenanceJson, ...receipt } = row;
    return { ...receipt, provenance: JSON.parse(provenanceJson) as Record<string, unknown> };
  }

  listSessionInbox(sessionId: SessionId, includeTerminal = false): Submission[] {
    const rows = this.db.prepare(`${this.sessionInboxSelect(`WHERE session_id = ? ${includeTerminal ? "" : "AND status IN ('queued','claimed')"}`)} ORDER BY
      manual_order DESC, CASE WHEN manual_order=1 THEN position END ASC, CASE urgency WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
      priority DESC, position, created_at, id`).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateSessionInbox(row)!);
  }

  routeSessionInboxItem(id: string, sessionId: SessionId, decision: "steer" | "follow_up" | "discussion", runId: RunId | null, error = "") {
    const timestamp = now();
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET status='routed',decision=?,run_id=?,error=?,claimed_at=COALESCE(claimed_at,?),started_at=COALESCE(started_at,?),revision=revision+1,updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(decision, runId, error, timestamp, timestamp, timestamp, id, sessionId);
    if (changed.changes === 1) this.touchSessionInboxRevision(sessionId, timestamp);
    return changed.changes === 1 ? this.getSessionInboxItem(id) : undefined;
  }

  findMergeCandidate(sessionId: SessionId, analysis: SessionInputAnalysis) {
    const normalized = analysis.summary.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!normalized) return undefined;
    const gateProfile = analysis.executionPolicy?.gateProfile ?? "strict";
    return this.listSessionInbox(sessionId).find((item) => item.status === "queued" && item.decision === "pending"
      && (item.analysis.executionPolicy?.gateProfile ?? "strict") === gateProfile
      && item.analysis.intent === analysis.intent
      && item.analysis.summary.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === normalized);
  }

  markSessionInboxDuplicate(sourceId: string, targetId: string, sessionId: SessionId) {
    const timestamp = now();
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET status='deleted',decision='merge',error=?,revision=revision+1,updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(`Duplicate of ${targetId}`, timestamp, sourceId, sessionId);
    if (changed.changes === 1) this.touchSessionInboxRevision(sessionId, timestamp);
    return changed.changes === 1 ? this.getSessionInboxItem(sourceId) : undefined;
  }

  updateSessionInboxItem(id: string, sessionId: SessionId, content: string, analysis?: SessionInputAnalysis) {
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    assertSubmissionContentBound(content);
    const resolved = analysis ?? { ...this.getSessionInboxItem(id)?.analysis, summary: trimmed.slice(0, 120), scope: trimmed.slice(0, 120) } as SessionInputAnalysis;
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET content=?,summary=?,objectives_json=?,intent=?,target_run_id=?,priority=?,urgency=?,relation=?,
      acceptance_json=?,scope=?,non_goals_json=?,confidence=?,decision_reason=?,router_version=?,execution_policy_json=?,revision=revision+1,updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`)
      .run(trimmed, resolved.summary, JSON.stringify(resolved.objectives), resolved.intent, resolved.targetRunId, resolved.priority, resolved.urgency, resolved.relation,
        JSON.stringify(resolved.acceptanceCriteria), resolved.scope, JSON.stringify(resolved.nonGoals), resolved.confidence, resolved.reason,
        resolved.routerVersion, JSON.stringify(resolved.executionPolicy ?? null), now(), id, sessionId).changes;
    if (changed === 1) this.touchSessionInboxRevision(sessionId);
    return changed === 1 ? this.getSessionInboxItem(id) : undefined;
  }

  private mutateSessionInboxProfile(input: {
    sessionId: SessionId;
    endpointId: string;
    operation: string;
    mutation: ProfileMutationContext;
    work: () => string[] | undefined;
  }): ProfileMutationResult<ProfileInboxMutationValue> {
    const identity = {
      principalId: input.mutation.principalId,
      profileId: "operator.session-inbox.v1",
      endpointId: input.endpointId,
      resourceType: "session_inbox",
      resourceId: input.sessionId,
      idempotencyKey: input.mutation.idempotencyKey,
    };
    const payloadHash = createHash("sha256").update(input.mutation.canonicalPayload).digest("hex");
    return this.db.transaction((): ProfileMutationResult<ProfileInboxMutationValue> => {
      const existing = this.db.prepare(`SELECT payload_hash AS payloadHash,expected_revision AS expectedRevision,
        result_json AS resultJson FROM profile_mutation_receipts
        WHERE principal_id=@principalId AND profile_id=@profileId AND endpoint_id=@endpointId
          AND resource_type=@resourceType AND resource_id=@resourceId AND idempotency_key=@idempotencyKey`)
        .get(identity) as { payloadHash: string; expectedRevision: number; resultJson: string } | undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.expectedRevision !== input.mutation.expectedRevision) {
          return { status: "idempotency_conflict" };
        }
        return {
          status: "succeeded",
          value: JSON.parse(existing.resultJson) as ProfileInboxMutationValue,
          replayed: true,
        };
      }
      const currentRevision = (this.db.prepare("SELECT revision FROM session_inbox_revisions WHERE session_id=?")
        .get(input.sessionId) as { revision: number } | undefined)?.revision;
      if (currentRevision === undefined) return { status: "not_found" };
      if (currentRevision !== input.mutation.expectedRevision) {
        return { status: "concurrency_conflict", currentRevision };
      }
      const itemIds = input.work();
      if (!itemIds) return { status: "state_conflict" };
      const resultingRevision = (this.db.prepare("SELECT revision FROM session_inbox_revisions WHERE session_id=?")
        .get(input.sessionId) as { revision: number }).revision;
      const items = itemIds.map((itemId) => this.getProfileInboxItem(input.sessionId, itemId))
        .filter((item): item is ProfileInboxItemRecord => Boolean(item));
      const value = { items, collectionRevision: resultingRevision };
      const timestamp = now();
      this.db.prepare(`INSERT INTO profile_mutation_receipts
        (principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key,payload_hash,
         expected_revision,resulting_revision,result_json,created_at,updated_at)
        VALUES (@principalId,@profileId,@endpointId,@resourceType,@resourceId,@idempotencyKey,@payloadHash,
          @expectedRevision,@resultingRevision,@resultJson,@timestamp,@timestamp)`).run({
        ...identity,
        payloadHash,
        expectedRevision: input.mutation.expectedRevision,
        resultingRevision,
        resultJson: JSON.stringify(value),
        timestamp,
      });
      this.db.prepare(`INSERT INTO profile_audit_events
        (id,principal_id,granted_scopes_json,delegated_actor_id,delegated_request_id,request_id,profile_id,
         endpoint_id,resource_type,resource_id,operation,outcome,error_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), input.mutation.principalId, JSON.stringify([...input.mutation.grantedScopes]),
        input.mutation.delegatedActorId ?? null, input.mutation.delegatedRequestId ?? null,
        input.mutation.requestId, identity.profileId, identity.endpointId, identity.resourceType,
        identity.resourceId, input.operation, "succeeded", "", timestamp,
      );
      return { status: "succeeded", value, replayed: false };
    })();
  }

  private getProfileInboxItem(sessionId: SessionId, itemId: string): ProfileInboxItemRecord | undefined {
    const row = this.db.prepare(`SELECT id,session_id AS sessionId,content,status,decision,run_id AS runId,
      position,summary,intent,target_run_id AS targetRunId,priority,urgency,relation,
      acceptance_json AS acceptanceCriteriaJson,confidence,decision_reason AS reason,
      execution_policy_json AS executionPolicyJson,revision,created_at AS createdAt,updated_at AS updatedAt
      FROM session_supervisor_inbox WHERE session_id=? AND id=?`).get(sessionId, itemId) as
      (Omit<ProfileInboxItemRecord, "executionPolicy" | "acceptanceCriteria"> & {
        executionPolicyJson: string; acceptanceCriteriaJson: string;
      }) | undefined;
    if (!row) return undefined;
    const { executionPolicyJson, acceptanceCriteriaJson, ...item } = row;
    return {
      ...item,
      acceptanceCriteria: JSON.parse(acceptanceCriteriaJson || "[]") as string[],
      executionPolicy: executionPolicyJson
        ? JSON.parse(executionPolicyJson) as ProfileInboxItemRecord["executionPolicy"]
        : null,
    };
  }

  updateSessionInboxItemProfile(input: {
    sessionId: SessionId;
    itemId: string;
    content: string;
    analysis: SessionInputAnalysis;
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue> {
    return this.mutateSessionInboxProfile({
      sessionId: input.sessionId,
      endpointId: "operator.session_inbox.update",
      operation: "update",
      mutation: input.mutation,
      work: () => this.updateSessionInboxItem(input.itemId, input.sessionId, input.content, input.analysis)
        ? [input.itemId] : undefined,
    });
  }

  reorderSessionInboxProfile(input: {
    sessionId: SessionId;
    itemIds: string[];
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue> {
    return this.mutateSessionInboxProfile({
      sessionId: input.sessionId,
      endpointId: "operator.session_inbox.reorder",
      operation: "reorder",
      mutation: input.mutation,
      work: () => this.reorderSessionInbox(input.sessionId, input.itemIds)?.map((item) => item.id),
    });
  }

  deleteSessionInboxItemProfile(input: {
    sessionId: SessionId;
    itemId: string;
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue> {
    return this.mutateSessionInboxProfile({
      sessionId: input.sessionId,
      endpointId: "operator.session_inbox.delete",
      operation: "delete",
      mutation: input.mutation,
      work: () => this.deleteSessionInboxItem(input.itemId, input.sessionId) ? [input.itemId] : undefined,
    });
  }

  decideSessionInboxItemProfile(input: {
    sessionId: SessionId;
    itemId: string;
    decision: "pending" | "defer";
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue> {
    return this.mutateSessionInboxProfile({
      sessionId: input.sessionId,
      endpointId: "operator.session_inbox.decide",
      operation: "decide",
      mutation: input.mutation,
      work: () => this.decideSessionInboxItem(input.itemId, input.sessionId, input.decision) ? [input.itemId] : undefined,
    });
  }

  mergeSessionInboxItemsProfile(input: {
    sessionId: SessionId;
    sourceId: string;
    targetId: string;
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue> {
    return this.mutateSessionInboxProfile({
      sessionId: input.sessionId,
      endpointId: "operator.session_inbox.merge",
      operation: "merge",
      mutation: input.mutation,
      work: () => this.mergeSessionInboxItems(input.sourceId, input.targetId, input.sessionId)
        ? [input.sourceId, input.targetId] : undefined,
    });
  }

  reorderSessionInbox(sessionId: SessionId, itemIds: string[]) {
    const transaction = this.db.transaction(() => {
      const queued = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id=? AND status='queued' ORDER BY position,created_at,id")
        .all(sessionId) as Array<{ id: string }>;
      const currentIds = queued.map((item) => item.id);
      if (itemIds.length !== currentIds.length || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !currentIds.includes(id))) return undefined;
      const timestamp = now();
      const update = this.db.prepare("UPDATE session_supervisor_inbox SET position=?,revision=revision+1,updated_at=? WHERE id=? AND session_id=? AND status='queued'");
      itemIds.forEach((id, index) => update.run(index + 1, timestamp, id, sessionId));
      this.db.prepare("UPDATE session_supervisor_inbox SET manual_order=1 WHERE session_id=? AND status='queued'").run(sessionId);
      this.touchSessionInboxRevision(sessionId, timestamp);
      return this.listSessionInbox(sessionId);
    });
    return transaction();
  }

  deleteSessionInboxItem(id: string, sessionId: SessionId) {
    const timestamp = now();
    const changed = this.db.prepare(`UPDATE session_supervisor_inbox SET status='deleted',decision='delete',revision=revision+1,updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(timestamp, id, sessionId).changes === 1;
    if (changed) this.touchSessionInboxRevision(sessionId, timestamp);
    return changed;
  }

  discardSessionInboxItem(id: string, sessionId: SessionId) {
    const changed = this.db.prepare("DELETE FROM session_supervisor_inbox WHERE id=? AND session_id=? AND status='queued' AND run_id IS NULL")
      .run(id, sessionId).changes === 1;
    if (changed) this.touchSessionInboxRevision(sessionId);
    return changed;
  }

  decideSessionInboxItem(id: string, sessionId: SessionId, decision: "pending" | "defer") {
    const timestamp = now();
    const changed = this.db.prepare("UPDATE session_supervisor_inbox SET decision=?,revision=revision+1,updated_at=? WHERE id=? AND session_id=? AND status='queued'").run(decision,timestamp,id,sessionId).changes === 1;
    if (changed) this.touchSessionInboxRevision(sessionId, timestamp);
    return changed;
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
        confidence=?,decision_reason=?,decision='pending',revision=revision+1,updated_at=? WHERE id=? AND status='queued'`)
        .run(content, summary, JSON.stringify(mergedCriteria), scope, priority, urgency,
          Math.min(target.analysis.confidence, source.analysis.confidence), `Merged queued instructions ${target.id} and ${source.id}`, timestamp, targetId);
      this.db.prepare("UPDATE session_supervisor_inbox SET status='deleted',decision='merge',error=?,revision=revision+1,updated_at=? WHERE id=? AND status='queued'").run(`Merged into ${targetId}`,timestamp,sourceId);
      this.touchSessionInboxRevision(sessionId, timestamp);
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
    const claimed = this.db.prepare("UPDATE session_supervisor_inbox SET status='claimed',decision='start_taskrun',claimed_at=?,revision=revision+1,updated_at=? WHERE id=? AND session_id=? AND status='queued'").run(timestamp,timestamp,itemId,sessionId);
    if (claimed.changes !== 1) return undefined;
    this.touchSessionInboxRevision(sessionId, timestamp);
    const inbox = this.getSessionInboxItem(itemId)!;
    const contract: TaskRunContractSnapshot = { sourceInput: inbox.content, summary: inbox.analysis.summary, objectives: inbox.analysis.objectives, acceptanceCriteria: inbox.analysis.acceptanceCriteria, scope: inbox.analysis.scope, nonGoals: inbox.analysis.nonGoals, sourceInboxIds: [inbox.id], parentRunId: inbox.analysis.targetRunId, relation: inbox.analysis.relation, intent: inbox.analysis.intent, decisionReason: inbox.analysis.reason, routerVersion: inbox.analysis.routerVersion, executionPolicy: inbox.analysis.executionPolicy };
    const run = this.createRun(sessionId, inbox.analysis.summary || inbox.content, `inbox:${inbox.id}`, contract);
    if (contract.parentRunId && contract.parentRunId !== run.id) {
      const edgeRelation = contract.relation === "parallel" || contract.relation === "follow_up" || contract.relation === "derived" || contract.relation === "depends_on" ? contract.relation : "derived";
      this.db.prepare("INSERT OR IGNORE INTO taskrun_edges (from_run_id,to_run_id,relation,reason,created_at) VALUES (?,?,?,?,?)")
        .run(contract.parentRunId,run.id,edgeRelation,`Session Inbox ${inbox.id}: ${contract.decisionReason}`,timestamp);
    }
    this.db.prepare("UPDATE session_supervisor_inbox SET status='started',run_id=?,started_at=?,revision=revision+1,updated_at=? WHERE id=? AND status='claimed'").run(run.id,timestamp,timestamp,inbox.id);
    this.touchSessionInboxRevision(sessionId, timestamp);
    return { item: this.getSessionInboxItem(inbox.id)!, run };
  }

  recordSessionInboxLaunchFailure(itemId: string, runId: RunId, error: string) {
    const timestamp = now();
    const row = this.db.prepare("SELECT session_id AS sessionId FROM session_supervisor_inbox WHERE id=? AND run_id=?")
      .get(itemId, runId) as { sessionId: string } | undefined;
    const changed = this.db.prepare("UPDATE session_supervisor_inbox SET status='started',error=?,revision=revision+1,updated_at=? WHERE id=? AND run_id=?")
      .run(error,timestamp,itemId,runId);
    if (changed.changes === 1 && row) this.touchSessionInboxRevision(row.sessionId, timestamp);
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
      this.db.prepare("UPDATE session_supervisor_inbox SET error='',revision=revision+1,updated_at=? WHERE id=? AND run_id=? AND status='started'").run(resumedAt,target.inboxItemId,runId);
      this.touchSessionInboxRevision(target.sessionId, resumedAt);
      this.projectAttempt({
        runId, ordinal: nextAttempt, trigger: "retry", status: "running", scenario: "retry",
        eventSequence: this.getRun(runId)?.lastEventSeq ?? 0, timestamp: resumedAt,
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
      const selectedSkills = this.listWorkspaceSkills(sessionId);
      const frozenContract = contract && selectedSkills.length ? {
        ...contract,
        skills: selectedSkills.map((skill) => ({
          skillId: skill.skillId, revisionId: skill.id, revision: skill.revision, name: skill.name,
          description: skill.description, content: skill.content, filePath: skill.filePath,
          sha256: skill.sha256, disableModelInvocation: skill.disableModelInvocation,
        })),
      } : contract;
      this.db.prepare(`
        INSERT INTO runs (id, session_id, request_id, status, phase, goal, model_id, reasoning_effort, gate_required, created_at, updated_at, contract_json)
        VALUES (?, ?, ?, 'running', 'discover', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, requestId, goal, session.modelId, session.reasoningEffort, effectiveGateProfile(frozenContract) === "off" ? 0 : 1, timestamp, timestamp, frozenContract ? JSON.stringify(frozenContract) : "");
      this.projectAttempt({
        runId: id, ordinal: 1, trigger: "initial", status: "running", scenario: "initial",
        eventSequence: 0, timestamp,
      });
      return this.getRun(id)!;
    });
    return transaction();
  }

  hasRun(id: RunId): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id));
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
    const checkRows = this.db.prepare(`SELECT check_key as key, title, status, required, command, evidence, stale,
      source_operation_id as sourceOperationId, observed_at as observedAt
      FROM run_checks WHERE run_id = ? ORDER BY check_key`).all(id) as Array<Omit<RunCheck, "required" | "stale"> & { required: number; stale: number }>;
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

  getRunExecutionState(id: RunId): TaskRunExecutionState | undefined {
    const row = this.db.prepare(`SELECT id,status,phase,attempt,last_event_seq as lastEventSeq,
      (SELECT COUNT(*) FROM plan_items WHERE run_id=runs.id) as planCount,
      (SELECT COUNT(*) FROM run_checks WHERE run_id=runs.id) as checkCount,
      (SELECT COUNT(*) FROM artifacts WHERE run_id=runs.id) as artifactCount
      FROM runs WHERE id=?`).get(id) as {
        id: RunId; status: RunStatus; phase: RunPhase; attempt: number; lastEventSeq: number;
        planCount: number; checkCount: number; artifactCount: number;
      } | undefined;
    if (!row) return undefined;
    const { planCount, checkCount, artifactCount, ...state } = row;
    return { ...state, counts: { plan: planCount, checks: checkCount, artifacts: artifactCount } };
  }

  getRunByRequestId(requestId: string): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE request_id = ?").get(requestId) as { id: RunId } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  listRuns(sessionId: SessionId, limit = 50): TaskRun[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?").all(sessionId, limit) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  listRunSummaries(sessionId: SessionId, limit = 50): Array<Pick<TaskRun, "id" | "goal" | "status" | "phase" | "contract" | "attempt" | "createdAt" | "updatedAt">> {
    const rows = this.db.prepare(`SELECT id,goal,status,phase,contract_json as contractJson,attempt,created_at as createdAt,updated_at as updatedAt
      FROM runs WHERE session_id=? ORDER BY updated_at DESC LIMIT ?`).all(sessionId, limit) as Array<{
        id: string; goal: string; status: RunStatus; phase: RunPhase; contractJson: string; attempt: number; createdAt: number; updatedAt: number;
      }>;
    return rows.map(({ contractJson, ...row }) => ({
      ...row,
      contract: contractJson ? JSON.parse(contractJson) as TaskRunContractSnapshot : null,
    }));
  }

  listOperatorSessionTaskRunsPage(
    sessionId: SessionId,
    query: OperatorReadPageQuery,
  ): { items: OperatorTaskRunReadRow[]; snapshotRowId: number } {
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) FROM runs").pluck().get());
    const afterClause = query.after
      ? "AND (runs.created_at < @afterCreatedAt OR (runs.created_at = @afterCreatedAt AND runs.id < @afterId))"
      : "";
    const items = this.db.prepare(`
      SELECT runs.id,runs.session_id as sessionId,runs.status,runs.phase,runs.attempt,
        substr(CASE WHEN trim(COALESCE(json_extract(CASE WHEN json_valid(runs.contract_json) THEN runs.contract_json ELSE '{}' END,'$.summary'),''))<>''
          THEN trim(json_extract(CASE WHEN json_valid(runs.contract_json) THEN runs.contract_json ELSE '{}' END,'$.summary')) ELSE trim(runs.goal) END,1,500) as goalSummary,
        substr(runs.blocked_reason,1,500) as blockedReason,
        EXISTS(SELECT 1 FROM approval_requests approval WHERE approval.run_id=runs.id AND approval.status='pending') as pendingApproval,
        EXISTS(SELECT 1 FROM user_input_requests input WHERE input.run_id=runs.id AND input.status='pending') as pendingUserInput,
        runs.last_event_seq as lastEventSequence,runs.created_at as createdAt,runs.updated_at as updatedAt,
        runs.completed_at as completedAt,
        CASE WHEN runs.status IN ('interrupted','blocked') THEN 1
          WHEN runs.status='failed' AND EXISTS(
            SELECT 1 FROM run_events event WHERE event.run_id=runs.id AND event.type='run.failed'
              AND json_extract(event.data,'$.reason') IN ('idle_timeout','hard_timeout')
          ) THEN 1 ELSE 0 END as resumable
      FROM runs
      WHERE runs.session_id=@sessionId AND runs.rowid <= @snapshotRowId ${afterClause}
      ORDER BY runs.created_at DESC,runs.id DESC LIMIT @limit
    `).all({
      sessionId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as OperatorTaskRunReadRow[];
    return { items, snapshotRowId };
  }

  getLatestOperatorSessionTaskRun(sessionId: SessionId): OperatorTaskRunReadRow | undefined {
    return this.db.prepare(`
      SELECT runs.id,runs.session_id as sessionId,runs.status,runs.phase,runs.attempt,
        substr(CASE WHEN trim(COALESCE(json_extract(CASE WHEN json_valid(runs.contract_json) THEN runs.contract_json ELSE '{}' END,'$.summary'),''))<>''
          THEN trim(json_extract(CASE WHEN json_valid(runs.contract_json) THEN runs.contract_json ELSE '{}' END,'$.summary')) ELSE trim(runs.goal) END,1,500) as goalSummary,
        substr(runs.blocked_reason,1,500) as blockedReason,
        EXISTS(SELECT 1 FROM approval_requests approval WHERE approval.run_id=runs.id AND approval.status='pending') as pendingApproval,
        EXISTS(SELECT 1 FROM user_input_requests input WHERE input.run_id=runs.id AND input.status='pending') as pendingUserInput,
        runs.last_event_seq as lastEventSequence,runs.created_at as createdAt,runs.updated_at as updatedAt,
        runs.completed_at as completedAt,
        CASE WHEN runs.status IN ('interrupted','blocked') THEN 1
          WHEN runs.status='failed' AND EXISTS(
            SELECT 1 FROM run_events event WHERE event.run_id=runs.id AND event.type='run.failed'
              AND json_extract(event.data,'$.reason') IN ('idle_timeout','hard_timeout')
          ) THEN 1 ELSE 0 END as resumable
      FROM runs WHERE runs.session_id=? ORDER BY runs.updated_at DESC,runs.id DESC LIMIT 1
    `).get(sessionId) as OperatorTaskRunReadRow | undefined;
  }

  getLatestRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC,id DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
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
        reason: prompt, eventSequence: seq, timestamp: request.requestedAt,
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
      const active = this.db.prepare(`SELECT continuation.id, continuation.run_id as runId, continuation.ordinal, continuation.status,
          run.attempt, run.last_event_seq as lastEventSeq FROM run_continuations continuation
        JOIN runs run ON run.id=continuation.run_id
        WHERE (continuation.status = 'queued' AND continuation.not_before <= ?) OR (continuation.status = 'running'
          AND (continuation.lease_until IS NULL OR continuation.lease_until <= ?))
        ORDER BY continuation.created_at`).all(timestamp, timestamp) as Array<{ id: string; runId: RunId; ordinal: number; status: "queued" | "running"; attempt: number; lastEventSeq: number }>;
      for (const item of active) {
        // A queued continuation becoming due is normal scheduling, not recovery.
        // Only an expired running lease needs durable repair before it can be claimed again.
        if (item.status === "queued") continue;
        this.db.prepare(`UPDATE run_continuations SET status = 'queued', error = 'Recovered after lease expiry',
          started_at = NULL, completed_at = NULL, lease_owner = '', lease_until = NULL, heartbeat_at = NULL WHERE id = ?`).run(item.id);
        this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = 'Continuation recovered after service restart', completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')")
          .run(timestamp, item.runId);
        this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
          .run(timestamp, item.runId);
        this.projectAttempt({
          runId: item.runId, ordinal: item.attempt, trigger: "recovery", status: "blocked", scenario: "recovery",
          reason: "Continuation recovered after service restart", eventSequence: item.lastEventSeq, timestamp,
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
          reason, eventSequence: item.lastEventSeq, timestamp,
        });
      }
      return active.map(({ id, runId, ordinal }) => ({ id, runId, ordinal }));
    });
    return transaction();
  }

  releaseContinuationLease(id: string, owner: string, reason = "Continuation preparation failed") {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const item = this.db.prepare(`SELECT continuation.id, continuation.run_id as runId, continuation.ordinal,
          run.attempt, run.last_event_seq as lastEventSeq FROM run_continuations continuation
        JOIN runs run ON run.id=continuation.run_id
        WHERE continuation.id = ? AND continuation.status = 'running' AND continuation.lease_owner = ?`)
        .get(id, owner) as { id: string; runId: RunId; ordinal: number; attempt: number; lastEventSeq: number } | undefined;
      if (!item) return undefined;
      const released = this.db.prepare(`UPDATE run_continuations SET status = 'queued', error = ?, started_at = NULL,
          completed_at = NULL, lease_owner = '', lease_until = NULL, heartbeat_at = NULL
          WHERE id = ? AND status = 'running' AND lease_owner = ?`).run(reason, item.id, owner);
      if (released.changes !== 1) return undefined;
      this.db.prepare(`UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = ?,
        completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')`)
        .run(reason, timestamp, item.runId);
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
        .run(timestamp, item.runId);
      this.projectAttempt({
        runId: item.runId, ordinal: item.attempt, trigger: "recovery", status: "blocked", scenario: "recovery",
        reason, eventSequence: item.lastEventSeq, timestamp,
      });
      return { id: item.id, runId: item.runId, ordinal: item.ordinal };
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
      not_before as notBefore,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt,
      lease_owner as leaseOwner, lease_until as leaseUntil, heartbeat_at as heartbeatAt
      FROM run_continuations WHERE run_id = ? ORDER BY ordinal`).all(runId) as RunContinuation[];
  }

  queueContinuation(runId: RunId, reason: string, notBefore = 0): RunContinuation {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare("SELECT id FROM run_continuations WHERE run_id = ? AND status IN ('queued', 'running')").get(runId) as { id: string } | undefined;
      if (active) throw new Error("Run already has an active continuation");
      const timestamp = now();
      const row = this.db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 as ordinal FROM run_continuations WHERE run_id = ?").get(runId) as { ordinal: number };
      const earliestStart = Math.max(0, Math.floor(notBefore));
      const continuation: RunContinuation = { id: randomUUID(), runId, ordinal: row.ordinal, status: "queued", reason, error: "", notBefore: earliestStart, createdAt: timestamp, startedAt: null, completedAt: null, leaseOwner: "", leaseUntil: null, heartbeatAt: null };
      this.db.prepare("INSERT INTO run_continuations (id, run_id, ordinal, status, reason, not_before, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
        .run(continuation.id, runId, continuation.ordinal, reason, earliestStart, timestamp);
      return continuation;
    });
    return transaction();
  }

  claimContinuation(runId: RunId, owner: string, leaseMs: number) {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const continuation = this.db.prepare(`SELECT id, ordinal FROM run_continuations
        WHERE run_id = ? AND status = 'queued' AND not_before <= ? ORDER BY ordinal LIMIT 1`).get(runId, timestamp) as { id: string; ordinal: number } | undefined;
      if (!continuation) return undefined;
      const run = this.db.prepare("SELECT session_id as sessionId, status, last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { sessionId: SessionId; status: RunStatus; seq: number } | undefined;
      if (!run || run.status !== "blocked") return undefined;
      const otherRunning = this.db.prepare("SELECT 1 FROM runs WHERE session_id = ? AND id <> ? AND status = 'running' LIMIT 1").get(run.sessionId, runId);
      if (otherRunning) return undefined;
      const leaseUntil = timestamp + leaseMs;
      const claimed = this.db.prepare(`UPDATE run_continuations SET status = 'running', error = '',
        started_at = COALESCE(started_at, ?), completed_at = NULL, lease_owner = ?, lease_until = ?, heartbeat_at = ?
        WHERE id = ? AND status = 'queued' AND not_before <= ?`).run(timestamp, owner, leaseUntil, timestamp, continuation.id, timestamp);
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
        eventSequence: seq, timestamp,
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

  listTranscriptEntries(runId: RunId, options: { limit?: number; attempt?: number; after?: number } = {}) {
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.floor(options.limit));
    const rows = options.after !== undefined
      ? options.attempt === undefined
        ? limit === undefined
          ? this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, options.after)
          : this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(runId, options.after, limit)
        : limit === undefined
          ? this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? AND attempt = ? AND seq > ? ORDER BY seq").all(runId, options.attempt, options.after)
          : this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? AND attempt = ? AND seq > ? ORDER BY seq LIMIT ?").all(runId, options.attempt, options.after, limit)
      : options.attempt === undefined
      ? limit === undefined
        ? this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? ORDER BY seq").all(runId)
        : this.db.prepare(`SELECT * FROM (SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt
          FROM run_transcript WHERE run_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`).all(runId, limit)
      : limit === undefined
        ? this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? AND attempt = ? ORDER BY seq").all(runId, options.attempt)
        : this.db.prepare(`SELECT * FROM (SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt
          FROM run_transcript WHERE run_id = ? AND attempt = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`).all(runId, options.attempt, limit);
    return (rows as Array<{ seq: number; attempt: number; role: string; messageJson: string; createdAt: number }>).map(({ messageJson, ...row }) => ({ ...row, message: JSON.parse(messageJson) as AgentMessage }));
  }

  searchTranscriptLiteral(runId: RunId, query: string, options: { limit?: number; snippetChars?: number; beforeSeq?: number } = {}) {
    if (!query) throw new Error("Transcript literal search query cannot be empty");
    const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 8)));
    const snippetChars = Math.min(1_000, Math.max(80, Math.floor(options.snippetChars ?? 320)));
    const encodedQuery = JSON.stringify(query).slice(1, -1);
    const beforeSeq = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(`SELECT seq,attempt,role,message_json as messageJson,created_at as createdAt
      FROM run_transcript
      WHERE run_id=? AND seq < ? AND instr(message_json, ?) > 0
      ORDER BY seq DESC LIMIT ?`).all(runId, beforeSeq, encodedQuery, limit + 1) as Array<{
        seq: number; attempt: number; role: string; messageJson: string; createdAt: number;
      }>;
    const matches = rows.slice(0, limit).map(({ messageJson, ...row }) => {
      const index = messageJson.indexOf(encodedQuery);
      const available = Math.max(0, snippetChars - encodedQuery.length);
      let start = Math.max(0, index - Math.floor(available / 2));
      let end = Math.min(messageJson.length, start + snippetChars);
      start = Math.max(0, end - snippetChars);
      return {
        ...row,
        snippet: `${start > 0 ? "…" : ""}${messageJson.slice(start, end)}${end < messageJson.length ? "…" : ""}`,
      };
    });
    return { matches, truncated: rows.length > limit };
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
          details: { synthetic: true, reason }, isError: true,
          error: { name: "ToolExecutionError", code: "ABORTED", message: `Tool call interrupted by ${reason} boundary` },
          timestamp: now(),
        };
        this.appendTranscript(runId, run.attempt, message);
        repaired.push({ toolCallId, toolName });
      }
      return repaired;
    });
    return transaction();
  }

  listTranscriptView(runId: RunId, options: { limit?: number; attempt?: number; after?: number } = {}) {
    type TranscriptViewItem =
      | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "thinking"; text: string; redacted: boolean; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; error?: Extract<AgentMessage, { role: "toolResult" }>["error"]; status: "pending" | "completed" | "failed"; createdAt: number };
    const toolResults = new Map<string, { content: string; isError: boolean; error?: Extract<AgentMessage, { role: "toolResult" }>["error"]; toolName: string }>();
    const entries = [...this.listTranscriptEntries(runId, options)];
    const supplementalEntrySeqs = new Set<number>();
    const toolCallIds = new Set<string>();
    const completedToolCallIds = new Set<string>();
    for (const entry of entries) {
      const message = entry.message;
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") toolCallIds.add(part.id);
      }
      if (message.role !== "toolResult") continue;
      completedToolCallIds.add(message.toolCallId);
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      toolResults.set(message.toolCallId, { content, isError: message.isError, error: message.error, toolName: message.toolName });
    }
    const missingToolCallSources = [...completedToolCallIds].filter((id) => !toolCallIds.has(id));
    if (missingToolCallSources.length) {
      const rows = this.db.prepare(`SELECT DISTINCT t.seq,t.attempt,t.role,t.message_json as messageJson,t.created_at as createdAt
        FROM run_transcript t, json_each(t.message_json,'$.content') part
        WHERE t.run_id=? AND t.role='assistant'
          AND json_extract(part.value,'$.type')='toolCall'
          AND json_extract(part.value,'$.id') IN (SELECT value FROM json_each(?))`)
        .all(runId, JSON.stringify(missingToolCallSources)) as Array<{ seq: number; attempt: number; role: string; messageJson: string; createdAt: number }>;
      const existingSeq = new Set(entries.map((entry) => entry.seq));
      for (const { messageJson, ...row } of rows) {
        if (existingSeq.has(row.seq)) continue;
        entries.push({ ...row, message: JSON.parse(messageJson) as AgentMessage });
        supplementalEntrySeqs.add(row.seq);
        existingSeq.add(row.seq);
        const message = JSON.parse(messageJson) as Extract<AgentMessage, { role: "assistant" }>;
        for (const part of message.content) if (part.type === "toolCall") toolCallIds.add(part.id);
      }
      entries.sort((left, right) => left.seq - right.seq);
    }
    const missingToolCallIds = [...toolCallIds].filter((id) => !toolResults.has(id));
    if (missingToolCallIds.length) {
      const rows = this.db.prepare(`SELECT message_json as messageJson FROM run_transcript
        WHERE run_id=? AND role='toolResult'
          AND json_extract(message_json,'$.toolCallId') IN (SELECT value FROM json_each(?))`)
        .all(runId, JSON.stringify(missingToolCallIds)) as Array<{ messageJson: string }>;
      for (const row of rows) {
        const message = JSON.parse(row.messageJson) as Extract<AgentMessage, { role: "toolResult" }>;
        const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        toolResults.set(message.toolCallId, { content, isError: message.isError, error: message.error, toolName: message.toolName });
      }
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
        if (supplementalEntrySeqs.has(entry.seq) && (part.type !== "toolCall" || !completedToolCallIds.has(part.id))) continue;
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
        view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "tool", toolCallId: part.id, toolName: part.name, arguments: part.arguments, result: result?.content ?? "", isError: result?.isError ?? false, error: result?.error, status: result ? (result.isError ? "failed" : "completed") : "pending", createdAt: entry.createdAt });
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
        (id, run_id, attempt, attempt_id, operation_type, payload_hash, payload_json, status, stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 'executing', ?, ?)`).run(
        id, runId, attempt, this.attemptId(runId, attempt), operationType, payloadHash, JSON.stringify(payload), timestamp, timestamp,
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
      payload_json as payloadJson, status, stage, effects_json as effectsJson, result_json as resultJson, error, created_at as createdAt,
      updated_at as updatedAt, completed_at as completedAt FROM operations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrateOperation(row) : undefined;
  }

  listOperations(runId: RunId, options: { limit?: number; ids?: string[] } = {}) {
    const select = `SELECT id, run_id as runId, attempt, operation_type as operationType,
      payload_hash as payloadHash, payload_json as payloadJson, status, stage, effects_json as effectsJson,
      result_json as resultJson, error, created_at as createdAt, updated_at as updatedAt, completed_at as completedAt
      FROM operations WHERE run_id = ?`;
    const ids = [...new Set(options.ids?.map((id) => id.trim()).filter(Boolean) ?? [])];
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.floor(options.limit));
    const filters: string[] = [];
    const params: Array<string | number> = [runId];
    if (ids.length) {
      // Keep the query at a constant bind count. A long-lived Run can legitimately
      // accumulate more evidence references than SQLite's host-parameter ceiling.
      filters.push("id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(ids));
    }
    if (limit !== undefined) {
      filters.push("id IN (SELECT id FROM operations WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT ?)");
      params.push(runId, limit);
    }
    const where = filters.length ? ` AND (${filters.join(" OR ")})` : "";
    const rows = this.db.prepare(`${select}${where} ORDER BY created_at,id`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateOperation(row));
  }

  private hydrateOperation(row: Record<string, unknown>) {
    const { payloadJson, effectsJson, resultJson, ...receipt } = row;
    return {
      ...receipt,
      payload: payloadJson ? JSON.parse(String(payloadJson)) as unknown : undefined,
      effects: JSON.parse(String(effectsJson || "[]")) as unknown[],
      result: resultJson ? JSON.parse(String(resultJson)) as unknown : undefined,
    } as import("@tagent/governance/ports").OperationRecord;
  }

  recordToolAttempt(runId: RunId, attempt: number, toolCallId: string, toolName: string, args: unknown) {
    const argsHash = this.canonicalHash(args);
    const timestamp = now();
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO tool_attempts
      (run_id, attempt, attempt_id, tool_call_id, tool_name, args_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`).run(
      runId, attempt, this.attemptId(runId, attempt), toolCallId, toolName, argsHash, timestamp,
    );
    const row = this.db.prepare(`SELECT tool_name AS toolName,args_hash AS argsHash,status FROM tool_attempts
      WHERE run_id=? AND attempt=? AND tool_call_id=?`).get(runId, attempt, toolCallId) as {
        toolName: string;
        argsHash: string;
        status: "running" | "succeeded" | "failed";
      };
    if (row.toolName !== toolName || row.argsHash !== argsHash) {
      throw new Error(`Tool attempt ${toolCallId} already exists with different content`);
    }
    return { argsHash, created: inserted.changes === 1, status: row.status, guard: this.evaluateToolGuard(runId, toolName, argsHash) };
  }

  completeToolAttempt(runId: RunId, attempt: number, toolCallId: string, success: boolean, error = "") {
    return this.db.prepare(`UPDATE tool_attempts SET status=?,error=?,completed_at=?
      WHERE run_id=? AND attempt=? AND tool_call_id=? AND status='running'`)
      .run(success ? "succeeded" : "failed", error, now(), runId, attempt, toolCallId).changes === 1;
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
    const bound = this.bindTrustedCheckEvidence(runId, check);
    this.db.prepare(`
      INSERT INTO run_checks (run_id, check_key, title, status, required, command, evidence, stale, source_operation_id, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, check_key) DO UPDATE SET title=excluded.title, status=excluded.status,
        required=excluded.required, command=excluded.command, evidence=excluded.evidence, stale=excluded.stale,
        source_operation_id=excluded.source_operation_id, observed_at=excluded.observed_at
    `).run(runId, bound.key, bound.title, bound.status, Number(bound.required), bound.command, bound.evidence,
      Number(bound.stale), bound.sourceOperationId ?? null, bound.observedAt ?? null);
    this.advanceRunPhase(runId, bound.status === "pending" ? "implement" : "verify");
  }

  private bindTrustedCheckEvidence(runId: RunId, check: RunCheck): RunCheck {
    const sourceOperationId = check.sourceOperationId?.trim() || null;
    if (check.status !== "passed" || !sourceOperationId) {
      return { ...check, sourceOperationId: null, observedAt: null };
    }
    const run = this.db.prepare("SELECT attempt FROM runs WHERE id=?").get(runId) as { attempt: number } | undefined;
    const operation = this.getOperation(sourceOperationId);
    if (!run || !operation || operation.runId !== runId || operation.attempt !== run.attempt) {
      throw new Error("Passed check evidence must reference a successful operation from the current Run Attempt");
    }
    if (operation.operationType !== "tool.bash" || operation.status !== "succeeded" || !operation.completedAt || operation.result === undefined) {
      throw new Error("Passed check evidence must reference a completed successful Bash operation");
    }
    const payload = operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload)
      ? operation.payload as Record<string, unknown>
      : undefined;
    const command = typeof payload?.command === "string" ? payload.command.trim() : "";
    const result = operation.result && typeof operation.result === "object" && !Array.isArray(operation.result)
      ? operation.result as Record<string, unknown>
      : undefined;
    const details = result?.details && typeof result.details === "object" && !Array.isArray(result.details)
      ? result.details as Record<string, unknown>
      : undefined;
    if (!command || details?.exitCode !== 0) {
      throw new Error("Passed check evidence receipt is missing the actual command or zero exit code");
    }
    const output = Array.isArray(result?.content)
      ? result.content.flatMap((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n")
      : "";
    const projectedOutput = output.length <= 3_000 ? output : `${output.slice(0, 2_000)}\n... output projected by Core ...\n${output.slice(-800)}`;
    const evidence = JSON.stringify({
      sourceOperationId,
      command,
      exitCode: 0,
      observedAt: operation.completedAt,
      output: projectedOutput,
      artifactId: typeof details?.artifactId === "string" ? details.artifactId : null,
      sha256: typeof details?.sha256 === "string" ? details.sha256 : this.canonicalHash(operation.result),
    });
    return { ...check, command, evidence, stale: false, sourceOperationId, observedAt: operation.completedAt };
  }

  getArtifact(runId: RunId, artifactId: string): Artifact | undefined {
    return this.db.prepare(`SELECT id, run_id as runId, kind, title, content, uri, created_at as createdAt
      FROM artifacts WHERE run_id = ? AND id = ?`).get(runId, artifactId) as Artifact | undefined;
  }

  listArtifacts(runId: RunId, after: number, limit: number): Array<Omit<Artifact, "content">> {
    return this.db.prepare(`SELECT id, run_id as runId, kind, title, uri, created_at as createdAt
      FROM artifacts WHERE run_id = ? ORDER BY created_at,id LIMIT ? OFFSET ?`)
      .all(runId, limit, after) as Array<Omit<Artifact, "content">>;
  }

  addArtifact(runId: RunId, artifact: Omit<Artifact, "runId" | "createdAt">): Artifact {
    const createdAt = now();
    this.db.prepare("INSERT INTO artifacts (id, run_id, kind, title, content, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(artifact.id, runId, artifact.kind, artifact.title, artifact.content, artifact.uri, createdAt);
    return { ...artifact, runId, createdAt };
  }

  appendEvent<TType extends import("@tagent/execution/domain").RunEventType>(runId: RunId, type: TType, data: import("@tagent/execution/domain").RunEventMap[TType]): RunEvent<TType> {
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT attempt,last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { attempt: number; seq: number } | undefined;
      if (!run) throw new Error(`Unknown run ${runId}`);
      const seq = run.seq + 1;
      const createdAt = now();
      this.db.prepare("INSERT INTO run_events (run_id, seq, attempt_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, seq, this.attemptId(runId, run.attempt), type, JSON.stringify(data), createdAt);
      this.db.prepare("UPDATE runs SET last_event_seq = ?, updated_at = ? WHERE id = ?").run(seq, createdAt, runId);
      return { runId, seq, type, data, createdAt } as RunEvent<TType>;
    });
    return transaction();
  }

  claimEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor {
    const transaction = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) throw new Error(`Unknown run ${runId}`);
      const timestamp = now();
      this.db.prepare(`INSERT INTO event_consumers
        (run_id, consumer_id, generation, acked_seq, claimed_at, updated_at)
        VALUES (?, ?, 1, 0, ?, ?)
        ON CONFLICT(run_id, consumer_id) DO UPDATE SET generation = event_consumers.generation + 1,
          claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`).run(runId, consumerId, timestamp, timestamp);
      return this.getEventConsumer(runId, consumerId)!;
    });
    return transaction();
  }

  getEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor | undefined {
    return this.db.prepare(`SELECT run_id as runId, consumer_id as consumerId, generation,
      acked_seq as ackedSeq,
      settled_acked_seq as settledAckedSeq, final_acked_seq as finalAckedSeq,
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
      const settled = this.db.prepare(`SELECT seq FROM run_events WHERE run_id = ? AND seq <= ?
        AND type IN ('run.completed','run.blocked','run.failed','run.cancelled') ORDER BY seq DESC LIMIT 1`).get(runId, seq) as { seq: number } | undefined;
      const final = this.db.prepare(`SELECT seq FROM run_events WHERE run_id = ? AND seq <= ?
        AND type IN ('run.completed','run.cancelled') ORDER BY seq DESC LIMIT 1`).get(runId, seq) as { seq: number } | undefined;
      this.db.prepare(`UPDATE event_consumers SET acked_seq = ?,
        settled_acked_seq = COALESCE(?, settled_acked_seq),
        final_acked_seq = COALESCE(?, final_acked_seq), updated_at = ?
        WHERE run_id = ? AND consumer_id = ? AND generation = ?`).run(
        seq, settled?.seq ?? null, final?.seq ?? null,
        now(), runId, consumerId, generation,
      );
      return "accepted" as const;
    });
    return transaction();
  }

  enqueueControl(runId: RunId, requestId: string, kind: ControlInboxItem["kind"], content: string, capacity: number) {
    assertControlContent(content);
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
      const run = this.db.prepare(`SELECT r.session_id as sessionId,sd.attempt
        FROM runs r LEFT JOIN supervisor_decisions sd ON sd.id=? WHERE r.id=?`)
        .get(decisionId, runId) as { sessionId: string; attempt: number | null } | undefined;
      const request: ApprovalRequest = {
        id: randomUUID(),
        runId,
        decisionId,
        ...(run?.attempt == null ? {} : { attempt: run.attempt }),
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
      const canonical = mapRunApprovalOperation({
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
        RUN_APPROVAL_DEFAULTS.risk,
        RUN_APPROVAL_DEFAULTS.expiresAt,
        RUN_APPROVAL_DEFAULTS.reuse.mode,
        RUN_APPROVAL_DEFAULTS.reuse.maxUses,
        RUN_APPROVAL_DEFAULTS.reuse.usedCount,
      );
      return request;
    })();
  }

  private hydrateApprovalRequest(row: (Omit<ApprovalRequest,"metadata"> & {metadataJson:string})|undefined) {
    if (!row) return undefined; const {metadataJson,...request}=row; return {...request,metadata:JSON.parse(metadataJson||"{}")} as ApprovalRequest;
  }

  getApprovalRequest(id: string) {
    return this.hydrateApprovalRequest(this.db.prepare(`SELECT ar.id,ar.run_id as runId,ar.decision_id as decisionId,sd.attempt,
      ar.action_type as actionType,ar.target_type as targetType,ar.target_id as targetId,ar.reason,ar.metadata_json as metadataJson,
      ar.status,ar.requested_at as requestedAt,ar.resolved_at as resolvedAt,ar.resolved_by as resolvedBy,ar.resolution
      FROM approval_requests ar LEFT JOIN supervisor_decisions sd ON sd.id=ar.decision_id WHERE ar.id = ?`).get(id) as Omit<ApprovalRequest,"metadata"> & {metadataJson:string}|undefined);
  }

  listApprovalRequests(runId: RunId) {
    const rows=this.db.prepare(`SELECT ar.id,ar.run_id as runId,ar.decision_id as decisionId,sd.attempt,
      ar.action_type as actionType,ar.target_type as targetType,ar.target_id as targetId,ar.reason,ar.metadata_json as metadataJson,
      ar.status,ar.requested_at as requestedAt,ar.resolved_at as resolvedAt,ar.resolved_by as resolvedBy,ar.resolution
      FROM approval_requests ar LEFT JOIN supervisor_decisions sd ON sd.id=ar.decision_id
      WHERE ar.run_id = ? ORDER BY ar.requested_at,ar.id`).all(runId) as Array<Omit<ApprovalRequest,"metadata"> & {metadataJson:string}>;
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

  authorizeExternalAction(runId: RunId, attempt: number) {
    return this.db.transaction(() => {
      const approved = this.db.prepare(`SELECT id,status FROM approval_requests
        WHERE run_id=? AND action_type='execute_external_action'
          AND status IN ('approved','consumed')
          AND CAST(json_extract(metadata_json,'$.approvedAttempt') AS INTEGER)=?
        ORDER BY requested_at DESC LIMIT 1`).get(runId, attempt) as { id: string; status: string } | undefined;
      if (!approved) return { allowed: false, reason: `Attempt ${attempt} has no approved external-action authorization` };
      if (approved.status === "approved") {
        const consumed = this.db.prepare(`UPDATE approval_requests SET status='consumed',used_count=1
          WHERE id=? AND status='approved'`).run(approved.id);
        if (consumed.changes !== 1) return { allowed: false, reason: "External-action authorization was consumed concurrently" };
      }
      return { allowed: true, reason: `External action approved for Attempt ${attempt}`, approvalId: approved.id };
    })();
  }

  updateProgressSnapshot(run: GovernanceProgressRunView, event: GovernanceRunEventView): ProgressSnapshot {
    const previous = this.getProgressSnapshot(run.id);
    const toolName = String(event.data.toolName ?? "");
    const successfulToolEvent = event.type === "tool.completed" && !event.data.isError;
    const progressEvent = event.type === "run.updated" || successfulToolEvent && ["write", "edit", "patch", "task_run"].includes(toolName);
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
      consecutiveFailures: failureEvent ? (previous?.attempt === run.attempt ? previous.consecutiveFailures : 0) + 1 : successfulToolEvent || progressEvent ? 0 : previous?.consecutiveFailures ?? 0,
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

  listEvents(runId: RunId, after = 0, limit?: number): RunEvent[] {
    const rows = (limit === undefined
      ? this.db.prepare(`SELECT run_id as runId, seq, type, data, created_at as createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq`).all(runId, after)
      : this.db.prepare(`SELECT run_id as runId, seq, type, data, created_at as createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(runId, after, Math.max(1, Math.floor(limit)))) as Array<{ runId: RunId; seq: number; type: import("@tagent/execution/domain").RunEventType; data: string; createdAt: number }>;
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> })) as RunEvent[];
  }

  transitionRun(runId: RunId, expected: RunStatus[], nextStatus: RunStatus, type: import("@tagent/execution/domain").RunEventType, data: Record<string, unknown>, reason = "", expectedAttempt?: number) {
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
        reason, eventSequence: seq, timestamp: createdAt,
      });
      finalizeProjectionCheckpoint(this.db, { runId, attemptId: this.attemptId(runId, row.attempt), attemptOrdinal: row.attempt, eventSeq: seq, timestamp: createdAt });
      this.enqueueLearningProjection(runId, row.attempt, type, nextStatus, seq, { ...data, reason }, createdAt);
      return { runId, seq, type, data, createdAt } as RunEvent;
    });
    return transaction();
  }

  private enqueueLearningProjection(runId: RunId, attempt: number, lifecycle: string, outcome: string, eventSeq: number, payload: Record<string, unknown>, timestamp = now(), runEventType = lifecycle) {
    if (eventSeq <= 0) throw new Error("New Learning projections require a real run event");
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found for Learning projection`);
    appendLearningProjection(this.db, { runId, attemptId: this.attemptId(runId, attempt), attemptOrdinal: attempt,
      lifecycle, outcome, eventSeq, payload, taskRunSnapshot: run as unknown as Record<string, unknown>, timestamp, runEventType });
  }

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
      this.projectAttempt({ runId, ordinal: run.attempt, trigger: "recovery", status, scenario: "terminal", reason, eventSequence: seq, timestamp });
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
      this.projectAttempt({ runId, ordinal: run.attempt, trigger: "recovery", status: "blocked", scenario: "terminal", reason, eventSequence: seq, timestamp });
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
          reason: "service_restart", eventSequence: seq, timestamp,
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
        scenario: resumedFromInput ? "input" : "resume", eventSequence: run.lastEventSeq, timestamp: resumedAt,
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
    if (effectiveGateProfile(run.contract) === "relaxed") return { passed: true, failures: [] };
    const failures: CompletionGate["failures"] = [];
    const requiredPlan = run.plan.filter((item) => item.required);
    const requiredChecks = run.checks.filter((item) => item.required);
    const mutationObserved = Boolean(this.db.prepare(`SELECT 1 FROM operations
      WHERE run_id=? AND attempt=? AND status <> 'pre_effect_rejected'
        AND (operation_type IN ('tool.write','tool.edit','tool.patch','tool.memory_forget')
          OR (operation_type='tool.bash' AND NOT EXISTS (
            SELECT 1 FROM json_each(operations.effects_json)
            WHERE json_extract(value,'$.kind')='workspace' AND json_extract(value,'$.action')='read_only'
          ))) LIMIT 1`).get(run.id, run.attempt));
    const executionPolicy = effectiveTaskExecutionPolicy(run.contract, mutationObserved ? [{ operationType: "tool.write", status: "succeeded", attempt: run.attempt }] : [], run.attempt);
    let operations: Map<string, OperationRecord> | undefined;
    const operationById = (id: string) => {
      operations ??= new Map(this.listOperations(run.id, {
        ids: requiredChecks.flatMap((check) => check.sourceOperationId ? [check.sourceOperationId] : []),
      }).map((operation) => [operation.id, operation]));
      return operations.get(id);
    };
    const trustedCheck = (check: RunCheck) => {
      if (check.status !== "passed" || check.stale || !check.sourceOperationId || !check.observedAt || !check.evidence.trim()) return false;
      const operation = operationById(check.sourceOperationId);
      if (!operation || operation.runId !== run.id || operation.attempt !== run.attempt
        || operation.operationType !== "tool.bash" || operation.status !== "succeeded"
        || operation.completedAt !== check.observedAt || operation.result === undefined) return false;
      const payload = operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload)
        ? operation.payload as Record<string, unknown>
        : undefined;
      const result = operation.result && typeof operation.result === "object" && !Array.isArray(operation.result)
        ? operation.result as Record<string, unknown>
        : undefined;
      const details = result?.details && typeof result.details === "object" && !Array.isArray(result.details)
        ? result.details as Record<string, unknown>
        : undefined;
      return typeof payload?.command === "string" && payload.command.trim() === check.command.trim() && details?.exitCode === 0;
    };
    const planRequired = ["read_only_analysis", "workspace_mutation", "external_action"].includes(executionPolicy.mode);
    if (requiredPlan.length === 0 && planRequired) failures.push({ kind: "plan", key: "plan", reason: "No required plan items" });
    for (const item of requiredPlan) if (item.status !== "done") failures.push({ kind: "plan_item", key: item.key, reason: `Required plan item is ${item.status}` });
    for (const check of requiredChecks) {
      if (check.status !== "passed") failures.push({ kind: "check", key: check.key, reason: `Required check is ${check.status}` });
      else if (check.stale) failures.push({ kind: "check", key: check.key, reason: "Evidence is stale" });
      else if (!trustedCheck(check)) failures.push({ kind: "check", key: check.key, reason: "Evidence is not bound to a successful Bash receipt from the current Attempt" });
    }
    const requiresTrustedVerification = executionPolicy.evidencePolicy === "trusted_check";
    if (requiresTrustedVerification && requiredChecks.length === 0) {
      failures.push({ kind: "check", key: "trusted_evidence", reason: "Change, verify, and release work requires at least one trusted required check" });
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
