import { afterEach, describe, expect, it } from "vitest";
import { CoreWorkflowGovernanceApplication } from "@tagent/core-service/application";
import {
  LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE,
  canonicalApprovalAction,
  canonicalApprovalActionForSource,
  canonicalApprovalStatus,
  canonicalOperationJson,
  operationDigest,
  stableJson,
  WorkflowGovernanceService,
  type CanonicalOperationInput,
  type SupervisorDecision,
  type WorkflowRevisionMaterializerPort,
} from "@tagent/governance";
import { WorkflowService, type WorkflowSpec } from "@tagent/learning";
import { LegacyStoreAdapter, Store } from "@tagent/persistence-sqlite";
import { SqliteCanonicalApprovalShadowRepository } from "@tagent/persistence-sqlite/sqlite";
import { workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function createStore() {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}

function supervisorDecision(runId: string, id: string): SupervisorDecision {
  return {
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
}

const workflowSpec: WorkflowSpec = {
  name: "Review safely",
  intent: "review a safe change",
  cueTerms: ["review"],
  applicability: ["review change"],
  nonApplicability: [],
  preconditions: [],
  inputContract: [],
  outputContract: [],
  steps: [{ stepId: "inspect", instruction: "Inspect the change", required: true }],
  verification: [{ check: "review", required: true, successCondition: "passes" }],
  requiredCapabilities: [],
  riskClass: "low",
};

function workflowFixture() {
  const store = createStore();
  const session = store.createSession();
  const service = new WorkflowService(workflowPersistence(store), "secret");
  const workflow = service.teach(session.id, workflowSpec, "message:1");
  const approval = service.requestActivation(workflow.id, workflow.revision!.id, "system", "candidate ready");
  return { store, session, service, workflow, approval };
}

describe("canonical Governance approval projection", () => {
  it("locks every legacy action and status mapping", () => {
    expect([
      "resume_taskrun",
      "start_parallel_taskrun",
      "activate_workflow",
      "apply_revision",
      "start_canary",
      "execute_workflow",
    ].map(canonicalApprovalAction)).toEqual([
      "task_run.resume",
      "task_run.start_parallel",
      "workflow.activate",
      "workflow.revision.apply",
      "workflow.canary.start",
      "workflow.execute",
    ]);
    expect(canonicalApprovalStatus("legacy_run", "superseded")).toBe("superseded");
    expect(canonicalApprovalStatus("legacy_workflow", "executed")).toBe("consumed");
    expect(canonicalApprovalStatus("legacy_workflow", "approved", { maxUses: 1, usedCount: 1 })).toBe("consumed");
    expect(canonicalApprovalStatus("legacy_run", "revoked")).toBeUndefined();
    expect(canonicalApprovalActionForSource("legacy_run", "activate_workflow")).toBeUndefined();
    expect(canonicalApprovalActionForSource("legacy_workflow", "resume_taskrun")).toBeUndefined();
  });

  it("locks the v1 canonical JSON and SHA-256 digest fixture", () => {
    const input: CanonicalOperationInput = {
      subject: { kind: "task_run", id: "run-1" },
      action: "task_run.resume",
      target: { kind: "task_run", id: "run-1" },
      scope: { type: "session", id: "session-1" },
      payload: { nested: { z: 1, a: [true, null, "x"] }, decisionId: "decision-1" },
    };
    expect(canonicalOperationJson(input)).toBe(
      '{"action":"task_run.resume","payload":{"decisionId":"decision-1","nested":{"a":[true,null,"x"],"z":1}},"schema":"tagent.approval.operation/v1","scope":{"id":"session-1","type":"session"},"subject":{"id":"run-1","kind":"task_run"},"target":{"id":"run-1","kind":"task_run"}}',
    );
    expect(operationDigest(input)).toBe(
      "tagent.approval.operation.sha256.v1:2ddb222e390f5a09a2ae6afacd35522ff98d5ae6abc8adfd26e9de5a1b553f25",
    );
    expect(operationDigest({ ...input, actor: "alice", reason: "because", requestedAt: 1, expiresAt: 2 } as CanonicalOperationInput))
      .toBe(operationDigest(input));

    const workflowInput: CanonicalOperationInput = {
      subject: { kind: "workflow", id: "workflow-1" },
      action: "workflow.activate",
      target: { kind: "workflow_revision", id: "revision-1" },
      scope: { type: "legacy_workflow_scope", id: "scope-1" },
      payload: {
        workflowId: "workflow-1",
        revisionId: "revision-1",
        impactScope: { scopeId: "scope-1", futureRuns: true, behaviorChange: true },
        diff: {
          fromStatus: "candidate",
          fromRevisionId: null,
          toStatus: "active",
          toRevisionId: "revision-1",
        },
        rollback: { action: "restore_workflow_state", status: "candidate", revisionId: null },
      },
    };
    expect(operationDigest(workflowInput)).toBe(
      "tagent.approval.operation.sha256.v1:5d6944a1cb163150aa44f0a7dc6e006eb5aba367c44baf7facda49b3011b23ae",
    );
  });

  it("rejects non-canonical values instead of silently changing the digest", () => {
    expect(stableJson({ b: -0, a: 1 })).toBe('{"a":1,"b":0}');
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), new Map()]) {
      expect(() => stableJson(value)).toThrow();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableJson(cyclic)).toThrow("cyclic");
    expect(() => stableJson(Array(1))).toThrow("dense arrays");
    expect(() => stableJson({ [Symbol("hidden")]: "value" })).toThrow("symbol keys");
    const hidden = {};
    Object.defineProperty(hidden, "value", { value: 1, enumerable: false });
    expect(() => stableJson(hidden)).toThrow("enumerable data properties");
    const accessor = {};
    Object.defineProperty(accessor, "value", { get: () => 1, enumerable: true });
    expect(() => stableJson(accessor)).toThrow("enumerable data properties");
    const extended = [1] as number[] & { extra?: number };
    extended.extra = 2;
    expect(() => stableJson(extended)).toThrow("extra properties");
  });

  it("projects pending and rejected Run approvals with deterministic v30 defaults", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "approval projection");
    const decision = store.recordSupervisorDecision(supervisorDecision(run.id, "decision-run"));
    const legacy = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);

    const pending = shadow.get({ source: "legacy_run", id: legacy.id });
    expect(pending).toMatchObject({
      state: "resolved",
      approval: {
        ref: { source: "legacy_run", id: legacy.id },
        subject: { kind: "task_run", id: run.id },
        action: "task_run.resume",
        target: { kind: "task_run", id: run.id },
        scope: { type: "session", id: session.id },
        risk: "medium",
        reuse: { mode: "one_time", maxUses: 1, usedCount: 0 },
        status: "pending",
        expiresAt: null,
      },
    });
    expect(pending?.state === "resolved" && pending.approval.operationDigest).toMatch(
      /^tagent\.approval\.operation\.sha256\.v1:[a-f0-9]{64}$/,
    );

    store.resolveApprovalRequest(legacy.id, "rejected", "human", "not allowed");
    expect(shadow.get({ source: "legacy_run", id: legacy.id })).toMatchObject({
      state: "resolved",
      approval: { status: "rejected", decidedBy: "human", decisionReason: "not allowed" },
    });
  });

  it("keeps historical approved Run rows unresolved without a consumption receipt", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "approved projection");
    const decision = store.recordSupervisorDecision(supervisorDecision(run.id, "decision-approved"));
    const legacy = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    store.resolveApprovalRequest(legacy.id, "approved", "human", "approved");
    store.db.prepare("UPDATE approval_requests SET used_count=NULL WHERE id=?").run(legacy.id);
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);
    expect(shadow.get({ source: "legacy_run", id: legacy.id })).toEqual({
      state: "unresolved",
      ref: { source: "legacy_run", id: legacy.id },
      legacyStatus: "approved",
      active: true,
      reasonCodes: ["run_approved_without_receipt"],
    });
    expect(shadow.listUnresolvedPage({ source: "legacy_run", activeOnly: true })).toMatchObject({
      items: [{ ref: { source: "legacy_run", id: legacy.id } }],
      hasMore: false,
    });
    expect(shadow.summarizeComparisons([{
      ref: { source: "legacy_run", id: legacy.id },
      operationDigest: "tagent.approval.operation.sha256.v1:unavailable",
      status: "approved",
    }])).toMatchObject({ total: 1, match: 0, mismatch: 0, unresolved: 1, activeUnresolved: 1, missing: 0 });
  });

  it("fails closed when a legacy action belongs to the other approval source", () => {
    const store = createStore();
    const run = store.createRun(store.createSession().id, "cross-source action");
    const decision = store.recordSupervisorDecision(supervisorDecision(run.id, "decision-cross-source"));
    const legacy = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    store.db.prepare("UPDATE approval_requests SET action_type='activate_workflow' WHERE id=?").run(legacy.id);
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);
    expect(shadow.get({ source: "legacy_run", id: legacy.id })).toMatchObject({
      state: "unresolved",
      reasonCodes: ["unknown_action"],
    });

    const workflow = workflowFixture();
    workflow.store.db.pragma("ignore_check_constraints = ON");
    workflow.store.db.prepare("UPDATE autonomy_approval_requests SET action_type='resume_taskrun' WHERE id=?")
      .run(workflow.approval.id);
    expect(new SqliteCanonicalApprovalShadowRepository(workflow.store.db)
      .get({ source: "legacy_workflow", id: workflow.approval.id })).toMatchObject({
      state: "unresolved",
      reasonCodes: ["unknown_action"],
    });
  });

  it("maps workflow status, expiry, reuse, and semantic digest without using requestHash", () => {
    const { store, service, approval } = workflowFixture();
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);
    const pending = shadow.get({ source: "legacy_workflow", id: approval.id });
    expect(pending).toMatchObject({
      state: "resolved",
      approval: {
        action: "workflow.activate",
        scope: { type: LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE, id: approval.scopeId },
        status: "pending",
        risk: "low",
        reuse: { mode: "one_time", maxUses: 1, usedCount: 0 },
        expiresAt: approval.expiresAt,
      },
    });
    const digest = pending?.state === "resolved" ? pending.approval.operationDigest : "";
    expect(digest).not.toBe(approval.requestHash);
    store.db.prepare("UPDATE autonomy_approval_requests SET request_hash=? WHERE id=?").run("legacy-request-hash", approval.id);
    expect(shadow.get({ source: "legacy_workflow", id: approval.id })).toMatchObject({
      state: "resolved",
      approval: { operationDigest: digest },
    });

    service.decideApproval(approval.id, "approved", "human", "reviewed");
    governanceApplication(store).executeAutonomyApproval(approval.id, "human");
    expect(shadow.get({ source: "legacy_workflow", id: approval.id })).toMatchObject({
      state: "resolved",
      approval: { status: "consumed", reuse: { usedCount: 1 } },
    });
  });

  it("uses the canonical legacy workflow scope for resolved and unresolved queries", () => {
    const { store, approval } = workflowFixture();
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);
    const scope = { type: LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE, id: approval.scopeId };

    expect(shadow.list({ source: "legacy_workflow", scope })).toHaveLength(1);
    store.db.prepare("UPDATE autonomy_approval_requests SET impact_scope_json='[]' WHERE id=?").run(approval.id);
    expect(shadow.listUnresolvedPage({ source: "legacy_workflow", scope, pageSize: 10 })).toMatchObject({
      items: [{ ref: { source: "legacy_workflow", id: approval.id }, reasonCodes: ["invalid_json"] }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("pages unresolved projections without allowing the all-table switch summary to truncate", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "unresolved gate pagination");
    const decision = store.recordSupervisorDecision(supervisorDecision(run.id, "decision-unresolved-page"));
    const insert = store.db.prepare(`INSERT INTO approval_requests
      (id,run_id,decision_id,action_type,target_type,target_id,reason,metadata_json,status,requested_at,resolved_by,resolution)
      VALUES (?,?,?,?,?,?,?,'{}','approved',?,?,'approved')`);
    store.db.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        insert.run(
          `bulk-${String(index).padStart(4, "0")}`,
          run.id,
          decision.id,
          "resume_taskrun",
          "taskrun",
          run.id,
          "bulk fixture",
          index,
          "human",
        );
      }
    })();
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);

    const first = shadow.listUnresolvedPage({ source: "legacy_run", activeOnly: true, pageSize: 1_000 });
    expect(first.items).toHaveLength(1_000);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ source: "legacy_run", id: "bulk-0999" });
    expect(shadow.listUnresolvedPage({
      source: "legacy_run",
      activeOnly: true,
      pageSize: 1_000,
      cursor: first.nextCursor!,
    })).toMatchObject({
      items: [{ ref: { source: "legacy_run", id: "bulk-1000" } }],
      nextCursor: null,
      hasMore: false,
    });
    expect(shadow.summarizeAllUnresolved()).toMatchObject({
      total: 1_001,
      active: 1_001,
      bySource: { legacy_run: 1_001, legacy_workflow: 0 },
      activeBySource: { legacy_run: 1_001, legacy_workflow: 0 },
    });
  });

  it("projects overdue pending and approved workflow rows as expired without mutating legacy authority", () => {
    const { store, approval } = workflowFixture();
    const readAt = approval.expiresAt + 1;
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db, { readTimestamp: () => readAt });
    expect(shadow.get({ source: "legacy_workflow", id: approval.id })).toMatchObject({
      state: "resolved",
      approval: { status: "expired" },
    });
    expect(store.db.prepare("SELECT status FROM autonomy_approval_requests WHERE id=?").get(approval.id))
      .toEqual({ status: "pending" });
    store.db.prepare("UPDATE autonomy_approval_requests SET status='approved' WHERE id=?").run(approval.id);
    expect(shadow.get({ source: "legacy_workflow", id: approval.id })).toMatchObject({
      state: "resolved",
      approval: { status: "expired" },
    });
  });

  it("reports digest/status mismatch and malformed workflow rows without writes", () => {
    const { store, approval } = workflowFixture();
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);
    const projection = shadow.get({ source: "legacy_workflow", id: approval.id });
    expect(projection?.state).toBe("resolved");
    if (!projection || projection.state !== "resolved") throw new Error("fixture projection must resolve");
    expect(shadow.compare({
      ref: projection.approval.ref,
      operationDigest: projection.approval.operationDigest,
      status: projection.approval.status,
    })).toMatchObject({ state: "match" });
    expect(shadow.compare({
      ref: projection.approval.ref,
      operationDigest: "tagent.approval.operation.sha256.v1:bad",
      status: "rejected",
    })).toMatchObject({ state: "mismatch", mismatches: ["operation_digest", "status"] });
    expect(shadow.summarizeComparisons([{
      ref: projection.approval.ref,
      operationDigest: "tagent.approval.operation.sha256.v1:bad",
      status: "rejected",
    }])).toMatchObject({ total: 1, match: 0, mismatch: 1, unresolved: 0, activeUnresolved: 0, missing: 0 });

    store.db.prepare("UPDATE autonomy_approval_requests SET impact_scope_json='[]' WHERE id=?").run(approval.id);
    expect(shadow.get(projection.approval.ref)).toMatchObject({ state: "unresolved", reasonCodes: ["invalid_json"] });
  });

  it("routes identical legacy IDs by source and makes unqualified collisions explicit", () => {
    const { store, approval: workflowApproval } = workflowFixture();
    const run = store.createRun(store.createSession().id, "ID conflict");
    const decision = store.recordSupervisorDecision(supervisorDecision(run.id, "decision-conflict"));
    const runApproval = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    store.db.prepare("UPDATE approval_requests SET id=? WHERE id=?").run(workflowApproval.id, runApproval.id);
    const shadow = new SqliteCanonicalApprovalShadowRepository(store.db);

    expect(shadow.resolveLegacyId(workflowApproval.id)).toEqual({
      state: "conflict",
      id: workflowApproval.id,
      refs: [
        { source: "legacy_run", id: workflowApproval.id },
        { source: "legacy_workflow", id: workflowApproval.id },
      ],
    });
    expect(shadow.get({ source: "legacy_run", id: workflowApproval.id })?.state).toBe("resolved");
    expect(shadow.get({ source: "legacy_workflow", id: workflowApproval.id })?.state).toBe("resolved");
  });

  it("expands schema v31 while leaving legacy approval APIs authoritative", () => {
    const store = createStore();
    expect(store.getSchemaVersion()).toBe(39);
    expect(store.db.prepare("PRAGMA table_info(approval_requests)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "operation_digest" })]));
    expect(store.db.prepare("PRAGMA table_info(autonomy_approval_requests)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "operation_digest" })]));
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_receipts'").get())
      .toEqual({ name: "approval_receipts" });
  });
});
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
