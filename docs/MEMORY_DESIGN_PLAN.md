# TAgent Core Memory Architecture and Implementation Plan

> **Document status: original design baseline.** This document preserves the detailed architecture and implementation plan that guided the first implementation. For the release-facing description of what the code currently does, use [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md). For deployment and administration, use [MEMORY_OPERATIONS.md](MEMORY_OPERATIONS.md).

Status: Proposed

## 1. Decision summary

TAgent Core should implement long-term memory as a hexagonal/ports-and-adapters module. The agent runtime, prompt assembly, memory lifecycle, policy gates, and storage implementations must not depend on one another's concrete technology.

The proposed memory model has two independent dimensions:

- semantic kind: `fact`, `preference`, `episode`, and `procedure`;
- lifecycle tier: `hot`, `warm`, and `cold`.

The initial production deployment should use:

- PostgreSQL for durable memory metadata, capture jobs, outbox records, Hot/Warm records, entity graph, topic graph, FTS, and vector indexes through `pgvector`;
- local filesystem or S3-compatible object storage for immutable Cold Markdown topic-page revisions;
- the existing SQLite Store for TAgent's current session and TaskRun control plane during the first migration phase.

Cold Markdown bodies are not embedded and are not searched as vector chunks. Hot/Warm topic descriptors are searched to obtain stable Topic IDs; selected Cold topic pages are then loaded in full. Cold pages are bounded semantic units, not arbitrary files or token chunks.

All memory reads and writes pass through policy gates. Storage adapters are internal infrastructure and must not be exposed directly to the agent or to the memory extraction model. In particular, sensitive-data checks run before persistence, before embedding, and before content is sent to an external model.

The core retrieval rule is:

```text
input cue
  -> retrieve Hot/Warm descriptors and graph candidates
  -> resolve stable Topic IDs
  -> read complete selected Cold topic-page revisions
  -> apply read/injection gates
  -> build bounded Memory Cards and Cold sections
  -> assemble prompt
```

The core write rule is:

```text
conversation/run evidence
  -> durable capture job
  -> source egress gate
  -> structured extraction proposal
  -> deterministic validation and write gate
  -> Hot/Warm upsert or Cold publication proposal
  -> transactional metadata/outbox update
  -> asynchronous embedding/index maintenance
```

## 2. Goals and non-goals

### 2.1 Goals

1. Replace storage technology without changing memory-domain orchestration.
2. Keep facts and preferences logically and physically separable throughout capture, retrieval, ranking, and Cold publication.
3. Support Hot/Warm vector search while keeping Cold Markdown free from vector chunk retrieval.
4. Support entity/topic graph traversal without requiring a graph database in the first deployment.
5. Enforce sensitive-data, tenant-scope, retention, provenance, and prompt-injection policies on every read and write path.
6. Preserve provenance, revisions, conflict state, and deletion semantics.
7. Make background capture and consolidation durable, idempotent, retryable, and observable.
8. Allow local development with lightweight adapters and production deployment with PostgreSQL plus S3.
9. Integrate with `AgentService` and `ContextAssembler` without leaking PostgreSQL, S3, pgvector, or model-provider types into core services.

### 2.2 Non-goals for the first release

- Replacing the existing TaskRun/session SQLite Store.
- Introducing Neo4j solely to store simple entity and topic relations.
- Embedding Cold Markdown bodies or returning arbitrary Cold chunks.
- Giving an LLM direct SQL, S3, filesystem, or graph write access.
- Automatically treating every message as long-term memory.
- Claiming perfect detection of secrets or sensitive personal data.
- Providing multi-region strong transactions between PostgreSQL and object storage.

## 3. Architectural principles

### 3.1 Ports belong to the domain

Interfaces are defined by the memory application/domain layer. PostgreSQL, S3, local files, embedding providers, and policy engines implement those interfaces. An adapter must not force storage-specific concepts such as SQL rows, S3 ETags, or Cypher queries into the domain API.

### 3.2 Semantic kind and temperature are orthogonal

```ts
export type MemoryKind = "fact" | "preference" | "episode" | "procedure";
export type MemoryTier = "hot" | "warm" | "cold";
```

Examples:

- a newly extracted project decision is a `hot fact`;
- a stable user communication preference may be a `warm preference`;
- a curated project architecture page is a `cold fact`;
- a stable release workflow page is a `cold procedure`.

Code must not infer kind from tier or tier from kind.

### 3.3 Cold is canonical content, Warm is navigation

Cold stores complete, bounded Topic Pages. Warm stores cards and descriptors that help locate them. A vector result is therefore a navigation hint, not the final authority.

```text
query -> Warm descriptor -> topicId -> Cold manifest -> complete Cold page
```

### 3.4 Every durable memory is scoped and attributable

Every record includes a scope, provenance, status, and policy classification. A record without a valid scope must be rejected.

Recommended initial scope hierarchy:

```ts
export type MemoryScope =
  | { type: "user"; id: string }
  | { type: "workspace"; id: string }
  | { type: "project"; id: string; parentWorkspaceId: string }
  | { type: "session"; id: string; parentWorkspaceId: string };
```

The effective read scope is computed by application policy, never accepted directly from model output.

### 3.5 The system fails closed for confidentiality and open for optional recall

- If a write gate or scope check is unavailable, durable memory writes stop or enter quarantine.
- If an optional vector backend is unavailable, retrieval falls back to aliases, FTS, active topics, and graph links.
- If Cold storage is unavailable, the system may answer from clearly labelled Hot/Warm cards but must not claim that a Cold page was verified.
- If the read gate is unavailable, recalled memory is not injected.

## 4. Logical architecture

```text
                                +----------------------+
User input -------------------->| MemoryFacade         |
                                | application boundary |
                                +----------+-----------+
                                           |
                         +-----------------+------------------+
                         |                                    |
                         v                                    v
                +------------------+                  +------------------+
                | RecallService    |                  | CaptureService   |
                +--------+---------+                  +--------+---------+
                         |                                     |
                  [read gates]                         [source/write gates]
                         |                                     |
           +-------------+-------------+             +---------+----------+
           |             |             |             |                    |
           v             v             v             v                    v
       VectorPort     GraphPort   RecordStorePort  ExtractorPort   CaptureJobPort
           |             |             |             |                    |
           +------+------+-+-----------+             +----------+---------+
                  |        |                                     |
                  v        v                                     v
             PostgreSQL / alternative                       Consolidator
                  |                                              |
                  |                                      [write/publish gates]
                  |                                              |
                  +-------------------+--------------------------+
                                      |
                                      v
                              ColdTopicService
                                      |
                         +------------+-------------+
                         |                          |
                         v                          v
                  TopicCatalogPort             BlobStorePort
                         |                          |
                    PostgreSQL                Local FS / S3
```

