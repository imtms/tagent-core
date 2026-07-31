# Changelog

All notable changes to TAgent Core are documented here.

## Unreleased

### Memory correctness and safety

- Reject TaskRun wrappers, verification logs, artifact publication metadata, file paths/sizes, one-off questions, and malformed Chinese-negation proposals before durable persistence or embedding.
- Stop automatic TaskRun Check/Artifact outcome capture; verified operational evidence remains in TaskRun records instead of default long-term semantic memory.
- Route direct company reporting relationships into one canonical `knowledge.company-org-structure` Topic and apply semantic fingerprints when merging repeated facts.
- Add intent/domain routing, lexical/vector/topic relevance thresholds, empty-result recall, identity isolation, semantic deduplication, contradiction suppression, and organization-path pruning.
- Add reversible quarantine SQL with a dry-run report and audit snapshots for existing dirty records.

## [0.1.3] - 2026-08-01

### Fixed

- Persist accepted user turns before asynchronous memory recall and runtime setup so newly submitted messages are immediately durable and visible.
- Add optimistic chat rendering with duplicate reconciliation, failed-submit draft restoration, and submission locking.
- Continuously reconcile persisted messages while a Run is active so SSE gaps or delayed startup cannot leave the conversation stale.
- Fence Session polling and asynchronous transcript updates against workspace switches to prevent responses from an old workspace overwriting the current UI.
- Return the newest 200 persisted messages in chronological order instead of permanently hiding messages after the first 200 in long conversations.
- Refresh terminal Run state atomically and guard late event responses against cross-workspace state corruption.

## [0.1.2] - 2026-08-01

### Changed

- Stabilized the mobile viewport with dynamic viewport sizing, contained scrolling, and non-animated pinned-to-bottom updates.
- Grouped completed and live tool activity into compact, collapsed summaries so tool-heavy runs no longer dominate the conversation.
- Added clear visual cards and separators for assistant responses, with tighter responsive spacing on phones.
- Capped the composer/inbox area and improved mobile safe-area behavior to keep the chat viewport stable while typing.

## [0.1.1] - 2026-08-01

### Security and reliability

- Classify memory evidence as `user_explicit`, `user_context_summary`, `tool_verified_fact`, `task_outcome`, or `assistant_inference`, with trust, source-role, and verification metadata.
- Stop parsing assistant prose as durable memory; task outcomes are built only from passed Check evidence and published Artifacts.
- Restore context-prune deposition through a role-aware user-only durable summary path instead of capturing mixed user/assistant history.
- Enforce one hard token budget across Hot/Warm cards and complete Cold Topic pages.
- Add capture-job lease heartbeat, owner token, monotonic fencing token, and CAS complete/fail operations.
- Require PostgreSQL 17, pgvector, and pg_trgm integration tests in CI and release workflows.

## [0.1.0] - 2026-08-01

First stable source release for the documented trusted single-service deployment profile.

### Added and changed

- Add optional Hot/Warm/Cold long-term memory behind `TAGENT_MEMORY_ENABLED`, preserving the original SQLite-only behavior when disabled.
- Add PostgreSQL/pgvector/pg_trgm storage, Fact/Preference separation, bounded entity graph routing, durable capture jobs, and immutable Local Cold Markdown Topic revisions.
- Add deterministic and hybrid LLM extraction with conversation coreference, OpenAI-compatible semantic embeddings, lexical fallback, and LLM-assisted Cold consolidation.
- Add sensitive-data and stored-prompt-injection gates across capture, persistence, embedding, Cold publication, recall, and prompt injection.
- Add dynamic Agent recall, `memory_search`, `memory_topic_get`, guarded `memory_forget`, capture observability events/API, and the Web Memory Center.
- Add maintained regressions for explicit identity, positive/negative food preferences, Chinese pronoun resolution, homes, and neighbor relationships.
- Add Schema v8 Session Supervisor Inbox so all chat composer input is durably queued before TaskRun creation, with idempotent admission, atomic claim, serial dispatch, restart recovery, defer/resume, merge, and deletion of unstarted items.
- Replace direct active-run steering in the Web composer with a persistent queue panel; queued input remains outside conversation history until Supervisor selection.
- Harden TaskRun supervision against duplicate proposed steers, stale attempt progress, terminal decision crash gaps, missing continuation rows, exhausted continuation resurrection, and spawned runtime launch failures.
- Refine progress semantics so read-only tool success and assistant message completion do not erase consecutive failures; classify skipped required contract items as non-recoverable.
- Add Schema v6 durable control inbox with request idempotency, bounded admission, per-attempt fencing, serialized FIFO delivery into Pi, and restart-safe `outcome_unknown` receipts.
- Return explicit `accepted`, `full`, `closing`, and `inactive` control admission outcomes and expose Run inbox inspection.
- Align runtime queue admission with Pi 0.83 `isStreaming`/`agent_settled`, reject late steer/follow-up instead of orphaning messages, and clear/audit Pi queues during abort.
- Persist Pi summarization retry and settled lifecycle events while keeping retry and compaction execution inside Pi.
- Add Schema v5 durable event-consumer cursors with monotonic ACKs, terminal delivery evidence, and generation fencing for stale Web/SSE connections.
- Close the subscribe-after-replay race by buffering live events while the persisted event backlog is replayed.


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

[0.1.0]: https://github.com/imtms/tagent-core/releases/tag/v0.1.0

[0.1.1]: https://github.com/imtms/tagent-core/releases/tag/v0.1.1

[0.1.2]: https://github.com/imtms/tagent-core/releases/tag/v0.1.2

[0.1.3]: https://github.com/imtms/tagent-core/releases/tag/v0.1.3
