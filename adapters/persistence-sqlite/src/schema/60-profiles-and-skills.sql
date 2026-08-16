CREATE TABLE profile_audit_events (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL,
      delegated_actor_id TEXT,
      delegated_request_id TEXT,
      request_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','outcome_unknown')),
      error_code TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

CREATE TABLE profile_mutation_receipts (
      principal_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      expected_revision INTEGER NOT NULL CHECK(expected_revision > 0),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision > 0),
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key)
    );

CREATE TABLE profile_operation_receipts (
      principal_id TEXT NOT NULL,
      delegated_actor_id TEXT,
      delegated_request_id TEXT,
      profile_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','outcome_unknown')),
      result_json TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key)
    );

CREATE TABLE profile_resource_revisions (
      profile_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,resource_type,resource_id)
    );

CREATE TABLE skill_catalog_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    );

CREATE TABLE skill_revisions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id),
      revision INTEGER NOT NULL CHECK(revision > 0),
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      disable_model_invocation INTEGER NOT NULL DEFAULT 0 CHECK(disable_model_invocation IN (0,1)),
      source_filename TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(skill_id, revision),
      UNIQUE(skill_id, sha256)
    );

CREATE TABLE workspace_skill_bindings (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      bound_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, skill_id)
    );

CREATE TABLE workspace_skill_revisions (
      workspace_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    );