Cross-cutting services:

- `MemoryPolicyEngine` for ordered gates;
- `MemoryAuditPort` for decisions and redacted evidence;
- `EmbeddingPort` for Hot/Warm embeddings only;
- `Clock`, `IdGenerator`, and `Tokenizer` ports for deterministic tests;
- metrics and tracing ports;
- `TransactionPort` or repository unit-of-work for metadata operations.

## 5. Package layout

Recommended source layout:

```text
src/memory/
├── domain/
│   ├── types.ts
│   ├── errors.ts
│   ├── topic.ts
│   ├── memory-record.ts
│   └── policy.ts
├── application/
│   ├── memory-facade.ts
│   ├── recall-service.ts
│   ├── retrieval-planner.ts
│   ├── memory-ranker.ts
│   ├── memory-card-builder.ts
│   ├── capture-service.ts
│   ├── consolidation-service.ts
│   ├── cold-topic-service.ts
│   └── deletion-service.ts
├── ports/
│   ├── record-store.ts
│   ├── vector-index.ts
│   ├── graph-store.ts
│   ├── topic-catalog.ts
│   ├── blob-store.ts
│   ├── embedding.ts
│   ├── extractor.ts
│   ├── policy-gate.ts
│   ├── job-queue.ts
│   └── audit.ts
├── adapters/
│   ├── postgres/
│   ├── sqlite/
│   ├── local-fs/
│   ├── s3/
│   ├── embedding/
│   ├── extractor/
│   └── policy/
├── workers/
│   ├── capture-worker.ts
│   ├── embedding-worker.ts
│   ├── cold-publish-worker.ts
│   └── retention-worker.ts
└── composition.ts
```

`core/agent-service.ts` may depend on `MemoryFacade`, but must not import an adapter.

## 6. Domain model

### 6.1 Common identity and provenance

```ts
export interface ProvenanceRef {
  sourceType: "message" | "run" | "transcript" | "tool_result" | "user_edit" | "import";
  sourceId: string;
  sessionId?: string;
  runId?: string;
  observedAt: number;
  evidenceHash: string;
  // Optional short, gated and redacted quotation. Never store raw secrets here.
  evidenceExcerpt?: string;
}

export type MemoryStatus =
  | "candidate"
  | "active"
  | "disputed"
  | "superseded"
  | "quarantined"
  | "deleted";

export interface MemoryRecordBase {
  id: string;
  kind: MemoryKind;
  tier: "hot" | "warm";
  scope: MemoryScope;
  topicIds: string[];
  entityIds: string[];
  status: MemoryStatus;
  confidence: number;
  importance: number;
  provenance: ProvenanceRef[];
  policyLabels: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  revision: number;
}
```

Cold pages are separate aggregates rather than records with `tier: cold`, because they have immutable body revisions and publication semantics.

### 6.2 Fact

```ts
export interface FactMemory extends MemoryRecordBase {
  kind: "fact";
  subjectEntityId: string;
  predicate: string;
  object: { type: "entity"; entityId: string } | { type: "literal"; value: unknown };
  validFrom?: number;
  validTo?: number;
  supersedesId?: string;
}
```

A conflicting fact does not silently overwrite the old row. Consolidation either marks the old fact `superseded`, creates a time-bounded revision, or marks both `disputed`.

### 6.3 Preference

```ts
export interface PreferenceMemory extends MemoryRecordBase {
  kind: "preference";
  dimension: string;
  value: unknown;
  applicability: "global" | "workspace" | "project" | "task";
  strength: number;
  origin: "explicit" | "repeated" | "inferred";
  supersedesId?: string;
}
```

Facts and preferences use separate repository methods, table constraints, vector namespaces, rankers, prompt sections, and Cold roots. This prevents a general preference such as “likes Rust” from overriding the fact that a TypeScript project must remain TypeScript.

### 6.4 Episode and procedure

Episodes retain time-oriented summaries and linked entities/topics. Procedures contain a trigger, action, constraints, priority, and origin. A one-time behavior remains an episode; it becomes a procedure candidate only after explicit instruction or repeated evidence.

### 6.5 Entity and relation graph

```ts
export interface MemoryEntity {
  id: string;
  scope: MemoryScope;
  type: "user" | "project" | "technology" | "organization" | "person" | "concept" | "other";
  canonicalName: string;
  aliases: string[];
  status: "active" | "merged" | "deleted";
  mergedIntoId?: string;
}

export interface MemoryEdge {
  id: string;
  scope: MemoryScope;
  fromEntityId: string;
  predicate: string;
  toEntityId?: string;
  literalValue?: unknown;
  topicId?: string;
  status: MemoryStatus;
  confidence: number;
  validFrom?: number;
  validTo?: number;
  provenance: ProvenanceRef[];
  revision: number;
}
```

The port supports bounded graph operations, not arbitrary backend query languages. This keeps PostgreSQL, Neo4j, Kuzu, and other adapters interchangeable.

### 6.6 Topic and Cold page

```ts
export interface TopicDescriptor {
  topicId: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  summary: string;
  aliases: string[];
  entityIds: string[];
  parentTopicId?: string;
  relatedTopicIds: string[];
  currentColdRevision?: number;
  status: "active" | "split" | "merged" | "deleted";
  embeddingState: "pending" | "ready" | "failed" | "disabled";
  revision: number;
}

export interface ColdTopicRevision {
  topicId: string;
  revision: number;
  kind: MemoryKind;
  scope: MemoryScope;
  objectKey: string;
  contentType: "text/markdown";
  checksum: string;
  byteLength: number;
  tokenCount: number;
  state: "staged" | "published" | "superseded" | "deleted";
  createdAt: number;
  createdBy: "consolidator" | "user" | "import";
  provenance: ProvenanceRef[];
  policyLabels: string[];
}
```

