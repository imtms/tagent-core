import type Database from "better-sqlite3";

const REQUIRED_TABLES = [
  "workspace_goals",
  "workspace_goal_requests",
  "workspace_goal_revisions",
  "workspace_goal_decisions",
  "workspace_goal_run_links",
  "workspace_goal_evidence_links",
] as const;

export function assertWorkspaceGoalsV35Schema(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of REQUIRED_TABLES) if (!tables.has(table)) throw new Error(`Workspace Goal v35 schema is missing ${table}`);
}

export function migrateWorkspaceGoalsV35(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 34 && previousVersion !== 35) throw new Error(`Workspace Goal v35 migration requires schema version 34 or 35, found ${previousVersion}`);
  if (previousVersion === 35) return assertWorkspaceGoalsV35Schema(db);
  db.exec(`
    CREATE TABLE workspace_goals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK(status IN ('draft','active','paused','ready_to_close','completed','cancelled')),
      active_definition_revision_id TEXT,
      active_plan_revision_id TEXT,
      current_run_id TEXT REFERENCES runs(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX idx_workspace_goals_workspace ON workspace_goals(workspace_id, updated_at DESC);
    CREATE TABLE workspace_goal_requests (
      idempotency_key TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id),
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE workspace_goal_revisions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('definition','plan')),
      revision INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_artifact_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(goal_id, kind, revision)
    );
    CREATE INDEX idx_workspace_goal_revisions_goal ON workspace_goal_revisions(goal_id, kind, revision DESC);
    CREATE TABLE workspace_goal_decisions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      target_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id),
      target_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('approve_goal','approve_plan','request_change','pause','resume','close','cancel')),
      approved_item_ids_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(goal_id, kind, target_revision_id, target_hash, actor_id)
    );
    CREATE INDEX idx_workspace_goal_decisions_goal ON workspace_goal_decisions(goal_id, created_at DESC);
    CREATE TABLE workspace_goal_run_links (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
      goal_revision INTEGER NOT NULL,
      plan_revision_id TEXT REFERENCES workspace_goal_revisions(id),
      approved_item_ids_json TEXT NOT NULL DEFAULT '[]',
      criterion_keys_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(goal_id, run_id)
    );
    CREATE INDEX idx_workspace_goal_run_links_goal ON workspace_goal_run_links(goal_id, created_at DESC);
    CREATE TABLE workspace_goal_evidence_links (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      goal_revision INTEGER NOT NULL,
      criterion_key TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      check_key TEXT,
      artifact_id TEXT,
      operation_id TEXT,
      source_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('valid','stale','contradicted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(goal_id, goal_revision, criterion_key, source_digest)
    );
    CREATE INDEX idx_workspace_goal_evidence_goal ON workspace_goal_evidence_links(goal_id, criterion_key, status);
  `);
  assertWorkspaceGoalsV35Schema(db);
}
