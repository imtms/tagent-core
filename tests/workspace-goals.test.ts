import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Store, createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite";
import {
  WorkspaceGoalService,
  workspaceGoalContentHash,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalRoadmap,
} from "@tagent/governance";
import { agentPersistence } from "./support/test-persistence.js";
import { recordSuccessfulBash, upsertTrustedCheck } from "./support/trusted-evidence.js";

function persistence(store: Store) {
  return createGuardedLegacyStoreAdapter(store, { run: (work: () => unknown) => work() } as never);
}

function definition(criteria: WorkspaceGoalDefinition["criteria"] = [
  { key: "stored", title: "Goal is durably stored", required: true },
  { key: "compatible", title: "TaskRuns remain compatible", required: true },
]): WorkspaceGoalDefinition {
  return {
    title: "Reliable Workspace Goal",
    outcome: "Track one long-term result through bounded TaskRuns.",
    scope: ["Goal storage", "TaskRun direction"],
    nonGoals: ["background polling", "automatic Goal closure"],
    criteria,
    completionPolicy: "user_confirm",
  };
}

function roadmap(items: WorkspaceGoalRoadmap["items"] = [
  { id: "storage", title: "Store Goals", outcome: "Goals persist", verification: "Run persistence tests", criterionKeys: ["stored"] },
  { id: "compatibility", title: "Keep TaskRuns compatible", outcome: "TaskRuns still launch", verification: "Run TaskRun tests", criterionKeys: ["compatible"] },
]): WorkspaceGoalRoadmap {
  return { summary: "Two bounded, independently verifiable TaskRuns", items };
}

function createApprovedGoal(store: Store, value = definition()) {
  const workspace = store.createSession("Goal workspace");
  const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
  const goal = goals.create({ workspaceId: workspace.id, definition: value, createdBy: "test" });
  goals.decide({
    goalId: goal.id,
    requestId: `approve:${goal.id}`,
    targetRevisionId: goal.definition!.id,
    targetHash: goal.definition!.contentHash,
    kind: "approve_goal",
    actorId: "user",
  });
  return { workspace, goals, goal };
}

function addApprovedRoadmap(goals: WorkspaceGoalService, goalId: string, value = roadmap(), approvedItemIds = value.items.map((item) => item.id)) {
  const revision = goals.addRoadmap(goalId, value, null, "test");
  goals.decide({
    goalId,
    requestId: `approve-roadmap:${revision.id}`,
    targetRevisionId: revision.id,
    targetHash: revision.contentHash,
    kind: "approve_roadmap",
    approvedItemIds,
    actorId: "user",
  });
  return revision;
}

