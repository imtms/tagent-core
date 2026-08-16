import type Database from "better-sqlite3";
import {
  capabilityAuthorizationReceiptId,
  capabilityOperationDigest,
  capabilityOperationId,
  capabilityOperationType,
  capabilityPayloadHash,
  stableJson,
  type ApprovalRef,
  type AuthorizationReceipt,
  type AuthorizationReceiptReadPort,
  type CanonicalJsonValue,
  type CanonicalOperationInput,
  type CapabilityCommand,
} from "@tagent/governance";
import type {
  CapabilityEffectSettlement,
  CapabilityExecutionPersistencePort,
  CapabilityExecutionRequest,
  CapabilityExecutionState,
  CapabilityExecutionStatus,
} from "@tagent/execution/ports";
import {
  mapRunApprovalOperation,
  type RunApprovalSemanticInput,
} from "./approval-operation-mapper.js";
import { SQLITE_DB_TIME_MS } from "./core-writer-lease.js";
import {
  TaskRunExecutionFenceValidator,
  type TaskRunExecutionScope,
} from "./task-run-execution-fence.js";
import type { WriterFenceGuard } from "./writer-fence-guard.js";

interface ApprovalUseRow {
  status: string;
  reuseMode: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
}

interface RunApprovalRow extends RunApprovalSemanticInput {
  scopeType: string | null;
  scopeId: string | null;
  storedDigest: string | null;
}

interface BoundApproval {
  ref: ApprovalRef;
  operationDigest: string;
}

interface OperationRow {
  id: string;
  runId: string;
  attempt: number;
  attemptId: string | null;
  operationType: string;
  payloadHash: string;
  status: string;
  stage: string;
  resultJson: string;
  error: string;
}

interface ApprovalReceiptRow {
  id: string;
  approvalSource: string;
  approvalId: string;
  operationId: string;
  operationDigest: string;
  outcome: string;
  actorId: string;
  detailsJson: string;
  createdAt: number;
}

const RECEIPT_SELECT = `SELECT id,approval_source as approvalSource,approval_id as approvalId,
  operation_id as operationId,operation_digest as operationDigest,outcome,actor_id as actorId,
  details_json as detailsJson,created_at as createdAt FROM approval_receipts`;
const OPERATION_SELECT = `SELECT id,run_id as runId,attempt,attempt_id as attemptId,
  operation_type as operationType,payload_hash as payloadHash,status,stage,
  result_json as resultJson,error FROM operations`;
const AUTHORIZATION_OUTCOMES_SQL = "'allow','require_approval','deny'";
const TERMINAL_STATUSES = new Set<CapabilityExecutionStatus>([
  "succeeded",
  "failed",
  "outcome_unknown",
  "cancelled",
]);
const CAPABILITY_STAGE_BY_STATUS: Readonly<Record<CapabilityExecutionStatus, string>> = {
  authorized: "authorization_committed",
  running: "effect_started",
  succeeded: "effect_succeeded",
  failed: "effect_failed",
  outcome_unknown: "outcome_unknown",
  cancelled: "cancelled",
};

