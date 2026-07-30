# Changelog

All notable changes to TAgent Core are documented here.

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