Topic IDs are stable logical IDs and must not be paths. Paths/object keys may change without changing references.

Example Topic IDs:

```text
project.tagent-core.memory.tier-model
project.tagent-core.memory.retrieval
user.preferences.communication
user.preferences.architecture
```

## 7. Core ports

The following interfaces are illustrative and should be refined into TypeScript schemas with runtime validation.

### 7.1 Memory facade

```ts
export interface MemoryFacade {
  recall(request: RecallRequest): Promise<RecallResult>;
  enqueueCapture(request: CaptureRequest): Promise<{ jobId: string }>;
  getColdTopic(request: GetColdTopicRequest): Promise<ColdTopicDocument>;
  forget(request: ForgetRequest): Promise<ForgetResult>;
}
```

Only this facade is injected into `AgentService`, HTTP controllers, and tools.

### 7.2 Record store

```ts
export interface MemoryRecordStorePort {
  getByIds(context: AccessContext, ids: string[]): Promise<MemoryRecordBase[]>;
  searchText(context: AccessContext, query: TextSearchQuery): Promise<MemoryCandidate[]>;
  listByTopic(context: AccessContext, topicIds: string[], kinds?: MemoryKind[]): Promise<MemoryRecordBase[]>;
  upsertFacts(context: WriteContext, operations: FactWriteOperation[]): Promise<WriteReceipt[]>;
  upsertPreferences(context: WriteContext, operations: PreferenceWriteOperation[]): Promise<WriteReceipt[]>;
  appendEpisodes(context: WriteContext, operations: EpisodeWriteOperation[]): Promise<WriteReceipt[]>;
  upsertProcedures(context: WriteContext, operations: ProcedureWriteOperation[]): Promise<WriteReceipt[]>;
  tombstone(context: WriteContext, ids: string[], reason: string): Promise<void>;
}
```

The interface intentionally has kind-specific mutations rather than a generic `put(any)`.

### 7.3 Vector index

```ts
export interface VectorIndexPort {
  query(context: AccessContext, query: VectorQuery): Promise<VectorCandidate[]>;
  upsert(context: WriteContext, records: VectorRecord[]): Promise<void>;
  remove(context: WriteContext, refs: VectorRef[]): Promise<void>;
  capabilities(): { dimensions?: number; namespaces: boolean; filters: string[] };
}
```

Rules:

- only Hot/Warm cards and Topic Descriptors are accepted;
- the adapter rejects `contentClass: "cold_body"`;
- namespace includes memory kind and effective tenant/scope;
- metadata filters are mandatory, not optional post-filtering;
- embedding text must already have passed egress and sensitive-data gates.

Possible adapters: PostgreSQL/pgvector, Qdrant, Milvus, OpenSearch, or a test in-memory adapter.

### 7.4 Graph store

```ts
export interface GraphStorePort {
  resolveEntities(context: AccessContext, names: string[]): Promise<EntityMatch[]>;
  getNeighborhood(context: AccessContext, query: NeighborhoodQuery): Promise<GraphNeighborhood>;
  findPaths(context: AccessContext, query: PathQuery): Promise<GraphPath[]>;
  upsertEntities(context: WriteContext, entities: EntityMutation[]): Promise<MemoryEntity[]>;
  applyEdges(context: WriteContext, edges: EdgeMutation[]): Promise<MemoryEdge[]>;
  mergeEntities(context: WriteContext, sourceId: string, targetId: string): Promise<void>;
}
```

All traversals require maximum depth and result limits. The first implementation should cap depth at 2 for online recall.

Possible adapters: PostgreSQL adjacency tables, Neo4j, Kuzu, or an in-memory test adapter.

### 7.5 Topic catalog and blob storage

```ts
export interface TopicCatalogPort {
  resolve(context: AccessContext, cue: TopicCue): Promise<TopicMatch[]>;
  getDescriptors(context: AccessContext, topicIds: string[]): Promise<TopicDescriptor[]>;
  getCurrentRevisions(context: AccessContext, topicIds: string[]): Promise<ColdTopicRevision[]>;
  stageRevision(context: WriteContext, revision: ColdTopicRevision): Promise<void>;
  publishRevision(context: WriteContext, topicId: string, revision: number): Promise<void>;
  markRevisionDeleted(context: WriteContext, topicId: string, revision: number): Promise<void>;
}

export interface BlobStorePort {
  putImmutable(input: PutBlobInput): Promise<{ objectKey: string; checksum: string; versionId?: string }>;
  get(input: GetBlobInput): Promise<{ body: string; checksum: string; versionId?: string }>;
  exists(input: BlobIdentity): Promise<boolean>;
  delete(input: DeleteBlobInput): Promise<void>;
}
```

`BlobStorePort` has no list-and-guess retrieval API in the online path. Cold reads always use a catalog-approved object identity.

Local adapter requirements:

- path containment under a configured Cold root;
- write temporary file, fsync as appropriate, then atomic rename;
- immutable revision paths;
- no symbolic-link traversal.

S3 adapter requirements:

- bucket and prefix fixed by configuration;
- server-side encryption enabled;
- private ACL/block-public-access;
- checksum verification;
- object versioning recommended;
- conditional writes where supported;
- short timeouts and bounded retries;
- never return public URLs; use server-side SDK access.

### 7.6 Policy gates

```ts
export type GateStage =
  | "capture_source"
  | "model_egress"
  | "write_candidate"
  | "embedding_egress"
  | "cold_publish"
  | "read_candidate"
  | "prompt_injection"
  | "export"
  | "delete";

export interface PolicyGatePort {
  evaluate(input: GateInput): Promise<GateDecision>;
}

export type GateDecision =
  | { action: "allow"; labels: string[]; obligations?: PolicyObligation[] }
  | { action: "transform"; transformed: GatePayload; labels: string[]; obligations?: PolicyObligation[] }
  | { action: "quarantine"; reasonCodes: string[]; labels: string[] }
  | { action: "deny"; reasonCodes: string[]; labels: string[] }
  | { action: "require_approval"; reasonCodes: string[]; approvalClass: string };
```

