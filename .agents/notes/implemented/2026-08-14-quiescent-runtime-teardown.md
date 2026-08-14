# Decision: Quiescent runtime teardown

Status: implemented
Kind: architecture

## Problem

Runtime shutdown previously raced owned work against a five-second timer and then released shared persistence, leases, and locks. A timeout could therefore report completion while callbacks, tools, or provider work still used those resources.

## Decision

`AttemptRuntimePort.dispose()` is required, asynchronous, idempotent, and resolves only at quiescence. Runtime registry shutdown snapshots and joins disposers plus preparation, control-delivery, and execution tasks with `Promise.allSettled`. Rejection of adjacent work still proves that work has settled; only a failed disposer means the runtime-owned quiescence barrier failed. A failed disposer retains runtime ownership and blocks release of the Store, writer lease, guard, and instance lock.

Hard time bounds belong at a worker or process termination boundary. Same-process work is cancelled cooperatively and joined; a timer never substitutes for quiescence.

## Alternatives considered

**Keep the five-second race.** Rejected because it abandons same-process Promises and makes later shared-resource release unsafe.

**Always release shared resources in `finally`.** Rejected because cleanup order is a durability and ownership boundary, not best-effort housekeeping.

## Verification

`tests/runtime.test.ts` latches a disposer and proves registry closure remains pending until quiescence, accepts rejected-but-settled adjacent work, and rejects a failed disposer. `tests/core-lifecycle.test.ts` proves a failed runtime barrier leaves lifecycle phase `closing` and retains every downstream resource.

## Consequences

Shutdown can remain pending on defective same-process code, which is truthful. Bounded termination now requires moving that code behind an isolatable boundary.
