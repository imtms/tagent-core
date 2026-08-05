import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreWorkflowGovernanceApplication } from "@tagent/core-service/application";
import {
  WorkflowGovernanceService,
  type SupervisorDecision,
  type WorkflowRevisionMaterializerPort,
} from "@tagent/governance";
import { WorkflowService, type WorkflowSpec } from "@tagent/learning";
import { LegacyStoreAdapter } from "@tagent/persistence-sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { SqliteCanonicalApprovalShadowRepository } from "@tagent/persistence-sqlite/sqlite";
import { workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
const temporaryDirectories: string[] = [];

const unusedMaterializer: WorkflowRevisionMaterializerPort = {
  materialize: () => { throw new Error("materializer is not used by activation tests"); },
};

function governanceApplication(store: Store) {
  const adapter = new LegacyStoreAdapter(store, {
    run<T>(work: () => T): T { return store.db.transaction(work)(); },
  });
  return new CoreWorkflowGovernanceApplication(
    new WorkflowGovernanceService(adapter.workflowGovernance, unusedMaterializer),
    adapter.workflowGovernance.reader,
  );
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function createStore(filename = ":memory:"): Store {
  const store = new Store(filename);
  stores.push(store);
  return store;
}

function closeStore(store: Store): void {
  stores.splice(stores.indexOf(store), 1);
  store.close();
}

function recordDecision(store: Store, runId: string, id: string): void {
  const decision: SupervisorDecision = {
    id,
    runId,
    evaluator: "system",
    evaluatorModel: "",
    attempt: 1,
    checkpointSeq: 0,
    trigger: "manual",
    action: "pause_for_approval",
    reasonCode: "approval_required",
    rationale: "approval required",
    confidence: 1,
    instruction: "",
    candidateResponseHash: "",
    status: "executed",
    error: "",
    createdAt: 1_700_000_000_000,
    executedAt: 1_700_000_000_000,
  };
  store.recordSupervisorDecision(decision);
}

const workflowSpec: WorkflowSpec = {
  name: "Governed release",
  intent: "release only after approval",
  cueTerms: ["release"],
  applicability: ["governed release"],
  nonApplicability: [],
  preconditions: [],
  inputContract: [],
  outputContract: [],
  steps: [{ stepId: "verify", instruction: "Verify release", required: true }],
  verification: [{ check: "verified", required: true, successCondition: "passes" }],
  requiredCapabilities: [],
  riskClass: "low",
};

function workflowFixture(store: Store) {
  const session = store.createSession("dual-write workflow");
  const service = new WorkflowService(workflowPersistence(store), "dual-write-secret");
  const workflow = service.teach(session.id, workflowSpec, "evidence:dual-write");
  const approval = service.requestActivation(workflow.id, workflow.revision!.id, "governor", "release reviewed");
  return { service, workflow, approval };
}

describe("Governance v31 live dual-write", () => {
  it("writes a new Run approval's canonical fields immediately with shadow digest parity", () => {
    const store = createStore();
    const session = store.createSession("dual-write run");
    const run = store.createRun(session.id, "resume after approval");
    recordDecision(store, run.id, "decision-live-run");

    const legacy = store.ensureApprovalRequest(run.id, "decision-live-run", "resume reviewed", {
      metadata: { requestedBy: "supervisor" },
    });
    const row = store.db.prepare(`SELECT scope_type as scopeType,scope_id as scopeId,
      operation_digest as operationDigest,risk_class as riskClass,expires_at as expiresAt,
      reuse_mode as reuseMode,max_uses as maxUses,used_count as usedCount
      FROM approval_requests WHERE id=?`).get(legacy.id) as Record<string, unknown>;
    const projection = new SqliteCanonicalApprovalShadowRepository(store.db).get({
      source: "legacy_run",
      id: legacy.id,
    });

    expect(row).toMatchObject({
      scopeType: "session",
      scopeId: session.id,
      riskClass: "medium",
      expiresAt: null,
      reuseMode: "one_time",
      maxUses: 1,
      usedCount: 0,
    });
    expect(row.operationDigest).toMatch(/^tagent\.approval\.operation\.sha256\.v1:[a-f0-9]{64}$/);
    expect(projection).toMatchObject({ state: "resolved", approval: { operationDigest: row.operationDigest } });
    expect(store.getApprovalRequest(legacy.id)).toEqual(legacy);
  });

  it("preserves proven-unused live Run approval state across approve and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "tagent-v31-dual-write-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "core.db");
    const first = createStore(filename);
    const session = first.createSession("reopen live approval");
    const run = first.createRun(session.id, "resume after restart");
    recordDecision(first, run.id, "decision-reopen-run");
    const approval = first.ensureApprovalRequest(run.id, "decision-reopen-run", "reviewed");
    first.resolveApprovalRequest(approval.id, "approved", "human", "safe");
    expect(first.db.prepare("SELECT status,used_count as usedCount FROM approval_requests WHERE id=?")
      .get(approval.id)).toEqual({ status: "approved", usedCount: 0 });
    expect(new SqliteCanonicalApprovalShadowRepository(first.db).get({
      source: "legacy_run",
      id: approval.id,
    })).toMatchObject({
      state: "resolved",
      approval: { status: "approved", reuse: { usedCount: 0 } },
    });
    closeStore(first);

    const reopened = createStore(filename);
    expect(reopened.db.prepare(`SELECT status,used_count as usedCount,operation_digest as operationDigest
      FROM approval_requests WHERE id=?`).get(approval.id)).toMatchObject({
      status: "approved",
      usedCount: 0,
      operationDigest: expect.stringMatching(/^tagent\.approval\.operation\.sha256\.v1:/),
    });
    expect(reopened.getApprovalRequest(approval.id)).toMatchObject({
      id: approval.id,
      status: "approved",
      resolvedBy: "human",
      resolution: "safe",
    });
    expect(new SqliteCanonicalApprovalShadowRepository(reopened.db).get({
      source: "legacy_run",
      id: approval.id,
    })).toMatchObject({ state: "resolved", approval: { status: "approved", reuse: { usedCount: 0 } } });
  });

  it("writes new Workflow canonical fields and settles execution with a deterministic receipt", () => {
    const store = createStore();
    const { service, approval } = workflowFixture(store);
    const pending = store.db.prepare(`SELECT operation_digest as operationDigest,reuse_mode as reuseMode,
      max_uses as maxUses,used_count as usedCount FROM autonomy_approval_requests WHERE id=?`)
      .get(approval.id) as Record<string, unknown>;
    const projection = new SqliteCanonicalApprovalShadowRepository(store.db).get({
      source: "legacy_workflow",
      id: approval.id,
    });
    expect(pending).toMatchObject({ reuseMode: "one_time", maxUses: 1, usedCount: 0 });
    expect(pending.operationDigest).toMatch(/^tagent\.approval\.operation\.sha256\.v1:[a-f0-9]{64}$/);
    expect(projection).toMatchObject({ state: "resolved", approval: { operationDigest: pending.operationDigest } });

    service.decideApproval(approval.id, "approved", "human", "verified");
    governanceApplication(store).executeAutonomyApproval(approval.id, "operator");
    expect(store.db.prepare(`SELECT status,used_count as usedCount FROM autonomy_approval_requests WHERE id=?`)
      .get(approval.id)).toEqual({ status: "executed", usedCount: 1 });
    expect(store.db.prepare(`SELECT id,approval_source as approvalSource,approval_id as approvalId,
      operation_id as operationId,operation_digest as operationDigest,outcome,actor_id as actorId,created_at as createdAt
      FROM approval_receipts WHERE approval_id=?`).get(approval.id)).toMatchObject({
      id: `approval-receipt:legacy_workflow:${approval.id}:executed`,
      approvalSource: "legacy_workflow",
      approvalId: approval.id,
      operationId: `legacy-workflow-approval:${approval.id}`,
      operationDigest: pending.operationDigest,
      outcome: "executed",
      actorId: "operator",
      createdAt: expect.any(Number),
    });
  });

  it("reopens a live executed Workflow approval without rewriting canonical state", () => {
    const directory = mkdtempSync(join(tmpdir(), "tagent-v31-workflow-reopen-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "core.db");
    const first = createStore(filename);
    const { service, approval } = workflowFixture(first);
    service.decideApproval(approval.id, "approved", "human", "verified");
    governanceApplication(first).executeAutonomyApproval(approval.id, "operator");
    const snapshot = () => ({
      approval: first.db.prepare(`SELECT status,operation_digest as operationDigest,reuse_mode as reuseMode,
        max_uses as maxUses,used_count as usedCount,executed_at as executedAt,
        execution_receipt_json as receiptJson FROM autonomy_approval_requests WHERE id=?`).get(approval.id),
      receipt: first.db.prepare("SELECT * FROM approval_receipts WHERE approval_id=? ORDER BY id").all(approval.id),
    });
    const before = snapshot();
    closeStore(first);

    const reopened = createStore(filename);
    expect({
      approval: reopened.db.prepare(`SELECT status,operation_digest as operationDigest,reuse_mode as reuseMode,
        max_uses as maxUses,used_count as usedCount,executed_at as executedAt,
        execution_receipt_json as receiptJson FROM autonomy_approval_requests WHERE id=?`).get(approval.id),
      receipt: reopened.db.prepare("SELECT * FROM approval_receipts WHERE approval_id=? ORDER BY id").all(approval.id),
    }).toEqual(before);
    expect(new SqliteCanonicalApprovalShadowRepository(reopened.db).get({
      source: "legacy_workflow",
      id: approval.id,
    })).toMatchObject({ state: "resolved", approval: { status: "consumed", reuse: { usedCount: 1 } } });
  });

  it("rolls back Workflow settlement if the canonical receipt cannot be appended", () => {
    const store = createStore();
    const { service, workflow, approval } = workflowFixture(store);
    service.decideApproval(approval.id, "approved", "human", "verified");
    const auditCount = (store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get() as { count: number }).count;
    const governanceReceiptCount = (store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts")
      .get() as { count: number }).count;
    store.db.exec(`CREATE TEMP TRIGGER reject_dual_write_receipt BEFORE INSERT ON approval_receipts
      BEGIN SELECT RAISE(ABORT, 'dual-write receipt rejected'); END`);

    expect(() => governanceApplication(store).executeAutonomyApproval(approval.id, "operator"))
      .toThrow("dual-write receipt rejected");
    expect(store.db.prepare(`SELECT status,executed_at as executedAt,execution_receipt_json as receipt,
      used_count as usedCount FROM autonomy_approval_requests WHERE id=?`).get(approval.id)).toEqual({
      status: "approved",
      executedAt: null,
      receipt: "{}",
      usedCount: 0,
    });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts WHERE approval_id=?")
      .get(approval.id)).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: auditCount });
    expect(store.db.prepare(`SELECT status,active_revision_id as activeRevisionId
      FROM workflow_definitions WHERE id=?`).get(workflow.id)).toEqual({
      status: "candidate",
      activeRevisionId: null,
    });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get())
      .toEqual({ count: governanceReceiptCount });
  });

  it("keeps incomplete or conflicting live Run canonical state unresolved", () => {
    const store = createStore();
    const session = store.createSession("run conflict");
    const run = store.createRun(session.id, "run conflict");
    recordDecision(store, run.id, "decision-run-conflict");
    const approval = store.ensureApprovalRequest(run.id, "decision-run-conflict", "reviewed");
    store.db.prepare("UPDATE approval_requests SET operation_digest='forged' WHERE id=?").run(approval.id);
    expect(new SqliteCanonicalApprovalShadowRepository(store.db).get({
      source: "legacy_run",
      id: approval.id,
    })).toMatchObject({
      state: "unresolved",
      active: true,
      reasonCodes: expect.arrayContaining(["legacy_field_conflict"]),
    });
  });

  it("fails closed on semantic digest conflict without changing legacy execution state", () => {
    const store = createStore();
    const { service, approval } = workflowFixture(store);
    service.decideApproval(approval.id, "approved", "human", "verified");
    store.db.prepare("UPDATE autonomy_approval_requests SET operation_digest='forged' WHERE id=?").run(approval.id);

    expect(new SqliteCanonicalApprovalShadowRepository(store.db).get({
      source: "legacy_workflow",
      id: approval.id,
    })).toMatchObject({
      state: "unresolved",
      active: true,
      reasonCodes: expect.arrayContaining(["legacy_field_conflict"]),
    });
    expect(() => governanceApplication(store).executeAutonomyApproval(approval.id, "operator"))
      .toThrow("Approved request is required before execution");
    expect(store.db.prepare(`SELECT status,used_count as usedCount,executed_at as executedAt
      FROM autonomy_approval_requests WHERE id=?`).get(approval.id)).toEqual({
      status: "approved",
      usedCount: 0,
      executedAt: null,
    });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts WHERE approval_id=?")
      .get(approval.id)).toEqual({ count: 0 });
  });
});
