# Upgrade and rollback

This guide describes the current repository boundary: API v1, independently deployed Core and Web Console artifacts, one fenced SQLite writer, and control-plane schema 37. It replaces the version-specific 0.2 upgrade notes; release tags retain those historical instructions.

## Compatibility boundary

- Supported HTTP routes use `/api/v1`; removed unversioned `/api/*` routes stay removed.
- Core is API-only and does not serve the Web Console or an SPA fallback.
- Durable submissions use the `Idempotency-Key` header and v1 receipt envelopes.
- Production uses Node.js `24.18.1`, npm 12 or newer, and Linux x64/Node ABI 137 for the immutable Core artifact.
- SQLite migrations are forward-only. A binary that understands at most schema 36 must not open schema 37.
- Core, Gateway and Web must honor generation-fenced event replay and durable persist-before-ACK behavior.

## Before upgrading

1. Stop new Gateway traffic and every Core writer.
2. Confirm the old Core process, OS lock and writer lease are gone.
3. Back up the SQLite database, WAL and SHM as one recovery set.
4. Back up PostgreSQL and Local Cold/S3 state when Memory is enabled.
5. Record the old release commit, artifacts, checksums, configuration, event-consumer ACKs and Learning watermarks.
6. Rehearse the migration and restore in an isolated production-like environment.

Never copy only the main SQLite file while a writer is active. Never use a partially copied database as a rollback point.

## Database migration

The production `Store` opener applies and revalidates the migration chain:

| Schema | Change |
| --- | --- |
| 30 | canonical Attempt authority, execution leases, checkpoints and recovery comparison |
| 31 | canonical Governance projections and approval receipts |
| 32 | capability authorization constraints and immutable identity |
| 33 | Learning integration journal, fenced delivery, reconciliation and migration issue ledger |
| 34 | Workspace execution preferences and immutable TaskRun model/reasoning snapshots |
| 35 | lightweight Workspace Goals and immutable definition/plan revisions |
| 36 | Goal decision/evidence idempotency, freshness and mutation authorization |
| 37 | operation audit payloads and trusted current-Attempt Bash bindings for checks |

Schema 37 adds:

```text
operations.payload_json
run_checks.source_operation_id
run_checks.observed_at
idx_run_checks_source_operation
```

Reopening a schema 37 database validates column and index shape and fails closed on drift. Existing operations and self-reported check text are not backfilled as trusted evidence; new verification must produce a successful current-Attempt Bash receipt.

The schema 33 preflight may record ambiguous source rows in `migration_issues`. Any open issue blocks startup. Correct the underlying source data and rerun the migration; do not delete or bypass the ledger.

## Deployment order

1. Verify the candidate Core archive and checksum.
2. Open a restored database with the release-local `Store` twice.
3. Require both opens to report `schema_meta.version=37`, zero open migration issues and the trusted-evidence index.
4. Start exactly one Core writer and require `/api/v1/health` to report `data.ok=true` and `data.writer.ready=true`.
5. Start one Gateway consumer, claim a new generation, replay from the durable ACK, persist each event, then ACK it.
6. Run `scripts/gateway-readiness-probe.mjs`; require exit 0, `ready=true`, zero lag and no terminal unacknowledged events.
7. Deploy the matching independent Web Console artifact.
8. Reopen traffic and monitor writer authority, consumer lag, Learning watermarks, Supervisor transport failures and runtime continuations.

Use [GATEWAY_PRODUCTION_READINESS.md](GATEWAY_PRODUCTION_READINESS.md) for the executable production gates.

## Verification

- `/api/v1/health` is ready and removed `/api/health` returns 404;
- schema version is 37 and a second open is idempotent;
- `migration_issues` has zero open rows;
- only one fresh writer fence exists;
- a passed required check is rejected unless it references a successful Bash operation from the current Attempt;
- change, verification and release completion reaches the semantic Supervisor only after trusted deterministic evidence passes;
- Gateway consumer lag and terminal unacknowledged counts are zero;
- configured Memory/Learning modes and authority state match policy;
- Core serves no Web assets and the Web Console targets the intended Gateway/API origin.

## Rollback

There is no in-place schema downgrade.

For a binary rollback that still understands schema 37, stop traffic and the current writer, switch the immutable release pointer, start one replacement writer and rerun readiness checks.

For any rollback to a schema-36-only or older binary:

1. stop Gateway traffic and all writers;
2. preserve the failed-upgrade database and readiness evidence for diagnosis;
3. restore the complete matching pre-upgrade SQLite/WAL/SHM recovery set;
4. restore the matching PostgreSQL/Cold state when Memory was enabled;
5. restore the matching artifact and configuration;
6. start exactly one old writer and validate it before reopening compatible traffic.

Do not overwrite a live schema 37 database with old files, and do not run an incompatible binary merely to inspect it.
