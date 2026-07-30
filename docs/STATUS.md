# Development Status

Updated: 2026-07-30 (Asia/Singapore)

## Completed

### Core control plane

- SQLite-backed sessions and ordered conversation messages.
- Durable TaskRun records with goal, phase, status, plan items, checks, artifacts, and ordered events.
- Deterministic completion gate that prevents a model response from directly marking a run complete.
- Request idempotency through stable `requestId` values.
- Startup recovery that marks abandoned running tasks as interrupted.
- Cancellation and in-flight steering for active runs.
- Explicit failure persistence for provider and pi runtime errors.
- Resume attempts reuse the same durable Run ID and request ID, increment `attempt`, record `resumedAt`, and append `run.resumed`.
- Resume reconstructs a fresh runtime from the durable TaskRun snapshot without duplicating the original user message.

### Agent runtime

- In-process integration with `@mariozechner/pi-agent-core`.
- Streaming model deltas and tool lifecycle events persisted to the run event log.
- TAgent-owned tools: `read`, `write`, `edit`, `bash`, and `task_run`.
- Workspace path containment and a minimal destructive-command policy.
- Sequential tool execution for predictable state mutations.
- Append-only pi transcript persistence for user, assistant, tool-call, and tool-result messages.
- Per-run aggregate model usage for input, output, cache, total tokens, and provider-reported cost.
- Resume loads the persisted pi transcript into the new runtime before appending the recovery instruction.
- Provider request timeout/retry controls and a wall-clock timeout for each run attempt.
- Persistent bounded continuations after completion-gate blocks, with queued/running/completed/blocked/failed/cancelled audit states.
- Automatic continuation limits by count and cumulative run tokens; exhausted runs remain blocked for manual inspection.
- Startup recovery requeues queued/running continuation records, restores the Run to blocked, and resumes from the persisted transcript.
- Versioned SQLite schema metadata rejects newer unsupported databases and advances only after transactional migration success.
- Resume/continuation context assembly prunes oldest complete turns to a 75% context-window budget while retaining the full transcript in SQLite.

### HTTP and Web

- Fastify API for sessions, messages, run history, runs, cancellation, steering, resumption, transcript audit, and SSE event replay.
- Injectable `createApp()` factory for tests and future modules.
- Responsive React workbench with session navigation, streaming conversation, tool activity, and TaskRun details.
- Production server serves the built Web application without an additional static-file dependency.
- Client request IDs support browsers without `crypto.randomUUID`, including `getRandomValues` and legacy fallbacks.
- Blocked and interrupted runs can be resumed from the Web workbench; the UI exposes the current attempt.
- The right panel lists up to 50 recent TaskRuns as collapsible history and expands the current/latest Run by default.
- Dynamic execution budgets scale continuation count, cumulative tokens, and per-attempt timeout across simple/standard/complex/extended tiers, while environment values remain hard ceilings.
- A deterministic stress test completes a single durable Run after 40 automatic continuations; hundreds of model-backed turns are not yet an acceptance claim.

### Quality baseline

- TypeScript configurations separated for Node and browser builds.
- Store, completion gate, workspace tool, and HTTP API tests.
- Desktop and mobile Chromium rendering checks.
- Production dependency audit with no known vulnerabilities at the current lockfile.
- Git repository linked to `git@github.com:imtms/tagent-core.git` with incremental commits on `main`.

## In Progress

- Add semantic or model-generated transcript summaries before old turns are pruned from runtime context.
- Define bounded retry classes that distinguish transient provider failures from deterministic request errors.
- Prepare the worker protocol needed for a future pi RPC adapter.

## Next Milestones

### P1: Runtime reliability

- Implement a pi RPC worker adapter behind the AgentRuntime interface.
- Use in-process pi for the primary interactive agent and pi RPC for isolated or concurrent worker tasks.
- Add bounded retries, provider timeouts, model usage persistence, and per-run token limits.
- Persist enough runtime transcript state to support exact provider conversation continuation after process restart.

### P2: Tool governance

- Replace regex-only Bash restrictions with capability policies and explicit approvals.
- Add per-tool timeout, output, and concurrency budgets.
- Separate read-only and mutating tools.
- Add operation receipts and idempotency keys for side-effecting tools.
- Run workers under a dedicated low-privilege account or container boundary.

### P3: Context modules

- Add memory and knowledge interfaces without coupling them to the core runtime.
- Add context assembly with deterministic precedence and token budgeting.
- Add source provenance and retrieval evidence to TaskRun artifacts.

### P4: Operations

- Add structured configuration validation and a `/api/config/status` endpoint without exposing secrets.
- Add migrations with schema versions.
- Add metrics, structured model usage, tracing, and health checks for SQLite and provider connectivity.
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
- Multiple TAgent Core processes can currently target the same SQLite database; leader/lease enforcement is not implemented.
