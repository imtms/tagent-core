import type Database from "better-sqlite3";

const REQUIRED_DECISION_COLUMNS = ["request_id", "payload_hash"] as const;
const REQUIRED_TABLES = ["workspace_goal_evidence_requests"] as const;

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

export function assertWorkspaceGoalReliabilityV36Schema(db: Database.Database): void {
  const decisionColumns = columns(db, "workspace_goal_decisions");
  for (const column of REQUIRED_DECISION_COLUMNS) {
    if (!decisionColumns.has(column)) throw new Error(`Workspace Goal v36 schema is missing workspace_goal_decisions.${column}`);
  }
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of REQUIRED_TABLES) if (!tables.has(table)) throw new Error(`Workspace Goal v36 schema is missing ${table}`);
}

export function migrateWorkspaceGoalReliabilityV36(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 35 && previousVersion !== 36) throw new Error(`Workspace Goal v36 migration requires schema version 35 or 36, found ${previousVersion}`);
  if (previousVersion === 36) return assertWorkspaceGoalReliabilityV36Schema(db);
  const decisionColumns = columns(db, "workspace_goal_decisions");
  if (!decisionColumns.has("request_id")) db.exec("ALTER TABLE workspace_goal_decisions ADD COLUMN request_id TEXT");
  if (!decisionColumns.has("payload_hash")) db.exec("ALTER TABLE workspace_goal_decisions ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_goal_decisions_request
      ON workspace_goal_decisions(goal_id, request_id) WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS workspace_goal_evidence_requests (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      evidence_link_id TEXT NOT NULL REFERENCES workspace_goal_evidence_links(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(goal_id, request_id)
    );
  `);
  assertWorkspaceGoalReliabilityV36Schema(db);
}
