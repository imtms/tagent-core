# Development Status

Updated: 2026-07-30 (Asia/Singapore)

## Completed

### Core control plane

- SQLite-backed sessions and ordered conversation messages.
- Durable TaskRun records with goal, phase, status, plan items, checks, artifacts, and ordered events.
- Deterministic completion gate that prevents a model response from directly marking a run complete.
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
- Dynamic execution budgets scale continuation count, cumulative tokens, and idle timeout across simple/standard/complex/extended tiers; `TAGENT_RUN_HARD_TIMEOUT_MS` remains the absolute attempt ceiling.
- A deterministic stress test completes a single durable Run after 40 automatic continuations; hundreds of model-backed turns are not yet an acceptance claim.

### Quality baseline

- TypeScript configurations separated for Node and browser builds.
- Store, completion gate, workspace tool, and HTTP API tests.
- Desktop and mobile Chromium rendering checks.
- Production dependency audit with no known vulnerabilities at the current lockfile.
- Full production and development dependency audit with no known vulnerabilities at the `0.1.0-alpha.1` lockfile.
- ESLint flat configuration, release checklist, security policy, changelog, license, and tag-triggered GitHub prerelease workflow.
- Git repository linked to `git@github.com:imtms/tagent-core.git` with incremental commits on `main`.

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

- Add memory and knowledge interfaces without coupling them to the core runtime.
- Add dynamic PromptAssembler sections, evidence summaries, and prompt provenance.
- Add source provenance and retrieval evidence to TaskRun artifacts.

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
- Cancel/resume transcript repair is implemented. Steering and follow-up now use pi's observable queue, but TAgent still lacks a bounded durable control-plane inbox and explicit closing/full responses.
- Provider failures are typed and auditable, but retry scheduling still uses the provider SDK/pi boundary rather than a TAgent-owned retry loop.
- The HTTP API has no authentication or multi-tenant isolation and must remain on localhost or a trusted private network for this alpha.