The policy engine composes ordered gates. A storage adapter never decides whether content is safe; it only enforces structural invariants and the policy receipt supplied by the application service.

## 8. Gate design

### 8.1 Required write pipeline

Every candidate follows this order:

1. **Admission and scope gate** — derive tenant/user/workspace/project from authenticated server context; reject model-supplied scope escalation.
2. **Source classification gate** — decide whether the source may be processed at all. Tool outputs and files may have stricter rules than user chat.
3. **Model egress gate** — redact or block secrets/PII before sending content to an extraction or embedding provider.
4. **Salience gate** — reject low-value content and transient chatter.
5. **Schema gate** — runtime-validate extraction operations; reject unknown predicates, oversized fields, invalid confidence, and arbitrary instructions.
6. **Sensitive-data write gate** — scan structured values and evidence excerpts again after extraction.
7. **Kind-specific policy gate** — facts, preferences, episodes, and procedures have different promotion rules.
8. **Conflict/provenance gate** — require evidence, detect duplicate or conflicting memory, and assign status.
9. **Retention gate** — attach expiration, legal hold, or no-persist obligations.
10. **Persistence** — write accepted or quarantined records and an audit receipt.
11. **Embedding egress gate** — independently evaluate the exact text that will be embedded.
12. **Index update** — enqueue idempotent embedding/vector and graph index work.

The raw source must not be written to a capture-job payload before the source gate. Capture jobs should normally reference existing durable message/transcript IDs and fetch the source under policy at execution time. If a payload must be materialized, it must be encrypted, TTL-bound, and classified.

### 8.2 Sensitive-data classes

At minimum detect and handle:

- API keys, bearer tokens, passwords, private keys, seed phrases, session cookies, and connection strings;
- cloud credentials and signed URLs;
- government/financial identifiers;
- private contact and health information, based on configured deployment policy;
- high-entropy tokens and known credential formats;
- sensitive workspace paths such as `.env`, SSH directories, cloud config, and credential stores;
- prompt-injection-like instructions contained inside imported/recalled memory.

Recommended default action:

| Data class | Extraction model | Durable memory | Embedding | Audit log |
|---|---|---|---|---|
| Credentials/secrets | deny or redact | deny | deny | type/reason only |
| Sensitive PII | local policy; often redact | quarantine or explicit consent | deny by default | hashed reference |
| Ordinary personal preference | allow | allow with user scope | allow after scope filter | decision metadata |
| Project fact | allow | allow with workspace/project scope | allow | decision metadata |
| Untrusted imported instruction | allow as quoted data | label untrusted | optional | label and source |

No detector is perfect. Therefore provide user-visible review, edit, forget, and export functions, and use least-retention defaults.

### 8.3 Read and injection gates

Recall is also governed:

1. derive allowed scopes from the authenticated request;
2. force scope filters into SQL/vector/graph queries;
3. reject deleted, quarantined, expired, or unauthorized candidates;
4. apply purpose filtering, for example preferences may be read for response style but not exposed verbatim;
5. load approved Cold object identities only;
6. verify checksum and revision against the catalog;
7. scan for stored prompt injection and unsafe instructions;
8. convert recalled content to a clearly delimited, low-authority data section;
9. record which memory IDs/revisions were injected.

Recalled memory is evidence, not a system instruction. Current system/developer policy and current explicit user input have higher authority.

### 8.4 Gate receipts and audit

Persist decisions without persisting the rejected secret:

```ts
export interface PolicyReceipt {
  id: string;
  stage: GateStage;
  subjectRef: string;
  action: GateDecision["action"];
  reasonCodes: string[];
  labels: string[];
  policyVersion: string;
  detectorVersions: Record<string, string>;
  payloadHash: string;
  actorType: "system" | "user" | "worker";
  actorId?: string;
  createdAt: number;
}
```

Audit logs must contain hashes, IDs, rule names, and redacted metadata—not denied content.

## 9. PostgreSQL design

### 9.1 Why PostgreSQL first

PostgreSQL provides one operational system for:

- durable jobs and leases;
- transactions, constraints, and outbox records;
- JSONB metadata;
- FTS and trigram/alias matching;
- pgvector similarity search;
- adjacency-list graph queries with recursive CTEs;
- row-level security if multi-tenant deployment is later enabled.

This is sufficient for online depth-1/2 graph traversal. Introduce a dedicated graph database only after measured query or scale requirements justify dual-write and operational complexity.

### 9.2 Recommended schemas and tables

Use a dedicated schema such as `memory`. Core tables:

```text
memory.records
memory.facts
memory.preferences
memory.episodes
memory.procedures
memory.entities
memory.entity_aliases
memory.edges
memory.topics
memory.topic_links
memory.cold_revisions
memory.embeddings
memory.capture_jobs
memory.outbox
memory.policy_receipts
memory.access_log
memory.tombstones
```

Common columns should include:

```text
id UUID primary key
owner_type / owner_id
workspace_id / project_id where applicable
kind / tier / status
revision bigint
created_at / updated_at / expires_at
topic_ids / entity_ids or normalized link tables
provenance jsonb
policy_labels text[]
```

Facts and preferences should be separate extension tables with check constraints. Do not place both into one unvalidated JSONB payload.

### 9.3 Vector table

Illustrative structure:

```sql
CREATE TABLE memory.embeddings (
  ref_type text NOT NULL CHECK (ref_type IN ('hot_record','warm_record','topic_descriptor')),
  ref_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact','preference','episode','procedure')),
  owner_type text NOT NULL,
  owner_id text NOT NULL,
  model_id text NOT NULL,
  dimensions integer NOT NULL,
  content_hash text NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (ref_type, ref_id, model_id)
);
```

The actual vector dimension is deployment-specific. A model change should create a new `model_id` index generation; do not mix incompatible dimensions. Blue/green re-embedding can populate a new generation and atomically switch active configuration.

Indexes should combine mandatory scope/kind filters with HNSW or IVFFlat as appropriate. Benchmark both recall and write cost before choosing.

Cold bodies must be structurally impossible to insert: `ref_type` excludes them, and the application adapter validates content class.

### 9.4 Graph tables

