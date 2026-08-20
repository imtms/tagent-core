import type Database from "better-sqlite3";
import { stableJson, type CanonicalJsonValue } from "@tagent/governance/domain";
import type {
  RuntimeTransitionCommand,
  RuntimeTransitionFence,
  SystemTransitionAuthority,
  SystemTransitionCommand,
  TaskRunTransitionOutcome,
  TaskRunTransitionPort,
  TaskRunTransitionResult,
} from "@tagent/execution/ports";
import { attemptIdFor, type RunEvent, type RunStatus } from "@tagent/execution/domain";
import type { Store } from "../store.js";
import {
  TaskRunExecutionFenceValidator,
  type TaskRunExecutionScope,
} from "./task-run-execution-fence.js";

interface SystemAttemptScope {
  attemptId: string;
  runId: string;
  ordinal: number;
  attemptStatus: string;
  active: boolean;
  version: number;
  runStatus: RunStatus;
}

interface RuntimeTransitionSpec {
  status: "completed" | "blocked" | "failed";
  eventType: "run.completed" | "run.blocked" | "run.failed";
}

const RUNTIME_TRANSITIONS: Readonly<Record<RuntimeTransitionCommand["kind"], RuntimeTransitionSpec>> = {
  complete: { status: "completed", eventType: "run.completed" },
  block: { status: "blocked", eventType: "run.blocked" },
  fail: { status: "failed", eventType: "run.failed" },
};

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes`);
  }
}

function assertStringWithoutNul(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${name} must be a string without NUL bytes`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${name} must contain exactly: ${keys.join(", ")}`);
  }
}

function canonicalData(value: unknown, name: string): Record<string, CanonicalJsonValue> {
  const record = asRecord(value, name);
  try {
    return JSON.parse(stableJson(record)) as Record<string, CanonicalJsonValue>;
  } catch (error) {
    throw new TypeError(`${name} must contain canonical JSON`, { cause: error });
  }
}

function terminalOutcome(
  scope: TaskRunExecutionScope,
  status: RuntimeTransitionSpec["status"],
  event: RunEvent,
  precedingEvents: RunEvent[],
): TaskRunTransitionOutcome {
  return {
    runId: scope.runId,
    sourceAttemptId: scope.attemptId,
    sourceOrdinal: scope.ordinal,
    targetAttemptId: scope.attemptId,
    targetOrdinal: scope.ordinal,
    fromStatus: "running",
    toStatus: status,
    precedingEvents,
    event,
  };
}

/** SQLite implementation of the closed TaskRun transition authority ABI. */
export class SqliteTaskRunTransitionRepository implements TaskRunTransitionPort {
  private readonly executionFenceValidator: TaskRunExecutionFenceValidator;

  constructor(
    private readonly db: Database.Database,
    private readonly store: Store,
  ) {
    this.executionFenceValidator = new TaskRunExecutionFenceValidator(db);
  }

  transitionRuntime(
    command: RuntimeTransitionCommand,
    fence: RuntimeTransitionFence,
  ): TaskRunTransitionResult {
    this.assertManagedTransaction();
    const normalized = this.validateRuntimeCommand(command);
    const scope = this.executionFenceValidator.validate(fence);
    const spec = RUNTIME_TRANSITIONS[normalized.kind];
    const precedingEvents = normalized.kind === "block"
      ? (normalized.precedingEvents ?? []).map((preceding) =>
        this.store.appendEvent(scope.runId, "message.rejected", preceding.data))
      : [];
    const event = this.store.transitionRun(
      scope.runId,
      ["running"],
      spec.status,
      spec.eventType,
      normalized.data,
      normalized.reason,
      scope.ordinal,
    );
    if (!event) throw new Error(`TaskRun ${scope.runId} transition lost its compare-and-set`);
    return { transitions: [terminalOutcome(scope, spec.status, event, precedingEvents)] };
  }

  transitionSystem(
    command: SystemTransitionCommand,
    authority: SystemTransitionAuthority,
  ): TaskRunTransitionResult {
    this.assertManagedTransaction();
    const normalizedCommand = this.validateSystemCommand(command);
    const normalizedAuthority = this.validateSystemAuthority(authority);
    this.assertAuthorityMatches(normalizedCommand, normalizedAuthority);

    if (normalizedCommand.kind === "startup_interrupt_active"
      || normalizedCommand.kind === "shutdown_interrupt_active") {
      const scopes = this.listInterruptibleSystemAttempts();
      this.store.markInterrupted();
      return {
        transitions: scopes.map((scope) => ({
          runId: scope.runId,
          sourceAttemptId: scope.attemptId,
          sourceOrdinal: scope.ordinal,
          targetAttemptId: scope.attemptId,
          targetOrdinal: scope.ordinal,
          fromStatus: "running",
          toStatus: "interrupted",
          precedingEvents: [],
          event: null,
        })),
      };
    }

    const scope = this.validateSystemAttempt(
      normalizedCommand.attemptId,
      normalizedCommand.expectedVersion,
    );
    if (normalizedCommand.kind === "admission_launch_failed") {
      return this.transitionAdmissionFailure(normalizedCommand, scope);
    }
    if (normalizedCommand.kind === "require_external_approval") {
      return this.transitionExternalApproval(normalizedCommand, scope);
    }
    return this.transitionResume(normalizedCommand, normalizedAuthority, scope);
  }

  private transitionExternalApproval(
    command: Extract<SystemTransitionCommand, { kind: "require_external_approval" }>,
    scope: SystemAttemptScope,
  ): TaskRunTransitionResult {
    const runningBoundary = scope.active && scope.attemptStatus === "running" && scope.runStatus === "running";
    const submittedInputBoundary = !scope.active
      && scope.attemptStatus === "waiting_input"
      && scope.runStatus === "waiting_input"
      && Boolean(this.db.prepare(`SELECT 1 FROM user_input_requests submitted
        WHERE submitted.run_id=? AND submitted.attempt=? AND submitted.status='submitted'
          AND NOT EXISTS (SELECT 1 FROM user_input_requests pending
            WHERE pending.run_id=submitted.run_id AND pending.status='pending') LIMIT 1`)
        .get(scope.runId, scope.ordinal));
    if (!runningBoundary && !submittedInputBoundary) {
      throw new Error(`External approval requires a running Attempt or a submitted-input boundary for ${scope.attemptId}`);
    }
    const approval = this.db.prepare(`SELECT json_extract(metadata_json,'$.submittedInputRequestId') as submittedInputRequestId
      FROM approval_requests
      WHERE id=? AND run_id=? AND action_type='execute_external_action' AND status='pending'
        AND CAST(json_extract(metadata_json,'$.approvedAttempt') AS INTEGER)=?`)
      .get(command.approvalId, scope.runId, scope.ordinal + 1) as { submittedInputRequestId: string | null } | undefined;
    if (!approval) throw new Error(`External approval ${command.approvalId} is not pending for ${scope.runId}`);
    if (submittedInputBoundary && (!approval.submittedInputRequestId || !this.db.prepare(`SELECT 1 FROM user_input_requests
      WHERE id=? AND run_id=? AND attempt=? AND status='submitted'`)
      .get(approval.submittedInputRequestId, scope.runId, scope.ordinal))) {
      throw new Error(`External approval ${command.approvalId} is not bound to submitted input for ${scope.attemptId}`);
    }
    const event = this.store.transitionRun(
      scope.runId, [scope.runStatus], "blocked", "run.blocked",
      { reason: command.reason, approvalId: command.approvalId, action: "execute_external_action" },
      command.reason, scope.ordinal,
    );
    if (!event) throw new Error(`TaskRun ${scope.runId} external approval boundary lost its compare-and-set`);
    return { transitions: [{
      runId: scope.runId, sourceAttemptId: scope.attemptId, sourceOrdinal: scope.ordinal,
      targetAttemptId: scope.attemptId, targetOrdinal: scope.ordinal, fromStatus: scope.runStatus,
      toStatus: "blocked", precedingEvents: [], event,
    }] };
  }

  private transitionAdmissionFailure(
    command: Extract<SystemTransitionCommand, { kind: "admission_launch_failed" }>,
    scope: SystemAttemptScope,
  ): TaskRunTransitionResult {
    if (!scope.active || scope.attemptStatus !== "running" || scope.runStatus !== "running") {
      throw new Error(`Admission launch failure requires the active running Attempt ${scope.attemptId}`);
    }
    const inbox = this.db.prepare(`UPDATE session_supervisor_inbox SET error=?,updated_at=?
      WHERE id=? AND run_id=? AND status='started'`)
      .run(command.error, Date.now(), command.inboxItemId, scope.runId);
    if (inbox.changes !== 1) {
      throw new Error(`Started admission inbox item ${command.inboxItemId} does not own ${scope.attemptId}`);
    }
    const data = {
      error: command.error,
      reason: "runtime_initialization_failed",
      stage: "launch_setup",
      retryable: command.retryable,
      inboxItemId: command.inboxItemId,
    };
    const event = this.store.transitionRun(
      scope.runId,
      ["running"],
      "failed",
      "run.failed",
      data,
      command.error,
      scope.ordinal,
    );
    if (!event) throw new Error(`TaskRun ${scope.runId} admission failure lost its compare-and-set`);
    return {
      transitions: [{
        runId: scope.runId,
        sourceAttemptId: scope.attemptId,
        sourceOrdinal: scope.ordinal,
        targetAttemptId: scope.attemptId,
        targetOrdinal: scope.ordinal,
        fromStatus: "running",
        toStatus: "failed",
        precedingEvents: [],
        event,
      }],
    };
  }

  private transitionResume(
    command: Extract<SystemTransitionCommand, { kind: "resume_manual" | "resume_approval" | "resume_input" }>,
    authority: SystemTransitionAuthority,
    scope: SystemAttemptScope,
  ): TaskRunTransitionResult {
    if (scope.active) throw new Error(`Resume requires an inactive source Attempt ${scope.attemptId}`);
    if (command.kind === "resume_manual") {
      if (authority.kind !== "manual_resume") throw new Error("Manual resume authority mismatch");
      if (!["blocked", "interrupted", "failed"].includes(scope.runStatus)) {
        throw new Error(`Manual resume cannot continue TaskRun from ${scope.runStatus}`);
      }
    } else if (command.kind === "resume_approval") {
      if (authority.kind !== "approval_resume") throw new Error("Approval resume authority mismatch");
      const approved = this.db.prepare(`SELECT 1 FROM approval_requests
        WHERE id=? AND run_id=? AND status='approved' AND (
          action_type='resume_taskrun'
          OR (action_type='execute_external_action'
            AND CAST(json_extract(metadata_json,'$.approvedAttempt') AS INTEGER)=?)
        )`)
        .get(command.approvalId, scope.runId, scope.ordinal + 1);
      if (!approved) throw new Error(`Approval ${command.approvalId} cannot resume ${scope.attemptId}`);
      if (scope.runStatus !== "blocked" && scope.runStatus !== "interrupted") {
        throw new Error(`Approval resume cannot continue TaskRun from ${scope.runStatus}`);
      }
    } else {
      if (authority.kind !== "input_resume") throw new Error("Input resume authority mismatch");
      const submitted = this.db.prepare(`SELECT 1 FROM user_input_requests
        WHERE id=? AND run_id=? AND attempt=? AND status='submitted'`)
        .get(command.inputRequestId, scope.runId, scope.ordinal);
      if (!submitted) throw new Error(`Input request ${command.inputRequestId} cannot resume ${scope.attemptId}`);
      if (scope.runStatus !== "waiting_input") {
        throw new Error(`Input resume cannot continue TaskRun from ${scope.runStatus}`);
      }
    }
    const resumed = this.store.resumeRun(scope.runId);
    const targetAttemptId = attemptIdFor(scope.runId, resumed.attempt);
    const target = this.db.prepare(`SELECT id,ordinal FROM attempts WHERE id=? AND run_id=?`)
      .get(targetAttemptId, scope.runId) as { id: string; ordinal: number } | undefined;
    if (!target || target.ordinal !== resumed.attempt) {
      throw new Error(`TaskRun ${scope.runId} resume did not create its target Attempt`);
    }
    return {
      transitions: [{
        runId: scope.runId,
        sourceAttemptId: scope.attemptId,
        sourceOrdinal: scope.ordinal,
        targetAttemptId: target.id,
        targetOrdinal: target.ordinal,
        fromStatus: scope.runStatus,
        toStatus: "running",
        precedingEvents: [],
        event: null,
      }],
    };
  }

  private validateRuntimeCommand(command: RuntimeTransitionCommand): RuntimeTransitionCommand {
    const value = asRecord(command, "RuntimeTransitionCommand");
    if (value.kind === "complete" || value.kind === "fail") {
      assertExactKeys(value, ["kind", "reason", "data"], "RuntimeTransitionCommand");
    } else if (value.kind === "block") {
      assertExactKeys(
        value,
        value.precedingEvents === undefined
          ? ["kind", "reason", "data"]
          : ["kind", "reason", "data", "precedingEvents"],
        "RuntimeTransitionCommand",
      );
    } else {
      throw new TypeError("RuntimeTransitionCommand.kind is not allowlisted");
    }
    if (value.kind === "complete") {
      assertStringWithoutNul(value.reason, "RuntimeTransitionCommand.reason");
    } else {
      assertNonEmpty(value.reason, "RuntimeTransitionCommand.reason");
    }
    const data = canonicalData(value.data, "RuntimeTransitionCommand.data");
    if (value.kind !== "block") return { kind: value.kind, reason: value.reason, data };
    if (value.precedingEvents !== undefined && !Array.isArray(value.precedingEvents)) {
      throw new TypeError("RuntimeTransitionCommand.precedingEvents must be an array");
    }
    const precedingEvents = (value.precedingEvents ?? []).map((event, index) => {
      const preceding = asRecord(event, `precedingEvents[${index}]`);
      assertExactKeys(preceding, ["kind", "data"], `precedingEvents[${index}]`);
      if (preceding.kind !== "message_rejected") {
        throw new TypeError(`precedingEvents[${index}].kind is not allowlisted`);
      }
      return {
        kind: "message_rejected" as const,
        data: canonicalData(preceding.data, `precedingEvents[${index}].data`),
      };
    });
    return { kind: "block", reason: value.reason, data, ...(precedingEvents.length ? { precedingEvents } : {}) };
  }

  private validateSystemCommand(command: SystemTransitionCommand): SystemTransitionCommand {
    const value = asRecord(command, "SystemTransitionCommand");
    switch (value.kind) {
      case "startup_interrupt_active":
      case "shutdown_interrupt_active":
        assertExactKeys(value, ["kind"], "SystemTransitionCommand");
        return { kind: value.kind };
      case "admission_launch_failed":
        assertExactKeys(value, ["kind", "attemptId", "expectedVersion", "inboxItemId", "error", "retryable"], "SystemTransitionCommand");
        assertNonEmpty(value.attemptId, "SystemTransitionCommand.attemptId");
        assertPositiveInteger(value.expectedVersion, "SystemTransitionCommand.expectedVersion");
        assertNonEmpty(value.inboxItemId, "SystemTransitionCommand.inboxItemId");
        assertNonEmpty(value.error, "SystemTransitionCommand.error");
        if (typeof value.retryable !== "boolean") throw new TypeError("SystemTransitionCommand.retryable must be boolean");
        return {
          kind: value.kind,
          attemptId: value.attemptId,
          expectedVersion: value.expectedVersion,
          inboxItemId: value.inboxItemId,
          error: value.error,
          retryable: value.retryable,
        };
      case "require_external_approval":
        assertExactKeys(value, ["kind", "attemptId", "expectedVersion", "approvalId", "reason"], "SystemTransitionCommand");
        assertNonEmpty(value.approvalId, "SystemTransitionCommand.approvalId");
        assertNonEmpty(value.reason, "SystemTransitionCommand.reason");
        break;
      case "resume_manual":
        assertExactKeys(value, ["kind", "attemptId", "expectedVersion", "reason"], "SystemTransitionCommand");
        assertNonEmpty(value.reason, "SystemTransitionCommand.reason");
        break;
      case "resume_approval":
        assertExactKeys(value, ["kind", "attemptId", "expectedVersion", "approvalId"], "SystemTransitionCommand");
        assertNonEmpty(value.approvalId, "SystemTransitionCommand.approvalId");
        break;
      case "resume_input":
        assertExactKeys(value, ["kind", "attemptId", "expectedVersion", "inputRequestId"], "SystemTransitionCommand");
        assertNonEmpty(value.inputRequestId, "SystemTransitionCommand.inputRequestId");
        break;
      default:
        throw new TypeError("SystemTransitionCommand.kind is not allowlisted");
    }
    assertNonEmpty(value.attemptId, "SystemTransitionCommand.attemptId");
    assertPositiveInteger(value.expectedVersion, "SystemTransitionCommand.expectedVersion");
    return value as unknown as SystemTransitionCommand;
  }

  private validateSystemAuthority(authority: SystemTransitionAuthority): SystemTransitionAuthority {
    const value = asRecord(authority, "SystemTransitionAuthority");
    switch (value.kind) {
      case "admission_launch_failure":
        assertExactKeys(value, ["kind", "component", "inboxItemId"], "SystemTransitionAuthority");
        if (value.component !== "admission_coordinator") throw new TypeError("Admission authority component is invalid");
        assertNonEmpty(value.inboxItemId, "SystemTransitionAuthority.inboxItemId");
        return { kind: value.kind, component: value.component, inboxItemId: value.inboxItemId };
      case "external_action_guard":
        assertExactKeys(value, ["kind", "component", "approvalId"], "SystemTransitionAuthority");
        if (value.component !== "admission_coordinator") throw new TypeError("External action guard component is invalid");
        assertNonEmpty(value.approvalId, "SystemTransitionAuthority.approvalId");
        return { kind: value.kind, component: value.component, approvalId: value.approvalId };
      case "lifecycle_interrupt":
        assertExactKeys(value, ["kind", "component", "phase"], "SystemTransitionAuthority");
        if (value.component === "execution_lifecycle_service" && value.phase === "startup") {
          return { kind: value.kind, component: value.component, phase: value.phase };
        }
        if (value.component === "runtime_registry" && value.phase === "shutdown") {
          return { kind: value.kind, component: value.component, phase: value.phase };
        }
        throw new TypeError("Lifecycle transition authority is invalid");
      case "manual_resume":
        assertExactKeys(value, ["kind", "actorId"], "SystemTransitionAuthority");
        assertNonEmpty(value.actorId, "SystemTransitionAuthority.actorId");
        return { kind: value.kind, actorId: value.actorId };
      case "approval_resume":
        assertExactKeys(value, ["kind", "approvalId"], "SystemTransitionAuthority");
        assertNonEmpty(value.approvalId, "SystemTransitionAuthority.approvalId");
        return { kind: value.kind, approvalId: value.approvalId };
      case "input_resume":
        assertExactKeys(value, ["kind", "inputRequestId"], "SystemTransitionAuthority");
        assertNonEmpty(value.inputRequestId, "SystemTransitionAuthority.inputRequestId");
        return { kind: value.kind, inputRequestId: value.inputRequestId };
      default:
        throw new TypeError("SystemTransitionAuthority.kind is not allowlisted");
    }
  }

  private assertAuthorityMatches(
    command: SystemTransitionCommand,
    authority: SystemTransitionAuthority,
  ): void {
    const matches = command.kind === "admission_launch_failed"
      ? authority.kind === "admission_launch_failure" && authority.inboxItemId === command.inboxItemId
      : command.kind === "require_external_approval"
        ? authority.kind === "external_action_guard" && authority.approvalId === command.approvalId
      : command.kind === "startup_interrupt_active"
        ? authority.kind === "lifecycle_interrupt" && authority.phase === "startup"
        : command.kind === "shutdown_interrupt_active"
          ? authority.kind === "lifecycle_interrupt" && authority.phase === "shutdown"
          : command.kind === "resume_manual"
            ? authority.kind === "manual_resume"
            : command.kind === "resume_approval"
              ? authority.kind === "approval_resume" && authority.approvalId === command.approvalId
              : authority.kind === "input_resume" && authority.inputRequestId === command.inputRequestId;
    if (!matches) throw new Error(`System transition authority does not permit ${command.kind}`);
  }

  private validateSystemAttempt(attemptId: string, expectedVersion: number): SystemAttemptScope {
    const row = this.db.prepare(`SELECT attempt.id as attemptId,attempt.run_id as runId,
      attempt.ordinal,attempt.status as attemptStatus,attempt.active,attempt.version,
      run.status as runStatus,run.attempt as runAttempt
      FROM attempts attempt JOIN runs run ON run.id=attempt.run_id WHERE attempt.id=?`)
      .get(attemptId) as (Omit<SystemAttemptScope, "active"> & { active: number; runAttempt: number }) | undefined;
    if (!row) throw new Error(`Attempt ${attemptId} does not exist`);
    if (row.version !== expectedVersion) throw new Error(`Attempt version mismatch for ${attemptId}`);
    if (row.runAttempt !== row.ordinal) throw new Error(`TaskRun projection is stale for Attempt ${attemptId}`);
    const { runAttempt: _runAttempt, ...scope } = row;
    return { ...scope, active: row.active === 1 };
  }

  private listInterruptibleSystemAttempts(): SystemAttemptScope[] {
    const rows = this.db.prepare(`SELECT attempt.id as attemptId,run.id as runId,
      attempt.ordinal,attempt.status as attemptStatus,attempt.active,attempt.version,
      run.status as runStatus,run.attempt as runAttempt
      FROM runs run LEFT JOIN attempts attempt
        ON attempt.run_id=run.id AND attempt.ordinal=run.attempt
      WHERE run.status='running' ORDER BY run.id`).all() as Array<{
        attemptId: string | null;
        runId: string;
        ordinal: number | null;
        attemptStatus: string | null;
        active: number | null;
        version: number | null;
        runStatus: RunStatus;
        runAttempt: number;
      }>;
    return rows.map((row) => {
      if (!row.attemptId || row.ordinal !== row.runAttempt || row.attemptStatus !== "running"
        || row.active !== 1 || row.version === null) {
        throw new Error(`Running TaskRun ${row.runId} is missing its active running Attempt projection`);
      }
      return {
        attemptId: row.attemptId,
        runId: row.runId,
        ordinal: row.ordinal,
        attemptStatus: row.attemptStatus,
        active: true,
        version: row.version,
        runStatus: row.runStatus,
      };
    });
  }

  private assertManagedTransaction(): void {
    if (!this.db.inTransaction) {
      throw new Error("TaskRun transitions require the SqlitePersistence writer transaction");
    }
  }
}
