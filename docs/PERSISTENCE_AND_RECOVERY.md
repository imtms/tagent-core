# Persistence and recovery

## Ownership

`@tagent/persistence-sqlite` owns the control-plane SQLite schema, repositories, migrations, transaction boundary, writer authority, and restart recovery primitives. Domains depend on its ports through the Core composition root; they do not issue uncontrolled SQL.

The current schema version is 35:

| Version | Authority introduced |
| --- | --- |
| 30 | canonical `Attempt`, execution leases, projection checkpoints, restart comparison |
| 31 | canonical Governance projections and expanded approval receipts |
| 32 | capability-authorization uniqueness, indexes, and immutable identity constraints |
| 33 | Learning integration journal, delivery, checkpoints, reconciliation, authority, effect receipts, migration issue ledger |
| 34 | Workspace model/reasoning preferences and immutable TaskRun execution-profile snapshots |
| 35 | lightweight Workspace Goals, immutable definition/plan revisions, decisions, Run links and evidence links |

Migrations are forward-only for a running release. A binary that only understands schema 34 must never open a schema 35 database.

## Startup order

Core becomes ready only after this sequence succeeds:

1. acquire the OS instance lock next to the SQLite database;
2. open the Store and run schema migrations;
3. claim the Core writer lease and fence;
4. install the connection-level writer guard;
5. start writer heartbeat verification;
6. run guarded post-migration and restart recovery;
7. construct Memory, Learning, runtime, Supervisor, and HTTP services;
8. recover continuations and Session Inbox work;
9. listen, start background workers, and mark the writer ready.

`GET /api/v1/health` returns 503 when the writer exists but is not ready. A lost instance lock, stale heartbeat, rejected lease, or changed connection guard clears readiness and initiates shutdown.

## Single-writer authority

The OS lock prevents two local Core processes from targeting the same database. Stale-lock recovery verifies host and process identity and fails closed when ownership cannot be proven.

The SQLite writer lease supplies a monotonic fence. Mutation adapters assert that fence, and connection-level triggers reject writes that do not carry the active authority. This protects the database even if code reaches a lower repository layer incorrectly.

## Unit of Work

Writes that span repositories use a synchronous Unit of Work. The callback must finish before the SQLite transaction returns; asynchronous callbacks are rejected. State transitions, receipts, events, projection checkpoints, and outbox entries therefore become visible atomically.

Do not perform provider calls, filesystem I/O, timers, or other asynchronous work inside the transaction. Persist intent/outbox state first, commit, then perform the effect under its owned lease and receipt protocol.

## Restart classification

Recovery does not guess that an interrupted external effect succeeded or failed:

- effect started without a durable terminal receipt becomes `outcome_unknown`;
- authorized work whose effect had not started becomes `cancelled` with `restart_before_effect`;
- a Pi control delivery that was in delivery becomes `outcome_unknown`;
- interrupted `Attempt`s release stale execution leases, reject unresolved candidate state, and preserve an auditable recovery event;
- pending Supervisor continuations, Session Inbox work, Learning deliveries, and checkpoints are reconciled through their durable state.

`outcome_unknown` requires explicit reconciliation or operator action. Replaying the same external mutation automatically could duplicate side effects.

## Schema 33 migration issues

The v33 preflight records ambiguous or unsafe source rows in `migration_issues`. Startup must stop while open issues remain. Do not delete, ignore, or manually mark the ledger resolved without correcting the source data and following the migration procedure.

## Shutdown order

Core stops new readiness first, then stops background workers, closes active runtimes, stops heartbeat work, removes the connection guard, releases the writer lease, closes the Store, and releases the OS instance lock. Shutdown attempts every step and reports aggregate failures.

## Backup and restore

Before upgrades or storage maintenance:

1. stop Core and confirm no writer remains;
2. copy the SQLite database with its WAL and SHM files as one recovery set;
3. record the release commit, artifact checksum, configuration, and schema version;
4. back up PostgreSQL and Local Cold/S3 state consistently when Memory is enabled;
5. test restore into an isolated location.

Do not copy only the main SQLite file while a writer is active. Rollback across schema versions means restoring the matching database backup and binary together.
