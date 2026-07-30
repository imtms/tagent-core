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

### HTTP and Web

- Fastify API for sessions, messages, runs, cancellation, steering, resumption, and SSE event replay.
- Injectable `createApp()` factory for tests and future modules.
- Responsive React workbench with session navigation, streaming conversation, tool activity, and TaskRun details.
- Production server serves the built Web application without an additional static-file dependency.
- Client request IDs support browsers without `crypto.randomUUID`, including `getRandomValues` and legacy fallbacks.
- Blocked and interrupted runs can be resumed from the Web workbench; the UI exposes the current attempt.

### Quality baseline

- TypeScript configurations separated for Node and browser builds.
- Store, completion gate, workspace tool, and HTTP API tests.
- Desktop and mobile Chromium rendering checks.
- Production dependency audit with no known vulnerabilities at the current lockfile.
- Git repository linked to `git@github.com:imtms/tagent-core.git` with incremental commits on `main`.

## In Progress

- Persist enough pi transcript and tool-result state to continue a provider conversation exactly after process restart.
- Define a bounded provider retry and timeout policy with usage persistence.
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

- The current in-process pi transcript exists only in memory during a run.
- Resume uses durable snapshot replay in a fresh pi runtime; it does not yet continue the exact provider transcript.
- Bash isolation is policy-based, not an OS-level sandbox.
- The first Web interface does not expose model/runtime selection or provider health.
- Multiple TAgent Core processes can currently target the same SQLite database; leader/lease enforcement is not implemented.
