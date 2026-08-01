# Changelog

### Fixed

- Prevent completed TaskRuns from entering redundant continuations when criterion-level coverage already passes but a second brittle whole-contract phrase matcher rejects harmless wording differences.
- Require explicit parallel language instead of treating discourse markers such as “另外” / “another” alone as proof of independent parallel work, and classify deploy/restart/pull operations as concrete change objectives.
- Preserve earlier streamed assistant drafts when a later assistant message starts, and only clear live text after the approved response is confirmed in persisted chat history.
- Page long chat history by stable message ID, stop refetching and reparsing messages on every status poll, memoize persisted Markdown, and use lightweight plain-text rendering while streaming.


## [Unreleased]

### Fixed

- Make the Contract gate the single owner of acceptance-criterion coverage receipts, eliminating duplicated Contract/Completion receipt drift from structured LLM audits. Invalid Supervisor audit output is retried internally up to three times and, if still invalid, blocks once without rerunning an already-finished Agent attempt.

### Changed

- Replaced keyword and lexical completion auditing with a structured LLM Supervisor reviewer for progress, evidence freshness, acceptance-criterion coverage, completion claims, blockers, continuation viability, runtime-failure classification, and final delivery quality. Persisted evaluations now record the evaluator, model, semantic summary, failures, and criterion evidence receipts; deterministic local logic remains only for runtime safety invariants such as repeated operations and pending control delivery.
- Reserved the main conversation for user and assistant messages by moving historical and live/recent Tool activity into the TaskRun audit workspace, collapsed by default.
- Expanded the right-side TaskRun panel into a Supervisor audit workspace with explicit progress, evidence, contract, claim, approval, and delivery standards; persisted gate failures; criterion coverage receipts; Supervisor rationale/confidence; and tool evidence drill-down.

### Fixed

- Keep the currently visible assistant response on screen until replacement content actually arrives, rather than moving it into a repeated `earlier draft retained` placeholder at every assistant message boundary.
- Reconcile missed SSE terminal events through Session polling by refreshing persisted messages, the terminal Run, and its transcript before clearing live state.
- Prefer the durable completed assistant partial when selecting the Supervisor candidate response, preventing an empty trailing assistant shell from yielding a completed TaskRun with no persisted chat answer.

### Changed

- Removed all TAgent Core token-budget control paths: no soft checkpoints, hard cumulative token ceiling, token-driven steer, token-driven continuation suppression, Memory recall token budget, or context reserve budget remains. Provider usage is observational only.
- Upgraded Session supervision to `semantic-rules-v3`, decomposing compound user input into persisted semantic objectives, timing, work kind, scope, and criterion-specific TaskRun contracts rather than carrying raw Inbox prose as the goal.
- Added criterion-by-criterion Contract Gate receipts and completion-claim validation against independent Check evidence, successful Operation receipts, or Artifacts. Agent-authored `done`/`passed` labels alone no longer establish completion.
- Context selection is governed by explicit recent-turn count and provenance, not a Core token budget; Memory recall is governed by relevance, policy, diversity, and result count.

### Fixed

- Reset provisional streaming content at every new assistant message boundary so a later steer, token-budget reminder, or continuation answer replaces the earlier draft instead of concatenating or making the visible reply appear to vanish.
- Defer the token-budget convergence steer while an assistant response is already streaming, preventing an otherwise good final answer from being replaced by a short acknowledgement of the budget warning.
- Emit an auditable `message.rejected` event when Supervisor rejects a candidate response; rejected prose remains in the Run transcript but is not persisted as the final chat answer.
- Add a contract-coverage delivery gate so short generic acknowledgements cannot complete substantial TaskRuns merely because agent-authored Plan and Check rows say `done`/`passed`.
- Strengthen continuation instructions to require a complete standalone replacement for a Supervisor-rejected candidate.

### Changed

- Context Manifests now reference stable durable Session message IDs and Run transcript sequence IDs, preserving provenance through turn compression and budget omission instead of relying on timestamp/index-derived identities.
- The Web TaskRun panel now provides Context Manifest history, selected/omitted source drill-down, and selected-source diffs between attempts.

### Added

- Immutable per-attempt Supervisor Context Manifests for Run start, resume, and continuation, including selected and omitted Session/transcript messages, TaskRun contracts, Memory inputs, selection reasons, token estimates, and stable hashes.
- Context Manifest diagnostics in the TaskRun Web panel and `GET /api/runs/:id/context-manifests`.
- An explicit capability and evidence roadmap defining when the architecture warrants promotion to `0.2.0`.

### Added

- Durable Supervisor approval requests with explicit Approve & Resume / Reject actions in the API and Web task panel.

### Changed

- Settled review now waits for durable control-message delivery instead of prematurely completing a Run.
- Progress supervision now detects repeated identical successful operations in addition to consecutive failures.

All notable changes to TAgent Core are documented here.

## [0.1.5] - 2026-08-01

### Memory operations and governance

