import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  assertExecutionPolicyV42Schema,
  migrateExecutionPolicyV42,
} from "@tagent/persistence-sqlite/migrations";

function schemaV41(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE session_supervisor_inbox (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL
  )`);
  return db;
}

describe("Execution policy schema v42", () => {
  it("adds the durable Router policy column and is re-entrant", () => {
    const db = schemaV41();
    try {
      migrateExecutionPolicyV42(db, 41);
      expect(() => assertExecutionPolicyV42Schema(db)).not.toThrow();
      expect(() => migrateExecutionPolicyV42(db, 42)).not.toThrow();
      expect(db.prepare("PRAGMA table_info(session_supervisor_inbox)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "execution_policy_json", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 }),
      ]));
    } finally {
      db.close();
    }
  });

  it("fails closed when the v42 column definition drifts", () => {
    const db = schemaV41();
    try {
      db.exec("ALTER TABLE session_supervisor_inbox ADD COLUMN execution_policy_json INTEGER");
      expect(() => assertExecutionPolicyV42Schema(db)).toThrow("incompatible session_supervisor_inbox.execution_policy_json");
      expect(() => migrateExecutionPolicyV42(db, 42)).toThrow("incompatible session_supervisor_inbox.execution_policy_json");
    } finally {
      db.close();
    }
  });
});
