ALTER TABLE plan_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json));
ALTER TABLE session_supervisor_inbox ADD COLUMN routing_provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(routing_provenance_json));

CREATE TABLE plan_item_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, item_key, revision),
  FOREIGN KEY(run_id, item_key) REFERENCES plan_items(run_id, item_key)
);

CREATE INDEX idx_plan_item_revisions_run ON plan_item_revisions(run_id, item_key, revision);

CREATE TRIGGER plan_item_revisions_append_only_update
BEFORE UPDATE ON plan_item_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan item revisions are append-only');
END;

CREATE TRIGGER plan_item_revisions_append_only_delete
BEFORE DELETE ON plan_item_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan item revisions are append-only');
END;
ALTER TABLE supervisor_decisions ADD COLUMN epistemic_status TEXT NOT NULL DEFAULT 'model_assessed'
  CHECK(epistemic_status IN ('deterministic','model_assessed','degraded'));

CREATE TABLE accepted_uncertainties (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  criterion_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  contract_hash TEXT NOT NULL CHECK(length(contract_hash) = 64),
  actor_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs_json)),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK(expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX idx_accepted_uncertainties_run ON accepted_uncertainties(run_id, created_at, id);

CREATE TRIGGER accepted_uncertainties_append_only_update
BEFORE UPDATE ON accepted_uncertainties
BEGIN
  SELECT RAISE(ABORT, 'accepted uncertainties are append-only');
END;

CREATE TRIGGER accepted_uncertainties_append_only_delete
BEFORE DELETE ON accepted_uncertainties
BEGIN
  SELECT RAISE(ABORT, 'accepted uncertainties are append-only');
END;

CREATE TABLE context_manifest_envelopes (
  manifest_id TEXT NOT NULL REFERENCES context_manifests(id),
  envelope_id TEXT NOT NULL REFERENCES attempt_request_envelopes(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(manifest_id, envelope_id)
);

CREATE INDEX idx_context_manifest_envelopes_envelope ON context_manifest_envelopes(envelope_id);

CREATE TABLE context_evidence_sources (
  manifest_id TEXT NOT NULL REFERENCES context_manifests(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  source_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'memory'),
  source_revision TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 71 AND source_hash LIKE 'sha256:%'),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(manifest_id, source_ref)
);

CREATE INDEX idx_context_evidence_sources_run_ref
ON context_evidence_sources(run_id, source_ref, created_at DESC, manifest_id DESC);

CREATE TRIGGER context_evidence_sources_append_only_update
BEFORE UPDATE ON context_evidence_sources
BEGIN
  SELECT RAISE(ABORT, 'context evidence sources are append-only');
END;

CREATE TRIGGER context_evidence_sources_append_only_delete
BEFORE DELETE ON context_evidence_sources
BEGIN
  SELECT RAISE(ABORT, 'context evidence sources are append-only');
END;

CREATE VIRTUAL TABLE run_transcript_fts USING fts5(
  run_id UNINDEXED,
  seq UNINDEXED,
  content,
  tokenize = 'unicode61'
);

INSERT INTO run_transcript_fts(run_id,seq,content)
SELECT run_id,seq,message_json FROM run_transcript;

CREATE TRIGGER run_transcript_fts_insert
AFTER INSERT ON run_transcript
BEGIN
  INSERT INTO run_transcript_fts(run_id,seq,content) VALUES (new.run_id,new.seq,new.message_json);
END;

CREATE TRIGGER run_transcript_append_only_update
BEFORE UPDATE ON run_transcript
BEGIN
  SELECT RAISE(ABORT, 'run transcript is append-only');
END;

CREATE TRIGGER run_transcript_append_only_delete
BEFORE DELETE ON run_transcript
BEGIN
  SELECT RAISE(ABORT, 'run transcript is append-only');
END;
