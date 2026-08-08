# Execution reliability and efficiency

TAgent Core keeps the existing TaskRun, Supervisor, evidence and approval model while reducing avoidable model/tool loops. These changes improve context signal density and mutation reliability without adding a cumulative Run token limit or hard model/tool-call budget.

## Snapshot-aware workspace mutation

Workspace reads return a `snapshotId` and `contentHash`. Snapshot-bound `edit` and atomic multi-file `patch` operations validate every snapshot and hunk before committing visible changes.

Properties:

- stale snapshots fail with `workspace.edit_stale` before mutation;
- precondition failures fail with `workspace.edit_precondition_failed`;
- multi-file patches preflight as a unit and do not intentionally leave partial writes;
- commit-time hashes are checked again through the descriptor-relative helper;
- normal commit failures roll back visible renames;
- successful edits invalidate affected checks;
- Operation canonical payloads include the snapshot-bound patch, so receipt replay does not write twice;
- durable `workspace.edit.completed` and `workspace.edit.rejected` events retain audit metrics.

## Durable large-output spill

Large tool output is no longer represented only by a permanently truncated string. `ArtifactSinkPort` and the Workspace file sink preserve the bounded complete stream available to Core, then return a head/tail preview and durable reference.

Tool results can include:

```text
artifactId / artifactUri
sha256
totalBytes / storedBytes / shownBytes
truncatedAtSource / outputDiscardedBytes
```

The default Artifact hard limit is 16 MiB and is configurable with `TAGENT_TOOL_ARTIFACT_MAX_BYTES`. If the source exceeds the configured limit, the result explicitly reports discarded bytes and never presents the Artifact as complete. Core emits `tool.output.spilled` for durable evidence and diagnostics.

## Core-owned project context

Core discovers `AGENTS.md` by default and optional allowlisted files from `TAGENT_PROJECT_RULE_FILES`. Selected files must be contained regular non-symlink files and respect the configured size bound.

The Context Manifest records each source path, SHA-256, precedence, selection reason and byte count, plus an aggregate context hash. Project content is explicitly untrusted: it may guide execution but cannot grant capabilities, approve operations or override TaskRun and completion authority.

## Fewer model/tool round trips

`task_run action=batch` applies up to 50 plan, check, phase, Artifact and check-staleness mutations in one fenced SQLite transaction and emits one compact `run.updated` receipt. If any mutation fails, the whole batch rolls back.

A passed required check must identify a successful Bash receipt from the current Attempt. When the check supplies only the exact command, the tool searches one bounded recent receipt window and reuses that result for every check in the batch. `task_run action=operations` returns only the latest 24 receipts with a bounded response.

Historical provider context is projected on every Pi request:

- general historical tool results default to 4,000 characters;
- historical `task_run` receipts default to 600 characters;
- head/tail and durable Artifact references are retained;
- the latest active turn stays complete.

Configuration:

```text
TAGENT_HISTORICAL_TOOL_RESULT_CHARS=4000
TAGENT_HISTORICAL_TASK_RUN_RECEIPT_CHARS=600
```

The deterministic benchmark can be run with:

```bash
node scripts/performance-efficiency-benchmark.mjs
```

Its representative 10-turn fixture reduces serialized historical context by about 61%, estimated historical tokens by about 62%, and representative TaskRun setup/settlement mutation round trips from 12 to 2. It measures deterministic projection opportunity, not provider wall-clock latency.

## Bounded hot paths

Long-lived Sessions and TaskRuns no longer load their complete history for normal execution:

- Session history, Attempt transcript and admission Run summaries use bounded SQL windows rather than loading and slicing full objects;
- Supervisor settlement loads at most the recent operation window plus required check source receipts in one query;
- large evidence-ID sets use one JSON-set bind instead of exceeding SQLite's host-parameter limit;
- common runtime events validate the lightweight current Attempt instead of hydrating a complete TaskRun;
- equivalent Pi model/provider configurations reuse one initialized model runtime;
- Bash stdout/stderr capture accumulates Buffer chunks and concatenates once, avoiding quadratic string growth;
- online Memory recall has a 3-second overall deadline; online embedding uses a 2.2-second timeout with no retry on the Attempt startup path.

Router and Supervisor transports default to 5 seconds. Deterministic routing, prerequisite gates, lightweight discussion completion and known runtime-error classification avoid their respective LLM call entirely when the result is authoritative locally.

## Bash timeout and repeat protection

Bash timeout is classified separately from generic signal termination and emits `tool.bash.timed_out` with command hash, output byte counts and Artifact references. Composite commands emit `tool.bash.composite` guidance so build, test, deploy, restart and polling can be executed and evidenced separately.

After a Bash command fails or times out, an identical canonical command is fenced before the next execution. The Agent must inspect preserved output or materially change the command/timeout/recovery approach. This prevents expensive blind reruns while allowing a changed recovery action.

## Continuation stall detection

Continuation progress signatures use stable failure kind/key/disposition plus durable plan state, trusted check receipt/time bindings, and Artifact content hashes. Two consecutive continuations with the same gate/evidence state stop with `continuation.stalled`, even when timestamps, UUIDs or wording differ. New durable evidence permits another bounded continuation.

## Preserved governance and budget behavior

- required plan/check completion gates remain enabled;
- semantic Supervisor review remains enabled;
- no cumulative Run token limit was introduced;
- no hard model-call or tool-call budget was introduced;
- legacy-looking `TAGENT_MAX_RUN_TOKENS`, `TAGENT_DYNAMIC_BUDGET`, `TAGENT_MAX_MODEL_CALLS` and `TAGENT_MAX_TOOL_CALLS` values do not install Run-budget controls;
- `TAGENT_MAX_TOKENS` remains the per-provider-response output cap, not a cumulative Run budget.
