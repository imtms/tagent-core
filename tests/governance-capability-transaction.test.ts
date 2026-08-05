import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityAuthorizationReceiptId,
  capabilityOperationDigest,
  capabilityPayloadHash,
  createCapabilityCommand,
  type CanonicalJsonValue,
  type CapabilityCommand,
} from "@tagent/governance";
import { SqliteFencedCapabilityAuthorizationRepository } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterAuthorityLostError, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";
import type { CapabilityExecutionRequest } from "@tagent/execution/ports";

const nowSql = "(SELECT value FROM writer_test_clock WHERE id=1)";
const ATTEMPT_ID = "attempt:run-1:1";
const connections: Database.Database[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  db: Database.Database;
  filename: string;
  lease: CoreWriterLease;
  repository: SqliteFencedCapabilityAuthorizationRepository;
  fence: CapabilityExecutionRequest["fence"];
  setNow(value: number): void;
  connect(): Database.Database;
}

interface ReopenedFixture {
  store: Store;
  guard: WriterFenceGuard;
  repository: SqliteFencedCapabilityAuthorizationRepository;
}

function open(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("busy_timeout=2000");
  connections.push(db);
  return db;
}

function claim(db: Database.Database, ownerId: string) {
  return CoreWriterLease.claim(db, { ownerId, pid: process.pid, host: "test-host" }, {
    leaseMs: 20_000,
    heartbeatIntervalMs: 5_000,
    skewMarginMs: 2_000,
    nowSql,
  });
}

function fixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "tagent-capability-transaction-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "core.sqlite");
  const store = new Store(filename);
  const db = store.db;
  connections.push(db);
  db.exec(`CREATE TABLE writer_test_clock (id INTEGER PRIMARY KEY CHECK (id=1),value INTEGER NOT NULL);
    INSERT INTO writer_test_clock VALUES (1,1000);
    INSERT INTO sessions (id,title,created_at,updated_at) VALUES ('session-1','session',1,1);
    INSERT INTO runs (id,session_id,request_id,status,phase,goal,created_at,updated_at,attempt)
      VALUES ('run-1','session-1','request-1','running','execute','goal',1,1,1);
    INSERT INTO supervisor_decisions
      (id,run_id,attempt,checkpoint_seq,trigger,action,reason_code,rationale,confidence,status,created_at)
      VALUES ('decision-1','run-1',1,1,'test','resume','test','test',1,'proposed',1);
    INSERT INTO attempts
      (id,run_id,ordinal,trigger,status,active,version,started_at,updated_at,reconstruction_state)
      VALUES ('${ATTEMPT_ID}','run-1',1,'initial','running',1,1,1,1,'complete');
    INSERT INTO execution_leases
      (attempt_id,owner_id,lease_token,fence,attempt_version,lease_until,heartbeat_at,released_at)
      VALUES ('${ATTEMPT_ID}','runtime','execution-token',7,1,10000,1000,NULL);
  `);
  const lease = claim(db, "owner-a")!;
  const guard = new WriterFenceGuard(db, lease.authority, { skewMarginMs: 2_000, nowSql });
  return {
    db,
    filename,
    lease,
    repository: new SqliteFencedCapabilityAuthorizationRepository(db, guard, { nowSql }),
    fence: {
      attemptId: ATTEMPT_ID,
      expectedVersion: 1,
      leaseToken: "execution-token",
      executionFence: 7,
    },
    setNow: (value) => { db.prepare("UPDATE writer_test_clock SET value=? WHERE id=1").run(value); },
    connect: () => open(filename),
  };
}

function reopenForProductionRecovery(receipt: Fixture): ReopenedFixture {
  const index = connections.indexOf(receipt.db);
  if (index >= 0) connections.splice(index, 1);
  receipt.db.close();
  const store = new Store(receipt.filename, { deferPostMigrationRecovery: true });
  connections.push(store.db);
  const guard = new WriterFenceGuard(store.db, receipt.lease.authority, {
    skewMarginMs: 2_000,
    nowSql,
  });
  guard.installConnectionGuard();
  return {
    store,
    guard,
    repository: new SqliteFencedCapabilityAuthorizationRepository(store.db, guard, { nowSql }),
  };
}

function runCommand(commandId = "command-1", overrides: Partial<CapabilityCommand["operation"]> = {}) {
  return createCapabilityCommand({
    commandId,
    operation: {
      subject: { kind: "task_run", id: "run-1" },
      action: "task_run.resume",
      target: { kind: "task_run", id: "run-1" },
      scope: { type: "session", id: "session-1" },
      payload: { decisionId: "decision-1" },
      ...overrides,
    },
  });
}

