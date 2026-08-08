import type Database from "better-sqlite3";

const REQUIRED_TABLES = ["workspace_goal_inbox_links", "workspace_goal_roadmap_item_progress"] as const;
const REQUIRED_COLUMNS = {
  workspace_goal_inbox_links: ["inbox_item_id", "goal_id", "goal_revision", "roadmap_revision_id", "roadmap_item_ids_json", "criterion_keys_json", "created_at"],
  workspace_goal_roadmap_item_progress: ["goal_id", "roadmap_revision_id", "item_id", "status", "run_id", "updated_at", "completed_at"],
} as const;

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function indexColumns(db: Database.Database, indexName: string): string[] {
  return (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(indexName) as Array<{ name: string }>).map((row) => row.name);
}

function legacyDecisionIdentityIndex(db: Database.Database): string | null {
  const legacy = ["goal_id", "kind", "target_revision_id", "target_hash", "actor_id"];
  const indexes = db.prepare("PRAGMA index_list(workspace_goal_decisions)").all() as Array<{ name: string; unique: number }>;
  return indexes.find((index) => index.unique === 1 && indexColumns(db, index.name).join("\0") === legacy.join("\0"))?.name ?? null;
}

function removeLegacyDecisionIdentityConstraint(db: Database.Database): void {
  if (!legacyDecisionIdentityIndex(db)) return;
  db.exec(`
    CREATE TABLE workspace_goal_decisions_v38 (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      target_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id),
      target_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('approve_goal','approve_plan','request_change','pause','resume','close','cancel')),
      approved_item_ids_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      request_id TEXT,
      payload_hash TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO workspace_goal_decisions_v38
      (id,goal_id,target_revision_id,target_hash,kind,approved_item_ids_json,reason,actor_id,created_at,request_id,payload_hash)
    SELECT id,goal_id,target_revision_id,target_hash,kind,approved_item_ids_json,reason,actor_id,created_at,request_id,payload_hash
      FROM workspace_goal_decisions;
    DROP TABLE workspace_goal_decisions;
    ALTER TABLE workspace_goal_decisions_v38 RENAME TO workspace_goal_decisions;
    CREATE INDEX idx_workspace_goal_decisions_goal ON workspace_goal_decisions(goal_id, created_at DESC);
    CREATE UNIQUE INDEX idx_workspace_goal_decisions_request
      ON workspace_goal_decisions(goal_id, request_id) WHERE request_id IS NOT NULL;
  `);
}

export function assertWorkspaceGoalExecutionV38Schema(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of REQUIRED_TABLES) if (!tables.has(table)) throw new Error(`Workspace Goal v38 schema is missing ${table}`);
  const runLinkColumns = db.prepare("PRAGMA table_info(workspace_goal_run_links)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
  const linkMode = runLinkColumns.find((column) => column.name === "link_mode");
  if (!linkMode) throw new Error("Workspace Goal v38 schema is missing workspace_goal_run_links.link_mode");
  if (linkMode.type.toUpperCase() !== "TEXT" || linkMode.notnull !== 1 || linkMode.dflt_value !== "'workspace'") {
    throw new Error("Workspace Goal v38 schema has incompatible workspace_goal_run_links.link_mode");
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columns(db, table);
    for (const column of required) if (!actual.has(column)) throw new Error(`Workspace Goal v38 schema is missing ${table}.${column}`);
  }
  const invalidMode = db.prepare("SELECT link_mode as mode FROM workspace_goal_run_links WHERE link_mode NOT IN ('workspace','roadmap') LIMIT 1").get() as { mode: string } | undefined;
  if (invalidMode) throw new Error(`Workspace Goal v38 data has invalid workspace_goal_run_links.link_mode: ${invalidMode.mode}`);
  if (legacyDecisionIdentityIndex(db)) throw new Error("Workspace Goal v38 schema retains the incompatible legacy decision identity constraint");
}

export function migrateWorkspaceGoalExecutionV38(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 37 && previousVersion !== 38) throw new Error(`Workspace Goal v38 migration requires schema version 37 or 38, found ${previousVersion}`);
  removeLegacyDecisionIdentityConstraint(db);
  if (previousVersion === 38) return assertWorkspaceGoalExecutionV38Schema(db);
  const runLinkColumns = columns(db, "workspace_goal_run_links");
  if (!runLinkColumns.has("link_mode")) {
    db.exec("ALTER TABLE workspace_goal_run_links ADD COLUMN link_mode TEXT NOT NULL DEFAULT 'workspace'");
    db.exec("UPDATE workspace_goal_run_links SET link_mode='roadmap' WHERE plan_revision_id IS NOT NULL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_goal_inbox_links (
      inbox_item_id TEXT PRIMARY KEY REFERENCES session_supervisor_inbox(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      goal_revision INTEGER NOT NULL,
      roadmap_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id),
      roadmap_item_ids_json TEXT NOT NULL DEFAULT '[]',
      criterion_keys_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_goal_inbox_links_goal
      ON workspace_goal_inbox_links(goal_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS workspace_goal_roadmap_item_progress (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      roadmap_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','blocked','skipped')),
      run_id TEXT REFERENCES runs(id),
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(goal_id, roadmap_revision_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_goal_roadmap_progress_run
      ON workspace_goal_roadmap_item_progress(run_id) WHERE run_id IS NOT NULL;
    INSERT OR IGNORE INTO workspace_goal_roadmap_item_progress
      (goal_id,roadmap_revision_id,item_id,status,run_id,updated_at,completed_at)
    SELECT l.goal_id,l.plan_revision_id,j.value,
      CASE WHEN r.status='completed' THEN 'completed'
           WHEN r.status IN ('running','waiting_input') THEN 'running'
           ELSE 'blocked' END,
      l.run_id,COALESCE(r.updated_at,l.created_at),
      CASE WHEN r.status='completed' THEN r.completed_at ELSE NULL END
    FROM workspace_goal_run_links l
    JOIN runs r ON r.id=l.run_id
    JOIN json_each(l.approved_item_ids_json) j
    WHERE l.link_mode='roadmap' AND l.plan_revision_id IS NOT NULL;
  `);
  assertWorkspaceGoalExecutionV38Schema(db);
}