```text
entities(id, owner/scope, type, canonical_name, normalized_name, status, merged_into_id, ...)
entity_aliases(entity_id, normalized_alias, locale, ...)
edges(id, owner/scope, from_entity_id, predicate, to_entity_id, literal_value,
      topic_id, status, confidence, valid_from, valid_to, provenance, revision, ...)
topics(topic_id, owner/scope, kind, title, summary, aliases, current_cold_revision, ...)
topic_links(from_topic_id, relation, to_topic_id, ...)
```

Use unique normalized alias constraints within a scope where safe, and explicit merge operations for entity deduplication. Query methods enforce bounded depth and row limits.

### 9.5 Jobs and outbox

`capture_jobs` should support:

- states `queued`, `running`, `completed`, `retryable_failed`, `dead_letter`, `cancelled`;
- idempotency key derived from source type, source ID, source revision, extractor version, and policy version;
- lease owner, lease expiry, heartbeat, attempts, and next-attempt time;
- source references rather than raw source content;
- terminal error class and redacted message.

`outbox` records drive embedding, graph projection, Cold publication follow-up, cache invalidation, and deletion propagation. Workers claim with `FOR UPDATE SKIP LOCKED`. Consumers are idempotent by event ID and target generation.

## 10. Cold Markdown storage

### 10.1 Layout

Logical organization remains by kind and topic, but object identity is revisioned:

```text
cold/
  facts/projects/tagent-core/memory/tier-model/rev-000004.md
  preferences/users/<opaque-user-id>/communication/rev-000002.md
  episodes/projects/tagent-core/timeline/rev-000010.md
  procedures/workspaces/<opaque-workspace-id>/code-change/rev-000003.md
```

Object keys must use opaque or sanitized identifiers and must not expose email addresses or raw private names.

### 10.2 Page format

```markdown
---
topic_id: project.tagent-core.memory.tier-model
kind: fact
revision: 4
scope_type: project
scope_id: <opaque-id>
updated_at: 2026-07-31T00:00:00Z
checksum: <sha256>
---

# TAgent Core Memory Tier Model

## Current decision

...

## Constraints

...

## Superseded decisions

...

## Related topics

...
```

The database catalog is authoritative for object key, current revision, checksum, state, and access scope. Front matter is a consistency aid, not authorization metadata.

### 10.3 Size and splitting policy

- target: 1,000–4,000 tokens;
- soft limit: 6,000 tokens;
- hard limit: 8,000 tokens unless explicitly approved;
- split by semantic subtopic, never fixed-size chunks;
- retain parent Topic ID as an index topic after splitting;
- read a complete selected page; if a parent is selected, load its bounded index page and route to complete child pages.

### 10.4 Publication protocol across PostgreSQL and object storage

There is no distributed transaction. Use immutable objects plus a staged catalog state:

1. Consolidator creates a proposed page and runs `cold_publish` policy.
2. Allocate `(topicId, revision)` in PostgreSQL as `staged` with expected checksum.
3. Write immutable object to a revision-specific key using conditional create.
4. Read/HEAD and verify checksum and length.
5. In one PostgreSQL transaction:
   - mark revision `published`;
   - set `topics.current_cold_revision` to the new revision;
   - mark prior revision `superseded`;
   - insert outbox events for descriptor refresh and audit.
6. A reconciler repairs or removes stale staged records and orphan objects after a safety interval.

Readers only follow `current_cold_revision` with state `published`, so partially published content is invisible.

For local files, the adapter uses temporary files and atomic rename; it still follows the same catalog protocol for parity with S3.

## 11. Retrieval and dynamic injection

### 11.1 Retrieval request

```ts
export interface RecallRequest {
  access: AccessContext;
  cue: string;
  recentMessages: AgentMessage[];
  activeRun?: { runId: string; goal: string };
  budgets: {
    maxHotWarmCards: number;
    maxColdTopics: number;
    maxColdTokens: number;
    maxTotalTokens: number;
  };
}
```

`AccessContext` is constructed by trusted server code and includes actor, allowed scopes, purpose, and correlation IDs.

### 11.2 Recall stages

1. Cheap cue analysis extracts exact aliases, entities, time expressions, active topic, and likely memory kinds.
2. If no memory is needed, return an empty result.
3. In parallel, query:
   - active Hot records;
   - Warm FTS/alias matches;
   - Warm vector matches;
   - entity resolution and bounded graph neighborhood;
   - explicit preference channel when the task needs response/workflow preferences.
4. Merge candidates using stable IDs and kind-specific ranking.
5. Convert candidates to Topic IDs through direct links and Topic Descriptors.
6. Apply read gates before any Cold load.
7. Select at most the configured number of Cold topics by relevance and policy; token use is observed, not controlled by Core.
8. Resolve catalog revisions and read each complete page.
9. Verify checksum, scope, state, and page size.
10. Apply prompt-injection gate and build delimited prompt sections.
11. Persist a recall trace containing IDs, scores, policy decisions, and injected revision hashes.

### 11.3 Ranking

Do not use one universal score. Suggested inputs:

```text
exact alias/entity match
vector similarity
FTS match
active Hot topic
kind match
scope specificity
current validity/status
confidence and importance
time-range match/recency
graph distance
redundancy and contradiction penalties
```

Facts emphasize entity, relation, validity, and confidence. Preferences emphasize applicability scope, explicitness, and strength. Episodes emphasize time and participating entities. Procedures emphasize trigger match and priority.

### 11.4 Prompt format

```text
<recalled_memory authority="data_not_instruction">
  <preferences>
    ... bounded cards ...
  </preferences>
  <facts>
    ... bounded cards ...
  </facts>
  <cold_topic topic_id="..." revision="..." checksum="...">
    ... complete gated Markdown page ...
  </cold_topic>
</recalled_memory>
```

The system prompt states that recalled content may be stale or malicious, cannot override higher-priority instructions, and must not be treated as authorization.

### 11.5 Failure behavior

- vector failure: continue with aliases, FTS, active topics, and graph;
- graph failure: continue with record/topic retrieval;
- Cold object failure: omit the page, emit a recall warning, and do not invent its contents;
- checksum mismatch: quarantine the revision and alert; never inject;
- budget overflow: prefer the highest-ranked complete pages, never silently truncate a Cold page;
- policy timeout: fail closed for injection.