function request(
  receipt: Fixture,
  approvalId: string,
  command: CapabilityCommand = runCommand(),
  source: "legacy_run" | "legacy_workflow" = "legacy_run",
): CapabilityExecutionRequest {
  return {
    command,
    fence: receipt.fence,
    approvalRef: { source, id: approvalId },
    actorId: "human-1",
    details: { channel: "test" },
  };
}

function insertRunApproval(
  db: Database.Database,
  id: string,
  command: CapabilityCommand = runCommand(),
  options: { usedCount?: number; maxUses?: number | null; reuseMode?: "one_time" | "reusable" } = {},
): void {
  db.prepare(`INSERT INTO approval_requests
    (id,run_id,decision_id,action_type,target_type,target_id,reason,metadata_json,status,requested_at,
     scope_type,scope_id,operation_digest,risk_class,expires_at,reuse_mode,max_uses,used_count)
    VALUES (?,'run-1','decision-1','resume_taskrun','taskrun','run-1','test',?,'approved',1,
      'session','session-1',?,'medium',10000,?,?,?)`).run(
    id,
    JSON.stringify({ sessionId: "session-1" }),
    capabilityOperationDigest(command),
    options.reuseMode ?? "one_time",
    options.maxUses === undefined ? 1 : options.maxUses,
    options.usedCount ?? 0,
  );
}

function insertWorkflowGraph(db: Database.Database, bindingId = "binding-1"): void {
  db.exec(`INSERT INTO workflow_definitions
      (id,scope_id,status,created_at,updated_at) VALUES ('workflow-1','session-1','active',1,1);
    INSERT INTO workflow_revisions
      (id,workflow_id,revision,spec_json,source_type,confidence,created_at)
      VALUES ('revision-1','workflow-1',1,'{}','explicit_user',1,1);
  `);
  db.prepare(`INSERT INTO workflow_bindings
    (id,run_id,attempt,workflow_id,revision_id,selector_version,relevance_score,created_at)
    VALUES (?,'run-1',1,'workflow-1','revision-1','test',1,1)`).run(bindingId);
}

function workflowCommand(commandId = "workflow-command", input: {
  action?: string;
  target?: { kind: string; id: string };
  bindingId?: string | null;
} = {}): CapabilityCommand {
  const action = input.action ?? "workflow.execute";
  const bindingId = input.bindingId === undefined ? "binding-1" : input.bindingId;
  const payload: Record<string, CanonicalJsonValue> = {
    workflowId: "workflow-1",
    impactScope: {},
    diff: {},
    rollback: {},
    revisionId: "revision-1",
  };
  if (bindingId) payload.bindingId = bindingId;
  return createCapabilityCommand({
    commandId,
    operation: {
      subject: { kind: "workflow", id: "workflow-1" },
      action,
      target: input.target ?? (action === "workflow.execute"
        ? { kind: "workflow_binding", id: bindingId ?? "missing-binding" }
        : { kind: "workflow_revision", id: "revision-1" }),
      scope: { type: "legacy_workflow_scope", id: "session-1" },
      payload,
    },
  });
}

function insertWorkflowApproval(
  db: Database.Database,
  id: string,
  command: CapabilityCommand,
  actionType = "execute_workflow",
): void {
  const payload = command.operation.payload as Record<string, CanonicalJsonValue>;
  db.prepare(`INSERT INTO autonomy_approval_requests
    (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,binding_id,status,risk_class,
     impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,expires_at,request_hash,
     created_at,updated_at,operation_digest,reuse_mode,max_uses,used_count)
    VALUES (?,'session-1',?,?,?,?,? ,?,'approved','high',?,'[]',?,?,'human',10000,?,1,1,?,'one_time',1,0)`)
    .run(
      id,
      actionType,
      command.operation.target.kind,
      command.operation.target.id,
      "workflow-1",
      "revision-1",
      typeof payload.bindingId === "string" ? payload.bindingId : null,
      JSON.stringify(payload.impactScope),
      JSON.stringify(payload.diff),
      JSON.stringify(payload.rollback),
      `request-hash:${id}`,
      capabilityOperationDigest(command),
    );
}

function persistedState(db: Database.Database, approvalId: string, source = "legacy_run") {
  const table = source === "legacy_run" ? "approval_requests" : "autonomy_approval_requests";
  return {
    usedCount: (db.prepare(`SELECT used_count value FROM ${table} WHERE id=?`).get(approvalId) as { value: number }).value,
    operations: (db.prepare("SELECT COUNT(*) value FROM operations").get() as { value: number }).value,
    receipts: (db.prepare("SELECT COUNT(*) value FROM approval_receipts WHERE outcome='allow'").get() as { value: number }).value,
  };
}

