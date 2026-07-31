# Memory Operations

## Enable or disable

Long-term memory is optional and disabled by default:

```env
TAGENT_MEMORY_ENABLED=false
```

In disabled mode, no memory adapter or worker is loaded, no PostgreSQL/S3 connection is attempted, memory-only environment values are ignored, and the original SQLite-backed TAgent Core remains usable. Memory HTTP endpoints return `503 {"error":"memory is disabled"}`.

To enable memory, set `TAGENT_MEMORY_ENABLED=true`. Memory adapter modules are loaded only for the selected backend; the corresponding external service and environment configuration are required only when that backend is enabled. The recommended durable Local Cold profile additionally requires `TAGENT_MEMORY_BACKEND=postgres`, `TAGENT_MEMORY_POSTGRES_URL`, PostgreSQL with pgvector, and a writable local Cold path. Configuration is validated before the memory runtime starts. For a dependency-free development adapter, use `TAGENT_MEMORY_BACKEND=memory`; it is not durable.

## Local PostgreSQL without Docker

On Debian: install `postgresql`, `postgresql-contrib`, development headers, and the pgvector package when available. Create database/user `tagent_memory`/`tagent`, then set `TAGENT_MEMORY_POSTGRES_URL`. The server runs `src/memory/postgres/schema.sql` idempotently at startup.

## Docker

`docker compose -f deploy/postgres/compose.yml up -d`

## Backups

Back up PostgreSQL with `pg_dump` and the cold object prefix together. Cold revisions are immutable; PostgreSQL's current revision pointer is authoritative. Run reconciliation after restore to identify missing or orphaned objects.

## Security

Use a private bucket, TLS, server-side encryption, short-lived credentials, and no public ACL. Rotate database/S3 credentials outside the memory store. Do not place credentials in topic pages or audit metadata.

## Single-service Local Cold profile

The API process now runs all durable local-memory maintenance loops in-process:

- capture job claiming and extraction;
- deterministic entity/relation projection;
- duplicate/conflict consolidation;
- Hot-to-Warm promotion;
- repeated inferred-preference promotion;
- scheduled Warm-to-Cold topic publication;
- staged Local Cold cleanup and current-object verification.

Recommended local settings:

```env
TAGENT_MEMORY_COLD_BACKEND=local
TAGENT_MEMORY_WORKER_INTERVAL_MS=1000
TAGENT_MEMORY_MAINTENANCE_INTERVAL_MS=60000
TAGENT_MEMORY_WARM_AFTER_MS=0
TAGENT_MEMORY_HOT_TTL_MS=2592000000
TAGENT_MEMORY_COLD_MINIMUM_RECORDS=2
```

Cold bodies remain complete immutable Markdown revisions and are never embedded. The single-service profile is intended for a trusted, single-user/local deployment. S3, multi-service workers, external semantic embedding, and multi-tenant authentication remain optional adapter/deployment concerns rather than requirements for this profile.
