CREATE TABLE approval_receipts (
    id TEXT PRIMARY KEY,
    approval_source TEXT NOT NULL CHECK (approval_source IN ('run','workflow')),
    approval_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(approval_source, approval_id, operation_id, outcome)
  );

CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), decision_id TEXT NOT NULL REFERENCES supervisor_decisions(id),
        action_type TEXT NOT NULL DEFAULT 'resume_taskrun', target_type TEXT NOT NULL DEFAULT 'taskrun', target_id TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, requested_at INTEGER NOT NULL, resolved_at INTEGER,
        resolved_by TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT ''
      , "scope_type" TEXT, "scope_id" TEXT, "operation_digest" TEXT, "risk_class" TEXT CHECK (risk_class IN ('low','medium','high')), "expires_at" INTEGER, "reuse_mode" TEXT CHECK (reuse_mode IN ('one_time','reusable')), "max_uses" INTEGER CHECK (max_uses IS NULL OR max_uses > 0), "used_count" INTEGER CHECK (used_count IS NULL OR used_count >= 0));

CREATE TABLE autonomy_approval_requests (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN ('activate_workflow','apply_revision','start_canary','execute_workflow')),
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        workflow_id TEXT REFERENCES workflow_definitions(id),
        revision_id TEXT REFERENCES workflow_revisions(id),
        proposal_id TEXT REFERENCES workflow_revision_proposals(id),
        binding_id TEXT REFERENCES workflow_bindings(id),
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','revoked','expired','executed')),
        risk_class TEXT NOT NULL CHECK (risk_class IN ('low','medium','high')),
        impact_scope_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        diff_json TEXT NOT NULL DEFAULT '{}',
        rollback_json TEXT NOT NULL DEFAULT '{}',
        requested_by TEXT NOT NULL,
        request_reason TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        decided_by TEXT NOT NULL DEFAULT '',
        decision_reason TEXT NOT NULL DEFAULT '',
        decided_at INTEGER,
        executed_at INTEGER,
        execution_receipt_json TEXT NOT NULL DEFAULT '{}',
        request_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , "operation_digest" TEXT, "reuse_mode" TEXT CHECK (reuse_mode IN ('one_time','reusable')), "max_uses" INTEGER CHECK (max_uses IS NULL OR max_uses > 0), "used_count" INTEGER CHECK (used_count IS NULL OR used_count >= 0));

CREATE TABLE autonomy_audit_events (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('observe','learn','distill','evolve','approval','execute')),
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        source_run_id TEXT REFERENCES runs(id),
        workflow_id TEXT REFERENCES workflow_definitions(id),
        revision_id TEXT REFERENCES workflow_revisions(id),
        approval_id TEXT REFERENCES autonomy_approval_requests(id),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        receipt_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

CREATE TABLE workflow_application_receipts (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES workflow_bindings(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        task_outcome TEXT NOT NULL,
        application_status TEXT NOT NULL DEFAULT 'exposed' CHECK (application_status IN ('exposed','adopted','partial','rejected')),
        executed_step_ids_json TEXT NOT NULL DEFAULT '[]',
        skipped_steps_json TEXT NOT NULL DEFAULT '[]',
        correction_observed INTEGER NOT NULL DEFAULT 0,
        repeated_tool_calls INTEGER NOT NULL DEFAULT 0,
        continuation_count INTEGER NOT NULL DEFAULT 0,
        verification_mapping_json TEXT NOT NULL DEFAULT '[]',
        required_checks_passed INTEGER NOT NULL,
        required_checks_failed INTEGER NOT NULL,
        attribution_level TEXT NOT NULL CHECK (attribution_level IN ('exposed','adopted','verified_contribution')),
        receipt_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, attempt_id TEXT,
        UNIQUE(binding_id, receipt_version)
      );

CREATE TABLE workflow_bindings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        selector_version TEXT NOT NULL,
        relevance_score REAL NOT NULL,
        selected_reason_json TEXT NOT NULL DEFAULT '[]',
        application_mode TEXT NOT NULL DEFAULT 'suggested',
        created_at INTEGER NOT NULL, attempt_id TEXT,
        UNIQUE(run_id, attempt, workflow_id, revision_id)
      );