afterEach(() => {
  connections.splice(0).reverse().forEach((db) => db.close());
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("Attempt-bound capability authorization persistence", () => {
  it("atomically reconciles capability and legacy operations on writer-fenced Store restart", () => {
    const receipt = fixture();
    const runningCommand = runCommand("restart-running-command");
    const authorizedCommand = runCommand("restart-authorized-command");
    insertRunApproval(receipt.db, "restart-running-approval", runningCommand);
    insertRunApproval(receipt.db, "restart-authorized-approval", authorizedCommand);
    const runningInput = request(receipt, "restart-running-approval", runningCommand);
    const authorizedInput = request(receipt, "restart-authorized-approval", authorizedCommand);
    receipt.repository.authorizeAndClaim(runningInput);
    receipt.repository.beginEffect(runningInput);
    receipt.repository.authorizeAndClaim(authorizedInput);
    receipt.db.prepare(`UPDATE approval_requests SET expires_at=NULL
      WHERE id IN ('restart-running-approval','restart-authorized-approval')`).run();
    receipt.db.prepare(`INSERT INTO operations
      (id,run_id,attempt,attempt_id,operation_type,payload_hash,status,stage,created_at,updated_at)
      VALUES ('legacy-restart','run-1',1,?,'tool.bash','legacy-hash','running','executing',1,1)`)
      .run(ATTEMPT_ID);
    // Startup reconciliation is a system authority path. It must remain able to
    // conservatively close in-flight effects after runtime Attempt authority is gone.
    receipt.db.prepare("UPDATE attempts SET status='interrupted',active=0,version=version+1 WHERE id=?")
      .run(ATTEMPT_ID);
    receipt.db.prepare("UPDATE execution_leases SET released_at=1001 WHERE attempt_id=?").run(ATTEMPT_ID);
    receipt.db.prepare("UPDATE runs SET status='blocked' WHERE id='run-1'").run();

    const reopened = reopenForProductionRecovery(receipt);
    reopened.store.db.exec(`CREATE TEMP TRIGGER reject_restart_authorized
      BEFORE UPDATE ON operations WHEN OLD.id='restart-authorized-command'
      BEGIN SELECT RAISE(ABORT,'restart authorization recovery rejected'); END`);
    expect(() => reopened.store.runPostMigrationRecovery(reopened.guard))
      .toThrow(/restart authorization recovery rejected/);
    expect(reopened.store.db.prepare("SELECT id,status,stage,completed_at as completedAt FROM operations ORDER BY id").all())
      .toEqual([
        { id: "legacy-restart", status: "running", stage: "executing", completedAt: null },
        { id: "restart-authorized-command", status: "authorized", stage: "authorization_committed", completedAt: null },
        { id: "restart-running-command", status: "running", stage: "effect_started", completedAt: null },
      ]);
    reopened.store.db.exec("DROP TRIGGER reject_restart_authorized");

    expect(reopened.store.runPostMigrationRecovery(reopened.guard)).toEqual({ operations: 3, controlInbox: 0 });
    expect(reopened.store.runPostMigrationRecovery(reopened.guard)).toEqual({ operations: 0, controlInbox: 0 });
    const rows = reopened.store.db.prepare(`SELECT id,status,stage,error,completed_at as completedAt
      FROM operations ORDER BY id`).all() as Array<{
        id: string;
        status: string;
        stage: string;
        error: string;
        completedAt: number | null;
      }>;
    expect(rows).toEqual([
      {
        id: "legacy-restart",
        status: "outcome_unknown",
        stage: "service_restart",
        error: "Service restarted before operation outcome was recorded",
        completedAt: null,
      },
      {
        id: "restart-authorized-command",
        status: "cancelled",
        stage: "restart_before_effect",
        error: "Service restarted before capability effect began; execution was cancelled",
        completedAt: expect.any(Number),
      },
      {
        id: "restart-running-command",
        status: "outcome_unknown",
        stage: "outcome_unknown",
        error: "Service restarted after capability effect began; outcome is unknown",
        completedAt: expect.any(Number),
      },
    ]);
    expect(reopened.store.db.prepare("SELECT COUNT(*) count FROM approval_receipts WHERE outcome='allow'").get())
      .toEqual({ count: 2 });
    expect(reopened.store.db.prepare(`SELECT id,used_count as usedCount FROM approval_requests
      WHERE id LIKE 'restart-%' ORDER BY id`).all()).toEqual([
      { id: "restart-authorized-approval", usedCount: 1 },
      { id: "restart-running-approval", usedCount: 1 },
    ]);

    reopened.guard.run(() => reopened.store.markInterrupted());
    expect(reopened.repository.authorizeAndClaim(runningInput)).toMatchObject({
      commandId: runningCommand.commandId,
      status: "outcome_unknown",
    });
    expect(reopened.repository.authorizeAndClaim(authorizedInput)).toMatchObject({
      commandId: authorizedCommand.commandId,
      status: "cancelled",
    });
    expect(reopened.store.db.prepare("SELECT COUNT(*) count FROM approval_receipts WHERE outcome='allow'").get())
      .toEqual({ count: 2 });
    expect(reopened.store.db.prepare(`SELECT SUM(used_count) count FROM approval_requests
      WHERE id LIKE 'restart-%'`).get()).toEqual({ count: 2 });
  });

  it("derives operation identity, consumes once, writes a real Attempt, and exactly replays", () => {
    const receipt = fixture();
    const command = runCommand("command-exact");
    insertRunApproval(receipt.db, "approval-exact", command);
    const input = request(receipt, "approval-exact", command);

    expect(receipt.repository.authorizeAndClaim(input)).toEqual({
      commandId: "command-exact",
      status: "authorized",
      authorization: { kind: "approval", approvalRef: input.approvalRef },
      error: "",
    });
    expect(receipt.repository.authorizeAndClaim(input)).toEqual(
      expect.objectContaining({ commandId: "command-exact", status: "authorized" }),
    );
    expect(persistedState(receipt.db, "approval-exact")).toEqual({ usedCount: 1, operations: 1, receipts: 1 });
    expect(receipt.db.prepare(`SELECT attempt_id as attemptId,operation_type as operationType,
      payload_hash as payloadHash,status,stage FROM operations WHERE id='command-exact'`).get()).toEqual({
      attemptId: ATTEMPT_ID,
      operationType: "task_run.resume",
      payloadHash: capabilityPayloadHash(command),
      status: "authorized",
      stage: "authorization_committed",
    });
    const receiptId = capabilityAuthorizationReceiptId(command);
    expect(receipt.repository.get(receiptId)).toMatchObject({
      id: receiptId,
      commandId: command.commandId,
      operationDigest: capabilityOperationDigest(command),
      approvalRef: input.approvalRef,
    });
    expect(receipt.repository.listByOperationDigest(capabilityOperationDigest(command))).toHaveLength(1);

    expect(() => receipt.repository.authorizeAndClaim({
      ...input,
      actorId: "different-human",
    })).toThrow(/different authorization receipt/);
    expect(persistedState(receipt.db, "approval-exact")).toEqual({ usedCount: 1, operations: 1, receipts: 1 });
  });

  it("binds subject, action, target, scope, and payload independently before consumption", () => {
    const receipt = fixture();
    insertRunApproval(receipt.db, "approval-binding");
    const cases: Array<[string, CapabilityCommand, RegExp]> = [
      ["subject", runCommand("wrong-subject", { subject: { kind: "task_run", id: "other-run" } }), /subject/],
      ["action", runCommand("wrong-action", { action: "task_run.start_parallel" }), /action/],
      ["target", runCommand("wrong-target", { target: { kind: "task_run", id: "other-run" } }), /target/],
      ["scope", runCommand("wrong-scope", { scope: { type: "session", id: "other-session" } }), /scope/],
      ["payload", runCommand("wrong-payload", { payload: { decisionId: "other-decision" } }), /payload/],
    ];
    for (const [_field, command, message] of cases) {
      expect(() => receipt.repository.authorizeAndClaim(request(receipt, "approval-binding", command)))
        .toThrow(message);
      expect(persistedState(receipt.db, "approval-binding")).toEqual({ usedCount: 0, operations: 0, receipts: 0 });
    }
  });

  it("requires a digest-bound Workflow binding for the exact Workflow/run/Attempt/scope", () => {
    const receipt = fixture();
    insertWorkflowGraph(receipt.db);
    const command = workflowCommand();
    insertWorkflowApproval(receipt.db, "workflow-approval", command);
    const input = request(receipt, "workflow-approval", command, "legacy_workflow");

    expect(receipt.repository.authorizeAndClaim(input)).toMatchObject({ status: "authorized" });
    expect(persistedState(receipt.db, "workflow-approval", "legacy_workflow"))
      .toEqual({ usedCount: 1, operations: 1, receipts: 1 });
  });

  it("rejects a missing, wrong-Attempt, or wrong-scope Workflow binding and non-execute Workflow actions", () => {
    for (const scenario of ["missing", "attempt", "scope"] as const) {
      const receipt = fixture();
      insertWorkflowGraph(receipt.db);
      const command = workflowCommand(`workflow-${scenario}`, scenario === "missing" ? { bindingId: null } : {});
      insertWorkflowApproval(receipt.db, `approval-${scenario}`, command);
      if (scenario === "attempt") receipt.db.prepare("UPDATE workflow_bindings SET attempt=2 WHERE id='binding-1'").run();
      if (scenario === "scope") {
        receipt.db.exec(`INSERT INTO sessions (id,title,created_at,updated_at)
          VALUES ('different-scope','different',1,1);
          UPDATE runs SET session_id='different-scope' WHERE id='run-1';`);
      }
      expect(() => receipt.repository.authorizeAndClaim(
        request(receipt, `approval-${scenario}`, command, "legacy_workflow"),
      )).toThrow(/binding|scope/);
      connections.splice(connections.indexOf(receipt.db), 1)[0].close();
    }

    const receipt = fixture();
    insertWorkflowGraph(receipt.db);
    const command = workflowCommand("workflow-activate", { action: "workflow.activate" });
    insertWorkflowApproval(receipt.db, "approval-activate", command, "activate_workflow");
    expect(() => receipt.repository.authorizeAndClaim(
      request(receipt, "approval-activate", command, "legacy_workflow"),
    )).toThrow(/Learning synchronous unit of work/);
  });

  it("routes source-qualified colliding IDs without consuming the other authority", () => {
    const receipt = fixture();
    const run = runCommand("source-collision");
    insertRunApproval(receipt.db, "same-id", run);
    insertWorkflowGraph(receipt.db);
    const workflow = workflowCommand("source-collision-workflow");
    insertWorkflowApproval(receipt.db, "same-id", workflow);

    expect(receipt.repository.authorizeAndClaim(request(receipt, "same-id", workflow, "legacy_workflow")))
      .toMatchObject({ status: "authorized" });
    expect(receipt.db.prepare("SELECT used_count value FROM approval_requests WHERE id='same-id'").get())
      .toEqual({ value: 0 });
    expect(receipt.db.prepare("SELECT used_count value FROM autonomy_approval_requests WHERE id='same-id'").get())
      .toEqual({ value: 1 });
  });

  it("rolls back consume, claim, and receipt when any authorization phase write fails", () => {
    const receipt = fixture();
    insertRunApproval(receipt.db, "approval-used", runCommand("command-used"), { usedCount: 1 });
    expect(() => receipt.repository.authorizeAndClaim(
      request(receipt, "approval-used", runCommand("command-used")),
    )).toThrow(/cannot be consumed/);
    expect(persistedState(receipt.db, "approval-used")).toEqual({ usedCount: 1, operations: 0, receipts: 0 });

    insertRunApproval(receipt.db, "approval-operation", runCommand("command-operation"));
    receipt.db.exec(`CREATE TEMP TRIGGER reject_capability_operation BEFORE INSERT ON operations
      WHEN NEW.id='command-operation' BEGIN SELECT RAISE(ABORT,'operation rejected'); END`);
    expect(() => receipt.repository.authorizeAndClaim(
      request(receipt, "approval-operation", runCommand("command-operation")),
    )).toThrow(/operation rejected/);
    expect(persistedState(receipt.db, "approval-operation")).toEqual({ usedCount: 0, operations: 0, receipts: 0 });
    receipt.db.exec("DROP TRIGGER reject_capability_operation");

    const collision = runCommand("command-collision");
    insertRunApproval(receipt.db, "approval-collision-operation", collision);
    receipt.db.prepare(`INSERT INTO operations
      (id,run_id,attempt,attempt_id,operation_type,payload_hash,status,stage,created_at,updated_at)
      VALUES (?,'run-1',1,?,'task_run.resume',?,'authorized','authorization_committed',1,1)`)
      .run(collision.commandId, ATTEMPT_ID, capabilityPayloadHash(collision));
    expect(() => receipt.repository.authorizeAndClaim(
      request(receipt, "approval-collision-operation", collision),
    )).toThrow(/already exists without an allow receipt/);
    expect(persistedState(receipt.db, "approval-collision-operation"))
      .toEqual({ usedCount: 0, operations: 1, receipts: 0 });
    receipt.db.prepare("DELETE FROM operations WHERE id=?").run(collision.commandId);

    insertRunApproval(receipt.db, "approval-receipt", runCommand("command-receipt"));
    receipt.db.exec(`CREATE TEMP TRIGGER reject_capability_receipt BEFORE INSERT ON approval_receipts
      WHEN NEW.id='capability-authorization:command-receipt'
      BEGIN SELECT RAISE(ABORT,'receipt rejected'); END`);
    expect(() => receipt.repository.authorizeAndClaim(
      request(receipt, "approval-receipt", runCommand("command-receipt")),
    )).toThrow(/receipt rejected/);
    expect(persistedState(receipt.db, "approval-receipt")).toEqual({ usedCount: 0, operations: 0, receipts: 0 });
  });

  it("uses beginEffect as the one-winner gate and never replays terminal effects", () => {
    const receipt = fixture();
    const command = runCommand("effect-command");
    insertRunApproval(receipt.db, "effect-approval", command);
    const input = request(receipt, "effect-approval", command);
    receipt.repository.authorizeAndClaim(input);

    expect(receipt.repository.beginEffect(input)).toMatchObject({ started: true, state: { status: "running" } });
    expect(receipt.repository.authorizeAndClaim(input)).toMatchObject({ status: "running" });
    expect(receipt.repository.beginEffect(input)).toMatchObject({ started: false, state: { status: "running" } });
    expect(receipt.repository.settleEffect(input, { status: "failed", error: "effect failed" }))
      .toMatchObject({ status: "failed", error: "effect failed" });
    expect(() => receipt.repository.beginEffect(input)).toThrow(/cannot begin.*failed/);
    expect(() => receipt.repository.settleEffect(input, { status: "failed", error: "again" }))
      .toThrow(/cannot settle.*failed/);
    expect(() => receipt.repository.markOutcomeUnknown(input, { error: "again" }))
      .toThrow(/cannot become outcome_unknown.*failed/);
    expect(persistedState(receipt.db, "effect-approval")).toEqual({ usedCount: 1, operations: 1, receipts: 1 });
  });

  it("rolls back begin and successful settlement, including stale-check invalidation, on injected failures", () => {
    const receipt = fixture();
    const command = runCommand("rollback-command");
    insertRunApproval(receipt.db, "rollback-approval", command);
    const input = request(receipt, "rollback-approval", command);
    receipt.repository.authorizeAndClaim(input);
    receipt.db.exec(`CREATE TEMP TRIGGER reject_effect_begin BEFORE UPDATE ON operations
      WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'begin rejected'); END`);
    expect(() => receipt.repository.beginEffect(input)).toThrow(/begin rejected/);
    expect(receipt.db.prepare("SELECT status FROM operations WHERE id='rollback-command'").get())
      .toEqual({ status: "authorized" });
    receipt.db.exec("DROP TRIGGER reject_effect_begin");
    receipt.repository.beginEffect(input);

    receipt.db.prepare(`INSERT INTO run_checks
      (run_id,check_key,title,status,required,command,evidence,stale)
      VALUES ('run-1','check-1','check','passed',1,'test','passed',0)`).run();
    receipt.db.exec(`CREATE TEMP TRIGGER reject_check_settlement BEFORE UPDATE ON run_checks
      WHEN OLD.status='passed' BEGIN SELECT RAISE(ABORT,'stale check rejected'); END`);
    expect(() => receipt.repository.settleEffect(input, { status: "succeeded", result: { ok: true } }))
      .toThrow(/stale check rejected/);
    expect(receipt.db.prepare("SELECT stale FROM run_checks WHERE check_key='check-1'").get()).toEqual({ stale: 0 });
    expect(receipt.db.prepare("SELECT status FROM operations WHERE id='rollback-command'").get())
      .toEqual({ status: "running" });
    receipt.db.exec("DROP TRIGGER reject_check_settlement");

    expect(receipt.repository.settleEffect(input, { status: "succeeded", result: { ok: true } }))
      .toMatchObject({ status: "succeeded", result: { ok: true } });
    expect(receipt.db.prepare("SELECT stale FROM run_checks WHERE check_key='check-1'").get()).toEqual({ stale: 1 });
    expect(receipt.db.prepare("SELECT updated_at as updatedAt FROM runs WHERE id='run-1'").get())
      .toEqual({ updatedAt: 1000 });
  });

  it("allows the current runtime holder to conservatively mark a begun effect outcome_unknown", () => {
    const receipt = fixture();
    const command = runCommand("unknown-command");
    insertRunApproval(receipt.db, "unknown-approval", command);
    const input = request(receipt, "unknown-approval", command);
    receipt.repository.authorizeAndClaim(input);
    receipt.repository.beginEffect(input);

    expect(receipt.repository.markOutcomeUnknown(input, { error: "effect result was not observable" }))
      .toMatchObject({ status: "outcome_unknown", error: "effect result was not observable" });
    expect(receipt.repository.authorizeAndClaim(input)).toMatchObject({ status: "outcome_unknown" });
    expect(() => receipt.repository.beginEffect(input)).toThrow();
  });

  it("rejects stale runtime authority before markOutcomeUnknown with zero operation writes", () => {
    const scenarios = [
      {
        name: "Attempt version",
        mutate: (receipt: Fixture, input: CapabilityExecutionRequest) => {
          receipt.db.prepare("UPDATE attempts SET version=version+1 WHERE id=?").run(ATTEMPT_ID);
          return input;
        },
        message: /Attempt version mismatch/,
      },
      {
        name: "lease token",
        mutate: (_receipt: Fixture, input: CapabilityExecutionRequest) => ({
          ...input,
          fence: { ...input.fence, leaseToken: "stale-token" },
        }),
        message: /token mismatch/,
      },
      {
        name: "execution fence",
        mutate: (_receipt: Fixture, input: CapabilityExecutionRequest) => ({
          ...input,
          fence: { ...input.fence, executionFence: input.fence.executionFence + 1 },
        }),
        message: /fence mismatch/,
      },
      {
        name: "released lease",
        mutate: (receipt: Fixture, input: CapabilityExecutionRequest) => {
          receipt.db.prepare("UPDATE execution_leases SET released_at=1001 WHERE attempt_id=?").run(ATTEMPT_ID);
          return input;
        },
        message: /released or expired/,
      },
      {
        name: "expired lease",
        mutate: (receipt: Fixture, input: CapabilityExecutionRequest) => {
          receipt.db.prepare("UPDATE execution_leases SET lease_until=1000 WHERE attempt_id=?").run(ATTEMPT_ID);
          return input;
        },
        message: /released or expired/,
      },
      {
        name: "inactive Attempt",
        mutate: (receipt: Fixture, input: CapabilityExecutionRequest) => {
          receipt.db.prepare("UPDATE attempts SET status='interrupted',active=0 WHERE id=?").run(ATTEMPT_ID);
          return input;
        },
        message: /not active and running/,
      },
      {
        name: "stale Run projection",
        mutate: (receipt: Fixture, input: CapabilityExecutionRequest) => {
          receipt.db.prepare("UPDATE runs SET attempt=2 WHERE id='run-1'").run();
          return input;
        },
        message: /TaskRun projection is stale/,
      },
    ] as const;

    for (const scenario of scenarios) {
      const receipt = fixture();
      const command = runCommand(`unknown-${scenario.name.replaceAll(" ", "-").toLowerCase()}`);
      const approvalId = `approval-${command.commandId}`;
      insertRunApproval(receipt.db, approvalId, command);
      const input = request(receipt, approvalId, command);
      receipt.repository.authorizeAndClaim(input);
      receipt.repository.beginEffect(input);
      const before = receipt.db.prepare(`SELECT status,stage,result_json as resultJson,error,
        updated_at as updatedAt,completed_at as completedAt FROM operations WHERE id=?`)
        .get(command.commandId);

      expect(
        () => receipt.repository.markOutcomeUnknown(
          scenario.mutate(receipt, input),
          { error: "must not write" },
        ),
        scenario.name,
      ).toThrow(scenario.message);
      expect(receipt.db.prepare(`SELECT status,stage,result_json as resultJson,error,
        updated_at as updatedAt,completed_at as completedAt FROM operations WHERE id=?`)
        .get(command.commandId), scenario.name).toEqual(before);
      expect(persistedState(receipt.db, approvalId), scenario.name)
        .toEqual({ usedCount: 1, operations: 1, receipts: 1 });
    }
  });

  it("returns a terminal exact replay after Attempt, lease, and TaskRun become inactive", () => {
    const receipt = fixture();
    const command = runCommand("terminal-replay-command");
    insertRunApproval(receipt.db, "terminal-replay-approval", command);
    const input = request(receipt, "terminal-replay-approval", command);
    receipt.repository.authorizeAndClaim(input);
    receipt.repository.beginEffect(input);
    expect(receipt.repository.settleEffect(input, { status: "succeeded", result: { delivered: true } }))
      .toMatchObject({ status: "succeeded" });
    receipt.db.prepare("UPDATE attempts SET status='completed',active=0,version=version+1 WHERE id=?").run(ATTEMPT_ID);
    receipt.db.prepare("UPDATE execution_leases SET released_at=1001 WHERE attempt_id=?").run(ATTEMPT_ID);
    receipt.db.prepare("UPDATE runs SET status='completed',completed_at=1001 WHERE id='run-1'").run();

    expect(receipt.repository.authorizeAndClaim(input)).toEqual({
      commandId: command.commandId,
      status: "succeeded",
      authorization: { kind: "approval", approvalRef: input.approvalRef },
      result: { delivered: true },
      error: "",
    });
    expect(() => receipt.repository.beginEffect(input)).toThrow();
    expect(persistedState(receipt.db, "terminal-replay-approval"))
      .toEqual({ usedCount: 1, operations: 1, receipts: 1 });
  });

  it("rejects stale/nonexistent Attempt, version, token, lease fence/state, TaskRun projection, and writer", () => {
    const receipt = fixture();
    const command = runCommand("fence-command");
    insertRunApproval(receipt.db, "fence-approval", command);
    const input = request(receipt, "fence-approval", command);
    const unchanged = () => expect(persistedState(receipt.db, "fence-approval"))
      .toEqual({ usedCount: 0, operations: 0, receipts: 0 });
    const reject = (candidate: CapabilityExecutionRequest, restore?: () => void) => {
      expect(() => receipt.repository.authorizeAndClaim(candidate)).toThrow();
      unchanged();
      restore?.();
    };
    reject({ ...input, fence: { ...input.fence, attemptId: "attempt:missing:1" } });
    reject({ ...input, fence: { ...input.fence, expectedVersion: 2 } });
    reject({ ...input, fence: { ...input.fence, leaseToken: "wrong" } });
    reject({ ...input, fence: { ...input.fence, executionFence: 8 } });
    receipt.db.prepare("UPDATE execution_leases SET attempt_version=2 WHERE attempt_id=?").run(ATTEMPT_ID);
    reject(input, () => receipt.db.prepare("UPDATE execution_leases SET attempt_version=1 WHERE attempt_id=?").run(ATTEMPT_ID));
    receipt.db.prepare("UPDATE execution_leases SET released_at=1000 WHERE attempt_id=?").run(ATTEMPT_ID);
    reject(input, () => receipt.db.prepare("UPDATE execution_leases SET released_at=NULL WHERE attempt_id=?").run(ATTEMPT_ID));
    receipt.db.prepare("UPDATE execution_leases SET lease_until=1000 WHERE attempt_id=?").run(ATTEMPT_ID);
    reject(input, () => receipt.db.prepare("UPDATE execution_leases SET lease_until=10000 WHERE attempt_id=?").run(ATTEMPT_ID));
    receipt.db.prepare("UPDATE attempts SET status='waiting_input',active=0 WHERE id=?").run(ATTEMPT_ID);
    reject(input, () => receipt.db.prepare("UPDATE attempts SET status='running',active=1 WHERE id=?").run(ATTEMPT_ID));
    receipt.db.prepare("UPDATE runs SET attempt=2 WHERE id='run-1'").run();
    reject(input, () => receipt.db.prepare("UPDATE runs SET attempt=1 WHERE id='run-1'").run());

    receipt.setNow(23_001);
    const currentDb = receipt.connect();
    expect(claim(currentDb, "owner-b")).not.toBeNull();
    expect(() => receipt.repository.authorizeAndClaim(input)).toThrow(WriterAuthorityLostError);
    unchanged();
  });

  it("leaves running state for startup recovery when writer authority is lost before outcome_unknown", () => {
    const receipt = fixture();
    const command = runCommand("writer-unknown-command");
    insertRunApproval(receipt.db, "writer-unknown-approval", command);
    const input = request(receipt, "writer-unknown-approval", command);
    receipt.repository.authorizeAndClaim(input);
    receipt.repository.beginEffect(input);
    const authorizedCommand = runCommand("writer-authorized-command");
    insertRunApproval(receipt.db, "writer-authorized-approval", authorizedCommand);
    const authorizedInput = request(receipt, "writer-authorized-approval", authorizedCommand);
    receipt.repository.authorizeAndClaim(authorizedInput);
    receipt.setNow(23_001);
    const currentDb = receipt.connect();
    expect(claim(currentDb, "owner-b")).not.toBeNull();

    expect(() => receipt.repository.authorizeAndClaim(input)).toThrow(WriterAuthorityLostError);
    expect(() => receipt.repository.beginEffect(authorizedInput)).toThrow(WriterAuthorityLostError);
    expect(() => receipt.repository.settleEffect(input, { status: "succeeded", result: null }))
      .toThrow(WriterAuthorityLostError);
    expect(() => receipt.repository.markOutcomeUnknown(input, { error: "unknown" }))
      .toThrow(WriterAuthorityLostError);
    expect(receipt.db.prepare("SELECT status FROM operations WHERE id=?").get(command.commandId))
      .toEqual({ status: "running" });
    expect(receipt.db.prepare("SELECT status FROM operations WHERE id=?").get(authorizedCommand.commandId))
      .toEqual({ status: "authorized" });
  });

  it("serializes two independent synchronous connections so one-time approval has one winner", () => {
    // better-sqlite3 calls cannot overlap on one JS isolate. This still exercises
    // two separately guarded connections and the BEGIN IMMEDIATE/conditional
    // consume contract; a worker-thread race would test SQLite scheduling rather
    // than additional repository behavior.
    const receipt = fixture();
    const commandA = runCommand("race-a");
    insertRunApproval(receipt.db, "race-approval", commandA);
    const secondDb = receipt.connect();
    const secondRepository = new SqliteFencedCapabilityAuthorizationRepository(
      secondDb,
      new WriterFenceGuard(secondDb, receipt.lease.authority, { skewMarginMs: 2_000, nowSql }),
      { nowSql },
    );
    const commandB = runCommand("race-b");
    const outcomes = [
      () => receipt.repository.authorizeAndClaim(request(receipt, "race-approval", commandA)),
      () => secondRepository.authorizeAndClaim(request(receipt, "race-approval", commandB)),
    ].map((attempt) => {
      try { return { status: "fulfilled" as const, state: attempt() }; }
      catch (error) { return { status: "rejected" as const, error }; }
    });
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(persistedState(receipt.db, "race-approval")).toEqual({ usedCount: 1, operations: 1, receipts: 1 });
  });
});
