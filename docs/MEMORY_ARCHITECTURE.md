# TAgent Core Memory Platform

## Invariants

- Fact and preference records use separate tables, domain types, ranking inputs, and prompt cards.
- Hot and warm records plus topic descriptors may be embedded. Cold bodies never enter a vector index.
- Cold memory is an immutable, complete Markdown topic revision stored through `BlobStorePort`; PostgreSQL holds the catalog and current revision pointer.
- Every read and write carries server-created `AccessContext` scopes and passes the policy gate.
- Secrets are inspected before extractor egress, persistence, embedding egress, cold publication, recall, and prompt injection.
- Recalled memory has `data_not_instruction` authority.

## Components

`MemoryService` is the application facade. Storage is replaceable through `RecordStorePort`, `VectorIndexPort`, `GraphStorePort`, `TopicCatalogPort`, `BlobStorePort`, `JobQueuePort`, `EmbeddingPort`, `ExtractorPort`, `SourceLoaderPort`, and `AuditPort`.

The default production composition uses PostgreSQL + pgvector for records, topic routing, graph adjacency, jobs, audit receipts, and vectors. Local filesystem or private S3-compatible storage holds cold revisions. The in-memory adapter supports tests and development.

## Recall

1. Gate the cue and derive allowed scopes on the server.
2. Search hot/warm FTS, vector records, topic descriptors, and graph entities.
3. Rank fact and preference cards independently.
4. Resolve candidate topic IDs.
5. Load only published cold revisions by exact topic ID, verify SHA-256, and read each selected page in full.
6. Apply injection gate and emit a bounded `recalled_memory` prompt section.

## Capture and consolidation

Context pruning and run completion enqueue idempotent durable capture jobs. Workers load source references, gate content before extraction, validate proposals, persist hot records, update warm descriptors and vectors, and later publish stable topic pages as immutable cold revisions. Cold publication writes the object first, verifies metadata, stages the catalog row, then atomically switches the current pointer and emits an outbox event.

## Deployment

Docker Compose is provided at `deploy/postgres/compose.yml`. If Docker is unavailable, install PostgreSQL and pgvector natively and use `TAGENT_MEMORY_POSTGRES_URL`. Configuration is documented in `.env.example`.

## Operations

- Export, edit, forget, quarantine review, reconciliation, backup, and restore are administrative operations.
- Forget marks records/topics deleted before removing vector entries and cold objects.
- Audit receipts contain hashes and reason codes, never rejected secret bodies.
- Online graph traversal is bounded to depth two.
