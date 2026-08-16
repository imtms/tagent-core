import { readFileSync } from "node:fs";

export const CURRENT_SCHEMA_ID = "tagent-core/0.8" as const;
export const BASE_SCHEMA_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 2;

const BASE_SCHEMA_FILES = [
  "00-core.sql",
  "10-execution.sql",
  "20-admission.sql",
  "30-governance.sql",
  "40-learning.sql",
  "50-workspace-goals.sql",
  "60-profiles-and-skills.sql",
  "80-indexes.sql",
  "90-triggers-and-seed.sql",
] as const;

function schemaFile(name: string): string {
  return readFileSync(new URL(`./schema/${name}`, import.meta.url), "utf8").trim();
}

/** Exact schema accepted by Core 0.8 before monotonic migration metadata was introduced. */
export const BASE_SCHEMA_SQL = BASE_SCHEMA_FILES.map(schemaFile).join("\n\n");

/** Additive revision-2 schema. The migration runner owns journal rows and PRAGMA user_version. */
export const MIGRATION_JOURNAL_SCHEMA_SQL = schemaFile("70-migration-journal.sql");

/** Direct-install schema for a new database at the latest durable revision. */
export const CURRENT_SCHEMA_SQL = `${BASE_SCHEMA_SQL}\n\n${MIGRATION_JOURNAL_SCHEMA_SQL}`;
