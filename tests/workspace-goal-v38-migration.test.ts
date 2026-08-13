import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { WorkspaceGoalService } from "@tagent/governance";
import { Store, createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite";

function persistence(store: Store) {
  return createGuardedLegacyStoreAdapter(store, { run: (work: () => unknown) => work() } as never);
}

describe("Workspace Goal execution schema v38 migration", () => {
  it("classifies legacy Roadmap links and backfills their item progress", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tagent-goal-v38-"));
    const filename = path.join(directory, "core.db");
    let store: Store | undefined;
    try {
      store = new Store(filename);
      const workspace = store.createSession("v37 Goal migration");
      const goals = new WorkspaceGoalService(persistence(store).workspaceGoals);
      const goal = goals.create({
        workspaceId: workspace.id,
        createdBy: "test",
        definition: {
          title: "Migrated Goal",
          outcome: "Preserve Roadmap execution state.",
          scope: [],
          nonGoals: [],
          criteria: [{ key: "done", title: "Work is done", required: true }],
          completionPolicy: "user_confirm",
        },
      });
      goals.decide({ goalId: goal.id, targetRevisionId: goal.definition!.id, targetHash: goal.definition!.contentHash, kind: "approve_goal", actorId: "user" });
      const roadmap = goals.addRoadmap(goal.id, {
        summary: "One item",
        items: [{ id: "deliver", title: "Deliver", outcome: "Delivered", verification: "Verify", criterionKeys: ["done"] }],
      }, null, "user");
      goals.decide({ goalId: goal.id, targetRevisionId: roadmap.id, targetHash: roadmap.contentHash, kind: "approve_roadmap", approvedItemIds: ["deliver"], actorId: "user" });
      const run = store.createRun(workspace.id, "deliver the Goal");
      goals.linkRun({ goalId: goal.id, runId: run.id, goalRevision: 1, roadmapRevisionId: roadmap.id, roadmapItemIds: ["deliver"], criterionKeys: ["done"], mode: "roadmap" });
      store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", run.attempt);
      store.close();
      store = undefined;

      const legacy = new Database(filename);
      legacy.pragma("foreign_keys = OFF");
      legacy.exec(`
        DROP TABLE workspace_goal_inbox_links;
        DROP TABLE workspace_goal_roadmap_item_progress;
        ALTER TABLE workspace_goal_run_links DROP COLUMN link_mode;
        UPDATE schema_meta SET version=37 WHERE id=1;
      `);
      legacy.close();

      store = new Store(filename);
      expect(store.getSchemaVersion()).toBe(43);
      expect(store.db.prepare("SELECT link_mode as mode FROM workspace_goal_run_links WHERE run_id=?").get(run.id)).toEqual({ mode: "roadmap" });
      expect(store.db.prepare(`SELECT item_id as itemId,status,run_id as runId,completed_at as completedAt
        FROM workspace_goal_roadmap_item_progress WHERE goal_id=? AND roadmap_revision_id=?`).get(goal.id, roadmap.id)).toEqual({
        itemId: "deliver",
        status: "completed",
        runId: run.id,
        completedAt: expect.any(Number),
      });
      store.db.prepare("UPDATE workspace_goal_run_links SET link_mode='invalid' WHERE run_id=?").run(run.id);
      store.close();
      store = undefined;
      expect(() => new Store(filename)).toThrow("invalid workspace_goal_run_links.link_mode");
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
