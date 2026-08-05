import { afterEach, describe, expect, it } from "vitest";
import { CoreWorkflowGovernanceApplication } from "@tagent/core-service/application";
import {
  LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE,
  WorkflowGovernanceApplication,
  WorkflowGovernanceService,
  createWorkflowRevisionDraft,
  operationDigest,
  type ApprovedWorkflowGovernanceCommit,
  type OwnedWorkflowGovernanceCommit,
  type WorkflowGovernanceEffectResult,
  type WorkflowGovernancePersistencePort,
  type WorkflowGovernanceReceipt,
  type WorkflowGovernanceState,
  type WorkflowRevisionMaterializerPort,
} from "@tagent/governance";
import { LegacyStoreAdapter, Store } from "@tagent/persistence-sqlite";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const unusedMaterializer: WorkflowRevisionMaterializerPort = {
  materialize() { throw new Error("not used"); },
};

function sqliteService(materializer: WorkflowRevisionMaterializerPort) {
  const store = new Store(":memory:");
  stores.push(store);
  const adapter = new LegacyStoreAdapter(store, {
    run<T>(work: () => T): T { return store.db.transaction(work)(); },
  });
  return {
    store,
    adapter,
    service: new WorkflowGovernanceApplication(adapter.workflowGovernance, materializer),
  };
}

