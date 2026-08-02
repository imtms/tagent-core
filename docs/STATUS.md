# Development Status

Updated: 2026-08-02 (Asia/Singapore)

Current stable release: `0.1.7`. Current SQLite schema: `16`.

## Completed

### Core control plane

- SQLite-backed sessions, ordered conversation messages, Schema v5 durable event-consumer cursors, Schema v6 durable control inbox records, Schema v7 TaskRun supervision records, and Schema v12 semantic Session Supervisor Inbox, TaskRun contracts, durable approval requests, and immutable Context Manifests.
- Session Input Router is the normal admission path: input is summarized, classified, prioritized, and either routed to the active Run, converted to a gated spawn proposal, or atomically bound to a durable TaskRun contract.
- Router analysis receives bounded recent Session messages, recent TaskRun summaries, and the active contract; Router and Supervisor have independent low-latency model/time/token configuration and default to `gpt-5.6-luna`.
- Automatic Session dispatch is blocked by any running Run and by the latest blocked/interrupted Run, while older historical blocked/interrupted Runs remain auditable without permanently freezing the queue.
- A user can explicitly start a selected queued Inbox item through a transactional `Run now` path; running Runs and active continuations retain concurrency priority and fencing.
- Durable TaskRun records with goal, phase, status, plan items, checks, artifacts, ordered events, and Schema v4 Run checkpoints.
- Deterministic completion gate that prevents a model response from directly marking a run complete.
- Structured LLM Supervisor audits semantic contract coverage and final delivery after authoritative local prerequisites pass; incomplete plans and missing/failed/stale checks take a deterministic sub-100ms path without an unnecessary model request.
- Request idempotency through stable `requestId` values.
- Startup recovery that marks abandoned running tasks as interrupted.
- Cancellation, SDK-backed in-flight steering, follow-up queueing, and manual compaction for active runs.
- Explicit failure persistence for provider and pi runtime errors.
- Resume attempts reuse the same durable Run ID and request ID, increment `attempt`, record `resumedAt`, and append `run.resumed`.
- Resume reconstructs a fresh runtime from the durable TaskRun snapshot without duplicating the original user message.

### Agent runtime

