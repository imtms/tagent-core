# Decision: Fence reindex publication at persistence

Status: implemented
Kind: bug-fix

## Problem

Reindex job claim, checkpoint, and completion use a lease token and fencing token, but the worker originally sent embedding results directly to `VectorIndexPort.upsert()`. A provider call could outlive its lease, another worker could reclaim the same job and activate newer content, and the expired worker could still overwrite the same generation before its later checkpoint was rejected. Guarding only vector upserts left the final cleanup, generation activation, job completion, and old-generation garbage collection as separate unfenced mutations; a reclaimed stale worker could therefore delete the newer claimant's vectors and overwrite completeness state after one last successful renewal.

## Decision

Reindex-only vector upserts go through `ReindexJobPort.upsertReindexVectors()`. The PostgreSQL implementation verifies the current job owner, lease token, fencing token, scope, generation, and database-clock unexpired lease in the same row-locking statement that performs the vector upsert. Final publication goes through `ReindexJobPort.finalizeReindex()`: one PostgreSQL transaction locks and revalidates that lease, removes missing/current and older-generation vectors, retires the prior active generation, activates the new generation, and completes the job. Any failed validation rolls back or performs no mutation, and the worker checks the boolean result. The in-memory implementation enforces the same behavioral contract. Ordinary online Memory vector writes continue to use `VectorIndexPort` because they do not run under a reindex job lease.

## Alternatives considered

**Renew immediately before the write.** Rejected because it reduces the expiry window but leaves a check/write race and cannot fence a worker after another claimant advances the fencing token.

**Attach a fencing token to each embedding row.** Rejected because it would add durable schema state and conflict semantics even though the reindex job row already owns the necessary authority. A job-guarded statement provides the required atomic boundary without a schema change.

**Rely on checkpoint rejection after the write.** Rejected because it detects the stale worker but cannot undo an overwritten active vector.

**Renew once and keep the existing final mutation sequence.** Rejected because the lease can expire or be reclaimed between renewal and any later cleanup/activation call; passing no authority to those calls cannot prove ownership.

**Fence each final call independently.** Rejected because another claimant could interleave between successful calls and expose a partial generation switch. The final visible publication needs one repository transaction.

## Verification

`tests/memory-governance-reindex.test.ts` deterministically blocks stale workers during both embedding and finalization, expires and reclaims their leases for worker B, and proves worker A can neither replace nor delete B's vectors or activation state after resuming. `tests/postgres-query-shape.test.ts` proves the PostgreSQL upsert and finalization paths lock and validate the job row, use the database clock, reject scope/generation mismatch, and keep cleanup, generation switch, and completion inside one transaction. `tests/postgres-memory.test.ts` exercises reclaimed-lease rejection, preserved content hashes, and atomic final publication against the environment-gated PostgreSQL 17 + pgvector profile.

## Consequences

The combined job/vector repository methods intentionally couple reindex mutation authority to the persistent Memory adapter. Future split storage backends must provide an equivalent atomic fence and final publication transaction or decline durable reindex support; a non-atomic cross-store implementation does not satisfy this decision. Embedding work may still be wasted after a lease expires, but its result cannot mutate or delete the active generation.
