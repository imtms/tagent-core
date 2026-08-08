import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("gateway contracts schema v39", () => {
  it("migrates a v38-shaped database, is re-entrant, and fences interrupted effects", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-v39-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const seed = new Store(filename);
    seed.db.exec(`
      DROP TABLE workspace_goal_operation_receipts;
      DROP TABLE task_run_command_receipts;
      DROP TABLE session_create_receipts;
      ALTER TABLE event_consumers DROP COLUMN final_acked_seq;
      ALTER TABLE event_consumers DROP COLUMN settled_acked_seq;
      UPDATE schema_meta SET version=38;
    `);
    seed.close();

    const migrated = new Store(filename);
    expect(migrated.db.prepare("SELECT version FROM schema_meta WHERE id=1").pluck().get()).toBe(39);
    const columns = migrated.db.prepare("PRAGMA table_info(event_consumers)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["settled_acked_seq", "final_acked_seq"]));
    const session = migrated.createSession("v39");
    const run = migrated.createRun(session.id, "recover receipt");
    migrated.claimTaskRunCommand({ principalId: "gateway", taskRunId: run.id, commandId: "interrupted", commandType: "task_run.steer", canonicalPayload: "{}", targetAttemptId: null, requestId: "request" });
    migrated.close();

    const reopened = new Store(filename);
    expect(reopened.getTaskRunCommand("gateway", run.id, "interrupted")?.state).toBe("outcome_unknown");
    reopened.close();
    expect(() => {
      const again = new Store(filename);
      again.close();
    }).not.toThrow();
  });
});
