import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite";
import Database from "better-sqlite3";

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
    expect(migrated.db.prepare("SELECT version FROM schema_meta WHERE id=1").pluck().get()).toBe(43);
    const columns = migrated.db.prepare("PRAGMA table_info(event_consumers)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["settled_acked_seq", "final_acked_seq"]));
    const created = migrated.createSessionIdempotent({
      principalId: "gateway",
      idempotencyKey: "restart-session",
      title: "v39",
      canonicalPayload: JSON.stringify({ title: "v39" }),
    });
    const session = created.session;
    const run = migrated.createRun(session.id, "recover receipt");
    migrated.claimTaskRunCommand({ principalId: "gateway", taskRunId: run.id, commandId: "interrupted", commandType: "task_run.steer", canonicalPayload: "{}", targetAttemptId: null, requestId: "request" });
    migrated.close();

    const reopened = new Store(filename);
    const replayed = reopened.createSessionIdempotent({
      principalId: "gateway",
      idempotencyKey: "restart-session",
      title: "v39",
      canonicalPayload: JSON.stringify({ title: "v39" }),
    });
    expect(replayed).toMatchObject({ replayed: true, session: { id: session.id } });
    expect(reopened.listSessions()).toHaveLength(1);
    expect(reopened.getTaskRunCommand("gateway", run.id, "interrupted")?.state).toBe("outcome_unknown");
    reopened.close();
    expect(() => {
      const again = new Store(filename);
      again.close();
    }).not.toThrow();
  });

  it.each([
    {
      name: "receipt columns",
      mutate(db: Database.Database) {
        db.exec("ALTER TABLE task_run_command_receipts DROP COLUMN completed_at");
      },
      message: "task_run_command_receipts column count",
    },
    {
      name: "receipt indexes",
      mutate(db: Database.Database) {
        db.exec("DROP INDEX idx_session_create_receipts_session");
      },
      message: "idx_session_create_receipts_session",
    },
    {
      name: "receipt foreign keys",
      mutate(db: Database.Database) {
        const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_create_receipts'").pluck().get())
          .replace("session_id TEXT NOT NULL REFERENCES sessions(id)", "session_id TEXT NOT NULL");
        db.exec("DROP TABLE session_create_receipts");
        db.exec(sql);
        db.exec("CREATE INDEX idx_session_create_receipts_session ON session_create_receipts(session_id,created_at)");
      },
      message: "session_create_receipts.session_id foreign key",
    },
    {
      name: "receipt status constraints",
      mutate(db: Database.Database) {
        const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workspace_goal_operation_receipts'").pluck().get())
          .replace(" CHECK(status IN ('started','succeeded','failed','outcome_unknown'))", "");
        db.exec("DROP TABLE workspace_goal_operation_receipts");
        db.exec(sql);
        db.exec("CREATE INDEX idx_workspace_goal_operation_status ON workspace_goal_operation_receipts(status,updated_at)");
      },
      message: "workspace_goal_operation_receipts.status constraint",
    },
  ])("fails closed when $name drift", async ({ mutate, message }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-v39-drift-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const seed = new Store(filename);
    seed.close();
    const db = new Database(filename);
    try { mutate(db); }
    finally { db.close(); }
    expect(() => new Store(filename)).toThrow(message);
  });
});
