import type Database from "better-sqlite3";
import {
  LEGACY_RUN_APPROVAL_DEFAULTS,
  canonicalApprovalStatus,
  stableJson,
} from "@tagent/governance";
import {
  buildLegacyWorkflowExecutedReceipt,
  mapLegacyRunApprovalOperation,
  mapLegacyWorkflowApprovalOperation,
  type LegacyWorkflowExecutedReceiptRow,
} from "../sqlite/canonical-approval-mapper.js";

export const GOVERNANCE_SCHEMA_V31_SQL = `
  CREATE TABLE IF NOT EXISTS approval_receipts (
    id TEXT PRIMARY KEY,
    approval_source TEXT NOT NULL CHECK (approval_source IN ('legacy_run','legacy_workflow')),
    approval_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(approval_source, approval_id, operation_id, outcome)
  );
  CREATE INDEX IF NOT EXISTS idx_approval_receipts_approval
    ON approval_receipts(approval_source, approval_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_approval_receipts_operation_digest
    ON approval_receipts(operation_digest, created_at, id);
  CREATE TRIGGER IF NOT EXISTS approval_receipts_append_only_update
    BEFORE UPDATE ON approval_receipts
    BEGIN
      SELECT RAISE(ABORT, 'approval_receipts is append-only');
    END;
  CREATE TRIGGER IF NOT EXISTS approval_receipts_append_only_delete
    BEFORE DELETE ON approval_receipts
    BEGIN
      SELECT RAISE(ABORT, 'approval_receipts is append-only');
    END;
`;

interface RunApprovalV31Row {
  id: string;
  runId: string;
  decisionId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  metadataJson: string;
  status: string;
  sessionId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  operationDigest: string | null;
  riskClass: string | null;
  expiresAt: number | null;
  reuseMode: string | null;
  maxUses: number | null;
  usedCount: number | null;
}

interface WorkflowApprovalV31Row {
  id: string;
  scopeId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  workflowId: string | null;
  revisionId: string | null;
  proposalId: string | null;
  bindingId: string | null;
  status: string;
  riskClass: string;
  impactScopeJson: string;
  diffJson: string;
  rollbackJson: string;
  executedAt: number | null;
  executionReceiptJson: string;
  operationDigest: string | null;
  reuseMode: string | null;
  maxUses: number | null;
  usedCount: number | null;
}

interface ColumnDefinition {
  name: string;
  type: "TEXT" | "INTEGER";
  definition: string;
  criticalCheck?: string;
}

interface TableColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexListRow {
  name: string;
  isUnique: number;
  origin: string;
  partial: number;
}

const RUN_APPROVAL_V31_COLUMNS: ColumnDefinition[] = [
  { name: "scope_type", type: "TEXT", definition: "TEXT" },
  { name: "scope_id", type: "TEXT", definition: "TEXT" },
  { name: "operation_digest", type: "TEXT", definition: "TEXT" },
  {
    name: "risk_class",
    type: "TEXT",
    definition: "TEXT CHECK (risk_class IN ('low','medium','high'))",
    criticalCheck: "CHECK (risk_class IN ('low','medium','high'))",
  },
  { name: "expires_at", type: "INTEGER", definition: "INTEGER" },
  {
    name: "reuse_mode",
    type: "TEXT",
    definition: "TEXT CHECK (reuse_mode IN ('one_time','reusable'))",
    criticalCheck: "CHECK (reuse_mode IN ('one_time','reusable'))",
  },
  {
    name: "max_uses",
    type: "INTEGER",
    definition: "INTEGER CHECK (max_uses IS NULL OR max_uses > 0)",
    criticalCheck: "CHECK (max_uses IS NULL OR max_uses > 0)",
  },
  {
    name: "used_count",
    type: "INTEGER",
    definition: "INTEGER CHECK (used_count IS NULL OR used_count >= 0)",
    criticalCheck: "CHECK (used_count IS NULL OR used_count >= 0)",
  },
];

const WORKFLOW_APPROVAL_V31_COLUMNS: ColumnDefinition[] = [
  { name: "operation_digest", type: "TEXT", definition: "TEXT" },
  {
    name: "reuse_mode",
    type: "TEXT",
    definition: "TEXT CHECK (reuse_mode IN ('one_time','reusable'))",
    criticalCheck: "CHECK (reuse_mode IN ('one_time','reusable'))",
  },
  {
    name: "max_uses",
    type: "INTEGER",
    definition: "INTEGER CHECK (max_uses IS NULL OR max_uses > 0)",
    criticalCheck: "CHECK (max_uses IS NULL OR max_uses > 0)",
  },
  {
    name: "used_count",
    type: "INTEGER",
    definition: "INTEGER CHECK (used_count IS NULL OR used_count >= 0)",
    criticalCheck: "CHECK (used_count IS NULL OR used_count >= 0)",
  },
];

