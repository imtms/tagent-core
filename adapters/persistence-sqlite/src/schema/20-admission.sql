CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE session_create_receipts (
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id,idempotency_key)
    );

CREATE TABLE session_inbox_revisions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    );

CREATE TABLE session_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        created_at INTEGER NOT NULL
      );

CREATE TABLE session_supervisor_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        run_id TEXT REFERENCES runs(id),
        error TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER,
        started_at INTEGER,
        summary TEXT NOT NULL DEFAULT '',
        objectives_json TEXT NOT NULL DEFAULT '[]',
        intent TEXT NOT NULL DEFAULT 'new_task',
        target_run_id TEXT,
        priority INTEGER NOT NULL DEFAULT 500,
        urgency TEXT NOT NULL DEFAULT 'normal',
        relation TEXT NOT NULL DEFAULT 'independent',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT '',
        non_goals_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        decision_reason TEXT NOT NULL DEFAULT '',
        router_version TEXT NOT NULL DEFAULT '',
        execution_policy_json TEXT NOT NULL DEFAULT '',
        manual_order INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        UNIQUE(session_id, request_id)
      );

CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
        reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('minimal','low','medium','high','xhigh','max')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0));

CREATE TABLE submission_audit_receipts (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      submission_id TEXT NOT NULL UNIQUE REFERENCES session_supervisor_inbox(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,idempotency_key)
    );