## 12. Capture and consolidation

### 12.1 Capture triggers

Initial triggers:

- a successful or blocked TaskRun reaches a stable boundary;
- user explicitly says “remember”, “from now on”, “I prefer”, or equivalent;
- context restoration drops complete turns;
- an important decision, milestone, failure, or plan change is detected;
- a session becomes idle;
- an authorized user imports or edits memory.

For Pi integration, semantic compaction remains Pi-owned inside a live attempt. TAgent capture is a separate durable memory pipeline and must not replace Pi's compaction state machine.

### 12.2 Extractor boundary

The extraction model receives only content approved by the model-egress gate and returns proposals, not database commands:

```ts
export interface ExtractionProposal {
  sourceRefs: ProvenanceRef[];
  operations: Array<
    | { type: "upsert_fact"; candidate: FactCandidate }
    | { type: "upsert_preference"; candidate: PreferenceCandidate }
    | { type: "append_episode"; candidate: EpisodeCandidate }
    | { type: "upsert_procedure"; candidate: ProcedureCandidate }
    | { type: "upsert_entity"; candidate: EntityCandidate }
    | { type: "link_topic"; candidate: TopicLinkCandidate }
    | { type: "no_memory"; reason: string }
  >;
  extractorVersion: string;
}
```

Runtime schemas validate every field. Predicates and operation types use an allowlist or governed registry. The extractor cannot choose owner IDs, bypass status transitions, publish Cold pages, or delete memory.

### 12.3 Promotion rules

Hot to Warm:

- explicit user memory requests can become active after policy validation;
- inferred preferences remain candidates until repeated or confirmed;
- duplicate facts increase evidence/confidence instead of multiplying rows;
- conflicts become disputed/superseding revisions;
- transient details receive TTL or are ignored.

Warm to Cold:

- stable and valuable information forms a coherent Topic Page;
- Cold publication may be triggered by explicit user action, topic-card threshold, TaskRun decision, or scheduled consolidation;
- facts and preferences are consolidated into separate pages;
- the consolidator updates the relevant section rather than append-only dumping;
- previous decisions move to a `Superseded` section where useful;
- user edits have higher authority and are not overwritten without conflict handling.

Cold is “stable canonical topic memory,” not merely “old memory.”

### 12.4 Embedding lifecycle

1. Accepted Hot/Warm record or Topic Descriptor writes an outbox event.
2. Embedding worker reads the current revision.
3. Exact embedding text passes `embedding_egress` policy.
4. Worker computes embedding with configured model and content hash.
5. Vector adapter upserts `(ref, modelId, contentHash)` idempotently.
6. Record embedding state becomes ready or failed.
7. Failed embeddings retry with bounded backoff and dead-letter visibility.

Cold body updates only refresh the Warm Topic Descriptor embedding; the Cold body itself is never embedded.

## 13. Deletion, retention, and user control

A usable memory system needs first-class forgetting:

- tombstone database records immediately so reads stop;
- remove vector records and graph projections through outbox jobs;
- remove or cryptographically retire Cold object revisions according to retention policy;
- update Topic Descriptors and current revision pointers;
- retain only the minimum deletion/audit marker allowed by policy;
- support deletion by memory ID, topic, source, user scope, workspace scope, or time range;
- support export and inspection showing source, confidence, status, and current scope;
- allow users to correct preferences and facts; corrections create revisions and supersede old values.

S3 versioning complicates physical erasure. Deployment policy must choose between recoverability and strict deletion. If strict erasure is required, use lifecycle rules, deletion of all object versions, or per-tenant envelope encryption whose key can be destroyed.

## 14. Adapter composition and configuration

### 14.1 Composition root

Only `src/memory/composition.ts` and `server.ts` know concrete adapters:

```ts
const memory = createMemoryModule({
  recordStore: createPostgresRecordStore(pg),
  vectorIndex: createPgVectorIndex(pg, embeddingConfig),
  graphStore: createPostgresGraphStore(pg),
  topicCatalog: createPostgresTopicCatalog(pg),
  blobStore: config.coldStore.kind === "s3"
    ? createS3BlobStore(config.coldStore)
    : createLocalBlobStore(config.coldStore),
  policy: createCompositePolicyEngine(policyConfig),
  embedding: createEmbeddingAdapter(embeddingConfig),
  extractor: createStructuredExtractor(extractorConfig),
  audit: createPostgresMemoryAudit(pg),
});
```

`AgentService` receives `MemoryFacade | undefined`; memory can be disabled without changing runtime behavior.

### 14.2 Suggested configuration

```text
TAGENT_MEMORY_ENABLED=false
TAGENT_MEMORY_METADATA_DRIVER=postgres
TAGENT_MEMORY_DATABASE_URL=postgres://...
TAGENT_MEMORY_VECTOR_DRIVER=pgvector
TAGENT_MEMORY_GRAPH_DRIVER=postgres
TAGENT_MEMORY_COLD_DRIVER=local|s3
TAGENT_MEMORY_COLD_LOCAL_ROOT=./data/memory/cold
TAGENT_MEMORY_S3_BUCKET=
TAGENT_MEMORY_S3_PREFIX=cold/
TAGENT_MEMORY_S3_REGION=
TAGENT_MEMORY_S3_ENDPOINT=
TAGENT_MEMORY_S3_KMS_KEY_ID=
TAGENT_MEMORY_EMBEDDING_PROVIDER=
TAGENT_MEMORY_EMBEDDING_MODEL=
TAGENT_MEMORY_EMBEDDING_DIMENSIONS=
TAGENT_MEMORY_POLICY_FILE=./config/memory-policy.yaml
TAGENT_MEMORY_MAX_COLD_TOPICS=3
TAGENT_MEMORY_MAX_COLD_TOKENS=10000
TAGENT_MEMORY_MAX_CARDS=8
```

Secrets come from the process secret manager/environment and must not appear in public runtime configuration, events, memory audit payloads, or model prompts.

### 14.3 Capability negotiation

Adapters expose capabilities at startup. The composition root validates required combinations:

- vector adapter dimensions match embedding adapter output;
- graph adapter supports required depth/filters;
- blob adapter supports immutable write and checksum;
- production policy engine is configured;
- Cold reads are disabled if catalog/blob consistency checks are unavailable.

