# Persistence and recovery

`@tagent/persistence-sqlite` owns Core's control-plane SQLite schema, repositories, synchronous transaction boundary, writer fencing, and restart recovery. Domain packages depend on persistence ports wired by `@tagent/core-service`; they do not issue uncontrolled SQL.

## Supported database contract

Core 0.8 supports one database shape:

| Field | Value |
| --- | --- |
| Durable marker | `core_schema.schema_id = 'tagent-core/0.8'` |
| Public numeric schema version | `1` |
| Creation source | `adapters/persistence-sqlite/src/current-schema.ts` |
| Upgrade support | none; only an empty database or the exact current schema is accepted |

An empty database is created in one transaction. Every subsequent open builds the reference schema in memory and compares the ordered `sqlite_master` table, index, and trigger definitions with the persisted database. A missing marker, another schema ID, an extra or missing object, or changed SQL fails startup. Core does not repair, backfill, or upgrade an earlier database.

For a new deployment, point `TAGENT_DB` at a nonexistent file or a verified empty database. If Core reports an unsupported schema or schema drift, stop it and create a new database. Do not copy rows or edit the marker to bypass validation.

## Startup order

Production startup is ordered so no runtime can mutate before writer ownership is established:

1. acquire the OS instance lock;
2. open SQLite, create or validate the exact current schema, and surface interrupted durable profile operations as `outcome_unknown`;
3. claim the `core_writer_lease` and monotonic fence;
4. install connection-level mutation guards;
5. create `SqlitePersistence` and the domain services;
6. start lifecycle-owned workers;
7. run writer-guarded startup recovery;
8. start HTTP and mark the writer ready.

Core rejects a second live instance. Losing the writer lease or failing a guard clears readiness and initiates shutdown.

## Transaction and writer authority

`SqliteUnitOfWork` is synchronous by design: work cannot cross an `await` while a SQLite transaction is open. Multi-repository mutations use this boundary. The active writer fence is checked by mutation adapters and connection guards, so reaching a lower repository directly does not grant write authority.

TaskRun state changes use the closed `TaskRunTransitionPort`. Attempt identity, version, execution lease token, and fence are validated inside the same transaction as runtime mutations. Approval consumption, operation authorization, and the append-only allow receipt are also one atomic write.

## Restart recovery

Startup never blindly repeats an effect whose outcome may have escaped Core:

- a capability effect that reached `effect_started` becomes `outcome_unknown`;
- an authorized capability operation that had not started is cancelled with `restart_before_effect`;
- other running operations become `outcome_unknown` with `service_restart`;
- in-flight control delivery becomes `outcome_unknown`;
- started TaskRun command, Workspace Goal, and capability-profile operation receipts become `outcome_unknown`;
- exact terminal receipts remain replayable without repeating the effect.

Callers must reconcile `outcome_unknown` explicitly. Automatic replay is forbidden.

## Learning integration

Learning consumes the immutable `integration_outbox` through one durable consumer, `learning-projection-v1`. Delivery state lives in `integration_consumer_delivery`; the contiguous checkpoint lives in `learning_projection_checkpoint`; `effect_receipts` deduplicate applied effects. A worker must hold the current lease generation, apply the effect and record its receipt atomically, then ACK and advance the checkpoint. There is no alternate projection source or runtime authority switch.

## Event delivery and receipts

Gateway event consumers claim a generation and ACK monotonically. Reclaiming produces a higher generation; stale generations cannot ACK. Gateway must durably persist the exact `(taskRunId, consumerId, generation, sequence, eventId)` delivery before ACK.

TaskRun commands, Workspace Goal operations, and capability-profile operations bind idempotency identity to a canonical payload hash. An exact retry returns the first result; a changed payload conflicts. A started receipt recovered after process loss is observable as `outcome_unknown`, not as permission to repeat an external effect.

## Trusted verification

A trusted passed check binds to a completed successful `tool.bash` operation from the same Run and current Attempt. Core verifies the canonical command, exit code, completion time, and source operation on finalization. Caller-authored evidence text or timestamps cannot establish trust. Workspace mutations make earlier checks stale; explicit read-only receipts do not.

## Shutdown order

Core removes readiness first and stops heartbeat timers. Runtime and background services then cancel and join all owned work as quiescence barriers. Only after both barriers settle does Core remove the connection guard, release the writer lease, close SQLite, and release the OS lock. If settlement cannot be proved, lifecycle remains `closing` and persistence authority is retained rather than being released under live work.

## Backup and restore

For same-release disaster recovery:

1. stop Core and confirm no writer remains;
2. copy the SQLite database with any WAL and SHM files as one recovery set;
3. record the release tag, commit, artifact checksum, configuration, and schema ID;
4. back up PostgreSQL and cold storage consistently when Memory is enabled;
5. test the restore with the identical release artifact in an isolated location.

Backups from an earlier schema ID are not upgrade inputs for Core 0.8. A release rollback is safe only when it accepts `tagent-core/0.8`; otherwise deploy with a new empty database or keep the current release running.
