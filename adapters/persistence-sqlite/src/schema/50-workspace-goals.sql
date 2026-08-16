CREATE TABLE "workspace_goal_decisions" (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      target_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id),
      target_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('approve_goal','approve_roadmap','request_change','pause','resume','close','cancel')),
      approved_item_ids_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      request_id TEXT,
      payload_hash TEXT NOT NULL DEFAULT ''
    );

CREATE TABLE workspace_goal_evidence_links (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      goal_revision INTEGER NOT NULL,
      criterion_key TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      check_key TEXT,
      artifact_id TEXT,
      operation_id TEXT,
      source_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('valid','stale','contradicted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(goal_id, goal_revision, criterion_key, source_digest)
    );

CREATE TABLE workspace_goal_evidence_requests (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      evidence_link_id TEXT NOT NULL REFERENCES workspace_goal_evidence_links(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(goal_id, request_id)
    );

CREATE TABLE workspace_goal_inbox_links (
      inbox_item_id TEXT PRIMARY KEY REFERENCES session_supervisor_inbox(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      goal_revision INTEGER NOT NULL,
      roadmap_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id),
      roadmap_item_ids_json TEXT NOT NULL DEFAULT '[]',
      criterion_keys_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

CREATE TABLE workspace_goal_operation_receipts (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','outcome_unknown')),
      result_json TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(goal_id,request_id)
    );

CREATE TABLE workspace_goal_requests (
      idempotency_key TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id),
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

CREATE TABLE workspace_goal_revisions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('definition','roadmap')),
      revision INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_artifact_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(goal_id, kind, revision)
    );

CREATE TABLE workspace_goal_roadmap_item_progress (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      roadmap_revision_id TEXT NOT NULL REFERENCES workspace_goal_revisions(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','blocked','skipped')),
      run_id TEXT REFERENCES runs(id),
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(goal_id, roadmap_revision_id, item_id)
    );

CREATE TABLE workspace_goal_run_links (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
      goal_revision INTEGER NOT NULL,
      roadmap_revision_id TEXT REFERENCES workspace_goal_revisions(id),
      approved_item_ids_json TEXT NOT NULL DEFAULT '[]',
      criterion_keys_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, link_mode TEXT NOT NULL DEFAULT 'workspace',
      PRIMARY KEY(goal_id, run_id)
    );

CREATE TABLE workspace_goals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK(status IN ('draft','active','paused','ready_to_close','completed','cancelled')),
      active_definition_revision_id TEXT,
      active_roadmap_revision_id TEXT,
      current_run_id TEXT REFERENCES runs(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
