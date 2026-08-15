import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreWorkflowGovernanceApplication } from "@tagent/core-service/application";
import { CanaryGovernanceRuntime } from "@tagent/core-service/composition";
import {
  WORKFLOW_APPROVAL_SCOPE_TYPE,
  CanaryGovernanceWorker,
  WorkflowGovernanceService,
  canaryOutcomeDigest,
  operationDigest,
  type WorkflowGovernanceReceipt,
  type WorkflowRevisionMaterializerPort,
} from "@tagent/governance";
import { WorkflowLearningService, type LearningFeatureControl } from "@tagent/learning";
import { SqlitePersistence, Store } from "@tagent/persistence-sqlite";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const unusedMaterializer: WorkflowRevisionMaterializerPort = {
  materialize: () => { throw new Error("materializer is not used by this fixture"); },
};

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const timestamp = 100;
  store.db.prepare(`INSERT INTO workflow_definitions
    (id,scope_id,status,active_revision_id,created_at,updated_at)
    VALUES ('workflow-1','scope-1','candidate',NULL,?,?)`).run(timestamp, timestamp);
  store.db.prepare(`INSERT INTO workflow_revisions
    (id,workflow_id,revision,spec_json,spec_hash,source_type,source_evidence_json,confidence,change_summary,created_at)
    VALUES ('revision-1','workflow-1',1,'{}','spec-1','explicit_user','[]',1,'fixture',?)`).run(timestamp);

  const digest = operationDigest({
    subject: { kind: "workflow", id: "workflow-1" },
    action: "workflow.activate",
    target: { kind: "workflow_revision", id: "revision-1" },
    scope: { type: WORKFLOW_APPROVAL_SCOPE_TYPE, id: "scope-1" },
    payload: {
      workflowId: "workflow-1",
      revisionId: "revision-1",
      impactScope: { scopeId: "scope-1" },
      diff: { toStatus: "active" },
      rollback: { action: "suspend" },
    },
  });
  store.db.prepare(`INSERT INTO autonomy_approval_requests
    (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,status,risk_class,
     impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,request_reason,expires_at,
     request_hash,created_at,updated_at,operation_digest,reuse_mode,max_uses,used_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "approval-1", "scope-1", "activate_workflow", "workflow_revision", "revision-1",
    "workflow-1", "revision-1", "approved", "low", JSON.stringify({ scopeId: "scope-1" }),
    "[]", JSON.stringify({ toStatus: "active" }), JSON.stringify({ action: "suspend" }),
    "requester", "fixture", 10_000, "request-hash-1", timestamp, timestamp,
    digest, "one_time", 1, 0,
  );
  const adapter = new SqlitePersistence(store, {
    run<T>(work: () => T): T { return store.db.transaction(work)(); },
  });
  const service = new WorkflowGovernanceService(adapter.workflowGovernance, unusedMaterializer);
  const command = {
    commandId: "command-activate-1",
    workflowId: "workflow-1",
    scopeId: "scope-1",
    revisionId: "revision-1",
    approval: {
      ref: { source: "workflow" as const, id: "approval-1" },
      action: "workflow.activate" as const,
      operationDigest: digest,
      risk: "low" as const,
    },
    actorId: "governor",
    reason: "activate fixture",
    timestamp: 200,
  };
  return { store, adapter, service, command };
}

function seedCanary(store: Store, samplesPerVariant = 5): void {
  store.db.prepare(`INSERT INTO workflow_revisions
    (id,workflow_id,revision,spec_json,spec_hash,source_type,source_evidence_json,confidence,change_summary,created_at)
    VALUES ('revision-2','workflow-1',2,'{}','spec-2','user_correction','[]',1,'candidate',110)`).run();
  store.db.prepare(`UPDATE workflow_definitions
    SET status='active',active_revision_id='revision-1',updated_at=110 WHERE id='workflow-1'`).run();
  store.db.prepare(`INSERT INTO workflow_promotions
    (id,workflow_id,revision_id,previous_revision_id,status,canary_percent,max_failure_delta,reason,created_at,updated_at)
    VALUES ('promotion-1','workflow-1','revision-2','revision-1','canary',10,0.02,'fixture',120,120)`).run();
  const session = store.createSession();
  for (let index = 0; index < samplesPerVariant * 2; index += 1) {
    const run = store.createRun(session.id, `canary-${index}`);
    store.db.prepare(`INSERT INTO run_checks
      (run_id,check_key,title,status,required,command,evidence,stale)
      VALUES (?,?,'required','passed',1,'','ok',0)`).run(run.id, `required-${index}`);
    const variant = index < samplesPerVariant ? "baseline" : "candidate";
    const revisionId = variant === "baseline" ? "revision-1" : "revision-2";
    store.db.prepare(`INSERT INTO workflow_canary_bindings
      (id,promotion_id,workflow_id,run_id,attempt,scope_id,assignment_key,assignment_hash,bucket,
       variant,revision_id,receipt_hash,outcome_status,success,required_checks,passed_checks,
       outcome_recorded_at,created_at)
      VALUES (?,?,?,?,1,'scope-1',?,?,?, ?,?,?, 'completed',1,1,1,?,?)`).run(
      `canary-binding-${index}`, "promotion-1", "workflow-1", run.id,
      `assignment-${index}`, `assignment-hash-${index}`, index, variant, revisionId,
      `canary-receipt-${index}`, 200 + index, 130 + index,
    );
  }
}

function directCanarySettlement(adapter: SqlitePersistence, evaluatedAtDelta = 0) {
  const evidence = adapter.workflowGovernance.reader.getCanaryDecisionEvidence("promotion-1");
  if (!evidence) throw new Error("Canary fixture evidence is missing");
  const outcomes = [...evidence.outcomes].sort((left, right) => left.variant.localeCompare(right.variant)
    || left.runId.localeCompare(right.runId));
  const checkResults = [...evidence.checks].sort((left, right) => left.runId.localeCompare(right.runId)
    || left.checkKey.localeCompare(right.checkKey));
  const baseline = outcomes.filter((outcome) => outcome.variant === "baseline");
  const candidate = outcomes.filter((outcome) => outcome.variant === "candidate");
  const rate = (rows: typeof outcomes) => rows.filter((outcome) => outcome.success).length / rows.length;
  const baselineSuccessRate = rate(baseline);
  const candidateSuccessRate = rate(candidate);
  const outcome = candidateSuccessRate >= baselineSuccessRate - evidence.promotion.authorizedMaxFailureDelta
    ? "promoted" as const
    : "rolled_back" as const;
  const evaluatedAt = Math.max(
    evidence.promotion.createdAt,
    ...outcomes.map((item) => item.recordedAt),
  ) + evaluatedAtDelta;
  return {
    commandId: `direct-settle:${evaluatedAtDelta}`,
    workflowId: evidence.promotion.workflowId,
    scopeId: evidence.promotion.scopeId,
    promotionId: evidence.promotion.promotionId,
    outcome,
    activeRevisionId: outcome === "promoted"
      ? evidence.promotion.candidateRevisionId
      : evidence.promotion.previousRevisionId,
    evaluationReceipt: {
      id: `direct-evaluation:${evaluatedAtDelta}`,
      promotionId: evidence.promotion.promotionId,
      outcomeDigest: canaryOutcomeDigest(evidence),
      outcome,
      baselineSampleSize: baseline.length,
      candidateSampleSize: candidate.length,
      baselineSuccessRate,
      candidateSuccessRate,
      authorizedMaxFailureDelta: evidence.promotion.authorizedMaxFailureDelta,
      evaluationRunIds: outcomes.map((item) => item.runId),
      outcomes,
      checkResults,
      evaluatedAt,
    },
    actorId: "direct-caller",
    reason: "direct settlement probe",
    timestamp: evaluatedAt,
  };
}

describe("SQLite Workflow Governance atomicity", () => {
  it("rolls back an approved effect when the mutation fails before receipts", () => {
    const { store, service, command } = fixture();
    store.db.exec(`CREATE TEMP TRIGGER reject_workflow_activation
      BEFORE UPDATE ON workflow_definitions
      WHEN NEW.status='active'
      BEGIN SELECT RAISE(ABORT,'activation mutation rejected'); END`);

    expect(() => service.activateWorkflow(command)).toThrow(/activation mutation rejected/);
    expect(store.db.prepare("SELECT status,active_revision_id activeRevisionId FROM workflow_definitions WHERE id='workflow-1'").get())
      .toEqual({ status: "candidate", activeRevisionId: null });
    expect(store.db.prepare("SELECT status,used_count usedCount FROM autonomy_approval_requests WHERE id='approval-1'").get())
      .toEqual({ status: "approved", usedCount: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 0 });
  });

  it("returns the committed result for an exact replay without duplicating effects", () => {
    const { store, service, command } = fixture();
    const first = service.activateWorkflow(command);
    const replay = service.activateWorkflow(command);

    expect(replay).toEqual(first);
    expect(store.db.prepare("SELECT status,used_count usedCount FROM autonomy_approval_requests WHERE id='approval-1'").get())
      .toEqual({ status: "executed", usedCount: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 1 });
  });

  it.each([
    ["approval status", "UPDATE autonomy_approval_requests SET status='rejected' WHERE id='approval-1'"],
    ["approved action", "UPDATE autonomy_approval_requests SET action_type='start_canary' WHERE id='approval-1'"],
    ["target identity", "UPDATE autonomy_approval_requests SET target_id='revision-x' WHERE id='approval-1'"],
    ["workflow subject", "UPDATE autonomy_approval_requests SET workflow_id=NULL WHERE id='approval-1'"],
    ["scope", "UPDATE autonomy_approval_requests SET scope_id='scope-x' WHERE id='approval-1'"],
    ["operation digest", "UPDATE autonomy_approval_requests SET operation_digest='forged' WHERE id='approval-1'"],
    ["risk", "UPDATE autonomy_approval_requests SET risk_class='medium' WHERE id='approval-1'"],
    ["reuse policy", "UPDATE autonomy_approval_requests SET reuse_mode='reusable' WHERE id='approval-1'"],
    ["expiry", "UPDATE autonomy_approval_requests SET expires_at=200 WHERE id='approval-1'"],
    ["prior use", "UPDATE autonomy_approval_requests SET used_count=1 WHERE id='approval-1'"],
  ])("rejects %s conflicts with zero writes", (_risk, mutation) => {
    const { store, service, command } = fixture();
    store.db.prepare(mutation).run();

    expect(() => service.activateWorkflow(command)).toThrow();
    expect(store.db.prepare("SELECT status,active_revision_id activeRevisionId FROM workflow_definitions WHERE id='workflow-1'").get())
      .toEqual({ status: "candidate", activeRevisionId: null });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 0 });
  });

  it("rejects a same-id non-exact replay without changing the committed effect", () => {
    const { store, service, command } = fixture();
    const committed = service.activateWorkflow(command);

    expect(() => service.activateWorkflow({ ...command, actorId: "different-governor" }))
      .toThrow(/conflicts with a committed effect/);
    expect(service.getState("workflow-1")).toEqual(committed.state);
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 1 });
  });

  it("rejects tampered command receipts before any approved effect write", () => {
    const { store, adapter, command } = fixture();
    const approvedCommand = { ...command, action: "workflow.activate" as const };
    const receipt = <TKind extends "approval" | "governance" | "audit">(
      kind: TKind,
    ): WorkflowGovernanceReceipt & { kind: TKind } => ({
      id: `workflow-governance:${command.commandId}:${kind}`,
      kind,
      commandId: command.commandId,
      action: "workflow.activate" as const,
      workflowId: command.workflowId,
      actorId: command.actorId,
      status: "committed" as const,
      detail: {
        scopeId: command.scopeId,
        reason: command.reason,
        approvalSource: "workflow",
        approvalId: command.approval.ref.id,
        operationDigest: command.approval.operationDigest,
        risk: command.approval.risk,
        revisionId: command.revisionId,
      },
      committedAt: command.timestamp,
    });
    expect(() => adapter.workflowGovernance.mutations.commitApprovedEffect({
      command: approvedCommand,
      materializedRevision: null,
      receipts: {
        kind: "approved",
        approval: receipt("approval"),
        governance: receipt("governance"),
        audit: { ...receipt("audit"), actorId: "tampered-actor" },
      },
    })).toThrow(/audit receipt conflicts/);
    expect(store.db.prepare("SELECT status,active_revision_id activeRevisionId FROM workflow_definitions WHERE id='workflow-1'").get())
      .toEqual({ status: "candidate", activeRevisionId: null });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 0 });
  });

  it("restores a forgotten workflow only as suspended", () => {
    const { store, service } = fixture();
    store.db.prepare("UPDATE workflow_definitions SET status='active',active_revision_id='revision-1'").run();
    service.forgetWorkflow({
      commandId: "command-forget", workflowId: "workflow-1", scopeId: "scope-1",
      actorId: "governor", reason: "forget", timestamp: 300, gracePeriodMs: 1_000,
    });
    const restored = service.restoreWorkflow({
      commandId: "command-restore", workflowId: "workflow-1", scopeId: "scope-1",
      actorId: "governor", reason: "restore", timestamp: 400,
    });

    expect(restored.state).toMatchObject({ status: "suspended", activeRevisionId: null });
    expect(store.db.prepare(`SELECT status,active_revision_id activeRevisionId,deleted_at deletedAt
      FROM workflow_definitions WHERE id='workflow-1'`).get())
      .toEqual({ status: "suspended", activeRevisionId: null, deletedAt: null });
  });

  it("settles Canary from re-read durable outcomes and stores the complete evaluation receipt", () => {
    const { store, adapter, service } = fixture();
    seedCanary(store);
    store.db.prepare(`INSERT INTO workflow_canary_bindings
      (id,promotion_id,workflow_id,run_id,attempt,scope_id,assignment_key,assignment_hash,bucket,
       variant,revision_id,receipt_hash,outcome_status,success,required_checks,passed_checks,
       outcome_recorded_at,created_at)
      SELECT 'canary-binding-retry',promotion_id,workflow_id,run_id,2,scope_id,assignment_key,
       assignment_hash,bucket,variant,revision_id,'canary-receipt-retry',outcome_status,success,
       required_checks,passed_checks,outcome_recorded_at+50,created_at+50
      FROM workflow_canary_bindings WHERE id='canary-binding-0'`).run();

    const settled = new CanaryGovernanceWorker(adapter.workflowGovernance, service).runOnce(300);
    expect(settled).toMatchObject({ kind: "settled", promotionId: "promotion-1", outcome: "promoted" });
    expect(store.db.prepare(`SELECT status,active_revision_id activeRevisionId
      FROM workflow_definitions WHERE id='workflow-1'`).get())
      .toEqual({ status: "active", activeRevisionId: "revision-2" });
    const evaluation = store.db.prepare(`SELECT evaluation_run_ids_json evaluationRunIdsJson,
      check_results_json checkResultsJson,evidence_json evidenceJson FROM workflow_evaluations
      WHERE id=?`).get(settled.kind === "settled" ? settled.evaluationReceiptId : "") as {
      evaluationRunIdsJson: string; checkResultsJson: string; evidenceJson: string;
    };
    expect(JSON.parse(evaluation.evaluationRunIdsJson)).toHaveLength(10);
    expect(JSON.parse(evaluation.checkResultsJson)).toHaveLength(10);
    expect(JSON.parse(evaluation.evidenceJson)).toMatchObject({ promotionId: "promotion-1", outcome: "promoted" });
    expect(new WorkflowLearningService(adapter.workflow).verifyEvaluationReceipt(
      settled.kind === "settled" ? settled.evaluationReceiptId : "",
    )).toBe(true);
  });

  it("selects decision-ready promotions past an insufficient head page", () => {
    const { store, adapter } = fixture();
    seedCanary(store);
    const insert = store.db.prepare(`INSERT INTO workflow_promotions
      (id,workflow_id,revision_id,previous_revision_id,status,canary_percent,max_failure_delta,
       reason,created_at,updated_at)
      VALUES (?,'workflow-1','revision-2','revision-1','canary',10,0.02,'insufficient',?,?)`);
    for (let index = 0; index < 32; index += 1) {
      insert.run(`promotion-insufficient-${index}`, index, index);
    }

    expect(adapter.workflowGovernance.reader.listCanaryDecisionCandidates(32).map((item) => item.promotionId))
      .toEqual(["promotion-1"]);
  });

  it.each(["suspend", "forget"] as const)("cancels Canary before workflow %s can be settled", (action) => {
    const { store, adapter, service } = fixture();
    seedCanary(store);
    if (action === "suspend") {
      service.suspendWorkflow({
        commandId: "command-suspend-canary", workflowId: "workflow-1", scopeId: "scope-1",
        actorId: "governor", reason: "operator suspension", timestamp: 300,
      });
    } else {
      service.forgetWorkflow({
        commandId: "command-forget-canary", workflowId: "workflow-1", scopeId: "scope-1",
        actorId: "governor", reason: "operator forget", timestamp: 300, gracePeriodMs: 1_000,
      });
    }

    expect(store.db.prepare("SELECT status FROM workflow_promotions WHERE id='promotion-1'").get())
      .toEqual({ status: "rejected" });
    expect(new CanaryGovernanceWorker(adapter.workflowGovernance, service).runOnce(400))
      .toMatchObject({ kind: "idle", reason: "no_candidate" });
    expect(store.db.prepare("SELECT status,active_revision_id activeRevisionId FROM workflow_definitions WHERE id='workflow-1'").get())
      .toEqual({ status: action === "suspend" ? "suspended" : "deprecated", activeRevisionId: null });
  });

  it("rejects Canary settlement after the active baseline changes", () => {
    const { store, adapter, service } = fixture();
    seedCanary(store);
    const settlement = directCanarySettlement(adapter);
    store.db.prepare(`UPDATE workflow_definitions SET status='suspended',active_revision_id=NULL
      WHERE id='workflow-1'`).run();

    expect(() => service.settleCanary(settlement)).toThrow(/settlement evidence conflicts/);
    expect(store.db.prepare("SELECT status FROM workflow_promotions WHERE id='promotion-1'").get())
      .toEqual({ status: "canary" });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_evaluations").get()).toEqual({ count: 0 });
  });

  it.each([
    ["insufficient samples", 4, false, 0],
    ["inconsistent durable outcome", 5, true, 0],
    ["unbound evaluatedAt", 5, false, 1],
  ])("rejects direct Canary settlement with %s", (_case, samples, corruptOutcome, evaluatedAtDelta) => {
    const { store, adapter, service } = fixture();
    seedCanary(store, samples);
    if (corruptOutcome) {
      store.db.prepare(`UPDATE workflow_canary_bindings SET success=0
        WHERE id='canary-binding-0'`).run();
    }

    expect(() => service.settleCanary(directCanarySettlement(adapter, evaluatedAtDelta)))
      .toThrow(/settlement evidence conflicts/);
    expect(store.db.prepare("SELECT status FROM workflow_promotions WHERE id='promotion-1'").get())
      .toEqual({ status: "canary" });
    expect(store.db.prepare("SELECT active_revision_id activeRevisionId FROM workflow_definitions WHERE id='workflow-1'").get())
      .toEqual({ activeRevisionId: "revision-1" });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_evaluations").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 0 });
  });

  it("fails closed on Learning lifecycle and non-boolean feature-policy bypasses", async () => {
    const { store, adapter, service } = fixture();
    const workflows = new WorkflowLearningService(adapter.workflow);
    const workflowSpec = {
      name: "candidate only", intent: "candidate only", cueTerms: ["candidate"],
      applicability: ["candidate only"], nonApplicability: [], preconditions: [],
      inputContract: [], outputContract: [],
      steps: [{ stepId: "one", instruction: "Do one step", required: true }],
      verification: [{ check: "done", required: true, successCondition: "done" }],
      requiredCapabilities: [], riskClass: "low" as const,
    };
    const before = store.db.prepare("SELECT COUNT(*) count FROM workflow_definitions").get();
    expect(() => workflows.createWorkflow(
      "scope-1", workflowSpec, "explicit_user", ["message:1"], "active" as never,
    )).toThrow(/only create candidate workflows/);
    expect(() => adapter.workflow.workflow.createWorkflow({
      id: "workflow-bypass", scopeId: "scope-1", status: "active",
      activeRevisionId: "revision-bypass", createdAt: 400, updatedAt: 400,
    } as never, {
      id: "revision-bypass", workflowId: "workflow-bypass", specJson: "{}",
      specHash: "spec-bypass", sourceType: "explicit_user", sourceEvidenceJson: "[]",
      confidence: 1, changeSummary: "bypass", createdAt: 400,
    })).toThrow(/only create candidate workflows/);
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_definitions").get()).toEqual(before);

    expect(() => service.updateFeaturePolicy({
      commandId: "invalid-policy", target: { kind: "global" }, actorId: "governor",
      reason: "invalid", timestamp: 400,
      policy: { memoryEnabled: true, learningEnabled: 1, autoExecutionEnabled: false },
    } as never)).toThrow(/must be boolean/);

    const featureState = {
      memoryAvailable: true, memoryEnabled: true, learningEnabled: false,
      autoExecutionEnabled: false, passiveLearningEnabled: false,
      activeExecutionRequiresApproval: true as const, updatedAt: 10, reason: "before",
    };
    const application = new CoreWorkflowGovernanceApplication(
      service,
      adapter.workflowGovernance.reader,
      { snapshot: () => featureState, refresh: async () => featureState } as unknown as LearningFeatureControl,
    );
    await expect(application.updateLearningSettings({ learningEnabled: 1 as never }))
      .rejects.toThrow(/must be boolean/);
  });

  it("contains detached Canary runtime failures while explicit ticks still reject", async () => {
    const onError = vi.fn();
    const background = new CanaryGovernanceRuntime(
      { runOnce: () => { throw new Error("database unavailable"); } } as never,
      { intervalMs: 60_000, onError },
    );
    background.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "database unavailable",
    })));
    await background.stop();

    const explicit = new CanaryGovernanceRuntime(
      { runOnce: () => { throw new Error("explicit failure"); } } as never,
      { intervalMs: 60_000 },
    );
    await expect(explicit.runOnce()).rejects.toThrow("explicit failure");
  });

  it("rolls back feature policy state when its audit receipt fails", () => {
    const { store, service } = fixture();
    store.db.prepare(`INSERT INTO learning_feature_settings
      (id,memory_enabled,learning_enabled,auto_execution_enabled,updated_at,reason)
      VALUES (1,1,0,0,100,'before')`).run();
    store.db.exec(`CREATE TEMP TRIGGER reject_feature_policy_audit
      BEFORE INSERT ON autonomy_audit_events
      WHEN NEW.action='learning.feature_policy.update'
      BEGIN SELECT RAISE(ABORT,'feature policy audit rejected'); END`);

    expect(() => service.updateFeaturePolicy({
      commandId: "command-policy", target: { kind: "global" },
      actorId: "governor", reason: "enable", timestamp: 500,
      policy: { memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: true },
    })).toThrow(/feature policy audit rejected/);
    expect(store.db.prepare(`SELECT memory_enabled memoryEnabled,learning_enabled learningEnabled,
      auto_execution_enabled automaticExecutionEnabled,updated_at updatedAt,reason
      FROM learning_feature_settings WHERE id=1`).get()).toEqual({
      memoryEnabled: 1, learningEnabled: 0, automaticExecutionEnabled: 0, updatedAt: 100, reason: "before",
    });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get()).toEqual({ count: 0 });
  });
});