- Added durable embedding reindex jobs with checkpoints, leases, fencing tokens, crash recovery, progress APIs, generation staging/ready/active states, and Memory Center progress controls.
- Added real embedding/extractor probes, persistent worker heartbeats, backlog age, latency/error metrics, reindex completeness, and degraded-event readiness reporting.
- Added continuous lifecycle metadata, kind-specific retention, repeated-confirmation reactivation, current-versus-history Cold consolidation, and asynchronous physical purge.
- Unified Topic and Record forgetting with tombstones, grace-period restore, delayed Cold object purge, and immutable revision preservation.
- Added recall feedback receipts that influence Ranking v2 and governance receipts for Candidate approve/reject/correct and Disputed resolution.
- Added a revisioned, human-editable Core Memory Markdown projection generated across high-value active records and deterministically injected each turn.

### Memory correctness, retrieval, and scale

- Separated raw capture source from extracted record evidence.
- Removed fixture-specific entities from production quality routing and added configurable domain ontology plus canonical SPO normalization.
- Added Ranking v2, MMR diversity, validity/current-state/trust scoring, Recall Trace v2, `memory_record_get`, provenance APIs, and deep readiness.
- Added content-hash incremental embedding indexing and then promoted reindexing to a durable, fenced job workflow.
- Expanded deterministic retrieval evaluation across identity, preference, temporal state, contradiction, organization, project decisions, residence, cross-language paraphrase, scope isolation, stale/current selection, and false positives.

### Supervisor orchestration

- Added a conservative Session Input Router that summarizes, classifies, prioritizes, and routes input as active-run steer/context, follow-up, parallel spawn proposal, discussion, clarification, defer, or independent work.
- Persisted structured TaskRun contracts, routing rationale, acceptance criteria, urgency, priority, target Run, relation, and confidence instead of copying raw Inbox text into a Run goal.
- Added semantic queue admission, manual-order override, duplicate receipts, edit reclassification, structured merge, explicit defer, and active-run context delivery.
- Added attempt-terminal failure classification, `request_evidence`, `pause_for_approval`, Agent-created Spawn Proposals, explicit proposed-to-approved-to-spawned transitions, and Web approval controls.

## [0.1.4] - 2026-08-01

> Version `0.1.4` was prepared on `main` but not tagged separately; these changes ship in the tagged `v0.1.5` release.

### Run budget elasticity

- Treat complexity-tier token allowances as soft guidance checkpoints instead of premature termination ceilings.
- Keep `TAGENT_MAX_RUN_TOKENS` as the single cumulative hard token ceiling, raise its default from 2,000,000 to 8,000,000 tokens, and steer active agents to compact and finish when crossing a soft checkpoint.

### Run admission and budget safety

- Reject opaque `release-*`, `ui-sync-*`, and `final-ui-sync-*` synchronization markers as non-actionable prompts instead of starting autonomous TaskRuns.
- Freeze dynamic Run budget classification to immutable admission data so agent-created plans/checks cannot raise their own token ceiling.
- Enforce the cumulative token ceiling during active runtime execution and abort immediately when usage crosses the limit, rather than checking only before an automatic continuation.

### Memory correctness and safety

- Reject TaskRun wrappers, verification logs, artifact publication metadata, file paths/sizes, one-off questions, and malformed Chinese-negation proposals before durable persistence or embedding.
- Stop automatic TaskRun Check/Artifact outcome capture; verified operational evidence remains in TaskRun records instead of default long-term semantic memory.
- Route direct company reporting relationships into one canonical organization Topic and apply semantic fingerprints when merging repeated facts.
- Add intent/domain routing, lexical/vector/topic relevance thresholds, empty-result recall, identity isolation, semantic deduplication, contradiction suppression, and organization-path pruning.
- Add reversible quarantine SQL with a dry-run report and audit snapshots for existing dirty records.

## [0.1.3] - 2026-08-01

### Changed

- Replace the hand-written Markdown renderer with `markdown-it` and a bounded `highlight.js` language set.
- Add tables, nested lists, fenced code highlighting, copy controls, safe external links/images, raw-HTML suppression, CJK URL handling, and responsive overflow containment.

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

> Version `0.1.1` was an internal version increment whose changes shipped in the tagged `v0.1.2` release; no `v0.1.1` tag was published.

- Classify memory evidence as `user_explicit`, `user_context_summary`, `tool_verified_fact`, `task_outcome`, or `assistant_inference`, with trust, source-role, and verification metadata.
- Stop parsing assistant prose as durable memory; at this stage task outcomes were restricted to passed Check evidence and published Artifacts. Automatic TaskRun outcome capture is removed entirely in `0.1.4`.
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

[0.1.2]: https://github.com/imtms/tagent-core/releases/tag/v0.1.2

[0.1.3]: https://github.com/imtms/tagent-core/releases/tag/v0.1.3


[0.1.5]: https://github.com/imtms/tagent-core/releases/tag/v0.1.5
