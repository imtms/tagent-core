CREATE TABLE attempt_request_envelopes (
      id TEXT PRIMARY KEY CHECK(length(id) > 0),
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt > 0),
      request_ordinal INTEGER NOT NULL CHECK(request_ordinal > 0),
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
      provider_payload_hash TEXT NOT NULL CHECK(length(provider_payload_hash) = 64),
      envelope_hash TEXT NOT NULL CHECK(length(envelope_hash) = 64),
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      FOREIGN KEY (run_id, attempt, attempt_id) REFERENCES attempts(run_id, ordinal, id)
    );

CREATE TABLE attempt_transition_audit (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  ordinal INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scenario TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  event_sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  trigger TEXT NOT NULL CHECK (trigger IN ('initial','resume','continuation','retry','input','recovery')),
  status TEXT NOT NULL CHECK (status IN ('queued','starting','running','settling','waiting_input','blocked','completed','failed','cancelled','interrupted','superseded')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1))
    CHECK ((active = 1) = (status IN ('queued','starting','running','settling'))),
  version INTEGER NOT NULL CHECK (version > 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(run_id, ordinal)
);

CREATE TABLE candidate_results (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    response TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );

CREATE TABLE control_inbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        request_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('steer', 'follow_up')),
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER,
        UNIQUE(run_id, request_id)
      );

CREATE TABLE event_consumers (
        run_id TEXT NOT NULL REFERENCES runs(id),
        consumer_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        acked_seq INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, settled_acked_seq INTEGER, final_acked_seq INTEGER,
        PRIMARY KEY (run_id, consumer_id)
      );

CREATE TABLE execution_leases (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK (fence > 0),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    lease_until INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    released_at INTEGER,
    CHECK (lease_until >= heartbeat_at)
  );

CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        operation_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        effects_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

CREATE TABLE plan_items (
        run_id TEXT NOT NULL REFERENCES runs(id),
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, item_key)
      );

CREATE TABLE progress_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), attempt INTEGER NOT NULL, checkpoint_seq INTEGER NOT NULL,
        meaningful_changes INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        repeated_operations INTEGER NOT NULL DEFAULT 0, last_progress_at INTEGER NOT NULL,
        last_decision_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
      , attempt_id TEXT);

CREATE TABLE run_checkpoints (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        assistant_partial TEXT NOT NULL DEFAULT '',
        current_tool_json TEXT NOT NULL DEFAULT '',
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_transcript_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE run_checks (
        run_id TEXT NOT NULL REFERENCES runs(id),
        check_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        command TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        stale INTEGER NOT NULL DEFAULT 0,
        source_operation_id TEXT,
        observed_at INTEGER,
        PRIMARY KEY (run_id, check_key)
      );

CREATE TABLE run_continuations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        ordinal INTEGER NOT NULL,
        source_attempt_id TEXT,
        scheduled_attempt_id TEXT,
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        not_before INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_until INTEGER,
        heartbeat_at INTEGER,
        UNIQUE(run_id, ordinal)
      );

CREATE TABLE run_events (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        attempt_id TEXT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

CREATE TABLE run_learning_policies (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        policy TEXT NOT NULL CHECK (policy IN ('allow','metadata_only','deny')),
        reason TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

CREATE TABLE run_model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        component TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        usage_input INTEGER NOT NULL DEFAULT 0,
        usage_output INTEGER NOT NULL DEFAULT 0,
        usage_cache_read INTEGER NOT NULL DEFAULT 0,
        usage_cache_write INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cost REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

CREATE TABLE run_transcript (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

CREATE TABLE supervisor_decisions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, trigger TEXT NOT NULL, action TEXT NOT NULL, reason_code TEXT NOT NULL,
        rationale TEXT NOT NULL, confidence REAL NOT NULL, instruction TEXT NOT NULL DEFAULT '',
        candidate_response_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, executed_at INTEGER, evaluator TEXT NOT NULL DEFAULT 'system',
        evaluator_model TEXT NOT NULL DEFAULT ''
      , attempt_id TEXT);

CREATE TABLE task_run_command_receipts (
      principal_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL REFERENCES runs(id),
      command_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      target_attempt_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','outcome_unknown')),
      result_json TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(principal_id,task_run_id,command_id)
    );

CREATE TABLE tool_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        attempt_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(run_id, attempt, tool_call_id)
      );

CREATE TABLE user_input_requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        prompt TEXT NOT NULL, fields_json TEXT NOT NULL, status TEXT NOT NULL,
        response_json TEXT NOT NULL DEFAULT '{}', requested_at INTEGER NOT NULL, submitted_at INTEGER
      , attempt_id TEXT);
