import { describe, expect, it, vi } from "vitest";
import { createCoreApplication } from "@tagent/core-service/application";
import type { WorkspaceGoalRoadmapGenerator } from "@tagent/core-service/application";
import { WorkspaceGoalService } from "@tagent/governance";
import { Store } from "@tagent/persistence-sqlite";
import type { AttemptRuntimeFactory, AttemptRuntimePort, AttemptRuntimeSpec } from "@tagent/execution/ports";
import { corePersistence } from "./support/test-persistence.js";

class DeferredRuntime implements AttemptRuntimePort {
  private resolvePrompt?: () => void;
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  async steer() { return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
  async dispose() { await this.abort(); }
  getMessages() { return []; }
  getError() { return undefined; }
}

function definition() {
  return {
    title: "Directed Workspace",
    outcome: "Complete a durable cross-TaskRun outcome.",
    scope: ["this Workspace"],
    nonGoals: ["unrelated refactors"],
    criteria: [
      { key: "stored", title: "State is stored", required: true },
      { key: "verified", title: "Behavior is verified", required: true },
    ],
    completionPolicy: "user_confirm" as const,
  };
}

function createApprovedGoal(store: Store) {
  const workspace = store.createSession("Goal execution");
  const goals = new WorkspaceGoalService(corePersistence(store).workspaceGoals);
  const goal = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test" });
  goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "approve_goal", actorId: "user" });
  return { workspace, goals, goal };
}

function enqueueUnlinkedRoadmapItem(store: Store, input: {
  workspaceId: string;
  goalId: string;
  goalOutcome: string;
  item: { id: string; title: string; outcome: string; verification: string };
  requestId: string;
}) {
  const content = [
    `Advance Workspace Goal: ${input.goalOutcome}`,
    `Execute Goal Roadmap item: ${input.item.title}`,
    `Expected outcome: ${input.item.outcome}`,
    `Verification: ${input.item.verification}`,
  ].join("\n");
  return store.enqueueSessionInbox(input.workspaceId, content, {
    summary: input.item.title,
    objectives: [{ id: `roadmap-${input.item.id}`, summary: input.item.outcome, timing: "current", kind: "change" }],
    intent: "new_task",
    targetRunId: null,
    priority: 700,
    urgency: "normal",
    relation: "independent",
    acceptanceCriteria: [input.item.outcome, input.item.verification],
    scope: input.item.outcome,
    nonGoals: [],
    confidence: 1,
    reason: `Explicitly launched from Workspace Goal ${input.goalId} Roadmap item ${input.item.id}.`,
    routerVersion: "workspace-goal-roadmap-v1",
  }, input.requestId);
}

