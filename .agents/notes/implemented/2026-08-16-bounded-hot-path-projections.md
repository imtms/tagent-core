# Decision: Bound hot-path work by new data rather than durable history

Status: implemented
Kind: simplification

## Problem

Several correct read paths did work proportional to an entire durable history or payload even when the caller needed only a delta. Event-consumer ACKs repeatedly scanned all prior events for terminal markers, TaskRun hydration counted every Transcript row, HTTP and SSE reads hydrated Artifact content that the wire contract discarded, and the Web Console re-sorted complete Transcript projections and rendered every token delta. Static Web ABI decoding also placed the full TypeBox runtime on the initial UI path.

These costs grow with successful product use: longer Runs, more events, larger Artifacts, and longer conversations make the same acknowledgement or refresh progressively slower. Memory startup also loaded every durable user message before workers could begin, making restart cost proportional to complete conversation history.

## Decision

Use the durable cursor's previous ACK as the lower bound when detecting newly crossed terminal events. Since `run_transcript.seq` is single-writer, gap-free, append-only state, use its indexed maximum as the Transcript count. Publish a `TaskRunReadView` whose Artifacts contain metadata only; internal execution and Supervisor paths retain the full `TaskRun`, while HTTP detail/interactions and SSE existence/watermark paths use bounded projections.

Merge ordered Transcript deltas with a linear two-way merge, and coalesce streaming output/thinking deltas into at most one React state update per animation frame. Load ABI schemas and TypeBox through Core Client's single cached dynamic loader rather than the initial UI chunk. Enforce production entry budgets of 400 KB raw and 120 KB gzip.

Backfill durable user messages through `MemoryHistoryBackfill` in bounded pages. Persist the exclusive last-message cursor in the existing Memory worker heartbeat metadata, advance it only after idempotent capture enqueue, and resume from it after restart without adding another durable table.

Page Memory Topic descriptors by immutable `created_at, topic_id` tuples rather than mutable `updated_at`. PostgreSQL Memory schema version 2 adds and indexes `memory.topics.created_at`; startup performs a fenced additive version-1 migration that backfills existing rows from their current `updated_at`, then preserves `created_at` across later upserts. The console paging contract exposes `snapshotCreatedAt` and `after.createdAt`, so updating a not-yet-read Topic cannot move it outside an active snapshot.

## Alternatives considered

**Add revision-3 partial indexes for terminal events and normalized Transcript tool links.** Deferred because incremental ACK ranges remove the observed history scan without another state-protocol transition. Normalized tool links remain useful only if measured Transcript JSON lookup costs become material.

**Cache every SQLite prepared statement globally.** Rejected for now because dynamic query shapes could create an unbounded cache and measured event append cost is already about 0.028 ms in memory. Narrow statement caching remains an option if production profiles show compilation dominating real I/O.

**Remove runtime ABI validation from Web.** Rejected because bundle size is not worth weakening fail-closed protocol handling; dynamic loading preserves validation and only moves parsing off the initial render path.

## Verification

- A 10,000-event ACK benchmark drops terminal-marker lookup from about 1.44 ms over full history to 0.003-0.004 ms over ten new events, over 350 times faster; the 100,000-event exploratory case improved by more than 4,000 times.
- A 1,000-entry Transcript count drops from about 0.019 ms to 0.001 ms; the 100,000-entry exploratory case produced the same count with roughly 2,800-times lower lookup time.
- The representative TaskRun read projection reduces serialized bytes from about 105 KB to 5.4 KB. A 10 MB Artifact fixture reduced hydration versus metadata-query time by about 33 times while the full internal TaskRun retained content.
- A 20,000-item Transcript delta merge is approximately 1.9 times faster, and 100 token deltas schedule one frame update in behavior tests.
- Production initial Web JavaScript falls from about 491 KB / 143 KB gzip to 363 KB / 107 KB gzip. The build test enforces the new budget.
- Memory history backfill reads at most 100 durable user messages per tick, resumes from heartbeat metadata after restart, and relies on capture idempotency when a crash occurs between enqueue and cursor persistence.
- A 501-Topic paging regression updates an unread Topic after page one and still returns every Topic exactly once; PostgreSQL query-shape tests require the immutable tuple predicate and schema tests cover the version-1 to version-2 migration.
- Type checks, lint, focused Store, HTTP differential, Core Client, Web behavior, ABI, runtime, lifecycle, and modular-monolith build tests pass.

## Consequences

The first Web API call loads the approximately 49 KB gzip ABI chunk before decoding, after which the promise and module are cached. Transport read projections must never be passed to Supervisor logic that hashes or semantically reviews Artifact content. Transcript count remains valid only while the repository preserves gap-free append-only sequence allocation; any future deletion or sparse import feature must introduce an explicit stored count instead of silently reusing `MAX(seq)`. The Topic migration cannot reconstruct original creation times for pre-version-2 rows, so it uses their migration-time `updated_at` as the stable baseline and only promises immutability after migration.
