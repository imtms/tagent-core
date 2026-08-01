# TAgent Core Long-Term Memory Architecture

Status: implemented on `main` for the trusted single-service PostgreSQL/pgvector/pg_trgm + Local Cold profile.

## 1. Scope and compatibility

Long-term memory is an opt-in adapter-based extension. With `TAGENT_MEMORY_ENABLED=false`, TAgent Core does not construct memory adapters, start memory workers, connect to PostgreSQL/S3, or touch Local Cold storage. The original SQLite session and TaskRun system remains the only durable context source.

When enabled, the memory module adds durable semantic recall without replacing:

- recent working context assembled from SQLite messages and the Pi transcript;
- TaskRun plans, checks, artifacts, checkpoints, and continuations;
- Pi retry and compaction behavior.

The supported first deployment boundary is one trusted process, one trusted workspace scope, PostgreSQL/pgvector metadata, and Local Cold files.

## 2. Two orthogonal classifications

Memory kind and storage temperature are independent.

Kinds:

- **Fact** — entity attributes, relationships, decisions, and current or historical state;
- **Preference** — user/person preferences, polarity, strength, origin, and applicability;
- **Episode** — time-oriented discussions, results, milestones, failures, and events;
- **Procedure** — recurring instructions, habits, and workflows.

Tiers:

- **Hot** — newly captured, active, fine-grained records with optional expiry;
- **Warm** — promoted, searchable records and Topic Descriptors used for recall and routing;
- **Cold** — immutable complete Markdown Topic revisions loaded only by exact Topic ID.

Facts and preferences have separate domain types and PostgreSQL tables. Preference ranking uses confidence and strength; fact/episode/procedure ranking uses confidence and importance.

## 3. Core invariants

1. Cold bodies never enter a vector index. Database constraints allow only `hot_record`, `warm_record`, and `topic_descriptor` vector references.
2. A selected Cold Topic is read as a complete page; it is not returned as an arbitrary similarity chunk.
3. Every durable record carries a scope and source references.
4. Access scopes are created by the server, not accepted as authority from model output.
5. Sensitive-data gates run before extractor egress, persistence, embedding egress, Cold publication, recall, and prompt injection.
6. Recalled memory is inserted with `authority="data_not_instruction"` and cannot override higher-authority instructions or current user input.
7. Capture is durable and idempotent. A successful job with no proposals is explicitly `completed_empty`, not silently reported as a stored memory.
8. Vector, graph, and LLM failures degrade to available deterministic/lexical paths; confidentiality failures do not bypass policy.

## 4. Ports and adapters

`MemoryService` is the application facade. The domain depends on ports rather than concrete stores:

- `RecordStorePort`
- `VectorIndexPort`
- `GraphStorePort`
- `TopicCatalogPort`
- `BlobStorePort`
- `EmbeddingPort`
- `ExtractorPort`
- `JobQueuePort`
- `SourceLoaderPort`
- `AuditPort`
- `PolicyGatePort`

Implemented adapters:

| Capability | Adapters |
| --- | --- |
| Records/topics/graph/jobs/vector/audit | PostgreSQL adapter; in-memory development/test adapter |
| Cold objects | Local filesystem; S3-compatible object storage |
| Embedding | OpenAI-compatible real embeddings; deterministic hash adapter for tests/development; lexical-only mode |
| Extraction | deterministic rule extractor; hybrid rule + OpenAI-compatible LLM extractor |
| Cold consolidation | deterministic Markdown projection; LLM semantic consolidator with deterministic fallback |
| Policy | default scope, sensitive-data, and stored-prompt-injection policy engine |

`AgentService` and Agent tools depend on `MemoryFacade`; they do not issue PostgreSQL, pgvector, or filesystem queries directly.

## 5. Storage model

### PostgreSQL

The startup migration enables `vector` and `pg_trgm`, then creates the `memory` schema. Main tables:

- `memory.records` for facts, episodes, and procedures;
- `memory.preferences` for preferences;
- `memory.entities` and `memory.edges` for the bounded relationship graph;
- `memory.topics` and `memory.cold_revisions` for Topic routing and immutable revision metadata;
- `memory.embeddings` for Hot/Warm/Topic Descriptor vectors only;
- `memory.capture_jobs` for durable capture, leases, attempts, proposal/persisted counts, and errors;
- `memory.policy_receipts` for hash-only policy audit evidence;
- `memory.outbox` for publication events.

Lexical recall combines PostgreSQL `simple` FTS, substring matching, trigram similarity, aliases, and semantic vectors when configured. Graph traversal is bounded to depth two.

### Local Cold

Cold objects are stored under a stable kind/scope/topic path with immutable revision names, for example:

```text
facts/workspace/default/project.memory.architecture/rev-000001.md
preferences/workspace/default/user.communication/rev-000003.md
```

PostgreSQL is authoritative for the current published revision. Readers verify SHA-256 before returning a page. A publication writes the immutable object, stages revision metadata, switches the current pointer, and compensates by abandoning/deleting an incomplete publication when possible.

## 6. Capture path

Capture triggers include:

- each persisted user message, with bounded local conversation context used only for coreference;
- role-aware summaries of durable user statements from complete turns removed from working context;
- manual capture through the HTTP API.

