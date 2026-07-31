# Memory Operations

## Local PostgreSQL without Docker

On Debian: install `postgresql`, `postgresql-contrib`, development headers, and the pgvector package when available. Create database/user `tagent_memory`/`tagent`, then set `TAGENT_MEMORY_POSTGRES_URL`. The server runs `src/memory/postgres/schema.sql` idempotently at startup.

## Docker

`docker compose -f deploy/postgres/compose.yml up -d`

## Backups

Back up PostgreSQL with `pg_dump` and the cold object prefix together. Cold revisions are immutable; PostgreSQL's current revision pointer is authoritative. Run reconciliation after restore to identify missing or orphaned objects.

## Security

Use a private bucket, TLS, server-side encryption, short-lived credentials, and no public ACL. Rotate database/S3 credentials outside the memory store. Do not place credentials in topic pages or audit metadata.
