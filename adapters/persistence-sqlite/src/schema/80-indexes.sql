CREATE INDEX idx_approval_receipts_approval
    ON approval_receipts(approval_source, approval_id, created_at, id);

CREATE UNIQUE INDEX idx_approval_receipts_one_allow_per_operation
    ON approval_receipts(operation_id) WHERE outcome='allow';

CREATE INDEX idx_approval_receipts_operation_digest
    ON approval_receipts(operation_digest, created_at, id);

CREATE UNIQUE INDEX idx_approval_requests_pending ON approval_requests(run_id) WHERE status = 'pending';

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id, requested_at);

CREATE INDEX idx_attempt_transition_audit_attempt ON attempt_transition_audit(attempt_id, created_at, id);

CREATE UNIQUE INDEX idx_attempts_one_active ON attempts(run_id)
      WHERE status IN ('queued','starting','running','settling');

CREATE INDEX idx_attempts_run ON attempts(run_id, ordinal);

CREATE UNIQUE INDEX idx_attempts_run_ordinal_id ON attempts(run_id, ordinal, id);

CREATE INDEX idx_autonomy_approvals_scope_status ON autonomy_approval_requests(scope_id,status,created_at);

CREATE INDEX idx_autonomy_approvals_target ON autonomy_approval_requests(action_type,target_id,status);

CREATE INDEX idx_autonomy_audit_scope ON autonomy_audit_events(scope_id,created_at);

CREATE INDEX idx_candidate_results_attempt ON candidate_results(attempt_id, created_at, id);

CREATE UNIQUE INDEX idx_candidate_results_one_per_attempt ON candidate_results(attempt_id);

CREATE INDEX idx_communication_profiles_resolve ON communication_profiles(subject_id, scope_type, scope_id, status);

CREATE INDEX idx_context_manifests_run ON context_manifests(run_id, attempt, created_at);

CREATE INDEX idx_continuations_due ON run_continuations(status, not_before, lease_until, created_at);

CREATE UNIQUE INDEX idx_continuations_one_active
      ON run_continuations(run_id) WHERE status IN ('queued', 'running');

CREATE INDEX idx_continuations_run ON run_continuations(run_id, ordinal);

CREATE INDEX idx_control_inbox_delivery ON control_inbox(run_id, attempt, status, created_at);

CREATE INDEX idx_event_consumers_updated ON event_consumers(updated_at);

CREATE INDEX idx_experience_scope_signature ON experience_observations(scope_id, task_signature, source_type, created_at);

CREATE INDEX idx_feedback_attribution_run ON feedback_attribution_receipts(run_id, attempt, status);

CREATE INDEX idx_gate_evaluations_run ON gate_evaluations(run_id, attempt, created_at);

CREATE INDEX idx_integration_consumer_delivery_claim
    ON integration_consumer_delivery(consumer,status,lease_until,outbox_sequence);

CREATE INDEX idx_integration_outbox_topic
    ON integration_outbox(topic,created_at,outbox_sequence);

CREATE INDEX idx_learning_events_run ON learning_events(run_id, attempt, created_at);

CREATE INDEX idx_messages_session ON messages(session_id, id);

CREATE INDEX idx_operations_attempt_created
    ON operations(attempt_id, created_at, id);

CREATE INDEX idx_operations_run ON operations(run_id, created_at);

CREATE INDEX idx_outcome_labels_run ON outcome_labels(run_id, attempt, label);

CREATE INDEX idx_profile_audit_resource ON profile_audit_events
      (profile_id,resource_type,resource_id,created_at);

CREATE INDEX idx_profile_operations_lookup ON profile_operation_receipts
      (principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key);

CREATE UNIQUE INDEX idx_request_envelopes_attempt_ordinal ON attempt_request_envelopes(attempt_id, request_ordinal);

CREATE INDEX idx_request_envelopes_run ON attempt_request_envelopes(run_id, attempt, request_ordinal);

CREATE INDEX idx_run_checks_source_operation
    ON run_checks(run_id, source_operation_id) WHERE source_operation_id IS NOT NULL;

