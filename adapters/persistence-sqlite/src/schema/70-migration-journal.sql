CREATE TABLE core_schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  description TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at INTEGER NOT NULL CHECK(applied_at >= 0)
);

CREATE TRIGGER core_schema_migrations_append_only_update
BEFORE UPDATE ON core_schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'core_schema_migrations is append-only');
END;

CREATE TRIGGER core_schema_migrations_append_only_delete
BEFORE DELETE ON core_schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'core_schema_migrations is append-only');
END;