- In-process integration with `@earendil-works/pi-coding-agent` 0.83 `AgentSession`.
- Pi owns ephemeral per-attempt steering/follow-up delivery, automatic retry, and threshold/overflow/manual compaction; TAgent remains authoritative for TaskRun state, SQLite transcript, completion gates, operation receipts, and policy.
- Pi SessionManager and SettingsManager are in-memory, ModelRuntime starts offline with runtime-only credentials, and project Extensions, Skills, prompts, themes, and context-file discovery are disabled.
- Only TAgent custom tools are active. Pi built-in file and shell tools stay disabled because they do not carry TAgent operation receipts, stale-check propagation, or workspace governance.
- TAgent composes Pi's installed before/after tool hooks instead of replacing them, and records prepared/validated arguments so future controlled Pi hook behavior remains intact.
- Streaming model deltas and tool lifecycle events persisted to the run event log.
- Runtime persistence is traffic-shaped without losing audit boundaries: text deltas are coalesced, tool progress is rate-limited, checkpoints only follow recovery-relevant events, unchanged checkpoints are skipped, and transcript sequence/count lookups avoid repeated full parsing.
- TAgent-owned tools: `read`, `write`, `edit`, `bash`, and `task_run`.
- Workspace path containment and a minimal destructive-command policy.
- Sequential tool execution for predictable state mutations.
- Append-only pi transcript persistence for user, assistant, tool-call, and tool-result messages.
- Cancel settlement and resume/continuation startup repair any unpaired tool calls with auditable synthetic error tool results before provider reuse.
- Per-run aggregate model usage for input, output, cache, total tokens, and provider-reported cost.
- Resume loads the persisted pi transcript into the new runtime before appending the recovery instruction.
- Pi automatic retry and provider timeout controls, a progress-sensitive idle watchdog for each attempt, and a separate absolute hard timeout.
- Provider responses and terminal failures are audited with typed auth, invalid-request, context-overflow, rate-limit, timeout, network, server, aborted, and unknown classifications plus retryability metadata.
- The idle watchdog is refreshed by model deltas and tool start/progress/completion events, so active tasks are no longer killed at the simple-tier five-minute mark.
- Persistent bounded continuations after completion-gate blocks, with queued/running/completed/blocked/failed/cancelled audit states.
- Automatic continuation limits by count and cumulative run tokens; exhausted runs remain blocked for manual inspection.
- Persistent operation receipts make `write`, `edit`, and `bash` idempotent by Run attempt and tool-call ID; unfinished operations become `outcome_unknown` after restart.
- Mutating tools automatically stale previously passing checks, so later workspace changes cannot reuse old verification evidence.
- Run terminal status and its terminal event are committed in one compare-and-set transaction.
- Durable tool-attempt guards block repeated identical calls and repeated failures before long continuation budgets amplify loops.
- Startup recovery requeues queued/running continuation records, restores the Run to blocked, and resumes from the persisted transcript.
- Continuation startup uses a transactional database claim that atomically leases one queued continuation, resumes the Run, increments its attempt, and writes `continuation.started`; a partial unique index permits only one queued/running continuation per Run.
- Active continuations renew their lease every 10 seconds; expired leases cannot be renewed, lease loss aborts the old runtime, and terminal continuation updates are fenced by lease owner.
- Recovery reclaims queued or expired continuation leases at startup and schedules a wake-up at the next persisted lease deadline, so an unexpired orphan is recovered after expiry without another process restart.
- Run completion, failure, cancellation, and timeout transitions are fenced by attempt, preventing a stale runtime from changing a newer attempt.
- Graceful close stops scheduling, waits for Pi abort and AgentService execution settlement, releases only this owner's continuation leases, and marks other active Runs interrupted before SQLite closes.
- SIGTERM and SIGINT enter the Fastify close path instead of bypassing runtime and lease cleanup.
- Versioned SQLite schema metadata rejects newer unsupported databases and advances only after transactional migration success.
- Resume/continuation context assembly prunes oldest complete turns to a 75% context-window budget while retaining the full transcript in SQLite.
- New Run context reads the newest persisted Session message window in chronological order, including Sessions beyond 10,000 messages.
- Active Runs persist a throttled checkpoint containing the current attempt, assistant partial text, current tool identity, and covered event/transcript sequences; text writes are coalesced to at most once per 500ms and tool boundaries persist immediately.
- Every Run start, resume, and continuation persists an immutable Context Manifest with selected/omitted messages, TaskRun contract, Memory inputs, selection reasons, token estimates, stable SQLite message/transcript source IDs, and a stable hash; API and Web expose the latest diagnostics.
- Terminal, blocked, interrupted, lease-recovered, and graceful-close paths archive checkpoints atomically or transactionally, preserving partial text for diagnostics without leaving a stale active checkpoint.
- Resume and continuation attempts create a fresh active checkpoint while the full transcript remains authoritative in SQLite.

### HTTP and Web

