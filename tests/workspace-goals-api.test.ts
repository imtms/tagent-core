import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite";
import { httpPersistence } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("Workspace Goal console API", () => {
  it("uses only Roadmap terminology and exposes direct Roadmap TaskRun start", async () => {
    const store = new Store(":memory:");
    const workspace = store.createSession("Goal workspace");
    const startWorkspaceGoalRoadmapItem = vi.fn(() => ({ item: { id: "inbox-roadmap" }, run: { id: "run-roadmap" } }));
    const service = { closeRuntimes: async () => undefined, startWorkspaceGoalRoadmapItem } as never;
    const app = createApp({ persistence: httpPersistence(store), service, logger: false, closeResources: async () => store.close() });
    apps.push(app);
    const definition = {
      title: "Workspace Goal Roadmap",
      outcome: "Track a durable Workspace outcome.",
      scope: ["Goal storage"],
      nonGoals: ["background polling"],
      criteria: [{ key: "durable", title: "Goal survives restart", required: true }],
      completionPolicy: "user_confirm",
    };
    const created = await app.inject({ method: "POST", url: `/api/v1/console/workspaces/${workspace.id}/goals`, payload: { definition, requestId: "goal-request-1" } });
    expect(created.statusCode).toBe(200);
    const goal = created.json().data;
    expect(goal).toMatchObject({ status: "draft", currentRunId: null, nextAction: { kind: "review_goal" }, roadmap: null });
    expect(store.listRuns(workspace.id)).toEqual([]);

    const approved = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { targetRevisionId: goal.definition.id, targetHash: goal.definition.contentHash, kind: "approve_goal" } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({ status: "active", nextAction: { kind: "generate_roadmap" } });

    const added = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/roadmaps`, payload: { content: { summary: "Bounded Roadmap", items: [
      { id: "web", title: "Expose Web UI", outcome: "Goal is manageable", verification: "Web build", criterionKeys: ["durable"] },
    ] } } });
    expect(added.statusCode).toBe(200);
    const withRoadmap = added.json().data;
    expect(withRoadmap).toMatchObject({ nextAction: { kind: "review_roadmap" }, roadmap: { kind: "roadmap", content: { items: [expect.objectContaining({ id: "web", criterionKeys: ["durable"] })] } } });

    const roadmapApproved = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { targetRevisionId: withRoadmap.roadmap.id, targetHash: withRoadmap.roadmap.contentHash, kind: "approve_roadmap", approvedItemIds: ["web"] } });
    expect(roadmapApproved.statusCode).toBe(200);
    expect(roadmapApproved.json().data).toMatchObject({ nextAction: { kind: "run_roadmap_item", roadmapItemId: "web" }, decisions: expect.arrayContaining([expect.objectContaining({ kind: "approve_roadmap", approvedItemIds: ["web"] })]) });

    const started = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/task-runs`, payload: { roadmapItemId: "web", requestId: "start-web" } });
    expect(started.statusCode).toBe(200);
    expect(started.json().data).toMatchObject({ inboxItemId: "inbox-roadmap", runId: "run-roadmap", goal: { id: goal.id } });
    expect(startWorkspaceGoalRoadmapItem).toHaveBeenCalledWith(goal.id, "web", "start-web");

    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/plans`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/run-links`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/evidence`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { targetRevisionId: withRoadmap.roadmap.id, targetHash: withRoadmap.roadmap.contentHash, kind: "approve_plan", approvedItemIds: ["web"] } })).statusCode).toBe(400);
  });
});
