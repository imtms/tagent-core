import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { assertSkillsV43Schema, migrateSkillsV43 } from "../adapters/persistence-sqlite/src/migrations/v43-skills.js";

describe("Skills schema v43", () => {
  const databases: Database.Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function v42() {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    return db;
  }

  it("creates the immutable catalog and Session binding tables re-entrantly", () => {
    const db = v42();
    migrateSkillsV43(db, 42);
    expect(() => migrateSkillsV43(db, 43)).not.toThrow();
    expect(() => assertSkillsV43Schema(db)).not.toThrow();
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(["session_skill_bindings", "sessions", "skill_revisions", "skills"]);
  });

  it("fails closed when a required table is absent", () => {
    const db = v42();
    migrateSkillsV43(db, 42);
    db.exec("DROP TABLE session_skill_bindings");
    expect(() => assertSkillsV43Schema(db)).toThrow("missing session_skill_bindings");
  });

  it("fails closed on column, index, uniqueness, foreign-key, and CHECK drift", () => {
    const cases: Array<{ mutate: (db: Database.Database) => void; message: string }> = [
      { mutate: (db) => db.exec("DROP INDEX idx_skill_revisions_latest; CREATE INDEX idx_skill_revisions_latest ON skill_revisions(revision)"), message: "invalid idx_skill_revisions_latest columns" },
      { mutate: (db) => db.exec("DROP INDEX idx_session_skill_revision"), message: "missing idx_session_skill_revision" },
      { mutate: (db) => db.exec("ALTER TABLE skills RENAME TO skills_valid; CREATE TABLE skills (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"), message: "missing UNIQUE skills(name)" },
      { mutate: (db) => db.exec("ALTER TABLE session_skill_bindings RENAME TO session_skill_bindings_valid; DROP INDEX idx_session_skill_revision; CREATE TABLE session_skill_bindings (session_id TEXT PRIMARY KEY,skill_revision_id TEXT NOT NULL,bound_at INTEGER NOT NULL); CREATE INDEX idx_session_skill_revision ON session_skill_bindings(skill_revision_id)"), message: "invalid session_skill_bindings foreign keys" },
      { mutate: (db) => db.exec("ALTER TABLE skill_revisions RENAME TO skill_revisions_valid; DROP INDEX idx_skill_revisions_latest; CREATE TABLE skill_revisions (id TEXT PRIMARY KEY,skill_id TEXT NOT NULL REFERENCES skills(id),revision INTEGER NOT NULL,description TEXT NOT NULL,content TEXT NOT NULL,file_path TEXT NOT NULL,sha256 TEXT NOT NULL,disable_model_invocation INTEGER NOT NULL DEFAULT 0,source_filename TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(skill_id,revision),UNIQUE(skill_id,sha256)); CREATE INDEX idx_skill_revisions_latest ON skill_revisions(skill_id,revision DESC)"), message: "missing check(revision>0)" },
    ];
    for (const item of cases) {
      const db = v42();
      migrateSkillsV43(db, 42);
      item.mutate(db);
      expect(() => assertSkillsV43Schema(db)).toThrow(item.message);
    }
  });
});
