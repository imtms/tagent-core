# Persistence and recovery

`@tagent/persistence-sqlite` owns Core's control-plane SQLite schema, repositories, synchronous transaction boundary, writer fencing, and restart recovery. Domain packages depend on persistence ports wired by `@tagent/core-service`; they do not issue uncontrolled SQL.

The stable Core Host is deliberately outside this boundary. It never imports `Store`/SQLite composition and never opens application persistence. It keeps only the small, atomically replaced `<release-root>/runtime/activation.json` manifest containing the active activation identity, phase, releases, and durable crash timestamps. The replaceable Core Generation owns every application database and optional Memory connection.

## Supported database contract

Core 0.8 supports one current database shape and a monotonic revision history:

| Field | Value |
| --- | --- |
| Durable marker | `core_schema.schema_id = 'tagent-core/0.8'` |
| Public numeric schema version | `2` |
| Creation source | deterministic SQL fragments under `adapters/persistence-sqlite/src/schema` |
| Upgrade support | exact revision 1 and pre-`user_version` 0.8 databases migrate transactionally to revision 2 |

An empty database is created from the revision-1 baseline and upgraded through the same ordered migration runner used for existing databases. Revision 2 adds the append-only `core_schema_migrations` journal and records SHA-256 checksums for the exact baseline and migration SQL. `PRAGMA user_version`, the journal, marker, and ordered `sqlite_master` definitions must all agree. Migration execution uses one `BEGIN IMMEDIATE` transaction; a failure leaves the prior revision intact. A missing marker, unsupported/newer revision, changed journal, or structural drift fails startup instead of attempting ad-hoc repair.

For a new deployment, point `TAGENT_DB` at a nonexistent file, a verified empty database, or an exact revision-1 0.8 database. Back up the database and WAL/SHM recovery set before the first revision-2 start. If Core reports an unsupported schema, checksum mismatch, or structural drift, restore/repair from a verified backup. Do not copy rows or edit markers, revisions, or the journal to bypass validation.

## Generation startup order

Production startup is ordered so no runtime can mutate before writer ownership is established:

1. acquire the OS instance lock;
2. open SQLite, transactionally create or upgrade the supported exact shape, validate the current revision/journal, and surface interrupted durable profile operations as `outcome_unknown`;
3. claim the `core_writer_lease` and monotonic fence;
4. install connection-level mutation guards;
5. create `SqlitePersistence` and the domain services;
6. start lifecycle-owned workers;
7. run writer-guarded startup recovery;
8. start HTTP and mark the writer ready.

Core rejects a second live instance. Losing the writer lease or failing a guard clears readiness and initiates shutdown.

Before this sequence, the Host resolves `current`, checks that it is a contained 40-character immutable release, uses its own trusted release verifier to validate the artifact, and forks the Generation. Every Generation uses the stable release root—not its immutable release directory—as its working directory, so default relative database/workspace paths remain identical across activation and rollback. The Generation reports `READY` only after HTTP is listening, background reconciliation has completed, and writer readiness is established, then emits writer-fenced IPC heartbeats. Development startup can still run through the Host as a non-activatable `development` Generation; direct `bootstrapCore` tests remain Host-independent.

## Transaction and writer authority

`SqliteUnitOfWork` is synchronous by design: work cannot cross an `await` while a SQLite transaction is open. Multi-repository mutations use this boundary. The active writer fence is checked by mutation adapters and connection guards, so reaching a lower repository directly does not grant write authority.

TaskRun state changes use the closed `TaskRunTransitionPort`. Attempt identity, version, execution lease token, and fence are validated inside the same transaction as runtime mutations. Approval-bound capability execution keeps approval use, operation authorization, and its append-only allow receipt in one atomic write. Runtime-tool external-action approval uses a separate Attempt activation: inspection is read-only, while activation revalidates the active persisted Attempt and atomically records its first-use state plus append-only receipt immediately before dispatch.

User-input submission and human approval necessarily cross separate UI commands. Their intermediate states are recoverable without widening authority: retrying an already-submitted input must carry the same normalized values and can recreate only its missing next-Attempt approval boundary; retrying an already-approved external-action request can resume only its recorded `approvedAttempt`, and only when the Run is still on the immediately preceding Attempt. A manual Resume request on an inactive external-action Run does not advance the Attempt: it creates a real `execute_external_action` approval bound to the next Attempt, and only approval resolution can resume it. Generic `resume_taskrun` approval cannot substitute for that authority. Repeated command recovery does not append another user message or approval event, and an approval can never resume a later Attempt.

## Restart recovery

Startup never blindly repeats an effect whose outcome may have escaped Core:

- a capability effect that reached `effect_started` becomes `outcome_unknown`;
- an authorized capability operation that had not started is cancelled with `restart_before_effect`;
- other running operations become `outcome_unknown` with `service_restart`;
- in-flight control delivery becomes `outcome_unknown`;
- started TaskRun command, Workspace Goal, and capability-profile operation receipts become `outcome_unknown`;
- exact terminal receipts remain replayable without repeating the effect.

Callers must reconcile `outcome_unknown` explicitly. Automatic replay is forbidden.

Workspace Goal recovery separately replays safe, idempotent projections rather than effects. Before queued Inbox dispatch, Core repairs any Goal Inbox item that already owns a Run but is missing its durable Run link/snapshot, then projects every linked Run's current status and evidence back into Goal state. Inbox claim, Run creation and Goal attachment are one transaction for new work. If a historical or corrupted internal Roadmap Run cannot prove its canonical Inbox authorization, mutation authorization remains fail-closed; it is never treated as an ordinary Workspace Run.