- `GET /api/runs/:id/operations` exposes durable side-effect receipts for audit and recovery decisions.
- Fastify API for sessions, messages, run history, runs, cancellation, steering, resumption, transcript audit, and SSE event replay.
- A normalized transcript-view API pairs assistant tool calls with results for stable Web diagnostics.
- Injectable `createApp()` factory for tests and future modules.
- Responsive React workbench with session navigation, streaming conversation, tool activity, and TaskRun details.
- Conversation messages render safe Markdown, and transcript tool calls expand inline to show arguments and paired results.
- Production server serves the built Web application without an additional static-file dependency.
- Client request IDs support browsers without `crypto.randomUUID`, including `getRandomValues` and legacy fallbacks.
- Blocked and interrupted runs can be resumed from the Web workbench; the UI exposes the current attempt.
- The right panel lists up to 50 recent TaskRuns as collapsible history and expands the current/latest Run by default.
- Web restores active assistant text and current tool from the durable checkpoint before opening SSE from the checkpoint's covered event sequence, and shows preserved checkpoints for interrupted or terminal Run diagnostics.
- Web event delivery now claims a persistent per-Run consumer generation, resumes from the greater of checkpoint coverage and durable ACK, advances ACKs monotonically after event handling, and records terminal-event acknowledgement evidence. A newer connection fences stale SSE streams and stale ACK writers.
- Provider-reported token and cost usage is persisted and displayed for observation only. TAgent Core no longer warns, steers, blocks, truncates Memory recall, or suppresses continuations based on cumulative token use; execution remains bounded by wall-clock, continuation count, policy, approval, and evidence gates.
- A deterministic stress test completes a single durable Run after 40 automatic continuations; hundreds of model-backed turns are not yet an acceptance claim.
- Session navigation displays each workspace's latest TaskRun status and phase, refreshed with the Session summary rather than an application-layer per-Session query loop.
- Session polling fully hydrates a newly started active Run without a browser refresh, including selected Run, messages, transcript, checkpoint partial, tool state, and SSE consumer handoff.

### Optional long-term memory

- Opt-in Hot/Warm/Cold memory platform; disabled mode loads no memory adapter/worker and preserves the original SQLite-only runtime.
- PostgreSQL 17/pgvector/pg_trgm durable profile with separate Fact and Preference storage, Topic Descriptors, bounded entity graph, capture jobs, policy receipts, and immutable Local Cold revisions.
- OpenAI-compatible semantic embedding with durable checkpointed/fenced reindex jobs, staged/active generations, progress reporting, and lexical-only fallback; deterministic hash embedding remains test/development-only.
- Deterministic safety extraction plus optional structured LLM extraction for multi-sentence context, negation, conditions, temporal changes, and Chinese coreference.
- User-message, role-aware user-only context-prune summary, and manual capture triggers with queued/completed/empty/failed observability and proposal/persisted counts. Assistant final prose and TaskRun Check/Artifact wrappers are not automatic semantic-memory sources.
- Continuous lifecycle governance with Hot-to-Warm promotion, canonical confirmation/supersession, kind-specific retention, stale/history handling, reversible Record/Topic tombstones, delayed purge, and Local Cold reconciliation.
- Ranking v2 recall across lexical, trigram, vector, Topic, and bounded graph routes, with domain routing, relevance thresholds, validity/trust/current-state scoring, MMR, empty-result behavior, identity isolation, semantic deduplication, contradiction suppression, feedback receipts, and Recall Trace v2; complete checksum-verified Cold pages are injected as low-authority data and never vector-chunked.
- Agent `memory_search`, `memory_topic_get`, `memory_record_get`, and guarded `memory_forget` tools plus a Memory Center for readiness, reindex progress, feedback, Candidate/Disputed governance, tombstone restore, and human-editable Core Memory revisions.
- Release documentation is indexed at [MEMORY.md](MEMORY.md); deployment limits remain trusted single-service/private-network use without complete multi-tenant authentication.

### Quality baseline

- TypeScript configurations separated for Node and browser builds.
- Store, completion gate, workspace tool, and HTTP API tests.
- Desktop and mobile Chromium rendering checks.
- Production dependency audit with no known vulnerabilities at the current lockfile.
- Full production and development dependency audit with no known high-severity vulnerabilities at the current release lockfile.
- ESLint flat configuration, release checklist, security policy, changelog, license, required PostgreSQL memory CI, and tag-triggered stable GitHub Release workflows.
- Git repository linked to `git@github.com:imtms/tagent-core.git` with incremental commits on `main`.
- The 2026-07-31 external PR audit merged queue scheduling, manual Inbox start, and workspace status improvements after combined and post-merge validation; deployment artifact and current-operation PRs remain open for rollback/integrity and sensitive-data fixes. See [PR_AUDIT_2026-07-31.md](PR_AUDIT_2026-07-31.md).

