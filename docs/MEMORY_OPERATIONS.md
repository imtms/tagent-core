# Memory Operations

## 1. Enable or disable

Long-term memory is disabled by default:

```env
TAGENT_MEMORY_ENABLED=false
```

Disabled mode does not load adapters or workers, connect to PostgreSQL/S3, or access Local Cold. Memory-only environment values are ignored. Original SQLite session/TaskRun behavior remains available, and memory endpoints return HTTP 503.

Enable only after configuring a complete profile:

```env
TAGENT_MEMORY_ENABLED=true
```

## 2. Deployment profiles

### Recommended: PostgreSQL + real embedding + hybrid extraction + Local Cold

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_MEMORY_BACKEND=postgres
TAGENT_MEMORY_POSTGRES_URL=postgresql://tagent:change-me@127.0.0.1:5432/tagent_memory

TAGENT_MEMORY_COLD_BACKEND=local
TAGENT_MEMORY_COLD_PATH=./data/memory-cold
TAGENT_MEMORY_WORKSPACE_SCOPE_ID=default

TAGENT_MEMORY_EMBEDDING_PROVIDER=openai
TAGENT_MEMORY_EMBEDDING_BASE_URL=https://embedding-provider.example/v1
TAGENT_MEMORY_EMBEDDING_API_KEY=...
TAGENT_MEMORY_EMBEDDING_MODEL=...
TAGENT_MEMORY_EMBEDDING_BATCH_SIZE=64

TAGENT_MEMORY_EXTRACTOR_PROVIDER=hybrid
# Optional; omitted values fall back to TAGENT_API_BASE, OPENAI_API_KEY, TAGENT_MODEL.
TAGENT_MEMORY_EXTRACTOR_BASE_URL=
TAGENT_MEMORY_EXTRACTOR_API_KEY=
TAGENT_MEMORY_EXTRACTOR_MODEL=
```

Use provider-specific `TAGENT_MEMORY_EMBEDDING_EXTRA_BODY` when required, for example a JSON object containing input type or truncation settings.

### Lexical-only durable profile

Set `TAGENT_MEMORY_EMBEDDING_PROVIDER=none`. PostgreSQL FTS, substring, trigram, topic aliases, and graph routing remain available. This is a valid fallback but does not provide semantic paraphrase retrieval.

### Development/test profile

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_MEMORY_BACKEND=memory
TAGENT_MEMORY_COLD_BACKEND=local
TAGENT_MEMORY_EMBEDDING_PROVIDER=hash
TAGENT_MEMORY_EXTRACTOR_PROVIDER=rule
```

Hot/Warm records, vectors, graph, jobs, and topic metadata are not durable in this mode. Hash embedding is deterministic test infrastructure, not a production semantic model.

## 3. PostgreSQL with Docker

```bash
docker compose -f deploy/postgres/compose.yml up -d
docker compose -f deploy/postgres/compose.yml ps
```

The supplied service uses PostgreSQL 17 with pgvector. Startup migration also requires permission to create/use `pg_trgm`, the `memory` schema, tables, indexes, and constraints.

Do not use the example password outside local development. Override Compose credentials and the connection URL for real deployment.

## 4. Native PostgreSQL

Install PostgreSQL 17, pgvector, and `pg_trgm` support. Create a database and role, then set `TAGENT_MEMORY_POSTGRES_URL`. The application runs `src/memory/postgres/schema.sql` idempotently at startup, including `CREATE EXTENSION IF NOT EXISTS vector` and `pg_trgm`. The database role therefore needs extension creation rights during initial migration, or an administrator must create both extensions first.

Basic validation:

```sql
SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm');
SELECT count(*) FROM memory.capture_jobs;
SELECT count(*) FROM memory.records;
SELECT count(*) FROM memory.preferences;
SELECT count(*) FROM memory.topics;
```

## 5. Local Cold permissions

`TAGENT_MEMORY_COLD_PATH` must be writable by the service account and included in backup/restore. Keep it outside the Git worktree for real data. Cold files may contain personal information even though secrets are gated, so use restrictive filesystem permissions and encrypted storage where required.

Cold files are immutable revisions. Do not edit a published revision in place: checksum verification will fail. Correct data through the memory lifecycle/UI/API so a new revision is published.

## 6. Worker tuning

```env
TAGENT_MEMORY_WORKER_INTERVAL_MS=1000
TAGENT_MEMORY_MAINTENANCE_INTERVAL_MS=60000
TAGENT_MEMORY_WARM_AFTER_MS=0
TAGENT_MEMORY_HOT_TTL_MS=2592000000
TAGENT_MEMORY_COLD_MINIMUM_RECORDS=2
TAGENT_MEMORY_RECALL_TOKEN_BUDGET=8000
```

