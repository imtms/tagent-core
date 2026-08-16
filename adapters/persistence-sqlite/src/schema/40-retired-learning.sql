CREATE TABLE communication_profile_revisions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES communication_profiles(id),
        revision INTEGER NOT NULL,
        values_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user','inferred','governance')),
        change_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(profile_id, revision)
      );

CREATE TABLE communication_profiles (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','session','task')),
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','superseded','deleted')),
        active_revision_id TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        previous_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(subject_id, scope_type, scope_id)
      );

CREATE TABLE effect_receipts (
    logical_consumer TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    effect_hash TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(logical_consumer,source_event_id)
  );

CREATE TABLE experience_observations (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id),
        attempt INTEGER,
        lifecycle TEXT NOT NULL DEFAULT 'manual',
        outcome TEXT NOT NULL DEFAULT '',
        event_seq INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user','task_experience','task_failure','user_correction')),
        task_signature TEXT NOT NULL,
        procedure_summary TEXT NOT NULL,
        checks_passed_json TEXT NOT NULL DEFAULT '[]',
        checks_failed_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        learn_policy TEXT NOT NULL CHECK (learn_policy IN ('allow','metadata_only','deny')),
        observation_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      , attempt_id TEXT);

CREATE TABLE feedback_attribution_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        weight REAL NOT NULL,
        basis TEXT NOT NULL,
        context_manifest_id TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('pending','applied','skipped','failed','dead_letter')),
        error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        applied_at INTEGER
      , attempt_id TEXT);

CREATE TABLE integration_consumer_delivery (
  outbox_sequence INTEGER NOT NULL REFERENCES integration_outbox(outbox_sequence),
  consumer TEXT NOT NULL CHECK(consumer = 'learning-projection-v1'),
  lease_generation INTEGER NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','acked','failed')),
  PRIMARY KEY(outbox_sequence,consumer)
);

CREATE TABLE integration_outbox (
    outbox_sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    source_event_id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL,
    run_event_ref TEXT,
    attempt_id TEXT,
    attempt_ordinal INTEGER,
    evidence_snapshot_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE integration_stream_sequence (
    id INTEGER PRIMARY KEY CHECK(id=1),
    next_sequence INTEGER NOT NULL
  );

CREATE TABLE learning_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        event_seq INTEGER NOT NULL DEFAULT 0,
        task_classification_json TEXT NOT NULL DEFAULT '{}',
        strategy_selected_json TEXT NOT NULL DEFAULT '[]',
        context_used_json TEXT NOT NULL DEFAULT '{}',
        execution_trace_json TEXT NOT NULL DEFAULT '{}',
        outcome_json TEXT NOT NULL DEFAULT '{}',
        attribution_json TEXT NOT NULL DEFAULT '{}',
        policy_json TEXT NOT NULL DEFAULT '{}',
        event_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, attempt_id TEXT,
        UNIQUE(run_id, attempt, lifecycle, event_seq)
      );

CREATE TABLE learning_feature_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        memory_enabled INTEGER NOT NULL DEFAULT 0,
        learning_enabled INTEGER NOT NULL DEFAULT 0,
        auto_execution_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT ''
      );

CREATE TABLE learning_projection_checkpoint (
  consumer TEXT PRIMARY KEY CHECK(consumer = 'learning-projection-v1'),
  watermark INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE outcome_labels (
        id TEXT PRIMARY KEY,
        learning_event_id TEXT NOT NULL REFERENCES learning_events(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        taxonomy_version TEXT NOT NULL,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      , attempt_id TEXT);

CREATE TABLE semantic_judgment_cache (
        cache_key TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

CREATE TABLE semantic_learning_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('user_message','workflow_eligibility','feedback_attribution')),
        run_id TEXT REFERENCES runs(id),
        attempt INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','failed','completed','dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      , lease_owner TEXT NOT NULL DEFAULT '', lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER, fence INTEGER NOT NULL DEFAULT 0, attempt_id TEXT);

CREATE TABLE user_corrections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT REFERENCES runs(id),
        attempt INTEGER,
        message_id INTEGER REFERENCES messages(id),
        correction_type TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'run',
        target_id TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('explicit_user','router','governance')),
        applied INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      , attempt_id TEXT);
