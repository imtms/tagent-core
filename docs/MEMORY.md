# Memory

## Boundary

Memory is an optional `@tagent/memory` domain. With `TAGENT_MEMORY_ENABLED=false`, Core does not construct Memory adapters, connect to PostgreSQL/S3, access Local Cold storage, or start Memory workers. SQLite sessions, TaskRuns, transcripts, and recovery remain available.

The supported persistent profile uses one Core process with PostgreSQL 17, `vector`, `pg_trgm`, and Local Cold storage. The in-memory backend is for tests/development. S3 is implemented as a Cold adapter but is not the primary release-gated deployment profile.

## Storage model

```text
Capture -> policy -> Hot/Warm record + Topic descriptor
                                   |
Recall <- lexical/vector/graph ----+
                                   |
                             exact Topic ID
                                   |
                       immutable Cold Markdown revision
```

- Hot/Warm stores facts, preferences, episodes, procedures, topics, graph links, capture jobs, lifecycle state, and metadata.
- Vector and lexical retrieval cover Hot/Warm records and Topic descriptors.
- Cold stores complete immutable Markdown Topic revisions.
- Cold page bodies are never chunk-vectorized. Recall selects a Topic ID, verifies the revision checksum, and loads the complete page.

## Configuration

Disabled mode:

```env
TAGENT_MEMORY_ENABLED=false
```

Persistent Local Cold profile:

```bash
docker compose -f deploy/postgres/compose.yml up -d
```

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_MEMORY_BACKEND=postgres
TAGENT_MEMORY_POSTGRES_URL=postgresql://tagent:tagent@127.0.0.1:5432/tagent_memory
TAGENT_MEMORY_COLD_BACKEND=local
TAGENT_MEMORY_COLD_PATH=./data/memory-cold
TAGENT_MEMORY_WORKSPACE_SCOPE_ID=default

TAGENT_MEMORY_EMBEDDING_PROVIDER=openai
TAGENT_MEMORY_EMBEDDING_BASE_URL=https://embedding-provider.example/v1
TAGENT_MEMORY_EMBEDDING_API_KEY=
TAGENT_MEMORY_EMBEDDING_MODEL=
TAGENT_MEMORY_EXTRACTOR_PROVIDER=hybrid
```

`openai` embeddings require base URL, key, and model. `none` enables lexical-only retrieval. `hash` is deterministic test/development behavior. Hybrid extraction may fall back to the main provider configuration when dedicated extractor settings are absent.

## Capture and policy

Capture is proposal-based. Source classification, model-egress policy, secret/prompt-injection checks, quality thresholds, scope, provenance, and conflict handling run before durable publication. A user message is not automatically a durable fact.

The optional shared Semantic Judge may improve intent, quality, correction, preference, and Learning evidence classification. Invalid, timed-out, rate-limited, or low-confidence output is withheld or follows conservative deterministic fallback; it cannot grant capability or bypass approval.

## Recall

Recall applies caller resource scope, workspace scope, lifecycle state, lexical/vector/topic thresholds, contradiction handling, and token budgets. Empty recall is valid. Selected content is persisted in the Attempt's Context Manifest with provenance and omission reasons.

## Lifecycle

Records support correction, supersession, stale/delete thresholds, feedback, reversible tombstones, and retention. Topic deletion retains immutable revisions through the configured grace period; restore targets explicit record or Topic IDs. Maintenance removes expired objects only after the policy boundary permits it.

Reindex is durable and generation-based. A new embedding generation is staged, checkpointed, validated, and activated only after completion; readers continue using the active generation during the build.

## Admin surface

Memory administration uses `/api/v1/admin/memory/*`, including recall, capture, jobs/status, export, forget, restore, reindex, governance, feedback, and Core Memory snapshot operations. Use the `@tagent/abi/admin/v1` schemas rather than copying payload shapes from old routes.

When service credentials are configured, routes require `admin` and/or their declared governance scope plus resource-scope checks. The independent Web Console uses versioned console/admin projections through the Core client.

## Operations

Before enabling Memory in production:

1. initialize PostgreSQL extensions and schema using the repository deployment profile;
2. put PostgreSQL and Cold storage on protected durable volumes;
3. configure backup/restore for PostgreSQL and Cold revisions as one logical set;
4. run the PostgreSQL integration test and retrieval/reindex rehearsal;
5. verify resource-scope isolation and the Memory-off path;
6. monitor capture failures, empty/filtered results, reindex generation, recall latency, and worker readiness.

Back up Memory consistently with the SQLite control plane before an upgrade. A SQLite rollback without matching Memory/Cold state may restore obsolete authority or references.

## Relationship to Learning

Learning depends on Memory. Disabling Memory forces Learning and automatic execution off. See [LEARNING.md](LEARNING.md).
