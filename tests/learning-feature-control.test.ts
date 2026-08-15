import { afterEach, describe, expect, it } from "vitest";
import { DistillationWorker, LearningFeatureControl, WorkflowLearningService } from "@tagent/learning";
import { Store } from "@tagent/persistence-sqlite";
import { workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("Memory/Learning feature gates", () => {
  it("hard-disables all Learning when Memory is unavailable", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const control = new LearningFeatureControl(store, false, { learningEnabled: true, autoExecutionEnabled: true });
    expect(control.snapshot()).toMatchObject({ memoryEnabled: false, learningEnabled: false, autoExecutionEnabled: false });
    await expect(control.applyCommittedState({ memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: true, updatedAt: Date.now(), reason: "invalid" }))
      .resolves.toMatchObject({ memoryEnabled: false, learningEnabled: false, autoExecutionEnabled: false });
    expect(() => new WorkflowLearningService(workflowPersistence(store), "", control).teach("scope", { name:"x",intent:"x",cueTerms:["x"],applicability:["x"],nonApplicability:[],preconditions:[],inputContract:[],outputContract:[],steps:[],verification:[],requiredCapabilities:[],riskClass:"low" }, "source")).toThrow("Memory is disabled");
  });

  it("persists passive-only mode and requires the auto execution gate before approval creation", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const control = new LearningFeatureControl(store, true, { learningEnabled: true, autoExecutionEnabled: false });
    const service = new WorkflowLearningService(workflowPersistence(store), "", control);
    const workflow = service.teach("scope", { name:"safe",intent:"safe task",cueTerms:["safe"],applicability:["safe"],nonApplicability:[],preconditions:[],inputContract:[],outputContract:[],steps:[{stepId:"one",instruction:"observe",required:true}],verification:[],requiredCapabilities:[],riskClass:"low" }, "source");
    expect(() => service.requestActivation(workflow.id, workflow.revision!.id)).toThrow("automatic execution is disabled");
    expect(service.recordExperience({scopeId:"scope",sourceType:"task_experience",taskSignature:"safe task",procedureSummary:"1. observe"})).toBeTruthy();
    await control.applyCommittedState({ memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: true, updatedAt: Date.now(), reason: "operator-enabled" });
    expect(service.requestActivation(workflow.id, workflow.revision!.id).status).toBe("pending");
  });

  it("reconciles a persisted unavailable default when Memory becomes configured later", () => {
    const store = new Store(":memory:"); stores.push(store);
    const unavailable = new LearningFeatureControl(store, false);
    expect(unavailable.snapshot()).toMatchObject({ memoryEnabled: false, reason: "memory_unavailable" });
    const available = new LearningFeatureControl(store, true);
    expect(available.snapshot()).toMatchObject({ memoryEnabled: true, reason: "initialized_from_runtime_configuration" });
  });

  it("stops the distillation worker when Memory is turned off", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const control = new LearningFeatureControl(store, true, { learningEnabled: true });
    const worker = new DistillationWorker(new WorkflowLearningService(workflowPersistence(store), "", control), 10);
    control.onChange(async state => { if (state.learningEnabled) worker.start(); else await worker.stop(); });
    worker.start();
    expect(worker.snapshot().running).toBe(true);
    await control.applyCommittedState({ memoryEnabled: false, learningEnabled: false, autoExecutionEnabled: false, updatedAt: Date.now(), reason: "operator-disabled" });
    expect(control.snapshot()).toMatchObject({ learningEnabled:false,autoExecutionEnabled:false });
    expect(worker.snapshot().running).toBe(false);
  });
});
