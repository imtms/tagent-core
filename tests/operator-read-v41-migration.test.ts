import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "@tagent/persistence-sqlite";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Operator Read schema v41", () => {
  it("migrates a v40 database, creates ordered indexes, and is re-entrant", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-v41-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const seed = new Store(filename);
    seed.db.exec(`
      DROP INDEX idx_sessions_operator_created;
      DROP INDEX idx_runs_operator_session_created;
      DROP INDEX idx_runs_operator_session_updated;
      UPDATE schema_meta SET version=40;
    `);
    seed.close();

    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(42);
    for (const index of ["idx_sessions_operator_created", "idx_runs_operator_session_created", "idx_runs_operator_session_updated"]) {
      expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").pluck().get(index)).toBe(index);
    }
    migrated.close();
    expect(() => new Store(filename).close()).not.toThrow();
  });

  it("fails closed when an Operator Read index drifts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-v41-drift-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    new Store(filename).close();
    const db = new Database(filename);
    db.exec("DROP INDEX idx_runs_operator_session_created; CREATE INDEX idx_runs_operator_session_created ON runs(session_id,updated_at,id)");
    db.close();
    expect(() => new Store(filename)).toThrow("idx_runs_operator_session_created columns");
  });
});
