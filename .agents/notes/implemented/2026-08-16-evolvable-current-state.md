# Decision: Evolvable current state

Status: implemented
Kind: architecture

## Problem

Core is a persistent execution product with immutable release activation and rollback, but SQLite accepts only an empty database or one exact `sqlite_master` snapshot. Any structural change therefore requires discarding durable TaskRuns, receipts, goals, skills, and other persisted state. The single generated schema string contains almost ninety tables and does not preserve an executable upgrade history or a safe compatibility decision for Host rollback.

## Decision

Supersede only the no-upgrade consequence of the single-current-system and self-managed-generation decisions. Keep one current API and one mutation authority, while introducing a monotonic SQLite schema revision, an append-only migration journal, idempotent transactional migrations, preflight inspection, and explicit state-protocol compatibility in release activation. Split schema ownership into deterministic module fragments and build one reference schema for drift verification.

An upgrade prepares and verifies the next state before serving traffic. Once an irreversible migration commits, automatic activation rollback to a release that cannot read the new revision is forbidden. Same-revision releases retain the current fast rollback behavior. Backup/restore and failure-injection tests are required before a schema-changing release.

## Alternatives considered

**Continue requiring a new database.** Rejected because persistence and self-managed upgrades cannot both be production features if ordinary releases discard state.

**Keep every historical application authority.** Rejected because migrations transform state shape; they do not retain legacy HTTP, dual writes, shadow repositories, or multiple mutation entrances.

**Move each domain to a separate database/service.** Rejected because Core relies on local atomic transitions across TaskRun, receipts, events, and governance state.

## Verification

- Existing exact 0.8 databases open without data loss and acquire a monotonic schema revision.
- New databases are created directly at the current revision.
- Migrations are ordered, journaled, transactional, restart-safe, and verified against a deterministic reference schema.
- State-changing activation preflight rejects an unsafe automatic binary rollback.
- Schema source is reviewable by responsibility rather than one opaque generated literal.
- Backup, migration failure, restart, current-open, and incompatible-rollback tests pass.

The exact 0.8 baseline is split into deterministic responsibility-owned SQL fragments. Revision 2 adds `core_schema_migrations`, append-only UPDATE/DELETE triggers, SHA-256 checksums, and `PRAGMA user_version`. Empty, legacy user-version 0, and revision-1 databases pass through the same ordered `BEGIN IMMEDIATE` migration runner. Every open validates marker, revision, complete `sqlite_master`, journal order, descriptions, and checksums.

The state protocol is now `tagent-core/state-0.8-r2`. Release verification and Host activation reject r1 manifests after migration, so the first r2 deployment requires backup and a full Host/service restart; subsequent compatible r2 Generation activation retains automatic rollback. Tests cover data preservation, repeat-open idempotence, append-only enforcement, failed-migration rollback, drift, newer revision rejection, manifest incompatibility, and readiness reading the real SQLite revision.

Final validation:

- The built SQLite package contains all ten ordered SQL fragments; release/readiness tests execute the current-schema path from a representative materialized release.
- `npm run check`, `npm run lint`, `npm run build`, and the complete 1,083-test suite pass; four PostgreSQL Memory cases and one external-LLM quality case are skipped locally because their services are not configured.
- Reopen, legacy revision 0/1 upgrade, migration rollback, journal checksum/append-only, schema drift, and newer-revision rejection regressions all pass.

## Consequences

Migration code becomes part of the trusted persistence boundary and must remain maintained for every supported durable revision. State-protocol evolution also makes some upgrades require an explicit Host/service restart rather than an in-band Generation swap.
