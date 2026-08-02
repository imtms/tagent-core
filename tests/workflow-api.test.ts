import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { AgentService } from "../src/core/agent-service.js";
import { createApp } from "../src/app.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const spec = {
  name: "Release workflow", intent: "prepare release", cueTerms: ["release"], applicability: ["prepare release"], nonApplicability: [], preconditions: [], inputContract: [], outputContract: [],
  steps: [{ stepId: "test", instruction: "Run tests", required: true }],
  verification: [{ check: "tests", required: true, successCondition: "pass" }], requiredCapabilities: [], riskClass: "low" as const,
};

describe("workflow learning HTTP API", () => {
  it("teaches, governs, records feedback, sets learning policy and forgets workflows", async () => {
    const store = new Store(":memory:");
    const service = new AgentService(store, process.cwd());
    const app = createApp({ store, service, logger: false, webRoot: process.cwd() }); apps.push(app);
    const session = store.createSession(); const run = store.createRun(session.id, "prepare release");
    const taught = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/workflows/teach`, payload: { spec, sourceId: "message:1", activate: true } });
    expect(taught.statusCode).toBe(200); const workflow = taught.json();
    expect(workflow.status).toBe("candidate");
    expect((await app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/activate`, payload: {} })).statusCode).toBe(409);
    const requested=await app.inject({method:"POST",url:`/api/workflows/${workflow.id}/activation-request`,payload:{revisionId:workflow.revision.id}});expect(requested.statusCode).toBe(200);const approval=requested.json();
    expect((await app.inject({method:"POST",url:`/api/autonomy-approvals/${approval.id}/approve`,payload:{actor:"human"}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/api/autonomy-approvals/${approval.id}/execute`,payload:{actor:"human"}})).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/workflows` })).json()[0].status).toBe("active");
    const policy = await app.inject({ method: "POST", url: `/api/runs/${run.id}/learning-policy`, payload: { policy: "deny", reason: "private task" } });
    expect(policy.json()).toMatchObject({ policy: "deny", reason: "private task" });
    const feedback = await app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/feedback`, payload: { revisionId: workflow.revision.id, runId: run.id, attempt: 1, signal: "harmful", idempotencyKey: "api-feedback-1" } });
    expect(feedback.statusCode).toBe(200);
    expect(service.getWorkflow(workflow.id)?.status).toBe("suspended");
    expect((await app.inject({ method: "DELETE", url: `/api/workflows/${workflow.id}` })).json()).toEqual({ ok: true });
    expect(service.getWorkflow(workflow.id)).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/restore`, payload: {} })).statusCode).toBe(200);
    expect(service.getWorkflow(workflow.id)?.status).toBe("suspended");
  });
});
