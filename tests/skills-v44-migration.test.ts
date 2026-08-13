import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSkillsV43 } from "../adapters/persistence-sqlite/src/migrations/v43-skills.js";
import { assertSkillCenterV44Schema, migrateSkillCenterV44 } from "../adapters/persistence-sqlite/src/migrations/v44-skill-center.js";

describe("Skill center schema v44", () => {
  const databases: Database.Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function v43() {
    const db = new Database(":memory:");
    databases.push(db);
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    migrateSkillsV43(db, 42);
    return db;
  }

  it("migrates the legacy single revision binding into a multi-Skill Workspace reference", () => {
    const db = v43();
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("workspace-1");
    db.prepare("INSERT INTO skills (id,name,created_at,updated_at) VALUES (?,?,?,?)").run("skill-1", "release-check", 1, 1);
    db.prepare(`INSERT INTO skill_revisions
      (id,skill_id,revision,description,content,file_path,sha256,disable_model_invocation,source_filename,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run("revision-1", "skill-1", 1, "Verify", "Check", ".tagent/skills/release-check/a/SKILL.md", "a".repeat(64), 0, "SKILL.md", 1);
    db.prepare("INSERT INTO session_skill_bindings (session_id,skill_revision_id,bound_at) VALUES (?,?,?)").run("workspace-1", "revision-1", 2);

    migrateSkillCenterV44(db, 43);

    expect(() => assertSkillCenterV44Schema(db)).not.toThrow();
    expect(db.prepare("SELECT session_id AS workspaceId,skill_id AS skillId,bound_at AS boundAt FROM workspace_skill_bindings").get())
      .toEqual({ workspaceId: "workspace-1", skillId: "skill-1", boundAt: 2 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_skill_bindings'").get()).toBeUndefined();
    expect(() => migrateSkillCenterV44(db, 44)).not.toThrow();
  });

  it("fails closed on missing indexes, incompatible columns, and foreign-key drift", () => {
    const cases: Array<{ mutate: (db: Database.Database) => void; message: string }> = [
      { mutate: (db) => db.exec("DROP INDEX idx_workspace_skill_skill"), message: "missing idx_workspace_skill_skill" },
      { mutate: (db) => db.exec("ALTER TABLE workspace_skill_bindings RENAME TO bad; CREATE TABLE workspace_skill_bindings (session_id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,bound_at INTEGER NOT NULL)"), message: "incompatible workspace_skill_bindings columns" },
      { mutate: (db) => db.exec("ALTER TABLE workspace_skill_bindings RENAME TO bad; DROP INDEX idx_workspace_skill_skill; CREATE TABLE workspace_skill_bindings (session_id TEXT NOT NULL,skill_id TEXT NOT NULL,bound_at INTEGER NOT NULL,PRIMARY KEY(session_id,skill_id)); CREATE INDEX idx_workspace_skill_skill ON workspace_skill_bindings(skill_id)"), message: "invalid workspace_skill_bindings foreign keys" },
    ];
    for (const item of cases) {
      const db = v43();
      migrateSkillCenterV44(db, 43);
      item.mutate(db);
      expect(() => assertSkillCenterV44Schema(db)).toThrow(item.message);
    }
  });
});
