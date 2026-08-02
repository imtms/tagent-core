import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { WorkflowService, type WorkflowSpec } from "../src/learning/workflow-service.js";

const stores: Store[] = [];
const create = () => { const store = new Store(":memory:"); stores.push(store); return { store, workflows: new WorkflowService(store) }; };
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const spec = (name = "Safe release workflow"): WorkflowSpec => ({
  name,
  intent: "prepare and verify a software release",
  cueTerms: ["release", "发布", "verify"],
  applicability: ["prepare release"],
  nonApplicability: ["draft announcement only"],
  preconditions: ["repository is available"],
  inputContract: [{ name: "releaseVersion", description: "Version to release", required: true }],
  outputContract: [{ name: "releaseArtifact", description: "Verified release artifact", required: true }],
  steps: [
    { stepId: "test", instruction: "Run the required test suite", required: true },
    { stepId: "build", instruction: "Build the release artifact", required: true },
  ],
  verification: [{ check: "release tests", required: true, successCondition: "all tests pass" }],
  requiredCapabilities: [],
  riskClass: "low",
});

describe("controlled workflow learning", () => {
  it("keeps explicit teaching versioned and requires activation before recall", () => {
    const { store, workflows } = create(); const session = store.createSession(); const run = store.createRun(session.id, "prepare release");
    const candidate = workflows.teach(session.id, spec(), "message:1");
    expect(candidate).toMatchObject({ status: "candidate", revision: { revision: 1, sourceType: "explicit_user", sourceEvidenceIds: ["message:1"], counterexampleIds: [], inputContract: [{ name: "releaseVersion", required: true }], outputContract: [{ name: "releaseArtifact", required: true }] } });
    expect(store.db.prepare("SELECT source_type as sourceType, source_evidence_json as evidenceJson FROM workflow_revisions WHERE id = ?").get(candidate.revision!.id)).toEqual({ sourceType: "explicit_user", evidenceJson: JSON.stringify(["message:1"]) });
    expect(workflows.recall(session.id, "prepare release", run.id, 1).workflows).toHaveLength(0);
    workflows.activate(candidate.id);
    const recalled = workflows.recall(session.id, "prepare release and verify it", run.id, 1);
    expect(recalled.workflows[0]).toMatchObject({ definition: { id: candidate.id }, revision: { revision: 1 } });
    expect(recalled.promptSection).toContain("Inputs:");
    expect(recalled.promptSection).toContain("Expected outputs:");
    expect(recalled.promptSection).toContain("grants no additional capability or approval");
    expect(recalled.contextItems[0]).toMatchObject({ kind: "workflow_revision", metadata: { workflowId: candidate.id } });
    expect(store.db.prepare("SELECT COUNT(*) as count FROM workflow_bindings").get()).toEqual({ count: 1 });
    const binding = store.db.prepare("SELECT selector_version as selectorVersion, relevance_score as relevanceScore, selected_reason_json as selectedReasonJson FROM workflow_bindings WHERE id = ?").get(recalled.workflows[0].bindingId) as { selectorVersion: string; relevanceScore: number; selectedReasonJson: string };
    expect(binding.selectorVersion).toBe("workflow-selector-v1");
    expect(binding.relevanceScore).toBeGreaterThan(0);
    expect(JSON.parse(binding.selectedReasonJson)).toEqual(expect.arrayContaining([expect.stringContaining("confidence")]));
    expect(recalled.contextItems[0].reason).toContain("confidence");
    workflows.setBindingMode(recalled.workflows[0].bindingId, "adopted");
    store.upsertCheck(run.id, { key: "release", title: "Release checks", status: "passed", required: true, command: "npm test", evidence: "ok", stale: false });
    store.finalizeRun(run.id, "completed"); workflows.recordRunApplications(store.getRun(run.id)!);
    expect(store.db.prepare("SELECT attribution_level as level FROM workflow_application_receipts").get()).toEqual({ level: "verified_contribution" });
    expect(store.db.prepare("SELECT signal FROM workflow_feedback").get()).toEqual({ signal: "successful" });
  });

  it("does not distill one success, distills repeated evidence as a candidate, and is idempotent", () => {
    const { store, workflows } = create(); const session = store.createSession();
    const first = store.createRun(session.id, "repeatable release");
    store.upsertPlanItem(first.id, { key: "test", title: "Run tests", status: "done", required: true, position: 1 });
    store.upsertCheck(first.id, { key: "tests", title: "Tests pass", status: "passed", required: true, command: "npm test", evidence: "ok", stale: false });
    store.finalizeRun(first.id, "completed"); workflows.projectRun(store.getRun(first.id)!, "completed");
    expect(store.db.prepare("SELECT source_type as sourceType, run_id as runId, attempt FROM experience_observations WHERE run_id = ?").get(first.id)).toEqual({ sourceType: "task_experience", runId: first.id, attempt: 1 });
    expect(workflows.listWorkflows(session.id)).toHaveLength(0);

    const second = store.createRun(session.id, "repeatable release");
    store.upsertPlanItem(second.id, { key: "test", title: "Run tests", status: "done", required: true, position: 1 });
    store.upsertCheck(second.id, { key: "tests", title: "Tests pass", status: "passed", required: true, command: "npm test", evidence: "ok", stale: false });
    store.finalizeRun(second.id, "completed"); workflows.projectRun(store.getRun(second.id)!, "completed");
    const distilled = workflows.listWorkflows(session.id);
    expect(distilled).toHaveLength(1);
    expect(distilled[0]).toMatchObject({ status: "candidate", revision: { sourceType: "task_experience", sourceEvidenceIds: expect.any(Array) } });
    expect(distilled[0].revision!.sourceEvidenceIds).toHaveLength(2);
    workflows.projectRun(store.getRun(second.id)!, "completed");
    expect(workflows.listWorkflows(session.id)).toHaveLength(1);
    expect(store.db.prepare("SELECT COUNT(*) as count FROM experience_observations").get()).toEqual({ count: 2 });
  });

  it("distinguishes failed task experience from successful task experience", () => {
    const { store, workflows } = create(); const session = store.createSession(); const run = store.createRun(session.id, "failed release");
    store.upsertPlanItem(run.id, { key: "test", title: "Run tests", status: "done", required: true, position: 1 });
    store.upsertCheck(run.id, { key: "tests", title: "Tests pass", status: "failed", required: true, command: "npm test", evidence: "failed", stale: false });
    store.finalizeRun(run.id, "failed", "tests failed"); workflows.projectRun(store.getRun(run.id)!, "failed");
    expect(store.db.prepare("SELECT source_type as sourceType FROM experience_observations").get()).toEqual({ sourceType: "task_failure" });
    expect(workflows.listWorkflows(session.id)).toHaveLength(0);
  });

  it("honors deny-learning and redacts common secret forms", () => {
    const { store, workflows } = create(); const session = store.createSession(); const denied = store.createRun(session.id, "private task");
    workflows.setRunLearningPolicy(denied.id, "deny");
    store.upsertPlanItem(denied.id, { key: "one", title: "Use token=super-secret-value", status: "done", required: true, position: 1 });
    store.finalizeRun(denied.id, "completed"); workflows.projectRun(store.getRun(denied.id)!, "completed");
    expect(store.db.prepare("SELECT COUNT(*) as count FROM experience_observations").get()).toEqual({ count: 0 });

    workflows.recordExperience({ scopeId: session.id, sourceType: "explicit_user", taskSignature: "secret flow", procedureSummary: "password=hunter2 token=abcd1234", sourceRefs: ["secret=reference-value"], learnPolicy: "allow" });
    const row = store.db.prepare("SELECT procedure_summary as summary FROM experience_observations").get() as { summary: string };
    expect(row.summary).not.toContain("hunter2");
    expect(row.summary).not.toContain("abcd1234");
    const sanitized = workflows.teach(session.id, { ...spec("Secret workflow"), inputContract: [{ name: "token", description: "token=abcd1234", required: true }], outputContract: [{ name: "receipt", description: "password=hunter2", required: true }], steps: [{ stepId: "secret=step-value", instruction: "Use api_key=top-secret-key", required: true, expectedArtifact: "token=artifact-secret", failureHandling: "password=failure-secret" }] }, "manual:secret=source-value");
    expect(JSON.stringify(sanitized)).not.toContain("abcd1234");
    expect(JSON.stringify(sanitized)).not.toContain("hunter2");
    expect(JSON.stringify(sanitized)).not.toContain("top-secret-key");
    expect(JSON.stringify(sanitized)).not.toContain("artifact-secret");
    expect(JSON.stringify(sanitized)).not.toContain("failure-secret");
    expect(JSON.stringify(sanitized)).not.toContain("source-value");
  });

  it("filters non-applicable and capability-gated workflows", () => {
    const { store, workflows } = create(); const session = store.createSession(); const run = store.createRun(session.id, "release production");
    const gated = workflows.teach(session.id, { ...spec("Production release"), requiredCapabilities: ["production_write"] }, "message:2", true);
    expect(workflows.recall(session.id, "prepare release", run.id, 1).workflows).toHaveLength(0);
    expect(workflows.recall(session.id, "draft announcement only for release", run.id, 1, ["production_write"]).workflows).toHaveLength(0);
    expect(workflows.recall(session.id, "prepare release", run.id, 1, ["production_write"]).workflows[0].definition.id).toBe(gated.id);
  });

  it("deduplicates feedback, suspends harmful workflows, and rolls back revisions", () => {
    const { store, workflows } = create(); const session = store.createSession(); const run = store.createRun(session.id, "prepare release");
    const workflow = workflows.teach(session.id, spec(), "message:3", true);
    const revision2 = workflows.revise(workflow.id, { steps: [...spec().steps, { stepId: "sign", instruction: "Sign artifact", required: true }] }, "user_correction", ["message:4"], "Add signing");
    expect(store.db.prepare("SELECT source_type as sourceType, source_evidence_json as evidenceJson FROM workflow_revisions WHERE id = ?").get(revision2.id)).toEqual({ sourceType: "user_correction", evidenceJson: JSON.stringify(["message:4"]) });
    workflows.activate(workflow.id, revision2.id);
    workflows.feedback({ workflowId: workflow.id, revisionId: revision2.id, runId: run.id, attempt: 1, signal: "harmful", idempotencyKey: "feedback:1", note: "Signing is wrong here" });
    workflows.feedback({ workflowId: workflow.id, revisionId: revision2.id, runId: run.id, attempt: 1, signal: "harmful", idempotencyKey: "feedback:1", note: "duplicate" });
    expect(workflows.getWorkflow(workflow.id)?.status).toBe("suspended");
    expect(store.db.prepare("SELECT COUNT(*) as count FROM workflow_feedback").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) as count FROM workflow_revision_proposals").get()).toEqual({ count: 1 });
    const rolledBack = workflows.rollback(workflow.id, workflow.revision!.id);
    expect(rolledBack).toMatchObject({ status: "active", activeRevisionId: workflow.revision!.id, revision: { revision: 1 } });
    expect(workflows.forget(workflow.id)).toBe(true);
    expect(workflows.getWorkflow(workflow.id)).toBeUndefined();
  });
});
