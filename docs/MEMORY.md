# Long-Term Memory

Long-term memory is an optional TAgent Core extension. It is disabled by default and does not change the original SQLite-backed session, transcript, TaskRun, checkpoint, or continuation behavior when disabled.

## Documentation map

| Document | Purpose |
| --- | --- |
| [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md) | Release-facing description of the implemented architecture, invariants, data flow, storage, and known limits |
| [MEMORY_OPERATIONS.md](MEMORY_OPERATIONS.md) | Enablement, configuration profiles, PostgreSQL/Local Cold setup, backup, restore, diagnostics, and upgrades |
| [MEMORY_API.md](MEMORY_API.md) | HTTP API, Agent tools, Web Memory Center, scopes, and response semantics |
| [MEMORY_RELEASE_CHECKLIST.md](MEMORY_RELEASE_CHECKLIST.md) | Memory-specific release and deployment gate |
| [MEMORY_DESIGN_PLAN.md](MEMORY_DESIGN_PLAN.md) | Original detailed design baseline; useful background, not the current implementation contract |

## Implemented release profile

The recommended first deployment is one trusted TAgent Core process with:

- PostgreSQL 17 for Hot/Warm records, preferences, topic descriptors, entity/relationship graph, capture jobs, policy receipts, and metadata;
- `pgvector` for Hot/Warm record and Topic Descriptor vectors;
- `pg_trgm`, substring matching, and PostgreSQL FTS for lexical fallback and Chinese-friendly matching;
- Local Cold storage for immutable, complete Markdown Topic revisions;
- an OpenAI-compatible embedding provider for production semantic retrieval;
- hybrid extraction: deterministic safety rules plus a structured LLM extractor;
- in-process capture and maintenance loops;
- the Web Memory Center and guarded Agent memory tools.

Cold bodies are never embedded. Hot/Warm retrieval routes to Topic IDs; selected Cold Topic pages are checksum-verified and read in full.

## Quick start

Memory-off compatibility mode:

```env
TAGENT_MEMORY_ENABLED=false
```

Recommended Local Cold profile:

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
TAGENT_MEMORY_EMBEDDING_API_KEY=...
TAGENT_MEMORY_EMBEDDING_MODEL=...

TAGENT_MEMORY_EXTRACTOR_PROVIDER=hybrid
# If omitted, extractor endpoint/key/model fall back to the main model settings.
```

See [MEMORY_OPERATIONS.md](MEMORY_OPERATIONS.md) before using this profile with existing data or exposing it outside a trusted private network.

## Release boundary

The current implementation is suitable for a trusted, single-service Local Cold deployment. It is not a claim of production-ready multi-tenant isolation. Built-in API authentication, formal server-side user membership, independent worker services, distributed provider scheduling, and multi-user approval roles remain outside this release boundary. Workspace-admin governance, reversible record/Topic tombstones, retention, durable reindex, feedback, and Core Memory projection are included in 0.1.5.
