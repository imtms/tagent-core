# Decision: Fence reindex vector writes at persistence

Status: implemented
Kind: bug-fix

## Problem

Reindex job claim, checkpoint, and completion use a lease token and fencing token, but the worker sent embedding results directly to `VectorIndexPort.upsert()`. A provider call could outlive its lease, another worker could reclaim the same job and activate newer content, and the expired worker could still overwrite the same generation before its later checkpoint was rejected.

## Decision

Reindex-only vector upserts go through `ReindexJobPort.upsertReindexVectors()`. The PostgreSQL implementation verifies the current job owner, lease token, fencing token, scope, generation, and database-clock unexpired lease in the same row-locking statement that performs the vector upsert. The in-memory implementation enforces the same behavioral contract. Ordinary online Memory vector writes continue to use `VectorIndexPort` because they do not run under a reindex job lease.

## Alternatives considered

**Renew immediately before the write.** Rejected because it reduces the expiry window but leaves a check/write race and cannot fence a worker after another claimant advances the fencing token.

**Attach a fencing token to each embedding row.** Rejected because it would add durable schema state and conflict semantics even though the reindex job row already owns the necessary authority. A job-guarded statement provides the required atomic boundary without a schema change.

**Rely on checkpoint rejection after the write.** Rejected because it detects the stale worker but cannot undo an overwritten active vector.

## Verification

`tests/memory-governance-reindex.test.ts` deterministically blocks worker A in embedding, expires and reclaims its lease for worker B, and proves A cannot replace B's vector after resuming. `tests/postgres-query-shape.test.ts` proves the PostgreSQL statement locks and validates the job row, uses the database clock, rejects scope/generation mismatch as one batch, and performs the mutation through the guarded CTE. `tests/postgres-memory.test.ts` exercises the reclaimed-lease rejection and preserved content hash against the environment-gated PostgreSQL 17 + pgvector profile. `npm run lint`, `npm run check`, and the full local `npm test -- --run` suite pass; the PostgreSQL suite remains CI/environment-gated when that service is absent locally.

## Consequences

The combined job/vector repository method intentionally couples reindex mutation authority to the persistent Memory adapter. Future split storage backends must provide an equivalent atomic fence or decline durable reindex support; a non-atomic cross-store implementation does not satisfy this decision. Embedding work may still be wasted after a lease expires, but its result cannot mutate the generation.