CREATE INDEX idx_run_model_usage_run ON run_model_usage(run_id, component);

CREATE INDEX idx_runs_operator_session_created
      ON runs(session_id,created_at DESC,id DESC);

CREATE INDEX idx_runs_operator_session_updated
      ON runs(session_id,updated_at DESC,id DESC);

CREATE INDEX idx_runs_session ON runs(session_id, updated_at);

CREATE INDEX idx_semantic_judgment_cache_expiry ON semantic_judgment_cache(expires_at);

CREATE INDEX idx_semantic_learning_jobs_claim ON semantic_learning_jobs(status, next_retry_at, lease_until, created_at);

CREATE INDEX idx_semantic_learning_jobs_pending ON semantic_learning_jobs(status, next_retry_at, created_at);

CREATE INDEX idx_session_create_receipts_session
      ON session_create_receipts(session_id,created_at);

CREATE INDEX idx_session_supervisor_inbox_queue ON session_supervisor_inbox(session_id,status,position,created_at);

CREATE INDEX idx_sessions_operator_created
      ON sessions(created_at DESC,id DESC);

CREATE INDEX idx_skill_revisions_latest ON skill_revisions(skill_id, revision DESC);

CREATE INDEX idx_submission_audit_principal
      ON submission_audit_receipts(principal_id,created_at);

CREATE INDEX idx_supervisor_decisions_run ON supervisor_decisions(run_id, attempt, created_at);

CREATE INDEX idx_task_run_command_run
      ON task_run_command_receipts(task_run_id,created_at);

CREATE INDEX idx_task_run_command_status
      ON task_run_command_receipts(status,updated_at);

CREATE INDEX idx_tool_attempts_guard ON tool_attempts(run_id, tool_name, args_hash, id);

CREATE INDEX idx_transcript_run ON run_transcript(run_id, seq);

CREATE INDEX idx_user_corrections_run ON user_corrections(run_id, attempt, created_at);

CREATE UNIQUE INDEX idx_user_input_requests_pending ON user_input_requests(run_id) WHERE status = 'pending';

CREATE INDEX idx_user_input_requests_run ON user_input_requests(run_id, requested_at);

CREATE INDEX idx_workflow_canary_outcomes ON workflow_canary_bindings(promotion_id, variant, outcome_recorded_at);

CREATE INDEX idx_workflow_definitions_scope ON workflow_definitions(scope_id, status, updated_at);

CREATE INDEX idx_workflow_distillation_conflicts_scope ON workflow_distillation_conflicts(scope_id, status, created_at);

CREATE INDEX idx_workflow_distillation_jobs_claim ON workflow_distillation_jobs(status, lease_until, created_at);

CREATE UNIQUE INDEX idx_workflow_evaluations_receipt_hash ON workflow_evaluations(receipt_hash) WHERE receipt_hash <> '';

CREATE INDEX idx_workspace_goal_decisions_goal ON workspace_goal_decisions(goal_id, created_at DESC);

CREATE UNIQUE INDEX idx_workspace_goal_decisions_request
      ON workspace_goal_decisions(goal_id, request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_workspace_goal_evidence_goal ON workspace_goal_evidence_links(goal_id, criterion_key, status);

CREATE INDEX idx_workspace_goal_inbox_links_goal
      ON workspace_goal_inbox_links(goal_id, created_at DESC);

CREATE INDEX idx_workspace_goal_operation_status
      ON workspace_goal_operation_receipts(status,updated_at);

CREATE INDEX idx_workspace_goal_revisions_goal ON workspace_goal_revisions(goal_id, kind, revision DESC);

CREATE INDEX idx_workspace_goal_roadmap_progress_run
      ON workspace_goal_roadmap_item_progress(run_id) WHERE run_id IS NOT NULL;

CREATE INDEX idx_workspace_goal_run_links_goal ON workspace_goal_run_links(goal_id, created_at DESC);

CREATE INDEX idx_workspace_goals_workspace ON workspace_goals(workspace_id, updated_at DESC);

CREATE INDEX idx_workspace_skill_skill ON workspace_skill_bindings(skill_id);
