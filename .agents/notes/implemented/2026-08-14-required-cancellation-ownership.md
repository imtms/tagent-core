# Decision: Required cancellation ownership

Status: implemented
Kind: architecture

## Problem

Optional signals and never-abort fallbacks concealed who owned asynchronous work. Deadline races returned control while memory work or helper processes could still be active, and cancellation could not distinguish an undispatched call from a body that may have produced effects.

## Decision

Cancellation is required through `RuntimeTool`, `SubprocessSpawnSpec`, workspace edit, artifact, execution-facing memory recall/core-snapshot, context-enrichment, and session-history seams. Callers provide the signal they own. The Pi adapter maps an absent upstream SDK signal to the runtime lifetime signal. HTTP memory recall and Artifact content reads derive a scoped signal from request-abort and response-close events instead of constructing a never-abort fallback.

The tool pipeline emits `ABORTED_BEFORE_DISPATCH` before body invocation and `ABORTED` after invocation. Started same-process bodies are joined even when they ignore cancellation. Memory deadlines abort cooperatively, then await settlement before returning. `RecallRequest.signal` is required, is passed unchanged to embedding recall, and is checked between non-cancellable repository stages so cancellation cannot be degraded into a successful result.

## Alternatives considered

**Keep optional signals with a static fallback.** Rejected because a fallback cannot represent the caller's lifetime.

**Race work against cancellation.** Rejected because it reports settlement while effects can remain live.

**Use one cancellation code.** Rejected because durable consumers need to know whether side effects were possible.

## Verification

Typed assertions pin required `AbortSignal` parameters, including memory recall/core-snapshot and HTTP Artifact reads. Pipeline tests cover pre-dispatch and started classification plus join behavior. Workspace tests abort a paused Python descriptor helper and wait for process settlement. Memory tests prove the same signal reaches embedding recall and that caller cancellation rejects the operation. HTTP deadline tests prove connection close aborts the scoped operation and removes lifecycle listeners. Deadline tests also use an explicit cleanup latch to prove ownership does not settle early and verify caller listeners are removed when work setup throws synchronously.

## Consequences

Every asynchronous caller must now make lifetime ownership explicit. Uncooperative same-process implementations remain visibly pending instead of being silently abandoned.
