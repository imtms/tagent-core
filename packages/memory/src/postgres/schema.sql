CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS memory;
CREATE TABLE IF NOT EXISTS memory.records (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('fact','episode','procedure')), tier text NOT NULL CHECK(tier IN ('hot','warm')),
 scope_type text NOT NULL, scope_id text NOT NULL, title text NOT NULL, content text NOT NULL, summary text NOT NULL,
 topic_ids text[] NOT NULL DEFAULT '{}', entity_ids text[] NOT NULL DEFAULT '{}', status text NOT NULL, confidence real NOT NULL,
 importance real NOT NULL, source_refs jsonb NOT NULL, provenance jsonb, valid_from bigint, valid_to bigint, supersedes_id uuid, expires_at bigint,
 created_at bigint NOT NULL, updated_at bigint NOT NULL, semantic jsonb, lifecycle jsonb, search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,''))) STORED
);
ALTER TABLE memory.records ADD COLUMN IF NOT EXISTS provenance jsonb;
CREATE INDEX IF NOT EXISTS memory_records_scope ON memory.records(scope_type,scope_id,status);
CREATE INDEX IF NOT EXISTS memory_records_topics ON memory.records USING gin(topic_ids);
CREATE INDEX IF NOT EXISTS memory_records_fts ON memory.records USING gin(search_document);
CREATE INDEX IF NOT EXISTS memory_records_trgm ON memory.records USING gin ((coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,'')) gin_trgm_ops);
CREATE TABLE IF NOT EXISTS memory.preferences (
 id uuid PRIMARY KEY, tier text NOT NULL CHECK(tier IN ('hot','warm')), scope_type text NOT NULL, scope_id text NOT NULL,
 dimension text NOT NULL, value text NOT NULL, summary text NOT NULL, topic_ids text[] NOT NULL DEFAULT '{}', entity_ids text[] NOT NULL DEFAULT '{}',
 applicability text NOT NULL, strength real NOT NULL, origin text NOT NULL, status text NOT NULL, confidence real NOT NULL,
 source_refs jsonb NOT NULL, provenance jsonb, supersedes_id uuid, expires_at bigint, created_at bigint NOT NULL, updated_at bigint NOT NULL, semantic jsonb, lifecycle jsonb,
 search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(dimension,'')||' '||coalesce(value,'')||' '||coalesce(summary,''))) STORED
);
ALTER TABLE memory.preferences ADD COLUMN IF NOT EXISTS provenance jsonb;
CREATE INDEX IF NOT EXISTS memory_preferences_scope ON memory.preferences(scope_type,scope_id,status);
CREATE INDEX IF NOT EXISTS memory_preferences_topics ON memory.preferences USING gin(topic_ids);
CREATE INDEX IF NOT EXISTS memory_preferences_fts ON memory.preferences USING gin(search_document);
CREATE INDEX IF NOT EXISTS memory_preferences_trgm ON memory.preferences USING gin ((coalesce(dimension,'')||' '||coalesce(value,'')||' '||coalesce(summary,'')) gin_trgm_ops);
CREATE TABLE IF NOT EXISTS memory.entities (id text PRIMARY KEY,type text NOT NULL,canonical_name text NOT NULL,aliases text[] NOT NULL,scope_type text NOT NULL,scope_id text NOT NULL,updated_at bigint NOT NULL);
CREATE INDEX IF NOT EXISTS memory_entities_scope ON memory.entities(scope_type,scope_id);
CREATE TABLE IF NOT EXISTS memory.edges (id text PRIMARY KEY,from_id text NOT NULL,predicate text NOT NULL,to_id text NOT NULL,scope_type text NOT NULL,scope_id text NOT NULL,confidence real NOT NULL,status text NOT NULL,updated_at bigint NOT NULL);
CREATE INDEX IF NOT EXISTS memory_edges_from ON memory.edges(scope_type,scope_id,from_id);
CREATE INDEX IF NOT EXISTS memory_edges_to ON memory.edges(scope_type,scope_id,to_id);
CREATE TABLE IF NOT EXISTS memory.topics (topic_id text PRIMARY KEY,kind text NOT NULL,scope_type text NOT NULL,scope_id text NOT NULL,title text NOT NULL,description text NOT NULL,aliases text[] NOT NULL,entity_ids text[] NOT NULL,related_topic_ids text[] NOT NULL,current_cold_revision uuid,embedding_text text NOT NULL,status text NOT NULL,updated_at bigint NOT NULL,search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple',coalesce(title,'')||' '||coalesce(description,''))) STORED);
CREATE INDEX IF NOT EXISTS memory_topics_scope ON memory.topics(scope_type,scope_id,status);
CREATE INDEX IF NOT EXISTS memory_topics_fts ON memory.topics USING gin(search_document);
CREATE INDEX IF NOT EXISTS memory_topics_trgm ON memory.topics USING gin ((coalesce(title,'')||' '||coalesce(description,'')) gin_trgm_ops);
CREATE TABLE IF NOT EXISTS memory.cold_revisions (id uuid PRIMARY KEY,topic_id text NOT NULL REFERENCES memory.topics(topic_id),kind text NOT NULL,scope_type text NOT NULL,scope_id text NOT NULL,revision integer NOT NULL,state text NOT NULL,object_key text NOT NULL UNIQUE,checksum text NOT NULL,byte_length integer NOT NULL,token_count integer NOT NULL,created_at bigint NOT NULL,published_at bigint,UNIQUE(topic_id,revision));
ALTER TABLE memory.topics DROP CONSTRAINT IF EXISTS memory_topics_current_revision_fk;
ALTER TABLE memory.topics ADD CONSTRAINT memory_topics_current_revision_fk FOREIGN KEY(current_cold_revision) REFERENCES memory.cold_revisions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE IF NOT EXISTS memory.embeddings (ref_type text NOT NULL CHECK(ref_type IN ('hot_record','warm_record','topic_descriptor')),ref_id text NOT NULL,scope_type text NOT NULL,scope_id text NOT NULL,kind text NOT NULL,generation text NOT NULL,embedding vector NOT NULL,content_hash text,updated_at bigint NOT NULL,PRIMARY KEY(ref_type,ref_id,generation));
CREATE INDEX IF NOT EXISTS memory_embeddings_scope ON memory.embeddings(scope_type,scope_id,kind,generation);
CREATE TABLE IF NOT EXISTS memory.capture_jobs (id uuid PRIMARY KEY,idempotency_key text NOT NULL UNIQUE,request jsonb NOT NULL,status text NOT NULL,attempts integer NOT NULL DEFAULT 0,lease_owner text,lease_until bigint,lease_token uuid,fencing_token bigint NOT NULL DEFAULT 0,error_code text,proposal_count integer,persisted_count integer,created_at bigint NOT NULL,updated_at bigint NOT NULL);
ALTER TABLE memory.capture_jobs ADD COLUMN IF NOT EXISTS extracted_count integer;
ALTER TABLE memory.capture_jobs ADD COLUMN IF NOT EXISTS proposal_count integer;
ALTER TABLE memory.capture_jobs ADD COLUMN IF NOT EXISTS persisted_count integer;
ALTER TABLE memory.capture_jobs ADD COLUMN IF NOT EXISTS filter_reasons jsonb NOT NULL DEFAULT '{}';
ALTER TABLE memory.capture_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE memory.capture_jobs ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS memory_jobs_claim ON memory.capture_jobs(status,lease_until,created_at);
CREATE TABLE IF NOT EXISTS memory.policy_receipts (id bigserial PRIMARY KEY,action text NOT NULL,subject_id text NOT NULL,scope_type text,scope_id text,decision text NOT NULL,reason_codes text[] NOT NULL,payload_hash text,policy_version text NOT NULL,created_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS memory.outbox (id bigserial PRIMARY KEY,event_type text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',created_at bigint NOT NULL,processed_at bigint);

ALTER TABLE memory.records ADD COLUMN IF NOT EXISTS semantic jsonb;
ALTER TABLE memory.preferences ADD COLUMN IF NOT EXISTS semantic jsonb;
ALTER TABLE memory.embeddings ADD COLUMN IF NOT EXISTS content_hash text;

ALTER TABLE memory.records ADD COLUMN IF NOT EXISTS lifecycle jsonb;
ALTER TABLE memory.preferences ADD COLUMN IF NOT EXISTS lifecycle jsonb;

ALTER TABLE memory.topics ADD COLUMN IF NOT EXISTS lifecycle jsonb;
CREATE TABLE IF NOT EXISTS memory.reindex_jobs (
 id uuid PRIMARY KEY, scope_type text NOT NULL, scope_id text NOT NULL, generation text NOT NULL,
 status text NOT NULL, checkpoint jsonb NOT NULL, lease_owner text, lease_until bigint, lease_token uuid,
 fencing_token bigint NOT NULL DEFAULT 0, error_code text, created_at bigint NOT NULL, updated_at bigint NOT NULL, completed_at bigint,
 UNIQUE(scope_type,scope_id,generation,status) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS memory_reindex_claim ON memory.reindex_jobs(status,lease_until,created_at);
CREATE TABLE IF NOT EXISTS memory.embedding_generations (
 scope_type text NOT NULL, scope_id text NOT NULL, generation text NOT NULL, status text NOT NULL,
 expected integer NOT NULL DEFAULT 0, indexed integer NOT NULL DEFAULT 0, skipped integer NOT NULL DEFAULT 0,
 activated_at bigint, updated_at bigint NOT NULL, PRIMARY KEY(scope_type,scope_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_one_active_generation ON memory.embedding_generations(scope_type,scope_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS memory.worker_heartbeats (
 worker_id text NOT NULL, scope_type text NOT NULL, scope_id text NOT NULL, kind text NOT NULL,
 heartbeat_at bigint NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(worker_id,scope_type,scope_id,kind)
);
CREATE TABLE IF NOT EXISTS memory.metrics (
 id bigserial PRIMARY KEY, scope_type text NOT NULL, scope_id text NOT NULL, name text NOT NULL, value double precision NOT NULL, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_metrics_lookup ON memory.metrics(scope_type,scope_id,name,created_at DESC);
CREATE TABLE IF NOT EXISTS memory.degraded_events (
 id bigserial PRIMARY KEY, scope_type text NOT NULL, scope_id text NOT NULL, reason text NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS memory.recall_feedback (
 id uuid PRIMARY KEY, record_id uuid NOT NULL, scope_type text NOT NULL, scope_id text NOT NULL, signal text NOT NULL,
 weight real NOT NULL, run_id text, note text, actor_id text NOT NULL, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_feedback_record ON memory.recall_feedback(record_id,created_at DESC);
CREATE TABLE IF NOT EXISTS memory.governance_receipts (
 id uuid PRIMARY KEY, record_id uuid NOT NULL, scope_type text NOT NULL, scope_id text NOT NULL, action text NOT NULL,
 previous_status text NOT NULL, next_status text NOT NULL, reason text NOT NULL, actor_id text NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS memory.core_snapshots (
 scope_type text NOT NULL, scope_id text NOT NULL, revision integer NOT NULL, markdown text NOT NULL,
 source_record_ids text[] NOT NULL, checksum text NOT NULL, token_count integer NOT NULL, generated_at bigint NOT NULL, edited_at bigint,
 PRIMARY KEY(scope_type,scope_id,revision)
);
