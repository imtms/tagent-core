# TAgent Core 0.1.13 Release Audit

## Scope

0.1.13 is an execution reliability, cost-observability, orchestration-efficiency, and Web recovery release. It incorporates the verified fixes for GitHub Issues #12-#23, while Issue #20 remains the umbrella for measuring token/cost behavior across real providers and workloads.

The release does not weaken operation receipts, required-check freshness, human approval, risk/capability policy, durable TaskRun state, or semantic review for change, release, risky, ambiguous, or insufficiently evidenced work.

## Runtime availability and accounting

- `TAGENT_MODEL` accepts an ordered comma-separated execution-model chain. An explicit main-model rate-limit failure advances to the next configured model in the same Run without a service restart and emits `provider.fallback`.
- Failed assistant turns are persisted before provider-failure classification, so provider-reported usage is not discarded merely because a turn failed.
- Schema 24 adds `run_model_usage` for Run-associated Router and Supervisor usage. These records are also accumulated into the Run totals, alongside the main Agent assistant-message usage.
- Usage remains observational. TAgent Core does not steer, stop, or rank work by a cumulative token budget.

## Orchestration efficiency

- High-confidence short routing decisions can use a deterministic Router path; ambiguous, referential, long, or multi-objective input still uses the semantic Router.
- The initial Agent request carries the TaskRun contract once rather than expanding it in both system and user input.
- Runtime history is selected as complete recent turns against the actual advertised context after reserving the system prompt, current prompt, and maximum response.
- Automatic continuation normally replays only the immediately preceding attempt plus the durable TaskRun snapshot. If no attempt delta exists, it falls back to the available transcript.
- Repeated unchanged gate diagnoses emit `continuation.stalled` instead of re-running the same work without semantic progress.
- Duplicate child proposals with the same parent, relation, and normalized goal reuse the existing proposal.
- Low-risk, single-answer discussion Runs may use `deterministic-lightweight-delivery-v1` only when there are no side effects, required checks, artifacts, truncation, non-goals, or risky release/security semantics. Every change/release/risky or ambiguous task retains full semantic Supervisor review.
- Supervisor schema repair sends the prior response, validation error, criterion IDs, evidence references, and compact schema instead of repeating the full audit payload.
- Message-start and retry checkpoints use the debounced persistence stream; tool boundaries and completed messages remain immediate recovery boundaries.

## Web real-time recovery

- SSE remains active for `running`, `waiting_input`, `blocked`, and `interrupted` Runs.
- Event errors trigger an application-level delayed reclaim/subscription in addition to native EventSource behavior.
- Browser `visibilitychange` and network `online` recovery recreate the stream after mobile suspension.
- Sequence-aware polling refreshes transcript and messages when the same Run advances, so polling is a content recovery path rather than metadata-only fallback.

## Verified external issue disposition

Issues #12-#19 and #21-#23 were reproduced against their reported baseline, fixed, regression-tested, replied to, and closed. The fixes cover strict `task_run` schemas, Anthropic message roles/transport, Supervisor placeholders and deterministic gates, recalled-memory review context, Memory runtime state, configurable retrieval thresholds, npm engine metadata, static Web-root containment, and configurable safe bind addresses.

Issue #20 remains open because provider-specific token totals require reproducible production traces. The structural causes identified in the code have been reduced through routing fast paths, duplicate-input removal, contract deduplication, context-aware turn selection, compact continuation/review inputs, stalled-continuation detection, and complete foreground usage attribution.

## Compatibility

- Package version: `0.1.13`.
- SQLite schema: `24`.
- Existing Schema 23 databases migrate transactionally by creating the additive `run_model_usage` table and index.
- Back up SQLite including WAL/SHM and Memory PostgreSQL/Cold stores before deployment.
- Code rollback after migration requires restoring the matching pre-upgrade SQLite backup and release artifact.
- Supported release toolchain: Linux x64, Node `24.18.1`, ABI `137`, npm `>=11`.

## Deployment order and gates

For the maintained instances, deploy in this order:

1. Commit and push release documentation and confirm Issue disposition.
2. Build and verify the immutable release artifact.
3. Back up and update the Memory/Learning instance on port 3220; restart and verify health, Schema 24, Memory availability, Learning state, Worker state, and release commit.
4. Only after 3220 passes, back up and update the historical-session instance on port 3210 to the same latest release; restart and verify health, Schema 24, Web shell, process/log state, and release commit.

Required repository gates are Server/Web TypeScript checks, ESLint with zero warnings, full Vitest, production build, `git diff --check`, release manifest verification, clean Git state, and `main == origin/main`.