CREATE TABLE workflow_canary_bindings (
        id TEXT PRIMARY KEY,
        promotion_id TEXT NOT NULL REFERENCES workflow_promotions(id),
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        scope_id TEXT NOT NULL,
        assignment_key TEXT NOT NULL,
        assignment_hash TEXT NOT NULL,
        bucket INTEGER NOT NULL CHECK (bucket >= 0 AND bucket < 10000),
        variant TEXT NOT NULL CHECK (variant IN ('baseline','candidate')),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        receipt_hash TEXT NOT NULL UNIQUE,
        outcome_status TEXT,
        success INTEGER,
        required_checks INTEGER NOT NULL DEFAULT 0,
        passed_checks INTEGER NOT NULL DEFAULT 0,
        outcome_recorded_at INTEGER,
        created_at INTEGER NOT NULL, attempt_id TEXT,
        UNIQUE(promotion_id, run_id, attempt)
      );

CREATE TABLE workflow_definitions (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('candidate','active','suspended','deprecated')),
        active_revision_id TEXT,
        deleted_at INTEGER,
        purge_after INTEGER,
        delete_reason TEXT NOT NULL DEFAULT '',
        previous_status TEXT,
        previous_active_revision_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE workflow_distillation_conflicts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES workflow_distillation_jobs(id),
        scope_id TEXT NOT NULL,
        candidate_signature TEXT NOT NULL,
        existing_workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        existing_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        kind TEXT NOT NULL CHECK (kind IN ('duplicate','conflict')),
        similarity REAL NOT NULL,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, existing_workflow_id, existing_revision_id, kind)
      );

CREATE TABLE workflow_distillation_jobs (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        signature_terms_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','dead_letter')),
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_token TEXT NOT NULL DEFAULT '',
        lease_until INTEGER,
        fence INTEGER NOT NULL DEFAULT 0,
        workflow_id TEXT REFERENCES workflow_definitions(id),
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(scope_id, task_signature)
      );

CREATE TABLE workflow_distillations (
        evidence_set_hash TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        created_at INTEGER NOT NULL
      );

CREATE TABLE workflow_evaluations (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        kind TEXT NOT NULL CHECK (kind IN ('shadow','offline_replay','canary')),
        status TEXT NOT NULL CHECK (status IN ('pending','passed','failed','rolled_back')),
        sample_size INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        baseline_rate REAL NOT NULL DEFAULT 0,
        risk_class TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        evaluator_id TEXT NOT NULL DEFAULT '',
        evaluator_version TEXT NOT NULL DEFAULT '',
        dataset_id TEXT NOT NULL DEFAULT '',
        dataset_hash TEXT NOT NULL DEFAULT '',
        baseline_revision_id TEXT REFERENCES workflow_revisions(id),
        candidate_revision_id TEXT REFERENCES workflow_revisions(id),
        evaluation_run_ids_json TEXT NOT NULL DEFAULT '[]',
        check_results_json TEXT NOT NULL DEFAULT '[]',
        receipt_hash TEXT NOT NULL DEFAULT '',
        signature TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

CREATE TABLE workflow_feedback (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        signal TEXT NOT NULL,
        weight REAL NOT NULL,
        adopted INTEGER NOT NULL DEFAULT 1,
        verified INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      , attempt_id TEXT);

CREATE TABLE workflow_governance_receipts (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

CREATE TABLE workflow_promotions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        previous_revision_id TEXT REFERENCES workflow_revisions(id),
        status TEXT NOT NULL CHECK (status IN ('candidate','canary','promoted','rolled_back','rejected')),
        canary_percent INTEGER NOT NULL DEFAULT 0,
        max_failure_delta REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE workflow_revision_proposals (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        base_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        patch_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('candidate','approved','rejected','applied')),
        decided_by TEXT NOT NULL DEFAULT '',
        decision_reason TEXT NOT NULL DEFAULT '',
        decided_at INTEGER,
        applied_revision_id TEXT REFERENCES workflow_revisions(id),
        created_at INTEGER NOT NULL, base_spec_hash TEXT NOT NULL DEFAULT '', proposed_spec_hash TEXT NOT NULL DEFAULT '', changed_paths_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(workflow_id, base_revision_id, reason)
      );

CREATE TABLE workflow_revisions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user','task_experience','task_failure','user_correction')),
        source_evidence_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, spec_hash TEXT NOT NULL DEFAULT '',
        UNIQUE(workflow_id, revision)
      );

CREATE TABLE workflow_selector_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        decision TEXT NOT NULL CHECK (decision IN ('selected','excluded')),
        reasons_json TEXT NOT NULL DEFAULT '[]',
        score REAL,
        created_at INTEGER NOT NULL, attempt_id TEXT,
        UNIQUE(run_id, attempt, workflow_id, revision_id)
      );

CREATE TABLE workflow_status_history (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        previous_status TEXT NOT NULL,
        next_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
