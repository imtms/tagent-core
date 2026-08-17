# Decision: Fence and atomically publish captured Memory

Status: implemented
Kind: architecture

## Problem

The capture worker persisted records, topics, graph data, and vectors before completing its leased job. If the lease was reclaimed or a write failed partway through publication, a stale worker could leave visible partial state and a retry could create duplicate records because extracted IDs are not stable.

## Decision

Captured projections publish through one capture-specific persistence port. Its PostgreSQL implementation locks and validates the claimed job using owner, lease token, fencing token, and database time, then writes durable records, preferences, topics, graph data, vectors, and job completion in one transaction. Embedding calls remain outside the transaction and completed vector documents enter the fenced commit as data. The in-memory implementation enforces the same all-or-nothing behavioral contract.

Direct administrative upserts retain their lexical fallback and do not claim capture-job authority. A composition that cannot provide the fenced capture commit must fail rather than silently publishing a leased capture through independent stores. Core Snapshot refresh runs only after a successful commit; refresh failure is reported without changing the already completed capture job.

## Alternatives considered

**Make extractor IDs deterministic only.** Rejected because it improves retry idempotency but still permits stale workers and partial topic, graph, vector, or job state.

**Wrap existing ports in a generic transaction callback.** Rejected because callbacks do not prove that independently supplied adapters share one transaction or one fencing authority.

**Use an outbox and projection workers.** Rejected for now as unnecessary operational complexity for a single PostgreSQL Memory store.

## Verification

Focused in-memory tests prove stale claimants and embedding failures publish no partial records, topics, graph edges, vectors, or completion. PostgreSQL query-shape tests prove the database-clock lease check and `FOR UPDATE` lock occur inside the same transaction before projection writes and completion. Readiness tests cover an intentionally absent embedding provider. `npm run check`, `npm run lint`, and the focused Memory/Web/architecture suites pass.

## Consequences

Embedding failures occur before commit and therefore use normal job retry. Blob-backed Cold consolidation remains a separate reconciled workflow outside this transaction. The capture port intentionally couples publication authority to one persistent Memory adapter; future split stores must provide an equivalent atomic fence or decline durable capture support rather than weaken the contract.
