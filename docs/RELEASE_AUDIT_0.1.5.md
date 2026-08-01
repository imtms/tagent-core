# TAgent Core 0.1.5 Release Audit

## Scope

0.1.5 promotes the long-term memory runtime from incremental indexing and passive inspection to durable operations, human governance, and stable core-memory injection.

## Delivered

- Durable Reindex Job: checkpoint, lease, fencing, crash reclaim, progress, staging/ready/active generation metadata and GC.
- Deep readiness: provider probes, persistent heartbeat, queue oldest age, P95 latency, error rates, pending embeddings, completeness and last degraded event.
- Topic tombstone/restore with delayed immutable Cold revision purge.
- Recall Feedback Receipt wired into Ranking v2.
- Candidate approve/reject/correct and Disputed resolution with governance receipts and Memory Center actions.
- Revisioned Core Memory Markdown projection, periodic cross-topic generation, human edits and deterministic per-turn injection.
- Expanded deterministic retrieval benchmark.

## Explicit remaining boundaries

- Reindex scans the current authorized scope into an in-job manifest; very large deployments should still add page-key cursors and provider-wide distributed rate scheduling.
- Periodic distillation currently uses deterministic cross-topic synthesis. LLM daily digest and role-aware LLM context-prune summarization remain optional next-stage capabilities.
- Governance is workspace-admin oriented; full multi-user approver roles are outside 0.1.x.
- Real-provider semantic benchmark remains an environment-gated/nightly concern rather than a hermetic release test.

## Stable deployment boundary

Single trusted process and workspace, SQLite control plane, private network/localhost, optional PostgreSQL 17 + pgvector + pg_trgm memory metadata, and Local Cold storage.
