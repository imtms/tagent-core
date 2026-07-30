# Changelog

All notable changes to TAgent Core are documented here.

## Unreleased

- Harden TaskRun supervision against duplicate proposed steers, stale attempt progress, terminal decision crash gaps, missing continuation rows, exhausted continuation resurrection, and spawned runtime launch failures.
- Refine progress semantics so read-only tool success and assistant message completion do not erase consecutive failures; classify skipped required contract items as non-recoverable.
- Add Schema v6 durable control inbox with request idempotency, bounded admission, per-attempt fencing, serialized FIFO delivery into Pi, and restart-safe `outcome_unknown` receipts.
- Return explicit `accepted`, `full`, `closing`, and `inactive` control admission outcomes and expose Run inbox inspection.
- Align runtime queue admission with Pi 0.83 `isStreaming`/`agent_settled`, reject late steer/follow-up instead of orphaning messages, and clear/audit Pi queues during abort.
- Persist Pi summarization retry and settled lifecycle events while keeping retry and compaction execution inside Pi.
- Add Schema v5 durable event-consumer cursors with monotonic ACKs, terminal delivery evidence, and generation fencing for stale Web/SSE connections.
- Close the subscribe-after-replay race by buffering live events while the persisted event backlog is replayed.

## [Unreleased]

### Changed

- Upgrade the in-process runtime from bare pi agent core to the controlled pi coding-agent `AgentSession` SDK.
- Delegate streaming steering, follow-up delivery, automatic retry, and overflow/threshold compaction to pi while preserving TAgent-owned TaskRun, transcript, policy, and operation-ledger authority.
- Use in-memory pi session/settings/model services with offline startup, disabled project resource discovery, runtime-only credentials, and TAgent custom tools only.
- Require Node.js 24.18.1 and npm 12 for the development and release baseline.

### Added

- Durable queue, retry, and compaction lifecycle events plus follow-up and manual compaction HTTP endpoints.
- Real faux-provider integration tests for controlled tools, transcript persistence, automatic retry, steering, follow-up, and terminal provider-failure audit.

## [0.1.0-alpha.1] - 2026-07-30

First public source preview of the persistent TAgent control plane.

### Added

- Durable SQLite sessions, messages, TaskRuns, plans, checks, artifacts, events, transcripts, operations, tool attempts, and continuations.
- Deterministic completion gate, atomic terminal transitions, verification staleness, and durable tool-loop guards.
- Session history and transcript context assembly with token reserves and complete-turn pruning.
- Transactional continuation claims with one-active enforcement, leases, heartbeat renewal, and owner fencing.
- Workspace-scoped `ls`, `read`, `write`, `edit`, `bash`, and `task_run` tools.
- Operation receipts for idempotent mutating tool calls and restart-safe `outcome_unknown` handling.
- Fastify HTTP/SSE API and responsive React workbench with run history, cancellation, steering, resume, Markdown rendering, and expandable tool-call diagnostics.

### Alpha limitations

- Supports one trusted process and one configured workspace. Multiple processes must not share the same database.
- Intended for localhost or trusted private-network use. The API has no authentication and must not be exposed directly to the public Internet.
- Bash restrictions are policy-based and do not provide an OS sandbox.
- Cancellation and steering do not yet provide control-plane transcript repair.
- Provider retries are not yet typed or independently audited, and context-overflow recovery is incomplete.
- Runtime checkpoints, semantic context summaries, consumer ACKs, and expiry-aware continuation takeover remain future work.

[0.1.0-alpha.1]: https://github.com/imtms/tagent-core/releases/tag/v0.1.0-alpha.1
