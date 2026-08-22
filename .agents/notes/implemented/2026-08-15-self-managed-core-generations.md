# Decision: Self-managed Core generations

Status: implemented
Kind: architecture

## Problem

Core already owns durable Attempt, operation, Continuation, transcript, checkpoint, writer-fence, quiescent-shutdown, and immutable-release behavior, but a running process cannot safely replace itself. Calling `systemctl`, switching a release link, or terminating the process from an Agent tool can kill the caller before its receipt and handoff are durable. A separate updater daemon would duplicate lifecycle authority, while same-heap JavaScript patching cannot establish quiescence or exclude stale database writers.

Core 0.8 also accepts only the exact `tagent-core/0.8` SQLite schema. Generation replacement must preserve that constraint instead of introducing an implicit migration path.

## Decision

Run one product and one systemd service as two process layers. A small `CoreHost` parent supervises one replaceable Core Generation child. The Host owns verified immutable-release selection, bounded restart/backoff, an atomically persisted activation manifest, strict Generation IPC, drain deadlines, candidate start, readiness, commit, and rollback. systemd remains the Host crash boundary.

The Host is an independently enforced module, not another workspace or service. `apps/core-service/src/host.ts` imports only Node APIs and the neutral `generation-protocol.ts`; architecture tests reject `@tagent/*`, application-composition, persistence, and Generation imports. It uses the verifier resolved from the running Host release rather than executing a candidate's verifier as its trust root. The Generation side is isolated in optional `GenerationHostBridge` and `ManagedGenerationAdapter` composition modules. Direct Generation bootstrap contains no Host dependency, and core application/runtime composition sees only a generic additional-Tool-Provider factory and lifecycle callback.

The existing Core service becomes the Generation. It continues to own HTTP, Runtime, domain services, the SQLite provider, instance lock, writer lease/fence, startup recovery, and quiescent close. The Host starts every Generation with the stable release root as its working directory rather than an immutable release directory, preserving default relative database and workspace identities across activation and rollback. A Generation reports `READY`, accepts `DRAIN`, persists a restart handoff after Runtime and background quiescence but before releasing writer authority, reports `DRAINED`, and exits. Parent IPC loss initiates Generation shutdown.

The IPC protocol is versioned and contains exact `protocolVersion`, `generationId`, and request identity. Its messages are `READY`, `ACTIVATE`, `DRAIN`, `DRAINED`, and `ACTIVATION_RESULT`. A request names only `current` or a full commit already installed under the configured release root. Host paths are resolved beneath that root; arbitrary paths and URLs are rejected.

Expose one native, approval-bound `core_generation_activate` Runtime tool only for a managed immutable release. It uses the existing explicit Attempt external-action approval and writer-fenced operation receipt through the maintained Runtime tool pipeline. The general `RuntimeTool.onOperationSettled` seam runs only after a new successful receipt is durable. Receipt replay does not call the hook, settlement failure cannot dispatch, and startup reconciliation redelivers a succeeded request that has no terminal activation event. The exact target/reason payload remains bound by the operation receipt. Bash and systemd are not the Agent control boundary.

Reuse `operations`, `run_events`, and `run_continuations`; do not add a restart-handoff table. A structured restart marker in Continuation `reason` identifies the request and target release. After quiescence, one writer-fenced transaction verifies the settled operation, reuses or queues the Continuation, moves the initiating interrupted Run to blocked, and appends `maintenance.handoff.prepared`. The next Generation records the activation result before starting the handoff Continuation. It then resumes from transcript, checkpoint, Context Manifest, and exact operation receipts without replaying settled effects.

Unexpected Generation exit restarts the same committed release with bounded exponential backoff. Startup may automatically queue a crash-recovery Continuation only when recovery found no `outcome_unknown` operation or control delivery and no pending input or approval. Ambiguous effects remain blocked for reconciliation.

Automatic crash recovery also requires no `outcome_unknown` TaskRun command, running tool attempt, or existing queued/running Continuation, and is limited to two recoveries per Run. Parent IPC loss has a bounded Generation fail-stop fallback. Crash timestamps are persisted before another restart is attempted; inability to persist the budget fails the Host closed.

