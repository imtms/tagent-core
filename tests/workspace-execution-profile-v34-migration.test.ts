import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceExecutionProfileV34Schema,
  migrateWorkspaceExecutionProfileV34,
} from "@tagent/persistence-sqlite/migrations";

function schemaV33(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      goal TEXT NOT NULL
    );
    INSERT INTO sessions (id,title,created_at,updated_at) VALUES ('session','Existing',1,1);
    INSERT INTO runs (id,session_id,goal) VALUES ('run','session','Existing task');
  `);
  return db;
}

describe("Workspace execution profile schema v34", () => {
  it("backfills the configured primary model and preserves the historical Pi reasoning default", () => {
    const db = schemaV33();
    try {
      migrateWorkspaceExecutionProfileV34(db, 33, "custom-primary");
      expect(db.prepare("SELECT model_id AS modelId,reasoning_effort AS reasoningEffort FROM sessions").get())
        .toEqual({ modelId: "custom-primary", reasoningEffort: "high" });
      expect(db.prepare("SELECT model_id AS modelId,reasoning_effort AS reasoningEffort FROM runs").get())
        .toEqual({ modelId: "custom-primary", reasoningEffort: "medium" });
      expect(() => migrateWorkspaceExecutionProfileV34(db, 34, "ignored-after-migration")).not.toThrow();
      expect(() => assertWorkspaceExecutionProfileV34Schema(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects a v34 database whose concrete model snapshot has drifted", () => {
    const db = schemaV33();
    try {
      migrateWorkspaceExecutionProfileV34(db, 33);
      db.prepare("UPDATE runs SET model_id='' WHERE id='run'").run();
      expect(() => assertWorkspaceExecutionProfileV34Schema(db)).toThrow("runs row(s) without a concrete model_id");
    } finally {
      db.close();
    }
  });
});
