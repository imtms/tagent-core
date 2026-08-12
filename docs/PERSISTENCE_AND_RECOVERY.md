# Persistence and recovery

## Ownership

`@tagent/persistence-sqlite` owns the control-plane SQLite schema, repositories, migrations, transaction boundary, writer authority, and restart recovery primitives. Domains depend on its ports through the Core composition root; they do not issue uncontrolled SQL.

The current schema version is 42:

| Version | Authority introduced |
| --- | --- |
| 30 | canonical `Attempt`, execution leases, projection checkpoints, restart comparison |
| 31 | canonical Governance projections and expanded approval receipts |
| 32 | capability-authorization uniqueness, indexes, and immutable identity constraints |
| 33 | Learning integration journal, delivery, checkpoints, reconciliation, authority, effect receipts, migration issue ledger |
| 34 | Workspace model/reasoning preferences and immutable TaskRun execution-profile snapshots |
| 35 | lightweight Workspace Goals, immutable definition/Roadmap revisions, decisions, Run links and evidence links |
| 36 | Goal decision/evidence idempotency, dynamic evidence freshness and mutation authorization support |
| 37 | operation audit payloads and current-Attempt trusted Bash bindings for Run checks |
| 38 | automatic Goal guidance, Goal Roadmap admission/progress, Run link modes and repeatable lifecycle decisions |
| 39 | Gateway Session/command/Goal operation receipts plus settled/final event-consumer ACK boundaries |
| 40 | Submission principal/provenance audit receipts and canonical-payload recovery |
| 41 | ordered Session/TaskRun indexes for bounded Operator Read keyset pagination |
| 42 | durable Session Inbox execution-policy snapshots for effect-before-approval enforcement |

Schema 37 added `operations.payload_json`, `run_checks.source_operation_id`, `run_checks.observed_at`, and the partial source-operation index. Legacy operations are not retroactively promoted to trusted evidence.

Schema 38 adds `workspace_goal_run_links.link_mode`, `workspace_goal_inbox_links` and `workspace_goal_roadmap_item_progress`. It classifies historical Goal-linked Runs, backfills Roadmap progress and removes the legacy decision-identity constraint so valid pause/resume cycles can repeat. Re-entry validates the complete v37 trusted-evidence shape and the v38 Goal execution shape and fails closed on drift.

Schema 39 adds `session_create_receipts`, `task_run_command_receipts`, `workspace_goal_operation_receipts`, `event_consumers.settled_acked_seq`, and `event_consumers.final_acked_seq`. Session identity is scoped by `(principal_id,idempotency_key)`; command identity by `(principal_id,task_run_id,command_id)`; Goal operation identity by `(goal_id,request_id)`. Every receipt stores the canonical payload hash. Re-entry validates the complete receipt column order/type/nullability/default/primary-key shape, foreign keys, status checks, ACK columns, and every explicit index fail-closed.

Schema 40 adds `submission_audit_receipts`. Submission identity remains `(session_id,idempotency_key)` while the audit receipt preserves the first Core principal, canonical content-plus-origin payload/hash, channel-neutral provenance, and Submission identity. The inbox item and its audit receipt commit together for new submissions; replay returns the original audit chain and changed canonical provenance conflicts. Re-entry validates the full table, unique identity, foreign key and indexes.

Schema 41 adds `idx_sessions_operator_created`, `idx_runs_operator_session_created`, and `idx_runs_operator_session_updated`. They support immutable Session/TaskRun inventory order and deterministic latest-Run selection. Re-entry validates index ownership and exact column order fail-closed. Operator cursor snapshot membership uses persisted row boundaries; read values remain read-committed.

Schema 42 adds `session_supervisor_inbox.execution_policy_json`. The Router decision now survives queueing and is copied into the immutable TaskRun contract, so external-action approval cannot be bypassed by the Inbox persistence boundary. Existing rows remain readable and use conservative legacy normalization.

Migrations are forward-only for a running release. A binary that only understands schema 41 must never open a schema 42 database.

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

The writer heartbeat keeps the 5-second interval and 10-second maximum-age safety boundary. The asynchronous instance-lock check is bounded by the remaining heartbeat lifetime, so a permanently pending check cannot hold shutdown open indefinitely. A synchronous writer-lease or connection-guard stage that returns only after the maximum age is treated as a missed heartbeat and cannot refresh readiness.

