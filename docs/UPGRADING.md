# Upgrade and rollback

This guide describes the current repository boundary: API v1, independently deployed Core and Web Console artifacts, one fenced SQLite writer, and control-plane schema 43. Release tags retain version-specific historical instructions.

## Compatibility boundary

- Supported HTTP routes use `/api/v1`; removed unversioned `/api/*` routes stay removed.
- Core is API-only and does not serve the Web Console or an SPA fallback.
- Durable submissions use the `Idempotency-Key` header and v1 receipt envelopes.
- Production uses Node.js `24.18.1`, npm 12 or newer, and Linux x64/Node ABI 137 for the immutable Core artifact.
- SQLite migrations are forward-only. A binary that understands at most schema 42 must not open schema 43.
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
| 35 | lightweight Workspace Goals and immutable definition/Roadmap revisions |
| 36 | Goal decision/evidence idempotency, freshness and mutation authorization |
| 37 | operation audit payloads and trusted current-Attempt Bash bindings for checks |
| 38 | automatic Goal guidance, Roadmap admission/progress and repeatable lifecycle decisions |
| 39 | durable Gateway Session/command/Goal operation receipts and settled/final event ACKs |
| 40 | durable Submission principal/provenance audit receipts |
| 41 | ordered Session/TaskRun indexes for Operator Read pagination and latest selection |
| 42 | durable Session Inbox execution-policy snapshots |
| 43 | immutable Skill revisions and per-Session Skill bindings |

Schema 37 added:

```text
operations.payload_json
run_checks.source_operation_id
run_checks.observed_at
idx_run_checks_source_operation
```

Schema 38 adds:

```text
workspace_goal_run_links.link_mode
workspace_goal_inbox_links
workspace_goal_roadmap_item_progress
```

The v38 migration classifies historical Goal-linked Runs, backfills Roadmap item progress and rebuilds the Goal decision table without the obsolete one-decision-per-kind identity constraint. Request-ID uniqueness remains authoritative. Reopening a schema 38 database validates both the v37 trusted-evidence shape and the v38 Goal execution shape and fails closed on drift. Existing operations and self-reported check text are not backfilled as trusted evidence.

Schema 39 adds:

```text
session_create_receipts
task_run_command_receipts
workspace_goal_operation_receipts
event_consumers.settled_acked_seq
event_consumers.final_acked_seq
```

The v39 migration backfills the settled ACK from the deprecated terminal ACK and is re-entrant. Re-entry validates full table columns, constraints, foreign keys and indexes rather than checking a partial inventory. On every reopen, unfinished command and Goal operation receipts become `outcome_unknown`; Core never guesses or automatically repeats a possibly completed effect.

Schema 40 adds `submission_audit_receipts`. New Submission admission atomically preserves the Session/key identity, Core principal, canonical payload/hash and channel-neutral provenance with the inbox item. The migration and every reopen validate the full table, foreign key, unique identity and index shape.

Schema 41 adds `idx_sessions_operator_created`, `idx_runs_operator_session_created`, and `idx_runs_operator_session_updated`. Migration and every reopen validate their table ownership and exact ordered columns. The indexes back `operator.read.v1`; no Session or TaskRun data is rewritten.

The schema 33 preflight may record ambiguous source rows in `migration_issues`. Any open issue blocks startup. Correct the underlying source data and rerun the migration; do not delete or bypass the ledger.

## Deployment order

1. Verify the candidate Core archive and checksum.
2. Open a restored database with the release-local `Store` twice.
3. Require both opens to report `schema_meta.version=43`, zero open migration issues, the trusted-evidence/Goal execution shapes, all v39 receipt/ACK shapes, the v40 Submission audit shape, all v41 Operator Read indexes, the v42 Inbox execution-policy column, and the v43 Skill tables.
4. Start exactly one Core writer and require `/api/v1/health` to report `data.ok=true` and `data.writer.ready=true`.
5. Negotiate `GET /api/v1/capabilities`; require schema 43, the necessary commands/events, the versioned Operator allowlist, current Approval authority, receipt-recovery protocol, retention policy, documented limits and the `operator.read.v1` marker. Then validate `GET /api/v1/operator/capabilities` before enabling historical inventory.
6. Start one Gateway consumer, claim a new generation, replay from the durable ACK, persist each event, then ACK it.
7. Run `scripts/gateway-readiness-probe.mjs`; require exit 0, `ready=true`, zero lag and no settled/final unacknowledged events.
8. Deploy the matching independent Web Console artifact.
9. Reopen traffic and monitor writer authority, `outcome_unknown` receipts, consumer lag, Learning watermarks, Supervisor transport failures and runtime continuations.

Use [GATEWAY_PRODUCTION_READINESS.md](GATEWAY_PRODUCTION_READINESS.md) for the executable production gates.

## Verification

- `/api/v1/health` is ready and removed `/api/health` returns 404;
- schema version is 43 and a second open is idempotent;
- `migration_issues` has zero open rows;
- only one fresh writer fence exists;
- a passed required check is rejected unless it references a successful Bash operation from the current Attempt;
- change, verification and release completion reaches the semantic Supervisor only after trusted deterministic evidence passes;
- Gateway consumer lag and settled/final unacknowledged counts are zero;
- configured Memory/Learning modes and authority state match policy;
- Core serves no Web assets and the Web Console targets the intended Gateway/API origin.

## Rollback

There is no in-place schema downgrade.

For a binary rollback that still understands schema 43 and the current ABI window, stop traffic and the current writer, switch the immutable release pointer, start one replacement writer and rerun readiness checks.

For any rollback to a schema-40-only or older binary:

1. stop Gateway traffic and all writers;
2. preserve the failed-upgrade database and readiness evidence for diagnosis;
3. restore the complete matching pre-upgrade SQLite/WAL/SHM recovery set;
4. restore the matching PostgreSQL/Cold state when Memory was enabled;
5. restore the matching artifact and configuration;
6. start exactly one old writer and validate it before reopening compatible traffic.

Do not overwrite a live schema 43 database with old files, and do not run an incompatible binary merely to inspect it.
