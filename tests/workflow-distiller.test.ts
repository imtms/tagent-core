import { afterEach, describe, expect, it } from "vitest";
import { WorkflowService } from "@tagent/learning";
import type { WorkflowSpec } from "@tagent/learning/domain";
import { Store } from "@tagent/persistence-sqlite";
import { workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
const make = () => { const store = new Store(":memory:"); stores.push(store); return { store, service: new WorkflowService(workflowPersistence(store)) }; };
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function observe(store: Store, service: WorkflowService, scopeId: string, signature: string, summary: string, success = true, failedChecks: string[] = []) {
  const run = store.createRun(scopeId, signature);
  return service.recordExperience({
    scopeId, runId: run.id, attempt: 1, sourceType: success ? "task_experience" : "task_failure",
    taskSignature: signature, procedureSummary: summary, checksPassed: success ? ["tests"] : [], checksFailed: failedChecks,
  });
}

const existingSpec: WorkflowSpec = {
  name: "Existing verification", intent: "verify software change", cueTerms: ["verify", "software", "change"],
  applicability: ["verify software change"], nonApplicability: [], preconditions: [], inputContract: [], outputContract: [],
  steps: [{ stepId: "deploy", instruction: "Deploy before running tests", required: true }],
  verification: [{ check: "tests", required: true, successCondition: "pass" }], requiredCapabilities: [], riskClass: "low",
};

describe("persistent asynchronous experience distiller", () => {
  it("persists fenced checkpoints and rejects stale worker writes", async () => {
    const { store, service } = make(); const session = store.createSession();
    observe(store, service, session.id, "verify software change", "1. Run tests\n2. Build artifact");
    observe(store, service, session.id, "verify code change", "1. Run the tests\n2. Build artifact");
    service.enqueueDistillation(session.id, "verify software change");
    const stale = service.claimDistillationJob("worker-a", 10) as any;
    service.checkpointDistillationJob(stale.id, "worker-a", stale.lease_token, stale.fence, { phase: "scan", cursor: 1 }, 10);
    expect(JSON.parse((store.db.prepare("SELECT checkpoint_json value FROM workflow_distillation_jobs WHERE id=?").get(stale.id) as any).value)).toMatchObject({ phase: "scan", cursor: 1 });
    store.db.prepare("UPDATE workflow_distillation_jobs SET lease_until=0 WHERE id=?").run(stale.id);
    const current = service.claimDistillationJob("worker-b") as any;
    expect(current.fence).toBe(stale.fence + 1);
    expect(() => service.checkpointDistillationJob(stale.id, "worker-a", stale.lease_token, stale.fence, { phase: "stale" })).toThrow("lease lost");
    service.checkpointDistillationJob(current.id, "worker-b", current.lease_token, current.fence, { phase: "resumed", cursor: 1 });
  });

  it("keeps a long-running job leased with an independent heartbeat", async () => {
    const { store, service } = make(); const session = store.createSession();
    observe(store, service, session.id, "heartbeat release verification", "1. Run tests\n2. Build artifact");
    observe(store, service, session.id, "heartbeat release validation", "1. Run the tests\n2. Build artifact");
    service.enqueueDistillation(session.id, "heartbeat release verification");
    const original = service.distillRepeatedExperience.bind(service);
    service.distillRepeatedExperience = (async (...args: Parameters<typeof original>) => { await new Promise((resolve) => setTimeout(resolve, 8_500)); return original(...args); }) as typeof service.distillRepeatedExperience;
    const running = service.runNextDistillationJob("heartbeat-worker");
    await new Promise((resolve) => setTimeout(resolve, 8_200));
    const job = store.db.prepare("SELECT lease_until as leaseUntil,fence FROM workflow_distillation_jobs").get() as any;
    expect(job.leaseUntil).toBeGreaterThan(Date.now() + 20_000);
    expect(service.claimDistillationJob("competing-worker")).toBeUndefined();
    await running;
  }, 20_000);

  it("aggregates semantically similar runs, keeps consistent order, and derives counterexample handling", async () => {
    const { store, service } = make(); const session = store.createSession();
    observe(store, service, session.id, "verify software release change", "1. Run tests\n2. Build release artifact\n3. Publish report");
    observe(store, service, session.id, "validate software release update", "1. Run the tests\n2. Build release artifact\n3. Notify team");
    observe(store, service, session.id, "verification of software release failed", "1. Build first\n2. Run tests", false, ["tests"]);
    service.enqueueDistillation(session.id, "verify software release change");
    const result = (await service.runNextDistillationJob("distiller"))!;
    expect(result.revision!.steps).toHaveLength(2);
    expect(result.revision!.steps[0].instruction).toMatch(/Run (?:the )?tests/);
    expect(result.revision!.steps[1].instruction).toBe("Build release artifact");
    expect(result.revision!.counterexampleIds).toHaveLength(1);
    expect(result.revision!.nonApplicability[0]).toContain("failed run");
    expect(result.revision!.steps[0].failureHandling).toContain("tests");
    expect(JSON.parse((store.db.prepare("SELECT checkpoint_json value FROM workflow_distillation_jobs").get() as any).value)).toMatchObject({ phase: "completed", workflowId: result.id });
  });

  it("withholds a candidate when repeated runs have no consistent steps or common verification", async () => {
    const { store, service } = make(); const session = store.createSession();
    observe(store, service, session.id, "reply to pull request review", "1. Draft a reply", true);
    observe(store, service, session.id, "respond to pull request review", "1. Post a comment", true);
    service.enqueueDistillation(session.id, "reply to pull request review");
    expect(await service.runNextDistillationJob("distiller")).toBeUndefined();
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_definitions").get()).toEqual({ count: 0 });
  });

  it("does not treat waiting-input or interruption events without failed checks as counterexamples", async () => {
    const { store, service } = make(); const session = store.createSession();
    observe(store, service, session.id, "verify software release change", "1. Run tests\n2. Build release artifact");
    observe(store, service, session.id, "validate software release update", "1. Run the tests\n2. Build release artifact");
    observe(store, service, session.id, "verify software release change", "Please provide the release identifier", false, []);
    service.enqueueDistillation(session.id, "verify software release change");
    const result = (await service.runNextDistillationJob("distiller"))!;
    expect(result.revision!.counterexampleIds).toEqual([]);
    expect(result.revision!.nonApplicability).toEqual([]);
  });

  it("records a durable conflict instead of silently duplicating a divergent workflow", async () => {
    const { store, service } = make(); const session = store.createSession();
    service.createWorkflow(session.id, existingSpec, "explicit_user", ["message:1"], "candidate");
    observe(store, service, session.id, "verify software change", "1. Run tests\n2. Build artifact");
    observe(store, service, session.id, "validate software change", "1. Run the tests\n2. Build artifact");
    service.enqueueDistillation(session.id, "verify software change");
    expect(await service.runNextDistillationJob("distiller")).toBeUndefined();
    const conflict = store.db.prepare("SELECT kind,status,reasons_json as reasonsJson FROM workflow_distillation_conflicts").get() as any;
    expect(conflict).toMatchObject({ kind: "conflict", status: "open" });
    expect(JSON.parse(conflict.reasonsJson)).toContain("same applicability with divergent procedure");
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_definitions").get()).toEqual({ count: 1 });
  });
});
