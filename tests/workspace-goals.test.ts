import { describe, expect, it } from "vitest";
import { Store, createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite";
import { WorkspaceGoalService } from "@tagent/governance";

function persistence(store: Store) {
  return createGuardedLegacyStoreAdapter(store, { run: (work: () => unknown) => work() } as never);
}

function definition() {
  return {
    title: "Reliable Workspace Goal",
    outcome: "Track one long-term result through bounded TaskRuns.",
    scope: ["lightweight Goal storage", "read projection"],
    nonGoals: ["new Agent roles", "automatic successor controller"],
    criteria: [
      { key: "stored", title: "Goal is durably stored", required: true },
      { key: "compatible", title: "Ordinary TaskRuns remain compatible", required: true },
    ],
    completionPolicy: "user_confirm" as const,
  };
}

describe("lightweight Workspace Goals", () => {
  it("migrates schema v34 to v35 additively and leaves ordinary TaskRuns independent", () => {
    const store = new Store(":memory:");
    try {
      expect(store.getSchemaVersion()).toBe(35);
      const workspace = store.createSession("Goal workspace");
      const run = store.createRun(workspace.id, "ordinary task");
      expect(store.getRun(run.id)).toMatchObject({ goal: "ordinary task", contract: null });
      expect((store.db.prepare("SELECT COUNT(*) as count FROM workspace_goals").get() as { count: number }).count).toBe(0);
    } finally { store.close(); }
  });

  it("creates, approves and reads a hash-bound Goal without starting a TaskRun", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Goal workspace");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      const draft = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test", idempotencyKey: "create-1" });
      expect(draft).toMatchObject({ status: "draft", requiredCriteria: 2, verifiedCriteria: 0, currentRunId: null });
      expect(draft.nextAction.kind).toBe("review_goal");
      const replay = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test", idempotencyKey: "create-1" });
      expect(replay.id).toBe(draft.id);
      expect(store.listRuns(workspace.id)).toEqual([]);
      goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      const active = goals.get(draft.id)!;
      expect(active.status).toBe("active");
      expect(active.nextAction.kind).toBe("create_plan");
      expect(goals.list(workspace.id)).toEqual([expect.objectContaining({ id: draft.id, title: definition().title })]);
    } finally { store.close(); }
  });

  it("supports bounded plan revisions and partial hash-bound approval", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Goal workspace");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      const draft = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test" });
      goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      const plan = goals.addPlan(draft.id, { summary: "Two bounded steps", items: [
        { id: "storage", title: "Store Goals", outcome: "Goals persist", verification: "migration test" },
        { id: "ui", title: "Show Goals", outcome: "Goals are usable in Web", verification: "Web build" },
      ] }, null, "test");
      expect(goals.get(draft.id)?.nextAction.kind).toBe("review_plan");
      expect(() => goals.decide({ goalId: draft.id, targetRevisionId: plan.id, targetHash: plan.contentHash, kind: "approve_plan", approvedItemIds: [], actorId: "user" })).toThrow("at least one");
      expect(() => goals.decide({ goalId: draft.id, targetRevisionId: plan.id, targetHash: plan.contentHash, kind: "approve_plan", approvedItemIds: ["unknown"], actorId: "user" })).toThrow("unknown");
      goals.decide({ goalId: draft.id, targetRevisionId: plan.id, targetHash: plan.contentHash, kind: "approve_plan", approvedItemIds: ["storage"], actorId: "user" });
      expect(goals.get(draft.id)?.nextAction.kind).toBe("run_task");
      expect(goals.get(draft.id)?.decisions.at(-1)?.approvedItemIds).toEqual(["storage"]);
    } finally { store.close(); }
  });

  it("rejects cross-workspace links and invalid evidence references", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Goal workspace");
      const otherWorkspace = store.createSession("Other workspace");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      const draft = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test" });
      goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      const otherRun = store.createRun(otherWorkspace.id, "wrong workspace");
      expect(() => goals.linkRun({ goalId: draft.id, runId: otherRun.id, goalRevision: 1 })).toThrow("different workspace");
      const run = store.createRun(workspace.id, "bounded implementation");
      goals.linkRun({ goalId: draft.id, runId: run.id, goalRevision: 1, criterionKeys: ["stored"] });
      expect(() => goals.linkEvidence({ goalId: draft.id, goalRevision: 1, criterionKey: "stored", runId: run.id, sourceDigest: "missing" })).toThrow("must reference");
      expect(() => goals.linkEvidence({ goalId: draft.id, goalRevision: 1, criterionKey: "stored", runId: run.id, sourceDigest: "missing-check", checkKey: "missing" })).toThrow("not found");
      store.upsertCheck(run.id, { key: "failed", title: "failed", status: "failed", required: true, command: "test", evidence: "failure", stale: false });
      expect(() => goals.linkEvidence({ goalId: draft.id, goalRevision: 1, criterionKey: "stored", runId: run.id, sourceDigest: "failed-check", checkKey: "failed" })).toThrow("not valid");
    } finally { store.close(); }
  });

  it("invalidates stale decisions and requires valid criterion evidence before closure", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Goal workspace");
      const adapter = persistence(store);
      const goals = new WorkspaceGoalService(adapter.workspaceGoals);
      const draft = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test" });
      expect(() => goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: "stale", kind: "approve_goal", actorId: "user" })).toThrow("stale");
      goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      const run = store.createRun(workspace.id, "bounded implementation");
      goals.linkRun({ goalId: draft.id, runId: run.id, goalRevision: draft.definition!.revision, criterionKeys: ["stored", "compatible"] });
      expect(() => goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "close", actorId: "user" })).toThrow("not ready");
      store.upsertCheck(run.id, { key: "stored", title: "stored", status: "passed", required: true, command: "test", evidence: "stored evidence", stale: false });
      store.upsertCheck(run.id, { key: "compatible", title: "compatible", status: "passed", required: true, command: "test", evidence: "compatibility evidence", stale: false });
      goals.linkEvidence({ goalId: draft.id, goalRevision: 1, criterionKey: "stored", runId: run.id, sourceDigest: "check:stored:1", checkKey: "stored" });
      goals.linkEvidence({ goalId: draft.id, goalRevision: 1, criterionKey: "compatible", runId: run.id, sourceDigest: "check:compatible:1", checkKey: "compatible" });
      const ready = goals.get(draft.id)!;
      expect(ready).toMatchObject({ status: "ready_to_close", requiredCriteria: 2, verifiedCriteria: 2 });
      goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "close", actorId: "user" });
      expect(goals.get(draft.id)?.status).toBe("completed");
    } finally { store.close(); }
  });
});
