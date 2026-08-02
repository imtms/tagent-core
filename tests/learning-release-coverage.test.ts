import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AgentService } from "../src/core/agent-service.js";
import { DistillationWorker } from "../src/learning/distillation-worker.js";
import { LearningFeatureControl } from "../src/learning/feature-control.js";
import { WorkflowService, type WorkflowSpec } from "../src/learning/workflow-service.js";
import { Store } from "../src/store/store.js";

const stores: Store[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

const spec: WorkflowSpec = {
  name: "Release gate probe", intent: "verify Learning release gates", cueTerms: ["release", "gate"], applicability: ["release gate"], nonApplicability: [],
  preconditions: [], inputContract: [], outputContract: [], steps: [{ stepId: "observe", instruction: "Observe only", required: true }],
  verification: [{ check: "gate", required: true, successCondition: "all active paths remain gated" }], requiredCapabilities: [], riskClass: "low",
};

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const control = new LearningFeatureControl(store, true, { learningEnabled: true, autoExecutionEnabled: false });
  const workflows = new WorkflowService(store, "", control);
  const worker = new DistillationWorker(workflows, 10);
  control.onChange(async (state) => { if (state.learningEnabled) worker.start(); else await worker.stop(); });
  const agent = new AgentService(store, process.cwd(), undefined, {}, undefined, "default", control);
  const app = createApp({ store, service: agent, logger: false, webRoot: process.cwd(), learningControl: control, distillationWorker: worker }); apps.push(app);
  return { store, control, workflows, worker, app };
}

describe("v0.1.8 Learning release acceptance coverage", () => {
  it("Memory-off disables every Learning API family, projector, scheduler, distiller, evolution and active path", async () => {
    const { store, control, workflows, worker, app } = fixture();
    const session = store.createSession();
    const run = store.createRun(session.id, "release gate");
    const workflow = workflows.teach(session.id, spec, "evidence:1");
    worker.start();
    await control.update({ memoryEnabled: false, reason: "test_memory_off" });

    expect(control.snapshot()).toMatchObject({ memoryEnabled: false, learningEnabled: false, autoExecutionEnabled: false, passiveLearningEnabled: false });
    expect(worker.snapshot()).toMatchObject({ running: false, ready: false });
    expect(workflows.projectRun(store.getRun(run.id)!, "failed")).toBeUndefined();
    expect(workflows.runNextDistillationJob("disabled-worker")).toBeUndefined();
    expect(workflows.recall(session.id, "release gate", run.id, 1)).toEqual({ promptSection: "", workflows: [], contextItems: [] });
    expect(() => workflows.teach(session.id, spec, "evidence:2")).toThrow("Memory is disabled");
    expect(() => workflows.requestActivation(workflow.id)).toThrow("Memory is disabled");
    expect(() => workflows.requestApproval({ scopeId: session.id, actionType: "execute_workflow", targetType: "workflow", targetId: workflow.id, workflowId: workflow.id, riskClass: "low" })).toThrow("Memory is disabled");

    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/api/sessions/${session.id}/learning-center`],
      ["GET", `/api/sessions/${session.id}/learning-events`],
      ["GET", `/api/sessions/${session.id}/communication-profiles`],
      ["POST", `/api/sessions/${session.id}/communication-preferences`, { dimension: "language", value: "中文" }],
      ["GET", `/api/sessions/${session.id}/corrections`],
      ["POST", `/api/sessions/${session.id}/corrections`, { content: "correction" }],
      ["POST", `/api/runs/${run.id}/learning-policy`, { policy: "deny" }],
      ["POST", "/api/workflow-distillation/run", {}],
      ["GET", "/api/workflow-distillation/dead-letter"],
      ["POST", `/api/workflows/${workflow.id}/activation-request`, {}],
      ["POST", `/api/workflows/${workflow.id}/promotion-request`, { revisionId: workflow.revision!.id }],
      ["POST", "/api/feedback-attribution/drain", {}],
      ["POST", "/api/autonomy-approvals/missing/execute", {}],
    ];
    for (const [method, url, payload] of routes) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode, `${method} ${url}`).toBe(503);
      expect(response.json()).toMatchObject({ code: "learning_disabled" });
    }
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_approval_requests").get()).toEqual({ count: 0 });
  });

  it("passive mode allows observation, evidence, distillation and candidate evolution but blocks all active operation families", () => {
    const { store, workflows } = fixture();
    const session = store.createSession();
    for (let index = 0; index < 2; index += 1) {
      const run = store.createRun(session.id, "release gate");
      store.upsertPlanItem(run.id, { key: "observe", title: "Observe", status: "done", required: true, position: 1 });
      store.upsertCheck(run.id, { key: "gate", title: "Gate", status: "passed", required: true, command: "test", evidence: "fresh", stale: false });
      store.finalizeRun(run.id, "completed");
      expect(workflows.projectRun(store.getRun(run.id)!, "completed")).toBeTruthy();
    }
    const candidate = workflows.runNextDistillationJob("passive-distiller");
    expect(candidate).toMatchObject({ status: "candidate", activeRevisionId: null });
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations WHERE source_type='task_experience'").get()).toEqual({ count: 2 });
    expect(workflows.listAutonomyAudit(session.id).map((item) => item.category)).toEqual(expect.arrayContaining(["observe", "learn", "distill"]));
    expect(workflows.recall(session.id, "release gate", "run-passive", 1)).toEqual({ promptSection: "", workflows: [], contextItems: [] });
    expect(() => workflows.requestActivation(candidate!.id)).toThrow("automatic execution is disabled");
    expect(() => workflows.requestProposalApplication("missing", "governor")).toThrow("automatic execution is disabled");
    expect(() => workflows.requestPromotion(candidate!.id, candidate!.revision!.id)).toThrow("automatic execution is disabled");
    expect(() => workflows.requestApproval({ scopeId: session.id, actionType: "execute_workflow", targetType: "workflow", targetId: candidate!.id, workflowId: candidate!.id, riskClass: "low" })).toThrow("automatic execution is disabled");
    expect(store.db.prepare("SELECT COUNT(*) count FROM autonomy_approval_requests").get()).toEqual({ count: 0 });
  });

  it("top-bar UI source exposes state, Memory dependency and permanent approval warning", () => {
    const source = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    for (const text of ["Learning execution", "Memory required", "Off · passive learning only", "On · approval always required", "Every active action still requires human approval."]) {
      expect(source).toContain(text);
    }
    expect(source).toContain('role="switch"');
    expect(source).toContain("disabled={!learningSettings.learningEnabled || learningToggleBusy}");
    expect(source).toContain("aria-checked={learningSettings.autoExecutionEnabled}");
  });

  it("release documentation covers every required operational topic with concrete state and approval contracts", () => {
    const document = readFileSync(new URL("../docs/LEARNING.md", import.meta.url), "utf8");
    for (const heading of ["Release boundary", "Hard dependency", "Modes", "Configuration", "API", "Web UI", "State transitions", "Upgrade and migration", "Operations", "Troubleshooting", "Rollback and emergency disable"]) {
      expect(document).toContain(`## ${heading}`);
    }
    for (const statement of ["Memory off => Learning off => automatic execution off", "passive observation", "Experience Observation", "durable Distillation Jobs", "Workflow/Revision candidates", "request -> pending -> human approve/reject -> explicit execute -> receipt", "activeExecutionRequiresApproval: true", "503 learning_disabled", "409", "Schema v22", "database backup", "emergency passive-only mode"]) {
      expect(document).toContain(statement);
    }
  });
});
