import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "@tagent/persistence-sqlite";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("gateway operator schema v40", () => {
  it("migrates a v39-shaped database and is re-entrant", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-v40-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const seed = new Store(filename);
    seed.db.exec("DROP TABLE submission_audit_receipts; UPDATE schema_meta SET version=39");
    seed.close();

    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(40);
    expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='submission_audit_receipts'").pluck().get())
      .toBe("submission_audit_receipts");
    migrated.close();
    expect(() => new Store(filename).close()).not.toThrow();
  });

  it("fails closed on submission audit drift", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-v40-drift-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    new Store(filename).close();
    const db = new Database(filename);
    db.exec("DROP INDEX idx_submission_audit_principal");
    db.close();
    expect(() => new Store(filename)).toThrow("idx_submission_audit_principal");
  });
});
