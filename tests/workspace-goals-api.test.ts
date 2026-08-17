import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite";
import { httpPersistence } from "./support/test-persistence.js";
import { corePersistence } from "./support/test-persistence.js";
import { createCoreClient } from "@tagent/core-client";
import { CoreWorkspaceGoalApplication, type WorkspaceGoalRoadmapGenerator } from "@tagent/core-service/application";
import type { AddressInfo } from "node:net";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function goalHttpService(store:Store,options:{generator?:WorkspaceGoalRoadmapGenerator;enqueue?:ReturnType<typeof vi.fn>}={}){
  const persistence=corePersistence(store);
  const enqueue=options.enqueue??vi.fn(()=>({item:{id:"goal-inbox"},run:{id:"goal-run"}}));
  const application=new CoreWorkspaceGoalApplication(persistence.workspaceGoals,{enqueueGoalRoadmapItem:enqueue} as never,options.generator,persistence.sessions,persistence.workspaceGoalOperations);
  const service={closeRuntimes:async()=>undefined,
    listWorkspaceGoals:application.listWorkspaceGoals.bind(application),createWorkspaceGoal:application.createWorkspaceGoal.bind(application),getWorkspaceGoal:application.getWorkspaceGoal.bind(application),
    reviseWorkspaceGoalDefinition:application.reviseWorkspaceGoalDefinition.bind(application),reviseWorkspaceGoalRoadmap:application.reviseWorkspaceGoalRoadmap.bind(application),
    requestWorkspaceGoalRoadmapGeneration:application.requestWorkspaceGoalRoadmapGeneration.bind(application),getWorkspaceGoalOperation:application.getWorkspaceGoalOperation.bind(application),
    startWorkspaceGoalRoadmapTask:application.startWorkspaceGoalRoadmapTask.bind(application),decideWorkspaceGoal:application.decideWorkspaceGoal.bind(application)} as never;
  return{application,enqueue,service};
}

