import { describe, expect, it, vi } from "vitest";
import { createCoreApplication } from "@tagent/core-service/application";
import type { WorkspaceGoalRoadmapGenerator } from "@tagent/core-service/application";
import { OpenAiWorkspaceGoalRoadmapGenerator } from "../apps/core-service/src/composition/workspace-goal-roadmap-generator.js";
import { credentialReference } from "@tagent/execution/ports";
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
  it("starts the Roadmap response timeout after credential resolution", async () => {
    const original = globalThis.fetch;
    let fetchSignalAborted = true;
    globalThis.fetch = async (_url, init) => {
      fetchSignalAborted = (init?.signal as AbortSignal | undefined)?.aborted ?? false;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Bounded", items: [
        { id: "store", title: "Store", outcome: "State is stored", verification: "Check storage", criterionKeys: ["stored"] },
        { id: "verify", title: "Verify", outcome: "Behavior is verified", verification: "Check behavior", criterionKeys: ["verified"] },
      ] }) } }] }), { status: 200 });
    };
    try {
      const generator = new OpenAiWorkspaceGoalRoadmapGenerator({
        model: { id: "roadmap-model", provider: "test", api: "openai-completions", baseUrl: "https://roadmap.test/v1", contextWindow: 32_000, maxTokens: 2_048 },
        credential: {
          reference: credentialReference("SLOW_ROADMAP_API_KEY"),
          resolver: {
            configured: async () => true,
            resolve: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return "secret"; },
          },
        },
        timeoutMs: 10,
      });
      await expect(generator.generate({ goalId: "goal-1", definition: definition() })).resolves.toMatchObject({ summary: "Bounded" });
      expect(fetchSignalAborted).toBe(false);
    } finally { globalThis.fetch = original; }
  });

  it("distinguishes Roadmap credential and response-header failures", async () => {
    const original = globalThis.fetch;
    const model = { id: "roadmap-model", provider: "test", api: "openai-completions", baseUrl: "https://roadmap.test/v1", contextWindow: 32_000, maxTokens: 2_048 } as const;
    try {
      const fetchProbe = vi.fn<typeof fetch>();
      globalThis.fetch = fetchProbe;
      const failedCredential = new OpenAiWorkspaceGoalRoadmapGenerator({
        model,
        credential: {
          reference: credentialReference("FAILED_ROADMAP_API_KEY"),
          resolver: { configured: async () => true, resolve: async () => { throw new Error("vault unavailable"); } },
        },
        timeoutMs: 10,
      });
      await expect(failedCredential.generate({ goalId: "goal-1", definition: definition() })).rejects.toThrow("credential resolution failed");
      expect(fetchProbe).not.toHaveBeenCalled();

      globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const fail = () => reject(signal.reason);
        if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
      });
      const stalledHeaders = new OpenAiWorkspaceGoalRoadmapGenerator({
        model,
        credential: {
          reference: credentialReference("TEST_ROADMAP_API_KEY"),
          resolver: { configured: async () => true, resolve: async () => "secret" },
        },
        timeoutMs: 10,
      });
      await expect(stalledHeaders.generate({ goalId: "goal-1", definition: definition() })).rejects.toThrow("response headers timed out");
    } finally { globalThis.fetch = original; }
  });

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
    let runtimeSpec: AttemptRuntimeSpec | undefined;
    const service = createCoreApplication({
      persistence: corePersistence(store),
      workspace: "/tmp",
      runtimeFactory: (spec) => { runtimeSpec = spec; return new DeferredRuntime(); },
      runtimeDefaults: { workspaceGoalRoadmapGenerator: generator }
    });
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
      expect(runtimeSpec?.attemptContext).toContain("State is stored");
      expect(runtimeSpec?.attemptContext).not.toContain("Behavior is verified");

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
    const service = createCoreApplication({
      persistence: corePersistence(store),
      workspace: "/tmp",
      runtimeFactory: () => new DeferredRuntime(),
      runtimeDefaults: {
        workspaceGoalRoadmapGenerator: { model: "roadmap-light", generate },
      }
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
    const service = createCoreApplication({
      persistence: corePersistence(store),
      workspace: "/tmp",
      runtimeFactory: () => new DeferredRuntime()
    });
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

  it("keeps a Goal-linked Inbox item immutable and attaches its Run inside claim", () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    const item = { id: "persist", title: "Persist", outcome: "State is stored", verification: "Run storage tests", criterionKeys: ["stored"] };
    const roadmap = goals.addRoadmap(goal.id, { summary: "Persist safely", items: [item] }, null, "user");
    goals.decide({ goalId: goal.id, targetRevisionId: roadmap.id, targetHash: roadmap.contentHash, kind: "approve_roadmap", approvedItemIds: [item.id], actorId: "user" });
    try {
      const queued = enqueueUnlinkedRoadmapItem(store, { workspaceId: workspace.id, goalId: goal.id, goalOutcome: definition().outcome, item, requestId: "immutable-roadmap" });
      goals.linkInbox({ goalId: goal.id, inboxItemId: queued.id, goalRevision: 1, roadmapRevisionId: roadmap.id, roadmapItemIds: [item.id], criterionKeys: item.criterionKeys });
      expect(goals.get(goal.id)?.roadmapProgress).toContainEqual(expect.objectContaining({
        itemId: item.id, status: "pending", queueStatus: "queued", inboxItemId: queued.id, runId: null,
      }));
      const unrelated = store.enqueueSessionInbox(workspace.id, "ordinary", { ...queued.analysis, routerVersion: "ordinary", reason: "ordinary" }, "ordinary");
      expect(store.updateSessionInboxItem(queued.id, workspace.id, "Delete unrelated files", { ...queued.analysis, summary: "Delete unrelated files" })).toBeUndefined();
      expect(store.mergeSessionInboxItems(unrelated.id, queued.id, workspace.id)).toBe(false);
      expect(store.mergeSessionInboxItems(queued.id, unrelated.id, workspace.id)).toBe(false);
      expect(store.deleteSessionInboxItem(queued.id, workspace.id)).toBe(false);
      expect(store.decideSessionInboxItem(queued.id, workspace.id, "defer")).toBe(false);

      const claimed = store.claimSessionInboxNow(queued.id, workspace.id);
      expect(claimed).toMatchObject({ status: "started", run: { contract: { sourceInput: expect.stringContaining("Persist"), workspaceGoal: { goalId: goal.id, mode: "roadmap", targetRoadmapItemIds: [item.id] } } } });
      if (claimed.status !== "started") throw new Error("Goal Inbox item did not start");
      expect(goals.get(goal.id)?.roadmapProgress).toContainEqual(expect.objectContaining({
        itemId: item.id, status: "running", queueStatus: null, inboxItemId: null, runId: claimed.run.id,
      }));
      expect(corePersistence(store).workspaceGoals.authorizeRunMutation(claimed.run.id)).toEqual({ allowed: true, reason: "Goal Roadmap slice is approved" });
    } finally { store.close(); }
  });

  it("fails closed when an internal Roadmap Run has no durable Run link", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Missing Goal Run link");
      const run = store.createRun(workspace.id, "orphan", undefined, {
        sourceInput: "orphan", summary: "orphan", objectives: [{ id: "roadmap-orphan", summary: "orphan", timing: "current", kind: "change" }],
        acceptanceCriteria: [], scope: "orphan", nonGoals: [], sourceInboxIds: [], parentRunId: null,
        relation: "independent", intent: "new_task", decisionReason: "orphan", routerVersion: "workspace-goal-roadmap-v1",
      });
      expect(corePersistence(store).workspaceGoals.authorizeRunMutation(run.id)).toEqual({
        allowed: false,
        reason: "Workspace Goal Roadmap TaskRun is missing its durable Run authorization",
      });
    } finally { store.close(); }
  });

  it("fails closed when recovery finds a Roadmap submission without durable authorization", async () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    const service = createCoreApplication({
      persistence: corePersistence(store),
      workspace: "/tmp",
      runtimeFactory: () => new DeferredRuntime()
    });
    try {
      const item = { id: "orphan", title: "Orphan", outcome: "State is stored", verification: "Run storage tests" };
      enqueueUnlinkedRoadmapItem(store, { workspaceId: workspace.id, goalId: goal.id, goalOutcome: definition().outcome, item, requestId: "orphan-roadmap-link" });
      expect(service.recoverSessionInbox()).toEqual([]);
      const run = store.listRuns(workspace.id)[0];
      expect(run).toMatchObject({ status: "failed", launchRetryable: false });
      expect(run.contract?.workspaceGoal).toBeUndefined();
      expect(goals.get(goal.id)?.runLinks).toEqual([]);
    } finally {
      await service.closeRuntimes();
      store.close();
    }
  });

  it("rejects a started requestId when the active Roadmap revision changes", async () => {
    const store = new Store(":memory:");
    const { workspace, goals, goal } = createApprovedGoal(store);
    const content = { summary: "Stable item", items: [
      { id: "persist", title: "Persist", outcome: "State is stored", verification: "Run storage tests", criterionKeys: ["stored"] },
    ] };
    const firstRoadmap = goals.addRoadmap(goal.id, content, null, "user");
    goals.decide({ goalId: goal.id, targetRevisionId: firstRoadmap.id, targetHash: firstRoadmap.contentHash, kind: "approve_roadmap", approvedItemIds: ["persist"], actorId: "user" });
    const service = createCoreApplication({ persistence: corePersistence(store), workspace: "/tmp", runtimeFactory: () => new DeferredRuntime() });
    try {
      const first = service.startWorkspaceGoalRoadmapItem(goal.id, "persist", "stable-start");
      store.transitionRun(first.run!.id, ["running"], "completed", "run.completed", {}, "done", first.run!.attempt);
      goals.recordRunOutcome(first.run!.id);
      const secondRoadmap = goals.addRoadmap(goal.id, content, null, "user");
      goals.decide({ goalId: goal.id, targetRevisionId: secondRoadmap.id, targetHash: secondRoadmap.contentHash, kind: "approve_roadmap", approvedItemIds: ["persist"], actorId: "user" });
      expect(() => service.startWorkspaceGoalRoadmapItem(goal.id, "persist", "stable-start")).toThrow("idempotency conflict");
      expect(goals.get(goal.id)?.roadmapProgress).toContainEqual(expect.objectContaining({ itemId: "persist", status: "pending" }));
      expect(store.listRuns(workspace.id)).toHaveLength(1);
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
    const service = createCoreApplication({
      persistence: corePersistence(store),
      workspace: "/tmp",
      runtimeFactory: runtimeFactory
    });
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
      expect(specs[0].attemptContext).toContain("user-started TaskRun");
      expect(specs[0].attemptContext).toContain("do not treat this Run as responsible for completing every Goal criterion");
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