Fail startup for incompatible required capabilities instead of discovering them during a user request.

## 15. Integration with current TAgent Core

### 15.1 Read path in AgentService

For a new Run:

1. load and budget recent Session messages with the existing `ContextAssembler`;
2. call `memory.recall()` with the current user cue, active TaskRun, and trusted access context;
3. record estimated memory token use for observability without enforcing a Core budget;
4. append a generated recalled-memory section to the system/prompt assembly;
5. persist `memory.recall.completed` with counts and reference hashes, not bodies;
6. start the Pi runtime.

`ContextAssembler` should evolve from returning only kept messages to also reporting dropped source message IDs/turns. Those IDs can create capture jobs without copying raw text into event payloads.

### 15.2 Write path

At stable boundaries, `AgentService` or a domain event consumer enqueues capture by reference:

```text
run/session event
  -> memory capture admission
  -> durable PostgreSQL job
  -> independent worker
```

The user-facing response does not wait for extraction or embedding. Explicit “remember this” actions may return an accepted/pending receipt and later expose success, quarantine, or denial.

### 15.3 Tools and API

Initial internal tools:

- `memory_search`: returns gated cards and Topic references;
- `memory_get`: reads an approved complete Cold Topic Page by Topic ID;
- `memory_forget`: requires explicit user intent/approval and returns a durable receipt;
- `memory_inspect`: shows metadata and provenance without exposing unauthorized content.

Tools call `MemoryFacade`; they never receive raw ports.

Suggested administrative/user API:

```text
GET    /api/memory/search
GET    /api/memory/topics/:topicId
GET    /api/memory/records/:id
POST   /api/memory/capture
PATCH  /api/memory/records/:id
DELETE /api/memory/records/:id
DELETE /api/memory/topics/:topicId
GET    /api/memory/jobs/:id
GET    /api/memory/audit
```

These endpoints require authentication and authorization before multi-user use. The current alpha has no API authentication, so memory APIs must not be publicly enabled until that boundary exists.

### 15.4 Events and observability

Runtime-neutral events:

```text
memory.recall.started/completed/degraded/denied
memory.capture.queued/completed/quarantined/failed
memory.embedding.completed/failed
memory.cold.staged/published/reconciled/failed
memory.deleted
memory.policy.denied/approval_required
```

Never include Cold bodies, source text, embeddings, or rejected sensitive values in events.

## 16. Security model

### 16.1 Threats addressed

- accidental credential/PII persistence;
- embedding-provider exfiltration;
- cross-user/workspace recall;
- persistent prompt injection in imported or remembered text;
- direct model writes to storage;
- path traversal and public S3 exposure;
- stale or partially published Cold content;
- deletion that leaves vector/graph copies behind;
- audit logs becoming a secret copy.

### 16.2 Required controls before production

1. Authenticated identity and server-derived access context.
2. Scope constraints in every PostgreSQL query and vector/graph operation.
3. TLS to PostgreSQL/S3/providers and encryption at rest.
4. Separate least-privilege database roles for API and workers where practical.
5. S3 block-public-access, encryption, and restricted bucket/prefix IAM.
6. Policy versioning and regression tests with secret/PII fixtures.
7. No raw memory bodies in logs, traces, errors, or analytics.
8. Prompt delimiting and low-authority memory instructions.
9. Rate limits and maximum payload/page/graph-depth limits.
10. Backup, restore, deletion, and staged-publication reconciliation procedures.

## 17. Consistency and reliability model

- PostgreSQL metadata is strongly consistent within one database transaction.
- Vector and graph projections are eventually consistent through the outbox.
- Cold publication is read-atomic through immutable objects and a PostgreSQL current-revision pointer.
- A recall result records exact record revisions and Cold checksums used.
- Workers are at-least-once; all operations must be idempotent.
- Deletes are immediately enforced by authoritative metadata, even if physical vector/object cleanup is pending.
- Cache keys include scope, policy version, record revision, and Cold checksum.
- Adapter timeouts, retries, and circuit breakers are bounded and observable.

Do not dual-write PostgreSQL and S3 from request code without a staged protocol. Do not make the vector index authoritative for existence or authorization.

## 18. Testing strategy

### 18.1 Contract tests for adapters

Run the same port contract suite against every adapter:

- record CRUD, revision fences, tombstones, and scope isolation;
- vector namespace/filter enforcement and Cold-body rejection;
- graph bounded traversal, merge, validity, and scope isolation;
- blob immutability, checksum, containment, missing objects, and conditional writes;
- topic staged/published transitions;
- job leases, retries, and idempotency;
- policy allow/transform/quarantine/deny behavior.

Use Testcontainers for PostgreSQL/pgvector and an S3-compatible service such as MinIO in integration tests. Keep in-memory/local adapters for fast unit tests, not as evidence of PostgreSQL/S3 correctness.

### 18.2 Security tests

- known and synthetic API keys, JWTs, private keys, passwords, and connection strings never reach persistence or embedding mocks;
- cross-scope IDs cannot be retrieved even with high vector similarity;
- recalled prompt injection remains quoted low-authority data;
- denied payloads are absent from logs and receipts;
- path traversal and symlink attempts fail in local Cold adapter;
- S3 adapter never produces public access;
- deletion blocks recall before asynchronous cleanup completes.

### 18.3 Retrieval quality tests

Build a versioned evaluation corpus covering:

- exact entity/topic lookup;
- aliases and Chinese/English mixed cues;
- facts versus preferences;
- time-bound episodes;
- conflicting/superseded facts;
- vague cues requiring graph expansion;
- vector backend unavailable;
- Cold page completeness and token limits;
- irrelevant-memory injection rate.

Measure Topic recall, correct Cold-page selection, scope safety, contradiction rate, injected tokens, latency, and fallback behavior—not only vector similarity.

### 18.4 Failure and recovery tests

- worker dies after claim and lease expires;
- embedding succeeds but receipt write fails;
- object write succeeds before catalog publish;
- catalog staging succeeds but object write fails;
- checksum mismatch;
- PostgreSQL unavailable;
- S3 unavailable;
- policy engine timeout;
- deletion races with recall;
- embedding-model generation switch.