const RECEIPT_COLUMNS: Array<{
  name: string;
  type: "TEXT" | "INTEGER";
  notnull: 0 | 1;
  pk: 0 | 1;
}> = [
  { name: "id", type: "TEXT", notnull: 0, pk: 1 },
  { name: "approval_source", type: "TEXT", notnull: 1, pk: 0 },
  { name: "approval_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "operation_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "operation_digest", type: "TEXT", notnull: 1, pk: 0 },
  { name: "outcome", type: "TEXT", notnull: 1, pk: 0 },
  { name: "actor_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "details_json", type: "TEXT", notnull: 1, pk: 0 },
  { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
];

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

function fail(message: string): never {
  throw new Error(`Governance v31 ${message}`);
}

function normalizeDdl(source: string): string {
  return source
    .toLowerCase()
    .replace(/["`]/g, "")
    .replace(/\[([^\]]+)]/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .trim();
}

function tableSql(db: Database.Database, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string | null } | undefined;
  if (!row?.sql) fail(`schema is missing table ${table}`);
  return normalizeDdl(row.sql);
}

function assertExpandedColumns(
  db: Database.Database,
  table: string,
  expected: ColumnDefinition[],
): void {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as TableColumnRow[];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const sql = tableSql(db, table);
  for (const definition of expected) {
    const column = byName.get(definition.name);
    if (!column) fail(`schema is missing ${table}.${definition.name}`);
    if (column.type.trim().toUpperCase() !== definition.type
      || column.notnull !== 0
      || column.dflt_value !== null
      || column.pk !== 0) {
      fail(`schema has incompatible declaration for ${table}.${definition.name}`);
    }
    if (definition.criticalCheck && !sql.includes(normalizeDdl(definition.criticalCheck))) {
      fail(`schema is missing required CHECK for ${table}.${definition.name}`);
    }
  }
}

function indexList(db: Database.Database, table: string): IndexListRow[] {
  return db.prepare(`SELECT name,"unique" as isUnique,origin,partial
    FROM pragma_index_list(?) ORDER BY name`).all(table) as IndexListRow[];
}

function indexColumns(db: Database.Database, index: string): string[] {
  return (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index) as Array<{ name: string | null }>)
    .map((row) => row.name ?? "");
}

function sameColumns(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function assertReceiptIndexes(db: Database.Database): void {
  const indexes = indexList(db, "approval_receipts");
  const uniqueColumns = ["approval_source", "approval_id", "operation_id", "outcome"];
  const uniqueConstraint = indexes.find((index) => index.isUnique === 1
    && index.origin === "u"
    && index.partial === 0
    && sameColumns(indexColumns(db, index.name), uniqueColumns));
  if (!uniqueConstraint) fail("schema is missing approval_receipts source/approval/operation/outcome UNIQUE constraint");

  const required = [
    {
      name: "idx_approval_receipts_approval",
      columns: ["approval_source", "approval_id", "created_at", "id"],
    },
    {
      name: "idx_approval_receipts_operation_digest",
      columns: ["operation_digest", "created_at", "id"],
    },
  ];
  for (const expected of required) {
    const index = indexes.find((item) => item.name === expected.name);
    if (!index || index.isUnique !== 0 || index.partial !== 0
      || !sameColumns(indexColumns(db, index.name), expected.columns)) {
      fail(`schema has incompatible index ${expected.name}`);
    }
  }
}

function assertReceiptTrigger(
  db: Database.Database,
  name: string,
  operation: "update" | "delete",
): void {
  const row = db.prepare(`SELECT tbl_name as tableName,sql FROM sqlite_master
    WHERE type='trigger' AND name=?`).get(name) as { tableName: string; sql: string | null } | undefined;
  if (!row?.sql || row.tableName !== "approval_receipts") {
    fail(`schema has incompatible trigger ${name}`);
  }
  const sql = normalizeDdl(row.sql);
  if (!sql.includes(`before ${operation} on approval_receipts`)
    || !sql.includes("raise(abort,'approval_receipts is append-only')")) {
    fail(`schema has incompatible trigger ${name}`);
  }
}

export function assertGovernanceV31Schema(db: Database.Database): void {
  assertExpandedColumns(db, "approval_requests", RUN_APPROVAL_V31_COLUMNS);
  assertExpandedColumns(db, "autonomy_approval_requests", WORKFLOW_APPROVAL_V31_COLUMNS);

  const receiptColumns = db.prepare("PRAGMA table_info(approval_receipts)").all() as TableColumnRow[];
  if (receiptColumns.length !== RECEIPT_COLUMNS.length) {
    fail("schema has incompatible approval_receipts column count");
  }
  for (const [index, expected] of RECEIPT_COLUMNS.entries()) {
    const column = receiptColumns[index];
    if (!column || column.name !== expected.name || column.type.trim().toUpperCase() !== expected.type
      || column.notnull !== expected.notnull || column.dflt_value !== null || column.pk !== expected.pk) {
      fail(`schema has incompatible approval_receipts column ${expected.name}`);
    }
  }
  const receiptSql = tableSql(db, "approval_receipts");
  if (!receiptSql.includes(normalizeDdl("CHECK (approval_source IN ('legacy_run','legacy_workflow'))"))) {
    fail("schema is missing approval_receipts approval_source CHECK");
  }
  assertReceiptIndexes(db);
  assertReceiptTrigger(db, "approval_receipts_append_only_update", "update");
  assertReceiptTrigger(db, "approval_receipts_append_only_delete", "delete");
}

function mapForBackfill<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    return fail(`backfill ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStoredField(
  approvalId: string,
  field: string,
  actual: string | number | null,
  expected: string | number | null,
  allowMissing: boolean,
): void {
  if (actual !== expected && !(allowMissing && actual === null)) {
    fail(`backfill conflict for ${approvalId}.${field}: expected ${String(expected)}, found ${String(actual)}`);
  }
}

function backfillRunApprovals(
  db: Database.Database,
  previousVersion: number | undefined,
  writeBackfill: boolean,
): void {
  const rows: RunApprovalV31Row[] = db.prepare(`SELECT approval.id,approval.run_id as runId,approval.decision_id as decisionId,
    approval.action_type as actionType,approval.target_type as targetType,approval.target_id as targetId,
    approval.metadata_json as metadataJson,approval.status,run.session_id as sessionId,
    approval.scope_type as scopeType,approval.scope_id as scopeId,
    approval.operation_digest as operationDigest,approval.risk_class as riskClass,
    approval.expires_at as expiresAt,approval.reuse_mode as reuseMode,
    approval.max_uses as maxUses,approval.used_count as usedCount
    FROM approval_requests approval LEFT JOIN runs run ON run.id=approval.run_id ORDER BY approval.id`).all() as RunApprovalV31Row[];
  const update = writeBackfill
    ? db.prepare(`UPDATE approval_requests SET
      scope_type=?,scope_id=?,operation_digest=?,risk_class=?,expires_at=?,reuse_mode=?,max_uses=?,used_count=?
      WHERE id=?`)
    : null;
  const allowMissing = previousVersion === undefined || previousVersion < 31;

  for (const row of rows) {
    if (!canonicalApprovalStatus("legacy_run", row.status)) {
      fail(`backfill found unknown Run status for ${row.id}`);
    }
    const canonical = mapForBackfill(() => mapLegacyRunApprovalOperation({
      id: row.id,
      runId: row.runId,
      decisionId: row.decisionId,
      actionType: row.actionType,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadataJson,
      runSessionId: row.sessionId,
    }));
    if (row.status === "approved" && row.usedCount !== null
      && row.usedCount !== 0 && row.usedCount !== 1) {
      fail(`backfill conflict for ${row.id}.usedCount: one-time approval usage must be 0, 1, or historical NULL`);
    }
    const expected = {
      scopeType: canonical.operation.scope.type,
      scopeId: canonical.operation.scope.id,
      operationDigest: canonical.operationDigest,
      riskClass: LEGACY_RUN_APPROVAL_DEFAULTS.risk,
      expiresAt: LEGACY_RUN_APPROVAL_DEFAULTS.expiresAt,
      reuseMode: LEGACY_RUN_APPROVAL_DEFAULTS.reuse.mode,
      maxUses: LEGACY_RUN_APPROVAL_DEFAULTS.reuse.maxUses,
      usedCount: row.status === "approved"
        ? allowMissing || row.usedCount === null ? null : row.usedCount
        : LEGACY_RUN_APPROVAL_DEFAULTS.reuse.usedCount,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      assertStoredField(row.id, key, row[key], expected[key], allowMissing);
    }
    update?.run(
      expected.scopeType,
      expected.scopeId,
      expected.operationDigest,
      expected.riskClass,
      expected.expiresAt,
      expected.reuseMode,
      expected.maxUses,
      expected.usedCount,
      row.id,
    );
  }
}

function insertOrVerifyReceipt(
  db: Database.Database,
  expected: LegacyWorkflowExecutedReceiptRow,
  insertIfMissing: boolean,
): void {
  if (insertIfMissing) {
    db.prepare(`INSERT OR IGNORE INTO approval_receipts
      (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
      VALUES (@id,@approval_source,@approval_id,@operation_id,@operation_digest,@outcome,@actor_id,@details_json,@created_at)`)
      .run(expected);
  }
  const stored = db.prepare("SELECT * FROM approval_receipts WHERE id=?")
    .get(expected.id) as LegacyWorkflowExecutedReceiptRow | undefined;
  if (!stored || stableJson(stored) !== stableJson(expected)) {
    fail(`receipt conflict for ${expected.approval_id}`);
  }
}

function backfillWorkflowApprovals(
  db: Database.Database,
  previousVersion: number | undefined,
  writeBackfill: boolean,
): void {
  const rows = db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,target_type as targetType,
    target_id as targetId,workflow_id as workflowId,revision_id as revisionId,proposal_id as proposalId,
    binding_id as bindingId,status,risk_class as riskClass,impact_scope_json as impactScopeJson,
    diff_json as diffJson,rollback_json as rollbackJson,executed_at as executedAt,
    execution_receipt_json as executionReceiptJson,operation_digest as operationDigest,
    reuse_mode as reuseMode,max_uses as maxUses,used_count as usedCount
    FROM autonomy_approval_requests ORDER BY id`).all() as WorkflowApprovalV31Row[];
  const update = writeBackfill
    ? db.prepare(`UPDATE autonomy_approval_requests
      SET operation_digest=?,reuse_mode=?,max_uses=?,used_count=? WHERE id=?`)
    : null;
  const allowMissing = previousVersion === undefined || previousVersion < 31;

  for (const row of rows) {
    if (!canonicalApprovalStatus("legacy_workflow", row.status, {
      maxUses: 1,
      usedCount: row.status === "executed" ? 1 : 0,
    })) fail(`backfill found unknown Workflow status for ${row.id}`);
    if (!["low", "medium", "high"].includes(row.riskClass)) {
      fail(`backfill found unknown Workflow risk for ${row.id}`);
    }
    const canonical = mapForBackfill(() => mapLegacyWorkflowApprovalOperation(row));
    if (row.status === "approved" && row.usedCount !== null
      && row.usedCount !== 0 && row.usedCount !== 1) {
      fail(`backfill conflict for ${row.id}.usedCount: one-time approval usage must be 0 or 1`);
    }
    const expected = {
      operationDigest: canonical.operationDigest,
      reuseMode: "one_time",
      maxUses: 1,
      usedCount: row.status === "executed"
        ? 1
        : row.status === "approved" && row.usedCount === 1 ? 1 : 0,
    } as const;
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      assertStoredField(row.id, key, row[key], expected[key], allowMissing);
    }
    if (row.status !== "executed" && row.executedAt !== null) {
      fail(`backfill found execution timestamp on non-executed Workflow approval ${row.id}`);
    }
    update?.run(expected.operationDigest, expected.reuseMode, expected.maxUses, expected.usedCount, row.id);
    if (row.status === "executed") {
      insertOrVerifyReceipt(db, mapForBackfill(() => buildLegacyWorkflowExecutedReceipt({
        approvalId: row.id,
        actionType: row.actionType,
        targetId: row.targetId,
        operationDigest: canonical.operationDigest,
        executedAt: row.executedAt!,
        receiptJson: row.executionReceiptJson,
      })), writeBackfill && allowMissing);
    }
  }
}

export function assertGovernanceV31Foundation(db: Database.Database): void {
  assertGovernanceV31Schema(db);
  backfillRunApprovals(db, 31, false);
  backfillWorkflowApprovals(db, 31, false);
}

export function migrateGovernanceV31(
  db: Database.Database,
  previousVersion: number | undefined,
  _timestamp: number,
): void {
  if (previousVersion !== undefined && previousVersion > 31) {
    fail(`migration cannot open schema version ${previousVersion}`);
  }
  for (const column of RUN_APPROVAL_V31_COLUMNS) {
    ensureColumn(db, "approval_requests", column.name, column.definition);
  }
  for (const column of WORKFLOW_APPROVAL_V31_COLUMNS) {
    ensureColumn(db, "autonomy_approval_requests", column.name, column.definition);
  }
  db.exec(GOVERNANCE_SCHEMA_V31_SQL);
  assertGovernanceV31Schema(db);
  backfillRunApprovals(db, previousVersion, true);
  backfillWorkflowApprovals(db, previousVersion, true);
}