function sameApprovalRef(left: ApprovalRef | null, right: ApprovalRef): boolean {
  return left?.source === right.source && left.id === right.id;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes`);
  }
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(message);
}

function parseCanonicalJson(source: string, name: string): CanonicalJsonValue {
  try {
    const parsed: unknown = JSON.parse(source);
    stableJson(parsed);
    return parsed as CanonicalJsonValue;
  } catch (error) {
    throw new Error(`${name} is not canonical JSON`, { cause: error });
  }
}

function hydrateReceipt(row: ApprovalReceiptRow): AuthorizationReceipt {
  if (row.approvalSource !== "run") {
    throw new Error(`Approval receipt ${row.id} has an unknown approval source`);
  }
  if (row.outcome !== "allow" && row.outcome !== "require_approval" && row.outcome !== "deny") {
    throw new Error(`Approval receipt ${row.id} is not an authorization decision receipt`);
  }
  return {
    id: row.id,
    commandId: row.operationId,
    operationDigest: row.operationDigest,
    decision: row.outcome,
    approvalRef: { source: row.approvalSource, id: row.approvalId },
    grantId: null,
    actorId: row.actorId,
    details: parseCanonicalJson(row.detailsJson, `Approval receipt ${row.id} details`),
    createdAt: row.createdAt,
  };
}

export interface SqliteFencedCapabilityAuthorizationOptions {
  nowSql?: string;
}

/**
 * Attempt-bound capability execution journal.
 *
 * Authorization, approval consumption, operation claim, and the allow receipt
 * share one WriterFenceGuard IMMEDIATE transaction. External effects run only
 * after beginEffect wins the authorized -> running compare-and-set.
 */
export class SqliteFencedCapabilityAuthorizationRepository
implements CapabilityExecutionPersistencePort, AuthorizationReceiptReadPort {
  private readonly executionFenceValidator: TaskRunExecutionFenceValidator;
  private readonly nowSql: string;

  constructor(
    private readonly db: Database.Database,
    private readonly writerFenceGuard: WriterFenceGuard,
    options: SqliteFencedCapabilityAuthorizationOptions = {},
  ) {
    this.nowSql = options.nowSql ?? SQLITE_DB_TIME_MS;
    if (!this.nowSql.trim() || this.nowSql.includes("\0") || this.nowSql.includes(";")) {
      throw new TypeError("Capability authorization nowSql must be a single SQLite expression");
    }
    this.executionFenceValidator = new TaskRunExecutionFenceValidator(db, { nowSql: this.nowSql });
  }

  authorizeAndClaim(request: CapabilityExecutionRequest): CapabilityExecutionState {
    const detailsJson = this.validateRequest(request);
    return this.writerFenceGuard.run((transaction: Database.Database) => {
      this.assertSharedConnection(transaction);
      const existingReceipt = this.findAuthorizationReceiptByOperation(transaction, request.command.commandId);
      if (existingReceipt) {
        const operation = this.requireOperation(transaction, request.command.commandId);
        const persistedScope = this.deriveOperationScope(transaction, request, operation);
        const persistedApproval = this.bindApproval(request, persistedScope);
        return this.replayAuthorization(
          request,
          persistedScope,
          persistedApproval,
          detailsJson,
          existingReceipt,
        );
      }

      const scope = this.executionFenceValidator.validate(request.fence);
      const approval = this.bindApproval(request, scope);

      this.consumeApproval(transaction, approval.ref, approval.operationDigest, scope.timestamp);
      this.insertAuthorizedOperation(transaction, request.command, scope);
      transaction.prepare(`INSERT INTO approval_receipts
        (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
        VALUES (?,?,?,?,?,'allow',?,?,?)`).run(
        capabilityAuthorizationReceiptId(request.command),
        approval.ref.source,
        approval.ref.id,
        capabilityOperationId(request.command),
        approval.operationDigest,
        request.actorId,
        detailsJson,
        scope.timestamp,
      );
      const operation = this.requireOperation(transaction, request.command.commandId);
      return this.hydrateState(operation, approval.ref);
    });
  }

  beginEffect(request: CapabilityExecutionRequest): { state: CapabilityExecutionState; started: boolean } {
    const detailsJson = this.validateRequest(request);
    return this.writerFenceGuard.run((transaction: Database.Database) => {
      this.assertSharedConnection(transaction);
      const scope = this.executionFenceValidator.validate(request.fence);
      const approval = this.bindApproval(request, scope);
      this.assertAuthorizationIdentity(transaction, request, scope, approval, detailsJson);
      const operation = this.requireOperation(transaction, request.command.commandId);
      if (operation.status === "running") {
        return { state: this.hydrateState(operation, approval.ref), started: false };
      }
      if (operation.status !== "authorized" || operation.stage !== "authorization_committed") {
        throw new Error(`Capability operation ${operation.id} cannot begin an effect from ${operation.status}`);
      }
      const changed = transaction.prepare(`UPDATE operations
        SET status='running',stage='effect_started',updated_at=?
        WHERE id=? AND status='authorized' AND stage='authorization_committed'`)
        .run(scope.timestamp, operation.id).changes;
      if (changed !== 1) throw new Error(`Capability operation ${operation.id} lost its begin-effect compare-and-set`);
      return {
        state: this.hydrateState(this.requireOperation(transaction, operation.id), approval.ref),
        started: true,
      };
    });
  }

  settleEffect(
    request: CapabilityExecutionRequest,
    settlement: CapabilityEffectSettlement,
  ): CapabilityExecutionState {
    const detailsJson = this.validateRequest(request);
    const resultJson = settlement.status === "succeeded" ? stableJson(settlement.result) : "";
    if (settlement.status === "failed") assertNonEmpty(settlement.error, "settlement.error");
    return this.writerFenceGuard.run((transaction: Database.Database) => {
      this.assertSharedConnection(transaction);
      const scope = this.executionFenceValidator.validate(request.fence);
      const approval = this.bindApproval(request, scope);
      this.assertAuthorizationIdentity(transaction, request, scope, approval, detailsJson);
      const operation = this.requireOperation(transaction, request.command.commandId);
      if (operation.status !== "running" || operation.stage !== "effect_started") {
        throw new Error(`Capability operation ${operation.id} cannot settle from ${operation.status}`);
      }
      const status = settlement.status;
      const error = settlement.status === "failed" ? settlement.error : "";
      if (settlement.status === "succeeded") {
        const staleChecks = transaction.prepare(`UPDATE run_checks SET stale=1
          WHERE run_id=? AND status='passed'`).run(scope.runId).changes;
        if (staleChecks > 0) {
          transaction.prepare("UPDATE runs SET updated_at=? WHERE id=?").run(scope.timestamp, scope.runId);
        }
      }
      const changed = transaction.prepare(`UPDATE operations SET
        status=?,stage=?,result_json=?,error=?,updated_at=?,completed_at=?
        WHERE id=? AND status='running' AND stage='effect_started'`)
        .run(status, `effect_${status}`, resultJson, error, scope.timestamp, scope.timestamp, operation.id).changes;
      if (changed !== 1) throw new Error(`Capability operation ${operation.id} lost its settlement compare-and-set`);
      return this.hydrateState(this.requireOperation(transaction, operation.id), approval.ref);
    });
  }

  markOutcomeUnknown(
    request: CapabilityExecutionRequest,
    input: { readonly error: string },
  ): CapabilityExecutionState {
    const detailsJson = this.validateRequest(request);
    assertNonEmpty(input.error, "outcomeUnknown.error");
    return this.writerFenceGuard.run((transaction: Database.Database) => {
      this.assertSharedConnection(transaction);
      const scope = this.executionFenceValidator.validate(request.fence);
      const operation = this.requireOperation(transaction, request.command.commandId);
      const approval = this.bindApproval(request, scope);
      this.assertAuthorizationIdentity(transaction, request, scope, approval, detailsJson);
      if (operation.status !== "running" || operation.stage !== "effect_started") {
        throw new Error(`Capability operation ${operation.id} cannot become outcome_unknown from ${operation.status}`);
      }
      const changed = transaction.prepare(`UPDATE operations SET
        status='outcome_unknown',stage='outcome_unknown',error=?,updated_at=?,completed_at=?
        WHERE id=? AND status='running' AND stage='effect_started'`)
        .run(input.error, scope.timestamp, scope.timestamp, operation.id).changes;
      if (changed !== 1) throw new Error(`Capability operation ${operation.id} lost its outcome-unknown compare-and-set`);
      return this.hydrateState(this.requireOperation(transaction, operation.id), approval.ref);
    });
  }

  get(id: string): AuthorizationReceipt | undefined {
    const row = this.db.prepare(`${RECEIPT_SELECT} WHERE id=?
      AND outcome IN (${AUTHORIZATION_OUTCOMES_SQL})`).get(id) as ApprovalReceiptRow | undefined;
    return row ? hydrateReceipt(row) : undefined;
  }

  listByOperationDigest(operationDigest: string): AuthorizationReceipt[] {
    return (this.db.prepare(`${RECEIPT_SELECT} WHERE operation_digest=?
      AND outcome IN (${AUTHORIZATION_OUTCOMES_SQL}) ORDER BY created_at,id`)
      .all(operationDigest) as ApprovalReceiptRow[]).map(hydrateReceipt);
  }

  private validateRequest(request: CapabilityExecutionRequest): string {
    if (request.command.schema !== "tagent.capability.command/v1") {
      throw new TypeError("Capability command schema is unsupported");
    }
    assertNonEmpty(request.command.commandId, "command.commandId");
    if (request.approvalRef.source !== "run") {
      throw new TypeError("approvalRef.source must identify run approval authority");
    }
    assertNonEmpty(request.approvalRef.id, "approvalRef.id");
    assertNonEmpty(request.actorId, "actorId");
    assertNonEmpty(request.fence.attemptId, "fence.attemptId");
    assertNonEmpty(request.fence.leaseToken, "fence.leaseToken");
    if (!Number.isSafeInteger(request.fence.expectedVersion) || request.fence.expectedVersion <= 0) {
      throw new TypeError("fence.expectedVersion must be a positive safe integer");
    }
    if (!Number.isSafeInteger(request.fence.executionFence) || request.fence.executionFence <= 0) {
      throw new TypeError("fence.executionFence must be a positive safe integer");
    }
    return stableJson(request.details);
  }

  private assertSharedConnection(transaction: Database.Database): void {
    if (transaction !== this.db) {
      throw new Error("Capability execution repository and WriterFenceGuard must share one SQLite connection");
    }
  }

  private bindApproval(request: CapabilityExecutionRequest, scope: TaskRunExecutionScope): BoundApproval {
    const mapped = this.mapRunApproval(request.approvalRef.id);
    this.assertCommandMatchesMappedOperation(request.command, mapped.operation);
    const commandDigest = capabilityOperationDigest(request.command);
    if (mapped.operationDigest !== commandDigest) {
      throw new Error(`Approval ${request.approvalRef.source}:${request.approvalRef.id} operation digest mismatch`);
    }

    if (mapped.operation.subject.id !== scope.runId || mapped.operation.scope.id !== scope.sessionId) {
      throw new Error(`TaskRun approval ${request.approvalRef.id} does not belong to fenced Attempt ${scope.attemptId}`);
    }
    return { ref: request.approvalRef, operationDigest: mapped.operationDigest };
  }

  private mapRunApproval(id: string): { operation: CanonicalOperationInput; operationDigest: string } {
    const row = this.db.prepare(`SELECT approval.id,approval.run_id as runId,
      approval.decision_id as decisionId,approval.action_type as actionType,
      approval.target_type as targetType,approval.target_id as targetId,
      approval.metadata_json as metadata,run.session_id as runSessionId,
      approval.scope_type as scopeType,approval.scope_id as scopeId,
      approval.operation_digest as storedDigest
      FROM approval_requests approval LEFT JOIN runs run ON run.id=approval.run_id
      WHERE approval.id=?`).get(id) as RunApprovalRow | undefined;
    if (!row) throw new Error(`Approval run:${id} does not exist`);
    const mapped = mapRunApprovalOperation({ ...row, enforceScopeConsistency: true });
    if (row.scopeType !== mapped.operation.scope.type || row.scopeId !== mapped.operation.scope.id
      || row.storedDigest !== mapped.operationDigest) {
      throw new Error(`Approval run:${id} canonical binding is stale`);
    }
    return mapped;
  }

  private assertCommandMatchesMappedOperation(command: CapabilityCommand, mapped: CanonicalOperationInput): void {
    if (command.operation.subject.kind !== mapped.subject.kind
      || command.operation.subject.id !== mapped.subject.id) {
      throw new Error(`Capability command ${command.commandId} subject does not match approval`);
    }
    if (command.operation.action !== mapped.action) {
      throw new Error(`Capability command ${command.commandId} action does not match approval`);
    }
    if (command.operation.target.kind !== mapped.target.kind
      || command.operation.target.id !== mapped.target.id) {
      throw new Error(`Capability command ${command.commandId} target does not match approval`);
    }
    if (command.operation.scope.type !== mapped.scope.type
      || command.operation.scope.id !== mapped.scope.id) {
      throw new Error(`Capability command ${command.commandId} scope does not match approval`);
    }
    assertCanonicalEqual(
      command.operation.payload,
      mapped.payload,
      `Capability command ${command.commandId} payload does not match approval`,
    );
  }

  private consumeApproval(
    transaction: Database.Database,
    ref: ApprovalRef,
    operationDigest: string,
    timestamp: number,
  ): void {
    const changed = transaction.prepare(`UPDATE approval_requests SET used_count=used_count+1
      WHERE id=? AND status='approved' AND operation_digest=? AND used_count>=0
      AND ((reuse_mode='one_time' AND max_uses=1)
        OR (reuse_mode='reusable' AND (max_uses IS NULL OR max_uses>0)))
      AND (max_uses IS NULL OR used_count<max_uses)
      AND (expires_at IS NULL OR expires_at>?)`).run(ref.id, operationDigest, timestamp).changes;
    if (changed !== 1) throw new Error(`Approval ${ref.source}:${ref.id} cannot be consumed for this operation`);
    this.readApprovalUse(transaction, ref);
  }

  private readApprovalUse(transaction: Database.Database, ref: ApprovalRef): ApprovalUseRow {
    const row = transaction.prepare(`SELECT status,reuse_mode as reuseMode,max_uses as maxUses,
      used_count as usedCount,expires_at as expiresAt FROM approval_requests WHERE id=?`)
      .get(ref.id) as ApprovalUseRow | undefined;
    if (!row || !Number.isSafeInteger(row.usedCount) || row.usedCount < 0
      || row.maxUses !== null && (!Number.isSafeInteger(row.maxUses) || row.maxUses <= 0)) {
      throw new Error(`Approval ${ref.source}:${ref.id} has invalid reuse state`);
    }
    return row;
  }

  private insertAuthorizedOperation(
    transaction: Database.Database,
    command: CapabilityCommand,
    scope: TaskRunExecutionScope,
  ): void {
    const existing = this.getOperationFrom(transaction, command.commandId);
    if (existing) throw new Error(`Capability operation ${command.commandId} already exists without an allow receipt`);
    transaction.prepare(`INSERT INTO operations
      (id,run_id,attempt,attempt_id,operation_type,payload_hash,status,stage,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'authorized','authorization_committed',?,?)`).run(
      capabilityOperationId(command),
      scope.runId,
      scope.ordinal,
      scope.attemptId,
      capabilityOperationType(command),
      capabilityPayloadHash(command),
      scope.timestamp,
      scope.timestamp,
    );
  }

  private replayAuthorization(
    request: CapabilityExecutionRequest,
    scope: TaskRunExecutionScope,
    approval: BoundApproval,
    detailsJson: string,
    receipt: AuthorizationReceipt,
  ): CapabilityExecutionState {
    this.assertReceiptMatches(request, approval, detailsJson, receipt);
    const operation = this.requireOperation(this.db, request.command.commandId);
    this.assertOperationMatches(request.command, scope, operation);
    const approvalUse = this.readApprovalUse(this.db, request.approvalRef);
    if (approvalUse.usedCount < 1) {
      throw new Error(`Capability operation ${request.command.commandId} has no consumed approval usage`);
    }
    return this.hydrateState(operation, request.approvalRef);
  }

  private assertAuthorizationIdentity(
    transaction: Database.Database,
    request: CapabilityExecutionRequest,
    scope: TaskRunExecutionScope,
    approval: BoundApproval,
    detailsJson: string,
  ): void {
    const receipt = this.findAuthorizationReceiptByOperation(transaction, request.command.commandId);
    if (!receipt) throw new Error(`Capability operation ${request.command.commandId} has no allow receipt`);
    this.assertReceiptMatches(request, approval, detailsJson, receipt);
    this.assertOperationMatches(request.command, scope, this.requireOperation(transaction, request.command.commandId));
  }

  private assertReceiptMatches(
    request: CapabilityExecutionRequest,
    approval: BoundApproval,
    detailsJson: string,
    receipt: AuthorizationReceipt,
  ): void {
    if (receipt.id !== capabilityAuthorizationReceiptId(request.command)
      || receipt.commandId !== capabilityOperationId(request.command)
      || receipt.operationDigest !== approval.operationDigest
      || !sameApprovalRef(receipt.approvalRef, request.approvalRef)
      || receipt.actorId !== request.actorId
      || stableJson(receipt.details) !== detailsJson) {
      throw new Error(`Capability operation ${request.command.commandId} has a different authorization receipt`);
    }
  }

  private assertOperationMatches(
    command: CapabilityCommand,
    scope: TaskRunExecutionScope,
    operation: OperationRow,
  ): void {
    if (operation.runId !== scope.runId
      || operation.attempt !== scope.ordinal
      || operation.attemptId !== scope.attemptId
      || operation.operationType !== capabilityOperationType(command)
      || operation.payloadHash !== capabilityPayloadHash(command)) {
      throw new Error(`Capability operation ${command.commandId} does not match command or fenced Attempt`);
    }
  }

  private deriveOperationScope(
    transaction: Database.Database,
    request: CapabilityExecutionRequest,
    operation: OperationRow,
  ): TaskRunExecutionScope {
    if (!operation.attemptId || operation.attemptId !== request.fence.attemptId) {
      throw new Error(`Capability operation ${operation.id} does not match the requested Attempt`);
    }
    const attempt = transaction.prepare(`SELECT run_id as runId,ordinal,version
      FROM attempts WHERE id=?`).get(operation.attemptId) as {
        runId: string;
        ordinal: number;
        version: number;
      } | undefined;
    if (!attempt || attempt.runId !== operation.runId || attempt.ordinal !== operation.attempt) {
      throw new Error(`Capability operation ${operation.id} has an invalid persisted Attempt identity`);
    }
    const run = transaction.prepare("SELECT session_id as sessionId FROM runs WHERE id=?")
      .get(operation.runId) as { sessionId: string } | undefined;
    if (!run) throw new Error(`Capability operation ${operation.id} has no TaskRun`);
    return {
      attemptId: operation.attemptId,
      runId: operation.runId,
      ordinal: operation.attempt,
      sessionId: run.sessionId,
      attemptVersion: attempt.version,
      timestamp: this.databaseTimestamp(transaction),
    };
  }

  private databaseTimestamp(transaction: Database.Database): number {
    const timestamp = (transaction.prepare(`SELECT (${this.nowSql}) value`).get() as { value: number }).value;
    if (!Number.isSafeInteger(timestamp)) throw new Error("Capability execution database clock is invalid");
    return timestamp;
  }

  private hydrateState(operation: OperationRow, approvalRef: ApprovalRef): CapabilityExecutionState {
    if (!this.isCapabilityStatus(operation.status)) {
      throw new Error(`Capability operation ${operation.id} has unsupported status ${operation.status}`);
    }
    const stageMatches = operation.status === "cancelled"
      ? operation.stage === "cancelled" || operation.stage === "restart_before_effect"
      : operation.stage === CAPABILITY_STAGE_BY_STATUS[operation.status];
    if (!stageMatches) {
      throw new Error(`Capability operation ${operation.id} has inconsistent ${operation.status}/${operation.stage} state`);
    }
    const result = operation.resultJson
      ? parseCanonicalJson(operation.resultJson, `Capability operation ${operation.id} result`)
      : undefined;
    return {
      commandId: operation.id,
      status: operation.status,
      authorization: { kind: "approval", approvalRef },
      ...(result === undefined ? {} : { result }),
      error: operation.error,
    };
  }

  private isCapabilityStatus(status: string): status is CapabilityExecutionStatus {
    return status === "authorized" || status === "running" || TERMINAL_STATUSES.has(status as CapabilityExecutionStatus);
  }

  private getOperationFrom(transaction: Database.Database, id: string): OperationRow | undefined {
    return transaction.prepare(`${OPERATION_SELECT} WHERE id=?`).get(id) as OperationRow | undefined;
  }

  private requireOperation(transaction: Database.Database, id: string): OperationRow {
    const operation = this.getOperationFrom(transaction, id);
    if (!operation) throw new Error(`Capability operation ${id} does not exist`);
    return operation;
  }

  private findAuthorizationReceiptByOperation(
    transaction: Database.Database,
    operationId: string,
  ): AuthorizationReceipt | undefined {
    const rows = transaction.prepare(`${RECEIPT_SELECT} WHERE operation_id=? AND outcome='allow'
      ORDER BY created_at,id`).all(operationId) as ApprovalReceiptRow[];
    if (rows.length > 1) throw new Error(`Capability operation ${operationId} has multiple allow receipts`);
    return rows[0] ? hydrateReceipt(rows[0]) : undefined;
  }
}
