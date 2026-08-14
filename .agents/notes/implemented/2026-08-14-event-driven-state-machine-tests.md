# Decision: Event-driven state-machine tests

Status: implemented
Kind: testing

## Problem

Critical runtime tests polled durable events with short sleeps or asserted only example traces. The sleeps hid publication/ownership races, slowed healthy runs, and left canonicalization, replay, ordering, and migration state spaces underexplored.

## Decision

`RunEventProbe` subscribes to the existing event boundary, remembers already observed events, and resolves predicates directly. A timer is only a failure guard. Pi lifecycle, cancellation, retry, steering, and compaction tests synchronize on events or explicit latches.

Seeded, size-bounded `fast-check` properties cover canonical request equivalence, semantic hash changes, operation and tool-attempt replay, identity conflict rejection, gap-free event sequences, and v44-to-v45 migration re-entry with durable envelope preservation. Database properties reuse one isolated in-memory Store per property instead of rerunning the complete migration chain for every generated case; the filesystem migration property retains independent databases and an explicit 15-second failure guard.

## Alternatives considered

**Increase sleep durations.** Rejected because it slows healthy runs without identifying the state that makes progress safe.

**Add only more hand-written examples.** Rejected because examples do not explore ordering and input-space combinations systematically.

**Use unseeded or unbounded generators.** Rejected because failures would be harder to reproduce and runtime could grow unpredictably.

## Verification

`tests/pi-session.test.ts` uses `tests/support/event-probe.ts` for critical boundaries. `tests/state-machine-properties.test.ts` runs four fixed-seed properties with bounded sizes. The event conversion exposed and now pins a retry race: the retry abort controller is installed before `provider.retry` becomes observable.

## Consequences

Critical synchronization now describes causality instead of elapsed time. Property failures report reproducible seeds and shrunk counterexamples, at the cost of a small test dependency and explicit generator maintenance.