## 19. Implementation phases

### Phase 0 — decisions and prerequisites

Deliverables:

- stable domain types, scope hierarchy, and policy taxonomy;
- decide authenticated user/workspace identity source;
- choose embedding provider and data-processing policy;
- choose local-only development and PostgreSQL/S3 production profiles;
- threat model and acceptance corpus.

Exit criteria:

- no unresolved source of trusted scope;
- policy for credentials and sensitive PII is approved;
- vector dimension/model migration strategy is defined.

### Phase 1 — module skeleton and local vertical slice

Implement:

- domain types and runtime schemas;
- all ports;
- in-memory record/vector/graph/job adapters for tests;
- local filesystem Cold adapter;
- composite policy engine with deterministic secret detection;
- `MemoryFacade`, recall trace, and prompt section builder;
- facts and preferences separated end to end;
- no automatic capture yet.

Exit criteria:

- adapter contract tests pass;
- Cold-body insertion into vector port is rejected;
- a cue resolves a Warm Topic Descriptor and loads one complete local Cold page;
- denied secrets never reach mock stores or embedding adapter.

### Phase 2 — PostgreSQL, pgvector, and durable workers

Implement:

- migrations for memory schema;
- PostgreSQL record, topic, graph, audit, job, and outbox adapters;
- pgvector adapter and embedding generation tracking;
- capture/embedding workers with leases and idempotency;
- PostgreSQL FTS and alias resolution;
- operational metrics and dead-letter inspection.

Exit criteria:

- Testcontainers contract/integration suite passes;
- restart recovery and at-least-once processing tests pass;
- vector outage fallback still recalls exact/FTS topics;
- depth-2 graph queries meet initial latency budget.

### Phase 3 — AgentService read integration

Implement:

- inject optional `MemoryFacade` into `AgentService`;
- trusted `AccessContext` factory;
- observed memory token usage in prompt assembly;
- recall before runtime launch;
- recall events and provenance trace;
- `memory_search` and `memory_get` tools.

Exit criteria:

- memory can be disabled with current behavior unchanged;
- enabled runs retrieve no unauthorized scopes;
- selected Cold pages are complete and within configured total budget;
- Pi compaction/runtime boundary remains unchanged.

### Phase 4 — capture and consolidation

Implement:

- capture triggers by durable source references;
- gated structured extractor;
- conflict, deduplication, preference-promotion, and entity-resolution logic;
- Hot to Warm transitions;
- Cold consolidation proposal and revision publication;
- user approval/quarantine flow for sensitive or uncertain writes.

Exit criteria:

- no model output writes directly to adapters;
- duplicate jobs are idempotent;
- conflicting facts preserve history;
- inferred one-off preferences do not become active global preferences;
- Cold publication survives all staged failure tests.

### Phase 5 — S3 and production hardening

Implement:

- S3-compatible blob adapter;
- encryption, versioning/lifecycle configuration, and checksum reconciliation;
- deletion/export/edit APIs and UI;
- backup/restore and orphan reconciliation;
- authentication/authorization prerequisite for memory APIs;
- policy and retrieval evaluation dashboards.

Exit criteria:

- local and S3 adapters pass the same contract suite;
- strict deletion behavior is documented and tested;
- security review and retrieval evaluation thresholds pass;
- production runbook is complete.

### Phase 6 — optional backend alternatives

Only after metrics justify them:

- Qdrant/Milvus vector adapter;
- Neo4j/Kuzu graph adapter;
- alternate object storage;
- local/private embedding or extraction model.

No application-service changes should be required beyond composition and capability configuration.

## 20. Initial acceptance criteria

The first usable release should demonstrate all of the following:

1. User cue retrieves Hot/Warm candidates by exact, FTS, and vector paths.
2. A Warm Topic Descriptor routes to a stable Topic ID.
3. Cold Markdown body has no embedding and is loaded as one complete bounded page.
4. Facts and preferences have separate schemas, search channels, ranking, and prompt sections.
5. PostgreSQL adjacency graph resolves an entity and traverses at most two hops.
6. Secret fixtures are denied before extractor persistence and before embedding.
7. Every read and write has a policy receipt or trace reference.
8. Scope filters prevent cross-user/workspace retrieval at query time.
9. Capture jobs survive process restart and process at least once without duplicate memory.
10. PostgreSQL/S3 partial publication cannot expose an incomplete Cold revision.
11. Vector, graph, or S3 failure produces defined degraded behavior.
12. Forgetting immediately removes logical visibility and eventually removes projections/blobs.
13. Current tagent-core behavior remains available with memory disabled.

## 21. Recommended first deployment

For the current repository, use this pragmatic topology:

```text
TAgent Core API process
  - existing SQLite TaskRun/session Store
  - MemoryFacade and read orchestration
  - no long-running memory work in request handlers

Memory worker process (same codebase, separate command)
  - capture/consolidation
  - embedding and outbox projection
  - retention and reconciliation

PostgreSQL 16+
  - memory schema
  - pgvector extension
  - records, topics, graph, jobs, audit, FTS, vectors

Cold store
  - local filesystem in development
  - private versioned S3-compatible bucket in production
```

This avoids prematurely migrating the proven TaskRun control-plane Store while ensuring the new memory subsystem is already backend-neutral. A later `ControlStorePort` migration can move TaskRun persistence independently; it should not be coupled to memory delivery.

## 22. Final design constraints

The implementation should treat these as invariants:

- No memory adapter is imported by `AgentService`.
- No LLM can call a storage adapter directly.
- No model-generated scope or owner identity is trusted.
- No Cold body is embedded or vector-searched.
- No denied sensitive value is copied into jobs, audit logs, events, embeddings, or error messages.
- No vector or graph projection is authoritative for authorization or deletion state.
- No Cold revision is readable until its object checksum is verified and catalog state is published.
- No Cold page is truncated during injection; select fewer complete pages instead.
- No fact/preference conflict is resolved by silently overwriting provenance.
- No optional backend failure may bypass read/write gates.

With these boundaries, PostgreSQL/pgvector can be the first vector and graph implementation, and local filesystem/S3 can be interchangeable Cold stores, without coupling TAgent's memory behavior to either technology.