describe("Workspace Goal console API", () => {
  it("calls the Roadmap generator at most once per requestId and exposes its receipt", async () => {
    const store = new Store(":memory:");
    const workspace = store.createSession("Generated Roadmap");
    const persistence = httpPersistence(store);
    const definition = { title: "Generate", outcome: "One draft", scope: [], nonGoals: [], criteria: [{ key: "one", title: "One", required: true }], completionPolicy: "user_confirm" as const };
    const generate = vi.fn(async () => ({ summary: "Generated once", items: [
      { id: "one", title: "One", outcome: "Done", verification: "Check", criterionKeys: ["one"] },
      { id: "verify_one", title: "Verify", outcome: "Verified", verification: "Inspect result", criterionKeys: ["one"] },
    ] }));
    const harness=goalHttpService(store,{generator:{model:"goal-api",generate}});
    const goal=harness.application.createWorkspaceGoal(workspace.id,{definition,actorId:"test"});
    harness.application.decideWorkspaceGoal({goalId:goal.id,targetRevisionId:goal.definition!.id,targetHash:goal.definition!.contentHash,kind:"approve_goal",actorId:"test"});
    const app = createApp({ persistence, service:harness.service, logger: false, closeResources: async () => store.close() });
    apps.push(app);
    const payload = { requestId: "generate-once", actorId: "gateway" };
    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/roadmap/generate`, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/roadmap/generate`, payload })).statusCode).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    const receipt = await app.inject({ method: "GET", url: `/api/v1/console/workspace-goals/${goal.id}/operations/generate-once` });
    expect(receipt.json().data).toMatchObject({ operationType: "roadmap.generate", state: "succeeded", result: { generated: true } });
    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/roadmap/generate`, payload: { requestId: "generate-once", actorId: "changed" } })).statusCode).toBe(409);
  });

  it("uses only Roadmap terminology and exposes direct Roadmap TaskRun start", async () => {
    const store = new Store(":memory:");
    const workspace = store.createSession("Goal workspace");
    const enqueue = vi.fn(() => ({ item: { id: "inbox-roadmap" }, run: { id: "run-roadmap" } }));
    const harness=goalHttpService(store,{enqueue});
    const app = createApp({ persistence: httpPersistence(store), service:harness.service, logger: false, closeResources: async () => store.close() });
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

    const approved = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { requestId: "approve-goal", targetRevisionId: goal.definition.id, targetHash: goal.definition.contentHash, kind: "approve_goal" } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({ status: "active", nextAction: { kind: "generate_roadmap" } });

    const added = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/roadmaps`, payload: { requestId: "add-roadmap", content: { summary: "Bounded Roadmap", items: [
      { id: "web", title: "Expose Web UI", outcome: "Goal is manageable", verification: "Web build", criterionKeys: ["durable"] },
    ] } } });
    expect(added.statusCode).toBe(200);
    const withRoadmap = added.json().data;
    expect(withRoadmap).toMatchObject({ nextAction: { kind: "review_roadmap" }, roadmap: { kind: "roadmap", content: { items: [expect.objectContaining({ id: "web", criterionKeys: ["durable"] })] } } });

    const roadmapApproved = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { requestId: "approve-roadmap", targetRevisionId: withRoadmap.roadmap.id, targetHash: withRoadmap.roadmap.contentHash, kind: "approve_roadmap", approvedItemIds: ["web"] } });
    expect(roadmapApproved.statusCode).toBe(200);
    expect(roadmapApproved.json().data).toMatchObject({ nextAction: { kind: "run_roadmap_item", roadmapItemId: "web" }, decisions: expect.arrayContaining([expect.objectContaining({ kind: "approve_roadmap", approvedItemIds: ["web"] })]) });

    const started = await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/task-runs`, payload: { roadmapItemId: "web", requestId: "start-web" } });
    expect(started.statusCode).toBe(200);
    expect(started.json().data).toMatchObject({ inboxItemId: "inbox-roadmap", runId: "run-roadmap", goal: { id: goal.id } });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({goalId:goal.id,requestId:"start-web",roadmapItem:expect.objectContaining({id:"web"})}));

    expect((await app.inject({ method: "POST", url: `/api/v1/console/workspace-goals/${goal.id}/decisions`, payload: { requestId: "invalid-decision", targetRevisionId: withRoadmap.roadmap.id, targetHash: withRoadmap.roadmap.contentHash, kind: "approve_something", approvedItemIds: ["web"] } })).statusCode).toBe(400);
  });

  it("exposes every stable Goal write through the typed Core Client", async () => {
    const store = new Store(":memory:");
    const workspace = store.createSession("Goal client");
    const enqueue = vi.fn(() => ({ item: { id: "client-inbox" }, run: { id: "client-run" } }));
    const harness=goalHttpService(store,{enqueue});
    const app = createApp({
      persistence: httpPersistence(store),
      service:harness.service,
      logger: false,
      closeResources: async () => store.close(),
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const client = createCoreClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const definition = {
      title: "Typed Goal", outcome: "Gateway uses owned schemas", scope: ["Core ABI"], nonGoals: [],
      criteria: [{ key: "typed", title: "Client is typed", required: true }], completionPolicy: "user_confirm" as const,
    };
    const created = await client.createWorkspaceGoal(workspace.id, { definition, requestId: "client-create", actorId: "gateway" });
    const revised = await client.reviseWorkspaceGoalDefinition(created.id, {
      definition: { ...definition, outcome: "Gateway uses complete owned schemas" }, requestId: "client-revise", actorId: "gateway",
    });
    const approved = await client.decideWorkspaceGoal(created.id, {
      requestId: "client-approve-goal", targetRevisionId: revised.id, targetHash: revised.contentHash, kind: "approve_goal", actorId: "gateway",
    });
    expect(approved.status).toBe("active");
    const withRoadmap = await client.reviseWorkspaceGoalRoadmap(created.id, {
      requestId: "client-roadmap", actorId: "gateway", content: {
        summary: "One bounded item",
        items: [{ id: "typed_client", title: "Verify client", outcome: "Client passes", verification: "Run client tests", criterionKeys: ["typed"] }],
      },
    });
    const roadmap = withRoadmap.roadmap!;
    await client.decideWorkspaceGoal(created.id, {
      requestId: "client-approve-roadmap", targetRevisionId: roadmap.id, targetHash: roadmap.contentHash,
      kind: "approve_roadmap", approvedItemIds: ["typed_client"], actorId: "gateway",
    });
    await expect(client.startWorkspaceGoalTaskRun(created.id, { roadmapItemId: "typed_client", requestId: "client-start" }))
      .resolves.toMatchObject({ inboxItemId: "client-inbox", runId: "client-run", goal: { id: created.id } });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({goalId:created.id,requestId:"client-start",roadmapItem:expect.objectContaining({id:"typed_client"})}));
  });
});