- capture and maintenance loops use independent locks;
- shorter maintenance intervals improve demo responsiveness but increase provider/database work;
- `COLD_MINIMUM_RECORDS` controls when a Topic becomes eligible for publication;
- Cold pages that do not fit the recall budget are skipped rather than truncated.

## 7. Extractor and embedding health

At startup, enabled OpenAI-compatible embedding configuration is validated and an asynchronous reindex is attempted. If embedding fails, a warning is logged and lexical recall remains available.

Hybrid extraction requires a valid base URL, key, and model. It may reference another environment variable using an exact `${NAME}` value, which the application resolves explicitly for systemd `EnvironmentFile` compatibility.

If an LLM extraction fails:

- deterministic proposals are persisted when available;
- if no deterministic proposal exists, the capture job retries and can become dead-letter;
- inspect job `errorCode`, `attempts`, `proposalCount`, and `persistedCount` rather than trusting the assistant's wording.

## 8. Diagnostics

Health and runtime configuration:

```bash
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://127.0.0.1:3100/api/config/status
```

The config status exposes only non-sensitive memory state such as enabled/backend/scope. It must not expose credentials.

In the Web Memory Center inspect:

- capture jobs stuck in `queued` or `running`;
- `completed_empty` jobs caused by unsupported/low-salience input;
- `dead_letter` jobs caused by provider or schema failures;
- Hot/Warm/Cold counts and disputed/candidate state;
- actual persisted records and Cold Topic pages.

PostgreSQL diagnostics:

```sql
SELECT id,status,attempts,error_code,proposal_count,persisted_count,created_at,updated_at
FROM memory.capture_jobs ORDER BY created_at DESC LIMIT 50;

SELECT scope_type,scope_id,tier,status,count(*)
FROM memory.records GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;

SELECT scope_type,scope_id,tier,status,count(*)
FROM memory.preferences GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
```

A capture enqueue failure produces `memory.capture.failed`; a zero-proposal extraction produces `memory.capture.empty`; successful persistence produces `memory.capture.completed`.

## 9. Backup and restore

Back up PostgreSQL and Local Cold as one logical snapshot:

1. stop memory writes or place the service in a controlled maintenance window;
2. run `pg_dump` for the memory database;
3. copy the complete Local Cold directory while preserving names and permissions;
4. record code version and non-secret configuration;
5. after restore, start the matching code and verify current revisions/checksums.

PostgreSQL's current revision pointer is authoritative. Missing objects make a Topic unreadable; orphaned objects are not current memory. Run/observe reconciliation after restore.

## 10. Upgrade and rollback

Before upgrade:

- back up PostgreSQL and Local Cold;
- verify available disk space;
- note the embedding model/generation and extractor profile;
- run the release checklist;
- do not assume application rollback also rolls back memory schema/data.

The migration is additive/idempotent in the current release. An older binary may not understand newer columns or statuses; restore the matching backup for a full rollback.

Changing embedding model or dimensions changes the generation. Startup reindex writes the configured generation; validate retrieval before retiring old generations.

## 11. Security

- keep the service on localhost or a trusted private network until authentication and formal multi-tenant authorization exist;
- use a least-privilege PostgreSQL role and TLS where applicable;
- use restrictive Local Cold permissions and encrypted disks/backups;
- rotate provider/database credentials outside memory storage;
- never place secrets in Cold pages, Topic metadata, audit fields, screenshots, or support bundles;
- treat recalled memory as untrusted data, not executable instruction;
- policy receipts contain hashes/reason codes, not rejected secret bodies.

## 12. Optional S3 adapter

`TAGENT_MEMORY_COLD_BACKEND=s3` requires bucket, region/endpoint as needed, and AWS-compatible credentials. Use a private bucket, encryption, version/lifecycle policy, no public ACL, and immutable object keys. S3 is implemented but the Local Cold profile is the primary release gate documented here.


## 13. Provenance and capture safety

Durable memory writes carry structured provenance:

- `user_explicit`: direct user statements; high trust and eligible for active memory.
- `user_context_summary`: role-aware summaries containing only durable user statements from pruned context; medium trust.
- `tool_verified_fact`: reserved for successful operation/check/artifact evidence.
- `task_outcome`: generated from structured passed Checks and published Artifacts, never assistant final prose.
- `assistant_inference`: untrusted and quarantined by default.

Assistant responses and mixed raw context-prune transcripts are not capture sources. One-off operational requests are excluded from semantic extraction. Capture jobs use lease heartbeat and fencing; stale workers cannot complete or fail a job after another worker has reclaimed it.

The recall token budget is a hard combined ceiling for safe Hot/Warm cards plus complete Cold Topic pages. If a card or complete Cold page does not fit, it is omitted rather than overflowing the prompt or truncating Cold content.

Required CI starts PostgreSQL 17 from `pgvector/pgvector:pg17`, creates a test-named database, and runs the PostgreSQL memory suite with pgvector and pg_trgm enabled.
