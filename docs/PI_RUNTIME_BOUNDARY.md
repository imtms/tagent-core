# Pi 0.83 and TAgent Scheduling Boundary

Updated: 2026-07-31 (Asia/Singapore)

## Decision

TAgent Core treats Pi `AgentSession` as the authoritative single-attempt model runtime. TAgent does not reimplement Pi's turn loop, in-memory message queues, provider retry loop, context-overflow recovery, compaction algorithm, tool execution lifecycle, or asynchronous abort settling.

TAgent owns the durable control plane around that runtime: TaskRun state, cross-restart continuation scheduling, leases and attempt fences, operation governance, execution budgets, checkpoints, consumer acknowledgements, and the completion gate.

## Responsibility Matrix

| Capability | Owner | TAgent integration rule |
|---|---|---|
| LLM/tool turn loop | Pi | Call `AgentSession.prompt()` and await the entire settled run. |
| Steer/follow-up ordering | Pi | Use `steer()` and `followUp()` only while `isStreaming`; observe `queue_update`. |
| Provider retries | Pi | Configure Pi retry settings and persist lifecycle events; never add a competing retry loop. |
| Context overflow recovery | Pi | Let Pi trigger overflow compaction and continuation. |
| Compaction algorithm | Pi | Call `compact()` and observe compaction/summarization retry events. |
| Tool hook execution | Pi | Compose Pi hooks; TAgent adds policy and operation receipts around prepared arguments. |
| Abort and idle settling | Pi | Call `clearQueue()`, then asynchronous `abort()`/`waitForIdle()` semantics. |
| Durable Run state | TAgent | SQLite is authoritative for status, phase, attempts, evidence, and gate state. |
| Cross-restart continuation | TAgent | Persist queue records, lease ownership, heartbeat, and attempt fences. |
| Completion | TAgent | Pi output is only a candidate; completion gate decides durable completion. |
| Delivery reliability | TAgent | Persist checkpoints, event ACKs, consumer generations, and terminal delivery evidence. |

## Correct Queue Semantics

Pi 0.83 queue methods do not themselves mean that a durable control message has been accepted. They are valid only while the Pi session is streaming. Calling them after `agent_settled` can create pending input without an active turn to consume it.

The runtime adapter therefore performs the atomic runtime-level policy available from Pi:

1. initialize or obtain the current `AgentSession`;
2. check `session.isStreaming`;
3. call Pi `steer()` or `followUp()` only while streaming;
4. return `settled` otherwise;
5. observe `queue_update` and `agent_settled` for audit and UI state.

This closes the short window where AgentService still owns a runtime object after Pi has settled.

A future durable inbox remains a TAgent concern. It should persist control input first, claim it against a specific Run attempt, then hand it to Pi while streaming. Pi remains the queue executor; SQLite provides restart durability and admission control.

## Cancellation

Pi owns cancellation of retries and the active model/tool loop. Before abort, the adapter calls Pi `clearQueue()` and records any discarded steering or follow-up messages. This prevents queued input from surviving ambiguously inside a cancelled runtime and provides audit evidence without duplicating Pi's queue implementation.

## Context Policy

Pi owns semantic compaction within a live attempt. TAgent's `ContextAssembler` remains only as a bounded restoration adapter when constructing a new Pi session from SQLite after restart, resume, or a cross-attempt continuation. It must not compete with Pi during a live session and should eventually consume persisted Pi compaction summaries rather than inventing a second semantic summarizer.

## Events Persisted by TAgent

The adapter translates Pi events into runtime-neutral durable events, including:

- queue snapshots and settled state;
- provider retry start/end;
- compaction start/end;
- summarization retry scheduling/start/finish;
- tool start/progress/end;
- assistant delta, retrying, and completed candidate output;
- queue contents discarded during abort.

These events are evidence and observability. They do not replace Pi's internal state machine.
