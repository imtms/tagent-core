# Pi runtime architecture

## Current dependency boundary

TAgent Core uses Pi only inside `@tagent/runtime-pi`:

```text
Execution-owned AttemptRuntimePort / RuntimeTool / RuntimeModelSpec
                         |
                         v
                  @tagent/runtime-pi
                    |           |
                    v           v
        pi-agent-core AgentHarness   pi-ai Models/providers
```

The production and lockfile dependency graph contains no `pi-coding-agent` package. `@tagent/workspace-local` exposes Execution-owned `RuntimeTool` values, and `@tagent/core-service` passes `RuntimeModelSpec`; neither package imports or exposes Pi types.

`pi-agent-core` owns the ephemeral model/tool loop for one bounded Attempt. `pi-ai` owns provider streaming, message assembly, usage and provider-specific overflow classification. TAgent Core remains authoritative for TaskRun and Attempt state, leases and fencing, durable transcript and events, capability approval, effect receipts, timeouts, continuation and Supervisor settlement.

## Adapter responsibilities

`@tagent/runtime-pi` provides the session policy that was previously obtained from `pi-coding-agent.AgentSession`:

- constructs a per-Attempt in-memory `Session` and `AgentHarness`;
- converts `RuntimeTool` and `RuntimeModelSpec` to Pi-owned values only inside the adapter;
- imports Core-provided initial transcript messages into the Harness session;
- projects text, thinking, tool, queue, retry, compaction and settled events;
- applies Core tool guards before execution and reports final tool outcomes;
- supports steering, follow-up, cancellation, manual compaction and model switching;
- applies abortable exponential-backoff full-turn retry before rate-limit fallback while disabling duplicate provider-library retries;
- checks restored context before a new turn, performs threshold compaction after successful turns, tolerates non-overflow automatic-compaction failure, and runs one compaction/retry cycle after context overflow;
- aborts an active Harness turn before manual compaction, then resumes the unresolved request without adding a synthetic user message;
- keeps retry/fallback/compaction failures in the durable audit transcript but removes them from the active continuation branch;
- queues controls received between Harness turns and drives every accepted message after retry backoff or compaction;
- enforces provider response-header and body-chunk idle timeouts, including cancellation of compaction transport;
- applies conservative OpenAI-compatible payload defaults for custom endpoints;
- projects bounded historical tool output and TaskRun receipts before provider requests while preserving the entire current turn.

The underlying `pi-agent-core` loop continues to provide schema validation, sequential/parallel tool execution, tool-result ordering, abort propagation and refusal to execute tool calls from token-truncated assistant output.

## Compatibility guarantees

The runtime contract suite covers:

- streamed text and thinking;
- transcript persistence and completion ordering;
- tool start/progress/end and aborted tool settlement;
- steering and follow-up queues during streaming, retry and compaction, late-input rejection and abort queue audit;
- provider retry, transcript-invisible continuation, typed terminal failures and rate-limit model fallback ordering;
- custom OpenAI-compatible provider registration, conservative payload compatibility, runtime credentials and header/body idle timeout;
- pre-turn and post-turn threshold compaction, non-fatal automatic-compaction failure, active-turn manual compaction and context-overflow recovery;
- cancellation during initialization, streaming and compaction;
- current-turn thinking/tool-result preservation and bounded historical projection;
- package, dependency and ESLint ownership boundaries.

The replacement is behavior-compatible for the TAgent runtime surface covered by these contracts. It intentionally does not reproduce unused coding-agent features such as TUI, themes, built-in coding tools, extension loading, prompt templates, project context discovery or persistent coding-agent session files.

## Dependency rules

- `pi-coding-agent` must not appear in source, manifests, lockfiles or the installed dependency tree.
- `pi-agent-core` and `pi-ai` production imports are allowed only in `adapters/runtime-pi`.
- `apps/core-service` and `adapters/workspace-local` depend only on TAgent-owned runtime contracts.
- New provider/session policy belongs in `runtime-pi`; durable execution authority must not move into the adapter.

These rules are enforced by workspace architecture tests, package-manifest tests, ESLint import restrictions and release dependency scans.