## In Progress

- Add semantic or model-generated transcript summaries before old turns are pruned from runtime context.
- Define whether durable control-plane retry policy is still needed above Pi's bounded per-session retry lifecycle.
- Prepare the worker protocol needed for a future pi RPC adapter.

## Next Milestones

### P1: Runtime reliability

- Implement a pi RPC worker adapter behind the AgentRuntime interface.
- Use in-process pi for the primary interactive agent and pi RPC for isolated or concurrent worker tasks.
- Add durable retry policy only for failures that must survive process loss; Pi already provides per-session retry events and context-overflow compaction recovery.
- Persist enough runtime transcript state to support exact provider conversation continuation after process restart.

### P2: Tool governance

- Replace regex-only Bash restrictions with capability policies and explicit approvals.
- Add sidecar output artifacts, credential-path policy, and per-tool concurrency budgets.
- Separate read-only and mutating tools.
- Run workers under a dedicated low-privilege account or container boundary.

### P3: Context modules

- Extend Memory governance with formal authenticated user/scope membership, multi-user approver roles, page-key reindex cursors, distributed provider scheduling, and real-provider quality dashboards.
- Expand the deterministic evaluation set into required real-provider/nightly Recall@K, MRR, precision, contradiction, zero-result, cross-language, drift, and token-efficiency benchmarks.
- Add learned feedback calibration, semantic conflict adjudication, Daily Memory/LLM distillation, and role-aware LLM context-prune summaries with same-turn reinjection.

### P4: Operations

- Add metrics, tracing, and provider connectivity health checks.
- Package a service unit and documented upgrade/rollback procedure.

### P5: Specialized workers

- Add deterministic and single-shot runtimes.
- Add pi RPC as the default general worker runtime.
- Add Codex app-server only for complex coding implementation and review tasks.
- Keep TaskRun completion and policy decisions in the TAgent control plane for every runtime.

## Known Limitations

- The full transcript remains durable, but runtime context pruning currently drops old turns without generating a semantic summary.
- Resume continues from persisted pi messages, but provider-specific server-side session state is not guaranteed to survive.
- Bash isolation is policy-based, not an OS-level sandbox.
- The first Web interface does not expose model/runtime selection or provider health.
- Multiple TAgent Core processes must not target the same SQLite database; process-level leader enforcement is not implemented.
- Continuation attempts heartbeat, use owner fencing, and only expire into recovery after the persisted lease deadline; process-level leader election remains absent.
- Cancel/resume transcript repair is implemented. Steering and follow-up enter a bounded, idempotent Schema v6 control inbox before serial delivery to Pi; settled runtimes reject delivery, old-attempt input is superseded, restart-ambiguous delivery becomes `outcome_unknown`, and the API returns explicit closing/full/inactive responses.
- Provider failures are typed and auditable, but retry scheduling still uses the provider SDK/pi boundary rather than a TAgent-owned retry loop.
- Scoped Bearer credentials are available for supported automation routes, but the Web/administrative surface has no built-in login or complete multi-tenant isolation and must remain on localhost or a trusted private network.

- Supervisor v3 adds edit reclassification, structured merge, explicit defer, attempt-terminal classification, request-evidence, wait-for-runtime, durable approval decisions, repeated-operation intervention, and approved derived TaskRun spawning.


## Version trajectory

The project remains on the `0.1.x` line while Topic orchestration, multi-intent supervision, unified capability approval, and dependency-aware scheduling are incomplete. See [Roadmap to 0.2.0](ROADMAP_0.2.md) for the required promotion gates.