function proposalReplayFixture() {
  const timestamp = 100;
  const impactScope = { scopeId: "scope-1", registryChange: true };
  const diff = { baseSpecHash: "spec-base", proposedSpecHash: "spec-result" };
  const rollback = { action: "retain_base_revision", revisionId: "revision-1" };
  const digest = operationDigest({
    subject: { kind: "workflow", id: "workflow-1" },
    action: "workflow.revision.apply",
    target: { kind: "workflow_proposal", id: "proposal-1" },
    scope: { type: LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE, id: "scope-1" },
    payload: {
      workflowId: "workflow-1",
      revisionId: "revision-1",
      proposalId: "proposal-1",
      impactScope,
      diff,
      rollback,
    },
  });
  const materializer: WorkflowRevisionMaterializerPort = {
    materialize(input) {
      const resultSpecHash = "spec-result";
      return {
        revisionId: input.revisionId,
        workflowId: input.proposal.workflowId,
        proposalId: input.proposal.proposalId,
        baseRevisionId: input.baseRevision.revisionId,
        baseSpecHash: input.baseRevision.specHash,
        proposalPatchHash: input.proposal.patchHash,
        resultSpecHash,
        draft: createWorkflowRevisionDraft({
          workflowId: input.proposal.workflowId,
          proposalId: input.proposal.proposalId,
          baseRevisionId: input.baseRevision.revisionId,
          baseSpecHash: input.baseRevision.specHash,
          proposalPatchHash: input.proposal.patchHash,
          resultSpecHash,
          value: {
            specJson: JSON.stringify({ name: "updated" }),
            specHash: resultSpecHash,
            sourceType: "explicit_user",
            sourceEvidenceJson: "[]",
            confidence: 1,
            changeSummary: "approved update",
            createdAt: 200,
          },
        }),
      };
    },
  };
  const { store, adapter, service } = sqliteService(materializer);
  store.db.prepare(`INSERT INTO workflow_definitions
    (id,scope_id,status,active_revision_id,created_at,updated_at)
    VALUES ('workflow-1','scope-1','candidate',NULL,?,?)`).run(timestamp, timestamp);
  store.db.prepare(`INSERT INTO workflow_revisions
    (id,workflow_id,revision,spec_json,spec_hash,source_type,source_evidence_json,confidence,change_summary,created_at)
    VALUES ('revision-1','workflow-1',1,'{}','spec-base','explicit_user','[]',1,'base',?)`).run(timestamp);
  store.db.prepare(`INSERT INTO workflow_revision_proposals
    (id,workflow_id,base_revision_id,reason,evidence_json,patch_json,base_spec_hash,
     proposed_spec_hash,changed_paths_json,status,decided_by,decided_at,created_at)
    VALUES ('proposal-1','workflow-1','revision-1','approved update','[]','{"name":"updated"}',
      'spec-base','spec-result','["name"]','approved','reviewer',?,?)`).run(
    timestamp, timestamp,
  );
  store.db.prepare(`INSERT INTO autonomy_approval_requests
    (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,proposal_id,status,risk_class,
     impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,request_reason,expires_at,
     request_hash,created_at,updated_at,operation_digest,reuse_mode,max_uses,used_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "approval-apply", "scope-1", "apply_revision", "workflow_proposal", "proposal-1",
    "workflow-1", "revision-1", "proposal-1", "approved", "medium", JSON.stringify(impactScope),
    "[]", JSON.stringify(diff), JSON.stringify(rollback), "requester", "apply", Number.MAX_SAFE_INTEGER,
    "request-hash-apply", timestamp, timestamp, digest, "one_time", 1, 0,
  );
  const command = {
    commandId: "command-apply",
    workflowId: "workflow-1",
    scopeId: "scope-1",
    proposalId: "proposal-1",
    revisionId: "revision-2",
    approval: {
      ref: { source: "legacy_workflow" as const, id: "approval-apply" },
      action: "workflow.revision.apply" as const,
      operationDigest: digest,
      risk: "medium" as const,
    },
    actorId: "governor",
    reason: "approved revision",
    timestamp: 200,
  };
  return { store, adapter, service, command };
}

describe("Workflow Governance command application", () => {
  it("atomically consumes approval, mutates state, and records all receipts while rejection is zero-write", () => {
    const states = new Map<string, WorkflowGovernanceState>();
    const approvals = new Map([
      ["approved", { status: "approved", action: "workflow.revision.apply", digest: "digest-approved" }],
      ["rejected", { status: "rejected", action: "workflow.activate", digest: "digest-rejected" }],
    ]);
    const receipts = new Map<string, WorkflowGovernanceReceipt>();
    let materialized = 0;
    const materializer: WorkflowRevisionMaterializerPort = {
      materialize(input) {
        materialized += 1;
        return {
          revisionId: input.revisionId,
          workflowId: input.proposal.workflowId,
          proposalId: input.proposal.proposalId,
          baseRevisionId: input.baseRevision.revisionId,
          baseSpecHash: input.baseRevision.specHash,
          proposalPatchHash: input.proposal.patchHash,
          resultSpecHash: "spec-result",
          draft: createWorkflowRevisionDraft({
            workflowId: input.proposal.workflowId,
            proposalId: input.proposal.proposalId,
            baseRevisionId: input.baseRevision.revisionId,
            baseSpecHash: input.baseRevision.specHash,
            proposalPatchHash: input.proposal.patchHash,
            resultSpecHash: "spec-result",
            value: { name: "opaque workflow draft" },
          }),
        };
      },
    };
    const persistence: WorkflowGovernancePersistencePort = {
      unitOfWork: {
        run(work) {
          const beforeStates = structuredClone([...states]);
          const beforeApprovals = structuredClone([...approvals]);
          const beforeReceipts = structuredClone([...receipts]);
          try {
            return work();
          } catch (error) {
            states.clear(); beforeStates.forEach(([key, value]) => states.set(key, value));
            approvals.clear(); beforeApprovals.forEach(([key, value]) => approvals.set(key, value));
            receipts.clear(); beforeReceipts.forEach(([key, value]) => receipts.set(key, value));
            throw error;
          }
        },
      },
      reader: {
        getState: (workflowId) => states.get(workflowId),
        getReceipt: (receiptId) => receipts.get(receiptId),
        getExecutableApproval: () => undefined,
        getApprovedProposal: (proposalId) => proposalId === "proposal-1" ? {
          proposalId,
          workflowId: "workflow-1",
          baseRevisionId: "revision-1",
          baseSpecHash: "spec-base",
          patchHash: "patch-approved",
          patchJson: JSON.stringify({ name: "updated" }),
          evidenceJson: "[]",
          reason: "approved update",
          status: "approved",
        } : undefined,
        getRevision: (revisionId) => revisionId === "revision-1" ? {
          revisionId,
          workflowId: "workflow-1",
          revision: 1,
          specHash: "spec-base",
          specJson: JSON.stringify({ name: "base" }),
          sourceType: "explicit_user",
          sourceEvidenceJson: "[]",
          confidence: 0.9,
        } : undefined,
        listCanaryDecisionCandidates: () => [],
        getCanaryDecisionEvidence: () => undefined,
      },
      mutations: {
        commitApprovedEffect(input: ApprovedWorkflowGovernanceCommit): WorkflowGovernanceEffectResult {
          const current = approvals.get(input.command.approval.ref.id);
          if (!current || current.status !== "approved"
            || current.action !== input.command.action
            || current.digest !== input.command.approval.operationDigest) {
            throw new Error("workflow approval rejected");
          }
          current.status = "consumed";
          const revisionId = input.materializedRevision?.revisionId
            ?? ("revisionId" in input.command ? input.command.revisionId : null);
          const state: WorkflowGovernanceState = {
            identity: { workflowId: input.command.workflowId, scopeId: input.command.scopeId },
            status: "active",
            activeRevisionId: revisionId ?? null,
            previousStatus: "candidate",
            version: 1,
            updatedAt: input.command.timestamp,
          };
          states.set(input.command.workflowId, state);
          Object.values(input.receipts)
            .filter((value): value is WorkflowGovernanceReceipt => typeof value !== "string")
            .forEach((receipt) => receipts.set(receipt.id, receipt));
          return { commandId: input.command.commandId, state, receipts: input.receipts, value: { revisionId } };
        },
        commitOwnedEffect(_input: OwnedWorkflowGovernanceCommit): WorkflowGovernanceEffectResult {
          throw new Error("not used");
        },
      },
    };
    const service = new WorkflowGovernanceService(persistence, materializer);

    const applied = service.applyProposalRevision({
      commandId: "command-approved",
      workflowId: "workflow-1",
      scopeId: "scope-1",
      proposalId: "proposal-1",
      revisionId: "revision-2",
      approval: {
        ref: { source: "legacy_workflow", id: "approved" },
        action: "workflow.revision.apply",
        operationDigest: "digest-approved",
        risk: "medium",
      },
      actorId: "governor",
      reason: "approved revision",
      timestamp: 100,
    });
    expect(applied).toMatchObject({
      commandId: "command-approved",
      state: { status: "active", activeRevisionId: "revision-2" },
      receipts: {
        kind: "approved",
        approval: { kind: "approval", status: "committed" },
        governance: { kind: "governance", status: "committed" },
        audit: { kind: "audit", status: "committed" },
      },
    });
    expect(approvals.get("approved")?.status).toBe("consumed");
    expect(receipts.size).toBe(3);
    expect(materialized).toBe(1);

    const before = {
      states: structuredClone([...states]),
      approvals: structuredClone([...approvals]),
      receipts: structuredClone([...receipts]),
    };
    expect(() => service.activateWorkflow({
      commandId: "command-rejected",
      workflowId: "workflow-2",
      scopeId: "scope-1",
      revisionId: "revision-x",
      approval: {
        ref: { source: "legacy_workflow", id: "rejected" },
        action: "workflow.activate",
        operationDigest: "digest-rejected",
        risk: "medium",
      },
      actorId: "governor",
      reason: "must reject",
      timestamp: 101,
    })).toThrow(/approval rejected/);
    expect({
      states: [...states], approvals: [...approvals], receipts: [...receipts],
    }).toEqual(before);
  });

  it("replays an applied proposal after proposal and approval consumption, while a commandId conflict fails closed", () => {
    const { store, service, command } = proposalReplayFixture();

    const first = service.applyProposalRevision(command);
    expect(store.db.prepare("SELECT status FROM workflow_revision_proposals WHERE id='proposal-1'").get())
      .toEqual({ status: "applied" });
    expect(store.db.prepare("SELECT status,used_count usedCount FROM autonomy_approval_requests WHERE id='approval-apply'").get())
      .toEqual({ status: "executed", usedCount: 1 });

    expect(service.applyProposalRevision(command)).toEqual(first);
    const before = {
      revisions: store.db.prepare("SELECT COUNT(*) count FROM workflow_revisions").get(),
      approvals: store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get(),
      governance: store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get(),
      audit: store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get(),
    };
    expect(() => service.applyProposalRevision({ ...command, reason: "conflicting replay" }))
      .toThrow(/conflicts with a committed effect/);
    expect({
      revisions: store.db.prepare("SELECT COUNT(*) count FROM workflow_revisions").get(),
      approvals: store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get(),
      governance: store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get(),
      audit: store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get(),
    }).toEqual(before);
  });

  it("reaches the exact replay through the Core approval facade after the approval is executed", () => {
    const { store, adapter, service } = proposalReplayFixture();
    const application = new CoreWorkflowGovernanceApplication(
      service,
      adapter.workflowGovernance.reader,
    );

    const first = application.applyWorkflowProposal("proposal-1", "governor", "approval-apply");
    const replay = application.applyWorkflowProposal("proposal-1", "governor", "approval-apply");

    expect(replay).toEqual(first);
    expect(store.db.prepare("SELECT status,used_count usedCount FROM autonomy_approval_requests WHERE id='approval-apply'").get())
      .toEqual({ status: "executed", usedCount: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_revisions").get()).toEqual({ count: 2 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM approval_receipts").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_governance_receipts").get()).toEqual({ count: 1 });
  });

  it("rejects maxFailureDelta above one before starting a canary", () => {
    const { store, service } = sqliteService(unusedMaterializer);

    expect(() => service.startCanary({
      commandId: "command-invalid-canary",
      workflowId: "workflow-1",
      scopeId: "scope-1",
      revisionId: "revision-2",
      previousRevisionId: "revision-1",
      canaryPercent: 10,
      maxFailureDelta: 1.01,
      approval: {
        ref: { source: "legacy_workflow", id: "approval-apply" },
        action: "workflow.canary.start",
        operationDigest: "digest-invalid",
        risk: "medium",
      },
      actorId: "governor",
      reason: "invalid policy",
      timestamp: 300,
    })).toThrow(/canary policy is invalid/);
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_promotions").get()).toEqual({ count: 0 });
  });

  it("validates the explicit global feature-policy target and invariants, and binds its payload in replay receipts", () => {
    const { store, service } = sqliteService(unusedMaterializer);
    const command = {
      commandId: "command-policy",
      target: { kind: "global" as const },
      actorId: "governor",
      reason: "enable governed learning",
      timestamp: 400,
      policy: { memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: true },
    };

    expect(() => service.updateFeaturePolicy({
      ...command,
      target: { kind: "scope", scopeId: "scope-1" },
    } as never)).toThrow(/target/i);
    expect(() => service.updateFeaturePolicy({
      ...command,
      policy: { memoryEnabled: false, learningEnabled: true, autoExecutionEnabled: false },
    })).toThrow(/policy|requires/i);
    expect(() => service.updateFeaturePolicy({
      ...command,
      policy: { memoryEnabled: true, learningEnabled: false, autoExecutionEnabled: true },
    })).toThrow(/policy|requires/i);

    const first = service.updateFeaturePolicy(command);
    expect(service.updateFeaturePolicy(command)).toEqual(first);
    expect(first.receipts).toMatchObject({
      kind: "feature_policy",
      audit: {
        workflowId: null,
        detail: {
          target: { kind: "global" },
          policy: { memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: true },
        },
      },
    });
    const before = {
      audit: store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get(),
      policy: store.db.prepare(`SELECT memory_enabled memoryEnabled,learning_enabled learningEnabled,
        auto_execution_enabled autoExecutionEnabled FROM learning_feature_settings WHERE id=1`).get(),
    };
    expect(() => service.updateFeaturePolicy({
      ...command,
      policy: { memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: false },
    })).toThrow(/conflicts with a committed effect/);
    expect({
      audit: store.db.prepare("SELECT COUNT(*) count FROM autonomy_audit_events").get(),
      policy: store.db.prepare(`SELECT memory_enabled memoryEnabled,learning_enabled learningEnabled,
        auto_execution_enabled autoExecutionEnabled FROM learning_feature_settings WHERE id=1`).get(),
    }).toEqual(before);
  });
});