describe("Workspace Goal Core execution", () => {
  it("deduplicates the single initial Roadmap LLM call and requires user approval before execution", async () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    const generate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        summary: "Two bounded items",
        items: [
          { id: "persist", title: "Persist", outcome: "State is stored", verification: "Run storage tests", criterionKeys: ["stored"] },
          { id: "verify", title: "Verify", outcome: "Behavior is verified", verification: "Run behavior tests", criterionKeys: ["verified"] },
        ],
      };
    });
    const generator: WorkspaceGoalRoadmapGenerator = { model: "roadmap-light", generate };
    const service = createCoreApplication(corePersistence(store), "/tmp", () => new DeferredRuntime(), { workspaceGoalRoadmapGenerator: generator });
    try {
      const [first, duplicate] = await Promise.all([
        service.generateWorkspaceGoalRoadmap(goal.id, "user"),
        service.generateWorkspaceGoalRoadmap(goal.id, "user"),
      ]);
      expect(generate).toHaveBeenCalledOnce();
      expect(first.roadmap?.id).toBe(duplicate.roadmap?.id);
      expect(first).toMatchObject({ nextAction: { kind: "review_roadmap" }, roadmap: { createdBy: "user:llm:roadmap-light" } });
      expect(store.listRuns(workspace.id)).toEqual([]);
      await expect(service.generateWorkspaceGoalRoadmap(goal.id, "user")).rejects.toThrow("already has a Roadmap");
      expect(generate).toHaveBeenCalledOnce();

      const current = goals.get(goal.id)!;
      goals.decide({ goalId: goal.id, targetRevisionId: current.roadmap!.id, targetHash: current.roadmap!.contentHash, kind: "approve_roadmap", approvedItemIds: ["persist", "verify"], actorId: "user" });
      const started = service.startWorkspaceGoalRoadmapItem(goal.id, "persist", "start-persist");
      expect(started.run?.contract?.workspaceGoal).toMatchObject({
        goalId: goal.id,
        mode: "roadmap",
        targetRoadmapItemIds: ["persist"],
        targetCriterionKeys: ["stored"],
      });
      expect(started.run?.contract?.acceptanceCriteria).toContain("[Workspace Goal criterion stored] State is stored");
      expect(goals.get(goal.id)?.roadmapProgress).toContainEqual(expect.objectContaining({ itemId: "persist", status: "running", runId: started.run!.id }));

      const replay = service.startWorkspaceGoalRoadmapItem(goal.id, "persist", "start-persist");
      expect(replay.item.id).toBe(started.item.id);
      expect(replay.run?.id).toBe(started.run?.id);
      expect(() => service.startWorkspaceGoalRoadmapItem(goal.id, "verify", "start-persist")).toThrow("idempotency conflict");
      expect(() => service.startWorkspaceGoalRoadmapItem(goal.id, "persist", "start-persist-again")).toThrow("already has a running TaskRun");
      expect(store.listSessionInbox(workspace.id, true).filter((item) => item.status === "queued")).toEqual([]);
    } finally {
      await service.closeRuntimes();
      store.close();
    }
  });

  it("discards a late LLM Roadmap when the Goal changed during generation", async () => {
    const store = new Store(":memory:");
    const { goals, goal } = createApprovedGoal(store);
    let resolveGeneration!: (value: Awaited<ReturnType<WorkspaceGoalRoadmapGenerator["generate"]>>) => void;
    const generate = vi.fn(() => new Promise<Awaited<ReturnType<WorkspaceGoalRoadmapGenerator["generate"]>>>((resolve) => {
      resolveGeneration = resolve;
    }));
    const service = createCoreApplication(corePersistence(store), "/tmp", () => new DeferredRuntime(), {
      workspaceGoalRoadmapGenerator: { model: "roadmap-light", generate },
    });
    try {
      const pending = service.generateWorkspaceGoalRoadmap(goal.id, "user");
      const manual = goals.addRoadmap(goal.id, {
        summary: "User-authored Roadmap",
        items: [
          { id: "manual_store", title: "Store", outcome: "State is stored", verification: "Run storage tests", criterionKeys: ["stored"] },
          { id: "manual_verify", title: "Verify", outcome: "Behavior is verified", verification: "Run behavior tests", criterionKeys: ["verified"] },
        ],
      }, null, "user");
      resolveGeneration({
        summary: "Late LLM Roadmap",
        items: [
          { id: "late_store", title: "Late store", outcome: "State is stored", verification: "Run storage tests", criterionKeys: ["stored"] },
          { id: "late_verify", title: "Late verify", outcome: "Behavior is verified", verification: "Run behavior tests", criterionKeys: ["verified"] },
        ],
      });
      await expect(pending).rejects.toThrow("changed during Roadmap generation");
      expect(generate).toHaveBeenCalledOnce();
      expect(goals.get(goal.id)?.roadmap).toMatchObject({ id: manual.id, createdBy: "user" });
    } finally {
      await service.closeRuntimes();
      store.close();
    }
  });

  it("repairs a missing durable Roadmap Inbox link when the start request is replayed", async () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    const item = { id: "persist", title: "Persist", outcome: "State is stored", verification: "Run storage tests", criterionKeys: ["stored"] };
    const roadmap = goals.addRoadmap(goal.id, { summary: "Persist safely", items: [item] }, null, "user");
    goals.decide({ goalId: goal.id, targetRevisionId: roadmap.id, targetHash: roadmap.contentHash, kind: "approve_roadmap", approvedItemIds: [item.id], actorId: "user" });
    const service = createCoreApplication(corePersistence(store), "/tmp", () => new DeferredRuntime());
    try {
      enqueueUnlinkedRoadmapItem(store, { workspaceId: workspace.id, goalId: goal.id, goalOutcome: definition().outcome, item, requestId: "repair-roadmap-link" });
      const started = service.startWorkspaceGoalRoadmapItem(goal.id, item.id, "repair-roadmap-link");
      expect(started.run?.contract?.workspaceGoal).toMatchObject({ goalId: goal.id, mode: "roadmap", targetRoadmapItemIds: [item.id] });
      expect(goals.get(goal.id)?.runLinks).toContainEqual(expect.objectContaining({ runId: started.run!.id, mode: "roadmap" }));
    } finally {
      await service.closeRuntimes();
      store.close();
    }
  });

  it("fails closed when recovery finds a Roadmap submission without durable authorization", async () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    const service = createCoreApplication(corePersistence(store), "/tmp", () => new DeferredRuntime());
    try {
      const item = { id: "orphan", title: "Orphan", outcome: "State is stored", verification: "Run storage tests" };
      enqueueUnlinkedRoadmapItem(store, { workspaceId: workspace.id, goalId: goal.id, goalOutcome: definition().outcome, item, requestId: "orphan-roadmap-link" });
      expect(service.recoverSessionInbox()).toEqual([]);
      const run = store.listRuns(workspace.id)[0];
      expect(run).toMatchObject({ status: "failed", launchRetryable: true });
      expect(run.contract?.workspaceGoal).toBeUndefined();
      expect(goals.get(goal.id)?.runLinks).toEqual([]);
    } finally {
      await service.closeRuntimes();
      store.close();
    }
  });

  it("attaches Goal direction and context to an ordinary user-started Workspace TaskRun", async () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    goals.addRoadmap(goal.id, {
      summary: "Unapproved draft must not leak into execution",
      items: [{ id: "draft", title: "Draft", outcome: "Draft", verification: "Draft", criterionKeys: ["stored"] }],
    }, null, "user");
    const specs: AttemptRuntimeSpec[] = [];
    const runtimeFactory: AttemptRuntimeFactory = (spec) => { specs.push(spec); return new DeferredRuntime(); };
    const service = createCoreApplication(corePersistence(store), "/tmp", runtimeFactory);
    try {
      const admitted = await service.enqueueSessionInput(workspace.id, "Fix the bounded user-facing bug", "manual-goal-task");
      expect(admitted.run?.contract?.workspaceGoal).toMatchObject({
        goalId: goal.id,
        mode: "workspace",
        roadmapRevisionId: null,
        roadmapItems: [],
        targetRoadmapItemIds: [],
        targetCriterionKeys: [],
      });
      expect(admitted.run?.contract?.acceptanceCriteria.some((criterion) => criterion.startsWith("[Workspace Goal criterion"))).toBe(false);
      expect(goals.get(goal.id)?.runLinks).toContainEqual(expect.objectContaining({ runId: admitted.run!.id, mode: "workspace" }));
      expect(corePersistence(store).workspaceGoals.authorizeRunMutation(admitted.run!.id).allowed).toBe(true);
      expect(specs[0].systemPrompt).not.toContain("user-started TaskRun");
      expect(specs[0].dynamicContext?.()).toContain("user-started TaskRun");
      expect(specs[0].dynamicContext?.()).toContain("do not treat this Run as responsible for completing every Goal criterion");
      const manifest = store.getLatestContextManifest(admitted.run!.id)!;
      expect(manifest.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "taskrun_contract", selected: true }),
        expect.objectContaining({ kind: "workspace_goal", selected: true, sourceId: expect.stringContaining(goal.id) }),
      ]));
    } finally {
      await service.closeRuntimes();
      store.close();
    }
  });
});