An unexpectedly terminated or heartbeat-unresponsive Generation is restarted by the Host on the committed release with durable exponential backoff and a bounded crash budget. Pre-`READY` failures consume the same budget across Host restarts; release-resolution and verification failures do not. Startup may queue a crash-recovery Continuation only when all of these are true for an interrupted TaskRun:

- no operation, control delivery, or TaskRun command is `outcome_unknown`;
- no tool attempt is still `running`;
- no user input or approval is pending;
- no Continuation is already queued or running;
- the Run has neither external-action execution policy nor any external-action approval history;
- the Run has used fewer than two automatic crash-recovery Continuations.

The Continuation reason carries `[crash-recovery:<restart-event-sequence>]` and instructs the next Attempt to reuse transcript, receipts, Context Manifest, and checkpoints without repeating settled effects. External-action Runs never cross this automatic boundary, even when no effect is ambiguous; a legacy queued external Continuation is cancelled before claim and the operator must request a fresh Attempt-bound approval. Any ambiguity leaves the Run `interrupted` for human reconciliation.

## Generation activation and handoff

`core_generation_activate` is a receipt-first maintenance effect. Even an ordinary TaskRun must have explicit human external-action approval. The normal tool pipeline settles the exact `maintenance.activate_generation` operation receipt under the current Attempt/writer fence; only its post-settlement hook may send the request to the Host. Receipt replay never dispatches twice, while startup reconciliation redispatches a succeeded receipt that has no terminal activation event.

Graceful replacement reuses the existing state model rather than adding maintenance tables:

1. the Host persists the activation identity and asks the active Generation to drain;
2. HTTP readiness is removed, owned Runtime/background work is cancelled and joined;
3. one fenced SQLite transaction verifies the succeeded operation receipt, creates or reuses a Continuation marked `[restart-handoff:<requestId>:<targetRelease>]`, moves the Run to `blocked`, updates its Attempt/checkpoint, and appends `maintenance.handoff.prepared`;
4. the Generation releases the writer guard, lease, Store, and OS lock, flushes `DRAINED`, and exits;
5. the candidate reports `READY` with a writer fence strictly higher than the drained Generation; the Host rejects a non-advancing fence and requires the candidate to survive the stabilization window with valid heartbeats before atomically changing `current`, recording the terminal Host phase, and returning the activation result;
6. the new Generation records `maintenance.activation.succeeded` or `.failed` before recovering the handoff Continuation.

If the initiating Run reached `completed` or `failed` between its accepted tool receipt and drain, handoff deliberately reopens it as `blocked`. This avoids losing the accepted activation across the final-response race; the continuation may generate one new complete standalone final response.

A drain timeout causes the Host to terminate the old process before starting a candidate. Process death and the existing writer fence then provide exclusion; ambiguous effects are still governed by the same `outcome_unknown` rules. Candidate readiness failure re-verifies and restores the previous release. If the Host itself crashes during activation, `current` plus `activation.json` deterministically decides whether the recovered result is committed or rolled back.

## Retired schema compatibility

The immutable revision-1 baseline still declares the former Learning tables and indexes. Current runtime code never reads or writes them; they remain solely so existing databases keep historical rows and exact-schema verification remains safe. Do not drop or rewrite these objects in place. A future data-removal migration must be explicit, backed up, and separately versioned.

## Event delivery and receipts

Gateway event consumers claim a generation and ACK monotonically. Reclaiming produces a higher generation; stale generations cannot ACK. Gateway must durably persist the exact `(taskRunId, consumerId, generation, sequence, eventId)` delivery before ACK.

TaskRun commands, Workspace Goal operations, and capability-profile operations bind idempotency identity to a canonical payload hash. An exact retry returns the first result; a changed payload conflicts. A started receipt recovered after process loss is observable as `outcome_unknown`, not as permission to repeat an external effect.

## Trusted verification

A trusted passed check binds to a completed successful `tool.bash` operation from the same Run and current Attempt. Core verifies the canonical command, exit code, completion time, and source operation on finalization. Caller-authored evidence text or timestamps cannot establish trust. Workspace mutations make earlier checks stale; explicit read-only receipts do not.

## Shutdown order

Core removes readiness first and stops heartbeat timers. Runtime and background services then cancel and join all owned work as quiescence barriers. Only after both barriers settle does Core remove the connection guard, release the writer lease, close SQLite, and release the OS lock. If settlement cannot be proved, lifecycle remains `closing` and persistence authority is retained rather than being released under live work.

During an activation, the durable handoff transaction runs after Runtime/background quiescence and before writer release. A Generation also closes on parent IPC loss and has a bounded fail-stop fallback so an orphan cannot retain writer authority indefinitely.

## Backup and restore

For same-release disaster recovery:

1. stop Core and confirm no writer remains;
2. copy the SQLite database with any WAL and SHM files as one recovery set;
3. record the release tag, commit, artifact checksum, configuration, and schema ID;
4. back up PostgreSQL and cold storage consistently when Memory is enabled;
5. test the restore with the identical release artifact in an isolated location.

Backups from another schema ID are not upgrade inputs for Core 0.8. A release rollback is safe only when it accepts both `tagent-core/0.8` revision 2 and the declared state protocol; otherwise restore the matching pre-upgrade backup or keep the current release running.

Generation self-management does not run an in-band state-protocol transition. Revision 2 release manifests declare `tagent-core/state-0.8-r2`; the stable Host rejects revision-1 manifests, preventing automatic rollback to a binary that cannot read the migrated database. The first r2 deployment therefore requires a full Host/service restart after backup. Later automatic activation rollback is allowed only among releases declaring the same r2 protocol. Optional Memory remains unchanged.
