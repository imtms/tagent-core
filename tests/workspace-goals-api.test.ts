import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite";
import { httpPersistence } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const service = { closeRuntimes: async () => undefined } as never;

describe("Workspace Goal console API", () => {
  it("creates, lists, approves and reads a Goal without starting work", async () => {
    const store = new Store(":memory:");
    const workspace = store.createSession("Goal workspace");
    const app = createApp({ persistence: httpPersistence(store), service, logger: false, closeResources: async () => store.close() });
    apps.push(app);
    const definition = {
      title: "Lightweight Goals",
      outcome: "Track a durable Workspace outcome.",
      scope: ["Goal storage"],
      nonGoals: ["automatic TaskRun creation"],
      criteria: [{ key: "durable", title: "Goal survives restart", required: true }],
      completionPolicy: "user_confirm",
    };
    const created = await app.inject({ method: "POST", url: `/api/v1/console/workspaces/${workspace.id}/goals`, payload: { definition, requestId: "goal-request-1" } });
    expect(created.statusCode).toBe(200);
    const goal = created.json().data;
    expect(goal).toMatchObject({ status: "draft", currentRunId: null, nextAction: { kind: "review_goal" } });
    expect(store.listRuns(workspace.id)).toEqual([]);
    const listed = await app.inject({ method: "GET", url: `/api/v1/console/workspaces/${workspace.id}/goals` });
    expect(listed.json().data).toEqual([expect.objectContaining({ id: goal.id, title: "Lightweight Goals" })]);
    const approved = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { targetRevisionId: goal.definition.id, targetHash: goal.definition.contentHash, kind: "approve_goal" } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({ status: "active", nextAction: { kind: "create_plan" } });
    const plan = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/plans`, payload: { content: { summary: "Bounded plan", items: [
      { id: "api", title: "Expose API", outcome: "Goal can be read", verification: "API contract test" },
      { id: "web", title: "Expose Web UI", outcome: "Goal is manageable", verification: "Web build" },
    ] } } });
    expect(plan.statusCode).toBe(200);
    const planRevision = plan.json().data;
    const withPlan = await app.inject({ method: "GET", url: `/api/v1/console/workspace-goals/${goal.id}` });
    expect(withPlan.json().data).toMatchObject({ nextAction: { kind: "review_plan" }, plan: { id: planRevision.id } });
    const planApproved = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { targetRevisionId: planRevision.id, targetHash: planRevision.contentHash, kind: "approve_plan", approvedItemIds: ["web"] } });
    expect(planApproved.statusCode).toBe(200);
    expect(planApproved.json().data).toMatchObject({ nextAction: { kind: "run_task" }, decisions: expect.arrayContaining([expect.objectContaining({ kind: "approve_plan", approvedItemIds: ["web"] })]) });
  });
});