The Host commits `current` only after the target Generation reports ready with a writer fence strictly higher than the prior Generation. A target that fails readiness or reports a non-advancing fence is replaced by the previous release, whose fence must advance again. Automatic binary rollback is allowed only while the state contract is unchanged. The later state-evolution decision advances the manifest contract to `tagent-core/state-0.8-r2`; the first r2 migration requires a full Host/service restart, and the Host thereafter rejects automatic rollback to r1 binaries.

SQLite stays behind the existing application persistence ports and entirely inside the Generation. Phase one does not introduce another state-provider abstraction merely for the Host because the Host has no application-state need. A later decision may add read-only `inspect`, idempotent `prepare`, monotonic state-format upgrades, and Provider replacement. Such work must explicitly supersede the current no-upgrade decision and prohibit automatic old-binary rollback after an irreversible state change.

## Alternatives considered

**Independent updater service.** Rejected because it introduces another deployment, authority, failure, and persistence boundary for behavior that a small parent loop can own inside the existing service.

**Agent invokes Bash or systemctl.** Rejected because the tool can terminate its own receipt/transcript path, bypass exact approval binding, and cannot durably coordinate handoff with the new process.

**Patch modules in the live JavaScript heap.** Rejected because existing Promises, native modules, closures, timers, and writer ownership cannot be proven quiescent across a module replacement.

**Host proxies HTTP or shares a listening socket between generations.** Deferred because zero-downtime traffic switching adds a network boundary and permits overlapping Generations. A short readiness gap is preferable while SQLite remains a single-writer embedded provider.

**New maintenance tables.** Rejected for phase one because operation receipts, Run events, Continuations, and an external Host activation manifest already provide the required durable identities and recovery facts.

**Add migrations as part of self-restart.** Rejected for phase one because it would contradict the current exact-schema contract and would make binary rollback unsafe before a state protocol and upgrade policy exist.

## Verification

`tests/core-service-workspace-package.test.ts` enforces the Host import boundary, private Generation entry, explicit managed-process exit, and the single Host system entrypoint. `tests/core-host.test.ts` covers strict/oversized IPC, backpressure, early parent disconnect, closed activation shape, stale drain identity, durable activation serialization, normal and same-release replacement, stable Generation working directories, monotonic writer fences, exact/conflicting replay, terminal-result persistence failure, forced drain, candidate readiness and commit-state rollback, deterministic Host crash points, startup-child reclamation, direct development startup, and durable crash budgets. `tests/core-lifecycle.test.ts` verifies handoff preparation occurs after quiescence and before writer release.

`tests/tool-pipeline.test.ts` proves explicit approval, post-receipt dispatch order, replay suppression, and no dispatch on settlement failure. `tests/store.test.ts` proves idempotent activation receipt/handoff/result recovery, conflicting-terminal rejection, every crash-recovery exclusion, and the two-Continuation limit. `tests/release-deploy.test.ts` proves the Host/state manifest contract, private Host/Generation modules, stage-only deployment, first-install bootstrap, tampered-release rejection, and no systemd/health ownership. The focused TypeScript, lifecycle, release, Gateway, architecture, and persistence suites plus repository `lint`, `check`, full test, and diff gates are the release evidence.

The original phase added no application table. The later revision-2 migration adds only the append-only schema journal and advances release manifests to `tagent-core/state-0.8-r2`; `hostProtocolVersion: 1` and the unexported `node_modules/@tagent/core-service/dist/generation-entry.js` child entry remain unchanged.

## Consequences

The Agent can restart or activate a compatible staged Core Generation and resume its durable TaskRun without a second updater process. Host code, application state, and Generation composition have explicit one-way boundaries; replacing SQLite later does not require changing Host supervision.

The stable Host is a small trusted root. Its protocol must remain backward compatible; Host implementation/protocol changes still require a full service restart. There is a bounded availability gap while the old Generation releases its listener/writer and the candidate becomes ready.

Forced termination cannot prove in-process quiescence, so recovery relies on process death, writer-fence takeover, and existing `outcome_unknown` rules. Reusing Continuation reason markers avoids a schema change but remains an interim typed-state compromise. SQLite and optional external Memory stores are not one transaction, so generation replacement is limited to an unchanged state contract until a later idempotent roll-forward design exists.
