CREATE TRIGGER approval_receipts_append_only_delete
    BEFORE DELETE ON approval_receipts
    BEGIN
      SELECT RAISE(ABORT, 'approval_receipts is append-only');
    END;

CREATE TRIGGER approval_receipts_append_only_update
    BEFORE UPDATE ON approval_receipts
    BEGIN
      SELECT RAISE(ABORT, 'approval_receipts is append-only');
    END;

CREATE TRIGGER integration_outbox_immutable_delete
    BEFORE DELETE ON integration_outbox
    BEGIN
      SELECT RAISE(ABORT, 'integration_outbox is immutable');
    END;

CREATE TRIGGER integration_outbox_immutable_update
    BEFORE UPDATE ON integration_outbox
    BEGIN
      SELECT RAISE(ABORT, 'integration_outbox is immutable');
    END;

CREATE TRIGGER operations_identity_immutable
    BEFORE UPDATE OF run_id, attempt, attempt_id, operation_type, payload_hash ON operations
    BEGIN
      SELECT RAISE(ABORT, 'operations identity is immutable');
    END;

INSERT INTO core_schema (id,schema_id) VALUES (1,'tagent-core/0.8');

INSERT INTO integration_stream_sequence (id,next_sequence) VALUES (1,1);

INSERT INTO skill_catalog_state (id,revision,updated_at) VALUES (1,1,0);
