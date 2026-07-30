# Agent Runtime Decision

Updated: 2026-07-30

## Decision

TAgent Core uses a hybrid runtime strategy:

- The primary interactive agent uses pi coding-agent `AgentSession` in-process.
- Isolated, concurrent, or delegated workers will use pi RPC behind the same TAgent-owned runtime interface.
- Codex app-server is reserved for specialized high-complexity coding implementation and review, not as the universal runtime.

The immediate implementation introduces the runtime interface and factory while retaining the in-process adapter as the only enabled implementation.

## Why In-Process Remains the Primary Runtime

The main Web conversation is already hosted inside one TAgent Core process. In-process pi has concrete advantages here:

- Tool implementations remain direct TAgent capability calls rather than being re-exposed through another protocol.
- Streaming and cancellation have no subprocess transport latency.
- The first version has one source of runtime state and fewer crash boundaries.
- The runtime can share the current TaskRun transaction and event publisher without protocol translation.
- Debugging is simpler while the durable control-plane contracts are still being stabilized.

Moving the primary agent to pi RPC now would add subprocess lifecycle, JSONL framing, handshake, event correlation, worker cleanup, and recovery semantics before the Worker contract is mature. It would not by itself solve durable transcript recovery because RPC session entries still need to be mapped into TAgent storage.

## Why RPC Is Still Required

In-process execution is not the long-term answer for every task. pi RPC is preferred for worker execution when one or more of these conditions apply:

- Multiple agent jobs should run concurrently.
- A task needs a separate process, HOME, environment, user, container, or worktree.
- Worker failure must not destabilize the main API process.
- A bounded delegated task needs independent cancellation and resource limits.
- TAgent needs to compare or replace worker implementations without changing AgentService.

## Runtime Contract

TAgent owns this minimal contract:

```text
prompt(query) -> Promise<void>
steer(instruction) -> Promise<void>
followUp(instruction) -> Promise<void>
compact(instructions?) -> Promise<void>
abort() -> void | Promise<void>
dispose() -> void
getMessages() -> AgentMessage[]
getError() -> string | undefined
```

The runtime factory receives Run ID, workspace, system prompt, tools, and an event sink. The adapter owns pi SessionManager, SettingsManager, ModelRuntime, queue, retry, and compaction details; pi-specific classes and protocol events must not leak into AgentService or the database schema. AgentService aggregates persisted runtime events into a throttled durable Run checkpoint, keeping checkpoint semantics runtime-neutral for future RPC workers.
Run events are consumed through Schema v5 durable consumer cursors. Each `(run, consumer)` claim increments a generation; replay starts after the durable ACK, ACKs are monotonic and bounded by the persisted event tail, and stale generations cannot advance delivery state.

Pi 0.83 abort is asynchronous and does not complete until the session is idle. Runtime adapters must preserve an abort requested during initialization, and must not dispose a busy session before that abort settles. Service close must also join the AgentService execution task before closing durable storage. Intermediate `agent_end` events with `willRetry: true` are retry progress, not completed assistant messages.

Pi installs Agent-level before/after tool hooks for its own runtime and extension semantics. TAgent adapters must compose those hooks rather than replace them, preserve Pi block/result transformations, and bind operation guards to Pi's prepared and validated arguments.

A later worker-oriented interface can add:

```text
start(WorkerSpec) -> workerId
snapshot(workerId) -> WorkerSnapshot
result(workerId) -> WorkerResult
close() -> Promise<void>
```

## Scheduling Policy

Initial scheduling policy:

| Work type | Runtime |
|---|---|
| Primary interactive Web conversation | In-process pi |
| Deterministic build/test/query | Deterministic runtime, planned |
| One model request with structured output | Single-shot runtime, planned |
| Explorer, bounded subtask, isolated operations | pi RPC, planned |
| Complex code implementation or review | Codex RPC, planned |

Runtime completion is always a candidate result. Only the TAgent TaskRun completion gate can set the durable run to completed.

## Migration Gates for pi RPC

Do not switch the primary agent to RPC until these are implemented and tested:

1. Stable WorkerSpec, WorkerEvent, WorkerSnapshot, and WorkerResult schemas.
2. Subprocess handshake and protocol version negotiation.
3. Event sequence correlation and duplicate suppression.
4. Timeouts, process cleanup, cancellation, and orphan recovery.
5. Sanitized environment and explicit capability exposure.
6. Transcript/session persistence mapped into TAgent-owned storage.
7. Contract tests that run against both in-process and RPC adapters.

## Consequences

- TAgent Core gains a replaceable runtime boundary now without premature process complexity.
- The current primary agent remains efficient and easy to inspect.
- Worker isolation is acknowledged as unfinished and tracked as a priority milestone.
- Future pi RPC adoption does not require rewriting AgentService or HTTP routes.
