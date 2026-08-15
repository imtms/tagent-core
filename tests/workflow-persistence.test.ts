import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLearningService } from "@tagent/learning";
import type { WorkflowSpec } from "@tagent/learning/domain";
import type { WorkflowLearningPersistencePort } from "@tagent/learning/ports";
import { SqlitePersistence, Store } from "@tagent/persistence-sqlite";

const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

const spec: WorkflowSpec = {
  name: "release verification",
  intent: "verify a release before shipping",
  cueTerms: ["release", "verify"],
  applicability: ["release verification"],
  nonApplicability: [],
  preconditions: [],
  inputContract: [],
  outputContract: [],
  steps: [{ stepId: "test", instruction: "Run the tests", required: true }],
  verification: [{ check: "tests", required: true, successCondition: "tests pass" }],
  requiredCapabilities: [],
  riskClass: "low",
};

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const adapter = new SqlitePersistence(store, {
    run: <T>(work: () => T) => store.db.transaction(work)(),
  });
  const persistence: WorkflowLearningPersistencePort = adapter.workflow;
  const workflow = persistence.workflow;
  return { store, workflow, service: new WorkflowLearningService(persistence) };
}

describe("workflow persistence boundary", () => {
  it("keeps WorkflowLearningService storage-neutral", () => {
    const source = readFileSync(new URL("../packages/learning/src/workflow-learning-service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/store\/store|better-sqlite3|\.db\b|\.prepare\b|\.transaction\b/);
  });

  it("rolls back workflow creation when the revision cannot be persisted", () => {
    const { store, service } = fixture();
    store.db.exec(`CREATE TEMP TRIGGER reject_workflow_revision BEFORE INSERT ON workflow_revisions
      BEGIN SELECT RAISE(ABORT, 'revision rejected'); END`);
    expect(() => service.teach("scope", spec, "evidence:1")).toThrow("revision rejected");
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_definitions").get()).toEqual({ count: 0 });
  });

  it("rolls back approval creation when its audit receipt fails", () => {
    const { store, service } = fixture();
    const workflow = service.teach("scope", spec, "evidence:approval-audit");
    store.db.exec(`CREATE TEMP TRIGGER reject_autonomy_audit BEFORE INSERT ON autonomy_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit rejected'); END`);
    expect(() => service.requestApproval({
      scopeId: "scope",
      actionType: "execute_workflow",
      targetType: "workflow",
      targetId: workflow.id,
      workflowId: workflow.id,
      riskClass: "low",
    })).toThrow("audit rejected");
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_approval_requests").get()).toEqual({ count: 0 });
  });

  it("rolls back binding mode when the application receipt fails", () => {
    const { store, workflow, service } = fixture();
    const session = store.createSession();
    const run = store.createRun(session.id, "release verification");
    const created = service.teach(session.id, spec, "evidence:1");
    workflow.recordWorkflowBinding({
      id: "binding-1",
      runId: run.id,
      attempt: run.attempt,
      workflowId: created.id,
      revisionId: created.revision!.id,
      score: 0.8,
      reasonsJson: "[]",
      createdAt: Date.now(),
    });
    store.db.exec(`CREATE TEMP TRIGGER reject_application_receipt BEFORE INSERT ON workflow_application_receipts
      BEGIN SELECT RAISE(ABORT, 'application receipt rejected'); END`);
    expect(() => workflow.recordApplication({
      id: "application-1",
      bindingId: "binding-1",
      status: "adopted",
      mode: "adopted",
      executedStepIdsJson: "[]",
      skippedStepsJson: "[]",
      correctionObserved: 0,
      repeatedToolCalls: 0,
      continuationCount: 0,
      verificationMappingJson: "[]",
      attributionLevel: "adopted",
      createdAt: Date.now(),
    })).toThrow("application receipt rejected");
    expect(store.db.prepare("SELECT application_mode as mode FROM workflow_bindings WHERE id='binding-1'").get())
      .toEqual({ mode: "suggested" });
  });
});
