# Runtime efficiency improvements (v0.2.3-P0)

This change set reduces avoidable model/tool loops without enabling a forced Run token cap or hard budget abort.

## Implemented

- `task_run action=batch` applies up to 50 plan/check/phase/artifact/stale mutations in one tool round-trip and emits one compact `run.updated` receipt.
- Historical tool context is projected on every Pi provider request, not only on resume:
  - default general historical tool result projection: 4,000 chars;
  - default historical `task_run` receipt projection: 600 chars;
  - head/tail is retained for general tool results and durable Artifact URI is preserved when available;
  - latest active turn remains complete.
- Configuration:
  - `TAGENT_HISTORICAL_TOOL_RESULT_CHARS` (default `4000`)
  - `TAGENT_HISTORICAL_TASK_RUN_RECEIPT_CHARS` (default `600`)
- Bash timeout is distinguished from generic signal termination, publishes `tool.bash.timed_out`, preserves output/Artifact references, and tells the Agent not to repeat the identical command.
- A failed Bash command with identical canonical arguments is fenced on the next attempt before execution. A materially changed command or timeout remains allowed.
- Composite Bash commands publish `tool.bash.composite` with split-stage guidance.
- Continuation stall detection compares normalized completion failures plus durable plan/check/artifact state. It stops two repeated no-progress continuations even if volatile wording/IDs differ, while allowing a continuation after durable evidence changes.
- System prompts now explicitly recommend batch governance updates and separately evidenced Bash stages.

## Preserved governance and budget defaults

- Required plan/check completion gates remain enabled.
- Semantic Supervisor review remains enabled.
- P0 snapshot-aware editing, Artifact spill, project context, deployment and migration paths remain intact.
- No Run token limit, model-call hard cap, tool-call hard cap or budget abort was added.
- Deterministic configuration/runtime tests pass legacy-looking `TAGENT_MAX_RUN_TOKENS`, `TAGENT_DYNAMIC_BUDGET`, `TAGENT_MAX_MODEL_CALLS`, and `TAGENT_MAX_TOOL_CALLS` values and verify that they do not create Core Run-budget fields, runtime controls, or budget-exhaustion events.
- `TAGENT_MAX_TOKENS=32768` remains the existing per-provider-response output cap. It is not a cumulative per-Run token budget and does not terminate a Run based on accumulated usage.

## Representative benchmark

Run:

```bash
node scripts/performance-efficiency-benchmark.mjs
```

Synthetic 10-turn tool-heavy transcript result:

- serialized historical context: `206,120 -> 80,966` chars (`60.7%` reduction);
- estimated historical context: `50,509 -> 19,216` tokens (`62.0%` reduction);
- representative TaskRun setup/settlement mutations: `12 -> 2` tool round-trips (`83.3%` reduction).

The benchmark is deterministic and measures projection/round-trip opportunity rather than provider latency. Real wall-clock improvement depends on model behavior, provider speed and task mix.