Assistant final responses, TaskRun terminal wrappers, Checks, Artifacts, file metadata, and ordinary one-off operational requests are not automatic semantic-memory sources. They remain in the control-plane audit store.

Flow:

```text
source reference/content
  -> source_egress policy gate
  -> durable idempotent capture job
  -> lease/claim
  -> deterministic + optional LLM extraction
  -> schema/role/scope and long-term-value quality validation
  -> canonical topic/fingerprint deduplication and conflict handling
  -> write policy gate
  -> Hot/Warm records, topics, graph
  -> embedding_egress gate and optional vector index
  -> completed / completed_empty / retry / dead_letter
```

The extractor receives `<context>` and `<focus_user>` sections. Context is for entity and pronoun resolution; it is not permission to turn assistant claims into user identity or preference facts. Deterministic paths cover explicit identity, explicit preferences, common food preferences, homes, and neighbor relationships. Hybrid extraction adds complex negation, conditions, temporal changes, multi-sentence relations, and implicit decisions.

Capture outcomes are observable through Run events and `/api/memory/jobs`:

- `memory.capture.queued`
- `memory.capture.completed`
- `memory.capture.empty`
- `memory.capture.failed`

A natural-language assistant response such as “记住了” is not itself persistence evidence. Durable success is `persistedCount > 0`.

## 7. Lifecycle and consolidation

The in-process memory worker runs independent capture and maintenance loops so a slow Cold consolidation does not starve capture.

Maintenance performs:

- Hot-to-Warm promotion;
- duplicate merge and confidence/source reinforcement;
- explicit conflict/supersede handling;
- repeated inferred-preference promotion;
- expired Hot cleanup;
- bounded graph projection;
- eligible Warm Topic consolidation;
- staged revision cleanup and current object verification.

When hybrid extraction is configured, Cold consolidation uses the configured LLM to merge synonyms, preserve negation and conditions, distinguish Current State from History, retain disputed views, summarize episodes chronologically, and include provenance. Failure falls back to deterministic Markdown projection rather than blocking the lifecycle.

## 8. Recall and dynamic injection

Recall runs before a new Agent attempt:

```text
cue read gate
  -> canonical profile fast path when applicable
  -> lexical record search
  -> optional semantic vector search
  -> Topic Descriptor search
  -> entity resolution and depth-2 graph expansion
  -> Topic ID routing
  -> load records attached to routed topics
  -> domain filtering, minimum relevance thresholds, contradiction suppression, and deduplication
  -> exact published Cold Topic load within budget
  -> checksum and prompt-injection gate
  -> recalled_memory prompt section
```

Hot/Warm cards and complete Cold pages share one hard memory token budget. Cards are admitted in rank order; a complete Cold page is skipped rather than truncated when it cannot fit. Recall may legitimately return zero cards instead of filling Top-K with unrelated memory.

Automatic recall is complemented by Agent tools:

- `memory_search` — retry with a different cue and optional kinds;
- `memory_topic_get` — read one complete published Cold Topic by exact ID;
- `memory_forget` — guarded deletion for explicit user correction/deletion requests.

## 9. Policy and trust boundary

The default policy engine detects and redacts common private keys, bearer tokens, API keys, password assignments, database URLs, and seed phrases. It also quarantines stored prompt-injection patterns during write/read/publication/injection stages.

Policy receipts contain action, subject, scope, decision, reason codes, policy version, timestamp, and payload hash. They do not copy rejected secret bodies.

Current scope types are `user`, `workspace`, `project`, and `session`. The current Agent integration primarily derives workspace and session scopes. Formal authenticated user-to-scope membership is not yet provided, so the service remains restricted to trusted private deployment.

## 10. Web and administration

When memory is enabled, the Web workbench shows Memory Center. It provides:

- Hot/Warm/Cold and status counts;
- Fact/Preference/Episode/Procedure filtering;
- record and provenance inspection;
- Cold Topic full-page inspection;
- recall diagnostics;
- manual capture/upsert;
- capture job status and counts;
- guarded deletion/export.

When memory is disabled, the entry is hidden and memory HTTP endpoints return `503`.

## 11. Failure behavior

| Failure | Behavior |
| --- | --- |
| Embedding provider unavailable | records remain durable; recall continues through lexical/topic/graph paths |
| LLM extractor unavailable | deterministic results are used when available; otherwise the job retries/fails visibly |
| Graph query fails | recall continues without graph expansion |
| Cold object missing/checksum mismatch | page is not trusted; reconciliation/operations must repair it |
| Policy denies/quarantines | content is not persisted or injected through that stage |
| Memory disabled | no adapter/worker initialization; original TAgent Core remains available |

## 12. Current release limitations

- No built-in HTTP authentication or complete multi-tenant membership system.
- Hash embedding is for deterministic tests/development, not production semantic quality.
- Rule-only extraction intentionally misses complex implicit memories; hybrid extraction is the recommended quality profile.
- Local Cold is the tested single-service release profile. S3 has an adapter but is not the primary release gate here.
- Forget removes selected records/topics and objects; a complete tombstone/retention/approval workflow is future hardening.
- Recall ranking does not yet expose a full per-channel scoring trace, MMR feedback loop, or offline quality dashboard.

The original broader design plan is preserved in [MEMORY_DESIGN_PLAN.md](MEMORY_DESIGN_PLAN.md).