describe("Workspace Goal Roadmap execution", () => {
  it("opens schema v39 additively and leaves TaskRuns independent when no Goal exists", () => {
    const store = new Store(":memory:");
    try {
      expect(store.getSchemaVersion()).toBe(39);
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_goal_roadmap_item_progress'").get()).toBeTruthy();
      const workspace = store.createSession("No Goal workspace");
      const run = store.createRun(workspace.id, "ordinary task");
      expect(store.getRun(run.id)).toMatchObject({ goal: "ordinary task", contract: null });
      expect(persistence(store).workspaceGoals.attachRun(run.id, null)).toBeNull();
      expect(persistence(store).workspaceGoals.authorizeRunMutation(run.id)).toEqual({ allowed: true, reason: "ordinary TaskRun is not Goal-governed" });
    } finally { store.close(); }
  });

  it("creates and approves a hash-bound Goal and Roadmap without starting work", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Goal lifecycle");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      const draft = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test", idempotencyKey: "create-1" });
      expect(goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test", idempotencyKey: "create-1" }).id).toBe(draft.id);
      expect(draft).toMatchObject({ status: "draft", currentRunId: null, nextAction: { kind: "review_goal" } });
      expect(draft.definition).not.toHaveProperty("contentJson");
      expect(() => goals.addRoadmap(draft.id, roadmap(), null, "user")).toThrow("approved Goal definition");
      goals.decide({ goalId: draft.id, targetRevisionId: draft.definition!.id, targetHash: draft.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      expect(goals.get(draft.id)).toMatchObject({ status: "active", nextAction: { kind: "generate_roadmap" } });

      const revision = goals.addRoadmap(draft.id, roadmap(), null, "user");
      expect(goals.get(draft.id)).toMatchObject({ nextAction: { kind: "review_roadmap" }, roadmap: { id: revision.id } });
      expect(() => goals.decide({ goalId: draft.id, targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: [], actorId: "user" })).toThrow("at least one");
      expect(() => goals.decide({ goalId: draft.id, targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: ["unknown"], actorId: "user" })).toThrow("unknown");
      goals.decide({ goalId: draft.id, targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: ["storage"], actorId: "user" });
      expect(goals.get(draft.id)).toMatchObject({
        nextAction: { kind: "run_roadmap_item", roadmapItemId: "storage" },
        roadmapProgress: [expect.objectContaining({ itemId: "storage", status: "pending" }), expect.objectContaining({ itemId: "compatibility", status: "unapproved" })],
      });
      expect(store.listRuns(workspace.id)).toEqual([]);
    } finally { store.close(); }
  });

  it("requires at least one evidence-bearing required criterion", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Required evidence");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      expect(() => goals.create({
        workspaceId: workspace.id,
        definition: definition([{ key: "optional", title: "Optional polish", required: false }]),
        createdBy: "test",
      })).toThrow("at least one required criterion");
    } finally { store.close(); }
  });

  it("allows only one active Goal to guide a Workspace", () => {
    const store = new Store(":memory:");
    try {
      const workspace = store.createSession("Single direction");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      const first = goals.create({ workspaceId: workspace.id, definition: definition(), createdBy: "test" });
      const second = goals.create({ workspaceId: workspace.id, definition: { ...definition(), title: "Second Goal" }, createdBy: "test" });
      goals.decide({ goalId: first.id, targetRevisionId: first.definition!.id, targetHash: first.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      expect(() => goals.decide({ goalId: second.id, targetRevisionId: second.definition!.id, targetHash: second.definition!.contentHash, kind: "approve_goal", actorId: "user" })).toThrow("another active workspace Goal");
      goals.decide({ goalId: first.id, targetRevisionId: first.definition!.id, targetHash: first.definition!.contentHash, kind: "pause", actorId: "user" });
      goals.decide({ goalId: second.id, targetRevisionId: second.definition!.id, targetHash: second.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      expect(goals.get(second.id)?.status).toBe("active");
    } finally { store.close(); }
  });

  it("attaches an immutable Goal-only snapshot to a user-started TaskRun before execution", () => {
    const store = new Store(":memory:");
    try {
      const { workspace, goals, goal } = createApprovedGoal(store);
      const run = store.createRun(workspace.id, "manually requested bounded task");
      goals.attachRun(run.id);
      const attached = store.getRun(run.id)!;
      expect(attached.contract?.workspaceGoal).toMatchObject({
        goalId: goal.id,
        mode: "workspace",
        definitionRevision: 1,
        roadmapRevisionId: null,
        targetRoadmapItemIds: [],
        targetCriterionKeys: [],
        criterionPrompts: [],
      });
      expect(attached.contract?.acceptanceCriteria.some((item) => item.startsWith("[Workspace Goal criterion"))).toBe(false);
      expect(goals.get(goal.id)?.runLinks).toEqual([expect.objectContaining({ runId: run.id, mode: "workspace", roadmapRevisionId: null, roadmapItemIds: [], criterionKeys: [] })]);
      expect(persistence(store).workspaceGoals.authorizeRunMutation(run.id)).toEqual({ allowed: true, reason: "User-started TaskRun follows the active Workspace Goal direction" });
    } finally { store.close(); }
  });

  it("embeds only an approved Roadmap slice and Goal criterion prompts in a Roadmap TaskRun", () => {
    const store = new Store(":memory:");
    try {
      const { workspace, goals, goal } = createApprovedGoal(store);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap(), ["storage"]);
      const run = store.createRun(workspace.id, "execute storage Roadmap item");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["stored"], mode: "roadmap" });
      const attached = store.getRun(run.id)!;
      expect(attached.contract?.workspaceGoal).toMatchObject({
        mode: "roadmap",
        roadmapRevisionId: revision.id,
        approvedRoadmapItemIds: ["storage"],
        targetRoadmapItemIds: ["storage"],
        targetCriterionKeys: ["stored"],
        roadmapItems: [expect.objectContaining({ id: "storage", criterionKeys: ["stored"] })],
      });
      expect(attached.contract?.acceptanceCriteria).toContain("[Workspace Goal criterion stored] Goal is durably stored");
      expect(persistence(store).workspaceGoals.authorizeRunMutation(run.id)).toEqual({ allowed: true, reason: "Goal Roadmap slice is approved" });
      expect(() => goals.linkRun({ goalId: goal.id, runId: store.createRun(workspace.id, "overreach").id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["compatible"], mode: "roadmap" })).toThrow("outside the selected Roadmap item");
      expect(() => goals.addRoadmap(goal.id, roadmap(), null, "user")).toThrow("while a guided TaskRun is active");
    } finally { store.close(); }
  });

  it("does not mark Roadmap items complete when an ordinary guided TaskRun finishes", () => {
    const store = new Store(":memory:");
    try {
      const { workspace, goals, goal } = createApprovedGoal(store);
      addApprovedRoadmap(goals, goal.id, roadmap(), ["storage"]);
      const run = store.createRun(workspace.id, "manual maintenance task");
      goals.attachRun(run.id);
      expect(store.getRun(run.id)?.contract?.workspaceGoal).toMatchObject({
        mode: "workspace",
        roadmapRevisionId: null,
        approvedRoadmapItemIds: [],
        targetRoadmapItemIds: [],
        roadmapItems: [],
        targetCriterionKeys: [],
      });
      store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", run.attempt);
      goals.recordRunOutcome(run.id);
      expect(goals.get(goal.id)).toMatchObject({
        currentRunId: null,
        roadmapProgress: expect.arrayContaining([expect.objectContaining({ itemId: "storage", status: "pending", runId: null })]),
      });
    } finally { store.close(); }
  });

  it("reuses Supervisor criterion coverage to complete a Roadmap item and link Core-validated evidence", () => {
    const store = new Store(":memory:");
    try {
      const value = definition([{ key: "stored", title: "Goal is durably stored", required: true }]);
      const { workspace, goals, goal } = createApprovedGoal(store, value);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap([{ id: "storage", title: "Store", outcome: "Stored", verification: "Run test", criterionKeys: ["stored"] }]));
      const run = store.createRun(workspace.id, "execute storage");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["stored"], mode: "roadmap" });
      upsertTrustedCheck(store, run.id, { key: "storage-test", title: "Storage test", command: "npm test -- storage" });
      const prompt = store.getRun(run.id)!.contract!.workspaceGoal!.criterionPrompts[0].prompt;
      store.recordGateEvaluation({
        id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq: 1, gateType: "contract",
        evaluator: "llm", evaluatorModel: "supervisor-test", summary: "covered", passed: true, failures: [],
        criterionCoverage: [{ criterion: prompt, status: "covered", evidenceRefs: ["check:storage-test"], reason: "The successful test verifies storage." }],
        inputManifestHash: "manifest", createdAt: Date.now(),
      });
      store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", run.attempt);
      goals.recordRunOutcome(run.id);
      expect(goals.get(goal.id)).toMatchObject({
        status: "ready_to_close",
        verifiedCriteria: 1,
        currentRunId: null,
        roadmapProgress: [expect.objectContaining({ itemId: "storage", status: "completed", runId: run.id })],
        evidenceLinks: [expect.objectContaining({ criterionKey: "stored", runId: run.id, checkKey: "storage-test", status: "valid" })],
      });
    } finally { store.close(); }
  });

  it("harvests actual covered and contradicted Supervisor evidence when a Goal TaskRun blocks", () => {
    const store = new Store(":memory:");
    try {
      const { workspace, goals, goal } = createApprovedGoal(store);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap([
        { id: "audit", title: "Audit", outcome: "Audit both criteria", verification: "Inspect receipts", criterionKeys: ["stored", "compatible"] },
      ]));
      const run = store.createRun(workspace.id, "audit Goal evidence");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["audit"], criterionKeys: ["stored", "compatible"], mode: "roadmap" });
      const storedReceipt = recordSuccessfulBash(store, run.id, "echo stored");
      const contradictionReceipt = recordSuccessfulBash(store, run.id, "echo incompatible");
      const prompts = new Map(store.getRun(run.id)!.contract!.workspaceGoal!.criterionPrompts.map((item) => [item.key, item.prompt]));
      store.recordGateEvaluation({
        id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq: 1, gateType: "contract",
        evaluator: "llm", evaluatorModel: "supervisor-test", summary: "partial and contradicted", passed: false, failures: [],
        criterionCoverage: [
          { criterion: prompts.get("stored")!, status: "covered", evidenceRefs: [`operation:${storedReceipt.id}`], reason: "Storage receipt is valid." },
          { criterion: prompts.get("compatible")!, status: "contradicted", evidenceRefs: [`operation:${contradictionReceipt.id}`], reason: "Compatibility receipt shows a conflict." },
        ],
        inputManifestHash: "manifest", createdAt: Date.now(),
      });
      store.transitionRun(run.id, ["running"], "blocked", "run.blocked", { reason: "compatibility conflict" }, "blocked", run.attempt);
      goals.recordRunOutcome(run.id);
      expect(goals.get(goal.id)).toMatchObject({
        status: "active",
        currentRunId: run.id,
        verifiedCriteria: 1,
        roadmapProgress: [expect.objectContaining({ itemId: "audit", status: "blocked", runId: run.id })],
        evidenceLinks: expect.arrayContaining([
          expect.objectContaining({ criterionKey: "stored", operationId: storedReceipt.id, status: "valid" }),
          expect.objectContaining({ criterionKey: "compatible", operationId: contradictionReceipt.id, status: "contradicted" }),
        ]),
      });
      store.db.prepare("UPDATE runs SET attempt=attempt+1 WHERE id=?").run(run.id);
      expect(goals.get(goal.id)?.evidenceLinks).toEqual(expect.arrayContaining([
        expect.objectContaining({ criterionKey: "stored", status: "stale" }),
        expect.objectContaining({ criterionKey: "compatible", status: "stale" }),
      ]));
    } finally { store.close(); }
  });

  it("returns resolve_problem for a blocked Goal TaskRun", () => {
    const store = new Store(":memory:");
    try {
      const value = definition([{ key: "stored", title: "Stored", required: true }]);
      const { workspace, goals, goal } = createApprovedGoal(store, value);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap([{ id: "storage", title: "Store", outcome: "Stored", verification: "Run test", criterionKeys: ["stored"] }]));
      const run = store.createRun(workspace.id, "blocked storage");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["stored"], mode: "roadmap" });
      store.transitionRun(run.id, ["running"], "blocked", "run.blocked", { reason: "external input" }, "blocked", run.attempt);
      goals.recordRunOutcome(run.id);
      expect(goals.get(goal.id)).toMatchObject({
        currentRunId: run.id,
        nextAction: { kind: "resolve_problem" },
        roadmapProgress: [expect.objectContaining({ itemId: "storage", status: "blocked", runId: run.id })],
      });
      const adapter = agentPersistence(store);
      const sourceAttempt = adapter.attempts.getAttemptForRun(run.id, run.attempt)!;
      adapter.taskRunTransitions.transitionSystem({
        kind: "resume_manual",
        attemptId: sourceAttempt.id,
        expectedVersion: sourceAttempt.version,
        reason: "retry after resolving the blocker",
      }, { kind: "manual_resume", actorId: "user" });
      expect(goals.get(goal.id)).toMatchObject({
        currentRunId: run.id,
        nextAction: { kind: "view_running_task" },
        roadmapProgress: [expect.objectContaining({ itemId: "storage", status: "running", runId: run.id })],
      });
    } finally { store.close(); }
  });

  it("rejects fake evidence, cross-criterion overreach, and arbitrary artifact URIs", () => {
    const store = new Store(":memory:");
    try {
      const { workspace, goals, goal } = createApprovedGoal(store);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap(), ["storage"]);
      const run = store.createRun(workspace.id, "evidence boundary");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["stored"], mode: "roadmap" });
      store.upsertCheck(run.id, { key: "fake", title: "Fake", status: "passed", required: true, command: "echo fake", evidence: "agent-authored", stale: false });
      expect(() => goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: run.id, checkKey: "fake" })).toThrow("successful current-Attempt Bash receipt");
      expect(() => goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: run.id, checkKey: "fake", status: "contradicted" })).toThrow("successful current-Attempt Bash receipt");
      upsertTrustedCheck(store, run.id, { key: "real", title: "Real", command: "echo real" });
      expect(() => goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "compatible", runId: run.id, checkKey: "real" })).toThrow("not authorized");
      store.addArtifact(run.id, { id: "fake-artifact", title: "Fake", kind: "report", content: "", uri: "artifact://claimed-only" });
      expect(() => goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: run.id, artifactId: "fake-artifact" })).toThrow("artifact receipt");
      const operation = recordSuccessfulBash(store, run.id, "echo receipt");
      expect(goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: run.id, operationId: operation.id })).toMatchObject({ status: "valid" });
    } finally { store.close(); }
  });

  it("counts evidence only for the current Goal definition revision", () => {
    const store = new Store(":memory:");
    try {
      const value = definition([{ key: "stored", title: "Stored v1", required: true }]);
      const { workspace, goals, goal } = createApprovedGoal(store, value);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap([{ id: "storage", title: "Store", outcome: "Stored", verification: "Verify", criterionKeys: ["stored"] }]));
      const run = store.createRun(workspace.id, "revision evidence");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["stored"], mode: "roadmap" });
      const operation = recordSuccessfulBash(store, run.id, "echo stored");
      goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: run.id, operationId: operation.id });
      expect(goals.get(goal.id)?.verifiedCriteria).toBe(1);
      store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", run.attempt);
      goals.recordRunOutcome(run.id);
      const next = goals.reviseDefinition(goal.id, definition([{ key: "stored", title: "Stored v2", required: true }]), "user");
      expect(goals.get(goal.id)).toMatchObject({ status: "draft", verifiedCriteria: 0 });
      goals.decide({ goalId: goal.id, targetRevisionId: next.id, targetHash: next.contentHash, kind: "approve_goal", actorId: "user" });
      expect(goals.get(goal.id)).toMatchObject({ status: "active", verifiedCriteria: 0, evidenceLinks: [expect.objectContaining({ goalRevision: 1 })] });
    } finally { store.close(); }
  });

  it("keeps a Goal active until its evidence-producing TaskRun is terminal", () => {
    const store = new Store(":memory:");
    try {
      const value = definition([{ key: "stored", title: "Stored", required: true }]);
      const { workspace, goals, goal } = createApprovedGoal(store, value);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap([
        { id: "storage", title: "Store", outcome: "Stored", verification: "Verify", criterionKeys: ["stored"] },
      ]));
      const run = store.createRun(workspace.id, "produce evidence while still running");
      goals.linkRun({
        goalId: goal.id,
        runId: run.id,
        goalRevision: 1,
        roadmapRevisionId: revision.id,
        roadmapItemIds: ["storage"],
        criterionKeys: ["stored"],
        mode: "roadmap",
      });
      const operation = recordSuccessfulBash(store, run.id, "echo stored");
      goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: run.id, operationId: operation.id });
      expect(goals.get(goal.id)).toMatchObject({ status: "active", verifiedCriteria: 1, currentRunId: run.id });

      store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", run.attempt);
      goals.recordRunOutcome(run.id);
      expect(goals.get(goal.id)).toMatchObject({ status: "ready_to_close", currentRunId: null });
    } finally { store.close(); }
  });

  it("tracks another active guided TaskRun when the latest linked Run finishes", () => {
    const store = new Store(":memory:");
    try {
      const { workspace, goals, goal } = createApprovedGoal(store);
      const first = store.createRun(workspace.id, "first manual task");
      const second = store.createRun(workspace.id, "second manual task");
      goals.attachRun(first.id);
      goals.attachRun(second.id);
      expect(goals.get(goal.id)?.currentRunId).toBe(second.id);
      expect(() => goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "pause", actorId: "user" })).toThrow("guided TaskRun is active");

      store.transitionRun(second.id, ["running"], "completed", "run.completed", {}, "done", second.attempt);
      goals.recordRunOutcome(second.id);
      expect(goals.get(goal.id)).toMatchObject({ status: "active", currentRunId: first.id });
    } finally { store.close(); }
  });

  it("keeps Roadmap approval paused and treats decisions without request IDs as distinct actions", () => {
    const store = new Store(":memory:");
    try {
      const { goals, goal } = createApprovedGoal(store);
      const revision = goals.addRoadmap(goal.id, roadmap(), null, "user");
      goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "pause", actorId: "user" });
      goals.decide({ goalId: goal.id, targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: ["storage"], actorId: "user" });
      expect(goals.get(goal.id)).toMatchObject({ status: "paused", activeRoadmapRevisionId: revision.id, nextAction: { kind: "resume" } });

      goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "resume", actorId: "user" });
      goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "pause", actorId: "user" });
      const current = goals.get(goal.id)!;
      expect(current.status).toBe("paused");
      expect(current.decisions.filter((decision) => decision.kind === "pause")).toHaveLength(2);
    } finally { store.close(); }
  });

  it("lets a user-started TaskRun continue Goal guidance from ready-to-close and reopens the Goal", () => {
    const store = new Store(":memory:");
    try {
      const value = definition([{ key: "stored", title: "Stored", required: true }]);
      const { workspace, goals, goal } = createApprovedGoal(store, value);
      const revision = addApprovedRoadmap(goals, goal.id, roadmap([
        { id: "storage", title: "Store", outcome: "Stored", verification: "Verify", criterionKeys: ["stored"] },
      ]));
      const evidenceRun = store.createRun(workspace.id, "complete the Goal criterion");
      goals.linkRun({ goalId: goal.id, runId: evidenceRun.id, goalRevision: 1, roadmapRevisionId: revision.id, roadmapItemIds: ["storage"], criterionKeys: ["stored"], mode: "roadmap" });
      const operation = recordSuccessfulBash(store, evidenceRun.id, "echo stored");
      goals.linkEvidence({ goalId: goal.id, goalRevision: 1, criterionKey: "stored", runId: evidenceRun.id, operationId: operation.id });
      store.transitionRun(evidenceRun.id, ["running"], "completed", "run.completed", {}, "done", evidenceRun.attempt);
      goals.recordRunOutcome(evidenceRun.id);
      expect(goals.get(goal.id)?.status).toBe("ready_to_close");

      const manualRun = store.createRun(workspace.id, "user requested one more bounded change");
      goals.attachRun(manualRun.id);
      expect(goals.get(goal.id)).toMatchObject({ status: "active", currentRunId: manualRun.id });
      expect(store.getRun(manualRun.id)?.contract?.workspaceGoal).toMatchObject({ goalId: goal.id, mode: "workspace" });
    } finally { store.close(); }
  });

  it("invalidates only the approval targeted by a change request", () => {
    const store = new Store(":memory:");
    try {
      const { goals, goal } = createApprovedGoal(store);
      const firstRoadmap = addApprovedRoadmap(goals, goal.id, roadmap(), ["storage"]);
      goals.decide({
        goalId: goal.id,
        requestId: "change-roadmap",
        targetRevisionId: firstRoadmap.id,
        targetHash: firstRoadmap.contentHash,
        kind: "request_change",
        actorId: "user",
      });
      expect(goals.get(goal.id)).toMatchObject({
        status: "active",
        activeDefinitionRevisionId: goal.definition!.id,
        activeRoadmapRevisionId: null,
        nextAction: { kind: "review_roadmap" },
        roadmapProgress: expect.arrayContaining([expect.objectContaining({ itemId: "storage", status: "unapproved" })]),
      });

      const secondRoadmap = goals.addRoadmap(goal.id, roadmap(), null, "user");
      goals.decide({ goalId: goal.id, targetRevisionId: secondRoadmap.id, targetHash: secondRoadmap.contentHash, kind: "approve_roadmap", approvedItemIds: ["storage"], actorId: "user" });
      goals.decide({
        goalId: goal.id,
        requestId: "change-definition",
        targetRevisionId: goal.definition!.id,
        targetHash: goal.definition!.contentHash,
        kind: "request_change",
        actorId: "user",
      });
      expect(goals.get(goal.id)).toMatchObject({
        status: "draft",
        activeDefinitionRevisionId: null,
        activeRoadmapRevisionId: null,
        nextAction: { kind: "review_goal" },
      });
    } finally { store.close(); }
  });

  it("does not let a change request for an old Roadmap invalidate the active revision", () => {
    const store = new Store(":memory:");
    try {
      const { goals, goal } = createApprovedGoal(store);
      const first = addApprovedRoadmap(goals, goal.id, roadmap(), ["storage"]);
      const second = goals.addRoadmap(goal.id, {
        ...roadmap(),
        summary: "Second Roadmap revision",
      }, null, "user");
      goals.decide({ goalId: goal.id, targetRevisionId: second.id, targetHash: second.contentHash, kind: "approve_roadmap", approvedItemIds: ["storage"], actorId: "user" });
      expect(() => goals.decide({
        goalId: goal.id,
        targetRevisionId: first.id,
        targetHash: first.contentHash,
        kind: "request_change",
        actorId: "user",
      })).toThrow("active Roadmap revision");
      expect(goals.get(goal.id)?.activeRoadmapRevisionId).toBe(second.id);
    } finally { store.close(); }
  });

  it("rejects a Roadmap whose criterion mapping belongs to an older Goal definition", () => {
    const store = new Store(":memory:");
    try {
      const { goals, goal } = createApprovedGoal(store);
      const staleRoadmap = goals.addRoadmap(goal.id, roadmap(), null, "user");
      const revised = goals.reviseDefinition(goal.id, definition([
        { key: "new-criterion", title: "New required outcome", required: true },
      ]), "user");
      goals.decide({ goalId: goal.id, targetRevisionId: revised.id, targetHash: revised.contentHash, kind: "approve_goal", actorId: "user" });
      expect(() => goals.decide({
        goalId: goal.id,
        targetRevisionId: staleRoadmap.id,
        targetHash: staleRoadmap.contentHash,
        kind: "approve_roadmap",
        approvedItemIds: ["storage"],
        actorId: "user",
      })).toThrow("outside the active Goal definition");
    } finally { store.close(); }
  });

  it("normalizes legacy Roadmap items that predate criterionKeys", () => {
    const store = new Store(":memory:");
    try {
      const { goals, goal } = createApprovedGoal(store);
      const revision = goals.addRoadmap(goal.id, roadmap([{ id: "legacy", title: "Legacy", outcome: "Works", verification: "Test", criterionKeys: ["stored"] }]), null, "test");
      const legacyContent = { summary: "Legacy", items: [{ id: "legacy", title: "Legacy", outcome: "Works", verification: "Test" }] };
      store.db.prepare("UPDATE workspace_goal_revisions SET content_json=?,content_hash=? WHERE id=?").run(JSON.stringify(legacyContent), workspaceGoalContentHash(legacyContent), revision.id);
      const legacyRevision = goals.get(goal.id)!.roadmap!;
      expect((legacyRevision.content as WorkspaceGoalRoadmap).items[0].criterionKeys).toEqual([]);
      expect(() => goals.decide({ goalId: goal.id, targetRevisionId: legacyRevision.id, targetHash: legacyRevision.contentHash, kind: "approve_roadmap", approvedItemIds: ["legacy"], actorId: "user" })).toThrow("create a new revision");
    } finally { store.close(); }
  });

  it("preserves decision idempotency and terminal monotonicity", () => {
    const store = new Store(":memory:");
    try {
      const { goals, goal } = createApprovedGoal(store);
      const revision = goals.addRoadmap(goal.id, roadmap(), null, "test");
      goals.decide({ goalId: goal.id, requestId: "approve-roadmap", targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: ["storage"], actorId: "user" });
      expect(() => goals.decide({ goalId: goal.id, requestId: "approve-roadmap", targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: ["compatibility"], actorId: "user" })).toThrow("idempotency conflict");
      expect(() => goals.decide({ goalId: goal.id, requestId: "approve-roadmap-again", targetRevisionId: revision.id, targetHash: revision.contentHash, kind: "approve_roadmap", approvedItemIds: ["storage"], actorId: "user" })).toThrow("already approved");
      const cancelled = goals.decide({ goalId: goal.id, requestId: "cancel", targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "cancel", actorId: "user" });
      const replay = goals.decide({ goalId: goal.id, requestId: "cancel", targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "cancel", actorId: "user" });
      expect(replay.id).toBe(cancelled.id);
      expect(() => goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "resume", actorId: "user" })).toThrow("terminal");
    } finally { store.close(); }
  });
});