Heartbeat deadline failures include sanitized diagnostics for the active stage, completed stage durations, heartbeat age, and the event-loop delay maximum and p99 for the current heartbeat window. These diagnostics intentionally exclude database URLs, SQL, filesystem paths, request payloads, and credentials. Use them to distinguish a pending instance-lock check from SQLite contention or an event-loop stall; the fail-closed boundary must not be disabled or increased without production latency evidence.

## Single-writer authority

The OS lock prevents two local Core processes from targeting the same database. Stale-lock recovery verifies host and process identity and fails closed when ownership cannot be proven.

The SQLite writer lease supplies a monotonic fence. Mutation adapters assert that fence, and connection-level triggers reject writes that do not carry the active authority. This protects the database even if code reaches a lower repository layer incorrectly.

## Unit of Work

Writes that span repositories can use a synchronous Unit of Work. The callback must finish before the SQLite transaction returns; asynchronous callbacks are rejected. State transitions, receipts, events, projection checkpoints, and outbox entries become visible atomically only when their application path composes them in that Unit of Work.

The HTTP TaskRun command path persists the command claim before applying an effect and settles the terminal receipt afterward. Durable inbox admission and domain transitions own their own atomic state/event boundaries. A crash after an effect but before terminal receipt settlement therefore reopens the command receipt as `outcome_unknown`; Core never blindly repeats it. Gateway reconciles that explicit state against the typed read model. This conservative protocol is the stable public recovery contract for commands that can cross Runtime, provider, scheduler, or application-service boundaries.

Do not perform provider calls, filesystem I/O, timers, or other asynchronous work inside the transaction. Persist intent/outbox state first, commit, then perform the effect under its owned lease and receipt protocol.

## Restart classification

Recovery does not guess that an interrupted external effect succeeded or failed:

- effect started without a durable terminal receipt becomes `outcome_unknown`;
- authorized work whose effect had not started becomes `cancelled` with `restart_before_effect`;
- a Pi control delivery that was in delivery becomes `outcome_unknown`;
- a TaskRun command or Workspace Goal operation left at `started` becomes `outcome_unknown` before HTTP readiness;
- interrupted `Attempt`s release stale execution leases, reject unresolved candidate state, and preserve an auditable recovery event;
- pending Supervisor continuations, Session Inbox work, Learning deliveries, and checkpoints are reconciled through their durable state; a preparation failure requeues only its own continuation lease, not every lease held by the process owner;
- external-action continuations require a fresh approval bound to the next Attempt and never inherit a consumed authorization.

`outcome_unknown` requires explicit reconciliation or operator action. Replaying the same external mutation automatically could duplicate side effects.

Session creation is a fully local transaction: Session row and receipt commit together. `steer`/`follow_up` accept at the durable fenced control-inbox boundary and deliver asynchronously. Commands persist their receipt claim before invoking the effect; if Core cannot prove terminal settlement after restart, GET returns the preserved `outcome_unknown` receipt rather than executing the command again. This classification is a safe recovery fallback, not proof of atomic command completion. Goal Roadmap generation similarly claims its request before the single LLM call and never calls the model twice for the same request identity.

## Trusted verification receipts

Core persists the canonical input hash for every operation and a JSON audit payload for new operations. A passed check may bind only to a completed, succeeded `tool.bash` operation from the same Run and current Attempt whose actual command is present and whose result reports exit code zero. Core copies the operation completion time into the check and derives evidence from the receipt; caller-provided evidence text and timestamps cannot establish trust.

Read-only and verification Bash commands preserve current checks. Commands classified as workspace mutations make prior checks stale. Completion revalidates the source operation, Attempt, command, status, exit code and completion time instead of trusting the denormalized check row.

## Schema 33 migration issues

The v33 preflight records ambiguous or unsafe source rows in `migration_issues`. Startup must stop while open issues remain. Do not delete, ignore, or manually mark the ledger resolved without correcting the source data and following the migration procedure.

## Shutdown order

Core stops new readiness first, then stops background workers, closes active runtimes, stops and drains heartbeat work, removes the connection guard, releases the writer lease, closes the Store, and releases the OS instance lock. Shutdown attempts every step and reports aggregate failures. Repeated lifecycle closure shares the same close operation, so one authority failure cannot release resources more than once.

## Backup and restore

Before upgrades or storage maintenance:

1. stop Core and confirm no writer remains;
2. copy the SQLite database with its WAL and SHM files as one recovery set;
3. record the release commit, artifact checksum, configuration, and schema version;
4. back up PostgreSQL and Local Cold/S3 state consistently when Memory is enabled;
5. test restore into an isolated location.

Do not copy only the main SQLite file while a writer is active. Rollback across schema versions means restoring the matching database backup and binary together.
