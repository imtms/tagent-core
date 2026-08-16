CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        uri TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

CREATE TABLE context_manifests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        source TEXT NOT NULL, items_json TEXT NOT NULL, stats_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      , attempt_id TEXT);

CREATE TABLE core_schema (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_id TEXT NOT NULL CHECK(schema_id = 'tagent-core/0.8')
);

CREATE TABLE core_writer_lease (
        lock_name TEXT PRIMARY KEY CHECK (lock_name = 'core-writer'),
        owner_id TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK (fence > 0),
        pid INTEGER NOT NULL CHECK (pid > 0),
        host TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER,
        CHECK (expires_at >= heartbeat_at),
        CHECK (released_at IS NULL OR released_at >= acquired_at)
      );

CREATE TABLE gate_evaluations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, gate_type TEXT NOT NULL, evaluator TEXT NOT NULL DEFAULT 'system',
        evaluator_model TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', passed INTEGER NOT NULL,
        failures_json TEXT NOT NULL, criterion_coverage_json TEXT NOT NULL DEFAULT '[]', input_manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      , attempt_id TEXT);

CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        goal TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
        reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('minimal','low','medium','high','xhigh','max')),
        gate_required INTEGER NOT NULL DEFAULT 1,
        blocked_reason TEXT NOT NULL DEFAULT '',
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 1,
        resumed_at INTEGER,
        usage_input INTEGER NOT NULL DEFAULT 0,
        usage_output INTEGER NOT NULL DEFAULT 0,
        usage_cache_read INTEGER NOT NULL DEFAULT 0,
        usage_cache_write INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cost REAL NOT NULL DEFAULT 0,
        contract_json TEXT NOT NULL DEFAULT ''
      );

CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0));

CREATE TABLE taskrun_edges (
        from_run_id TEXT NOT NULL REFERENCES runs(id), to_run_id TEXT NOT NULL REFERENCES runs(id),
        relation TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        PRIMARY KEY(from_run_id, to_run_id, relation)
      );
