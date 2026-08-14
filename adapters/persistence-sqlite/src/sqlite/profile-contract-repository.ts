import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ProfileContractRepository,
  ProfileMutationContext,
  ProfileMutationResult,
  ProfilePageQuery,
  ProfileInboxItemRecord,
  ProfileContextManifestRecord,
  ProfileOperationIdentity,
  ProfileOperationReceiptRecord,
  ProfileSessionSettingsRecord,
  ProfileSynchronousMutationInput,
} from "@tagent/admission/ports";

type OperationRow = Omit<ProfileOperationReceiptRecord, "result" | "error"> & {
  resultJson: string;
  errorJson: string;
};

export class SqliteProfileContractRepository implements ProfileContractRepository {
  constructor(private readonly db: Database.Database) {}

  getProfileResourceRevision(profileId: string, resourceType: string, resourceId: string): number {
    return (this.db.prepare(`SELECT revision FROM profile_resource_revisions
      WHERE profile_id=? AND resource_type=? AND resource_id=?`).get(profileId, resourceType, resourceId) as
      { revision: number } | undefined)?.revision ?? 1;
  }

  bumpProfileResourceRevision(profileId: string, resourceType: string, resourceId: string): number {
    const timestamp = Date.now();
    this.db.prepare(`INSERT INTO profile_resource_revisions (profile_id,resource_type,resource_id,revision,updated_at)
      VALUES (?,?,?,2,?) ON CONFLICT(profile_id,resource_type,resource_id)
      DO UPDATE SET revision=profile_resource_revisions.revision+1,updated_at=excluded.updated_at`)
      .run(profileId, resourceType, resourceId, timestamp);
    return this.getProfileResourceRevision(profileId, resourceType, resourceId);
  }

  runSynchronousMutation<T>(input: ProfileSynchronousMutationInput<T>): ProfileMutationResult<T> {
    const identity = {
      principalId: input.mutation.principalId,
      profileId: input.profileId,
      endpointId: input.endpointId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      idempotencyKey: input.mutation.idempotencyKey,
    };
    const payloadHash = createHash("sha256").update(input.mutation.canonicalPayload).digest("hex");
    return this.db.transaction((): ProfileMutationResult<T> => {
      const existing = this.db.prepare(`SELECT payload_hash AS payloadHash,expected_revision AS expectedRevision,
        result_json AS resultJson FROM profile_mutation_receipts
        WHERE principal_id=@principalId AND profile_id=@profileId AND endpoint_id=@endpointId
          AND resource_type=@resourceType AND resource_id=@resourceId AND idempotency_key=@idempotencyKey`)
        .get(identity) as { payloadHash: string; expectedRevision: number; resultJson: string } | undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.expectedRevision !== input.mutation.expectedRevision) {
          return { status: "idempotency_conflict" };
        }
        return { status: "succeeded", value: JSON.parse(existing.resultJson) as T, replayed: true };
      }
      const currentRevision = input.readRevision();
      if (currentRevision === undefined) return { status: "not_found" };
      if (currentRevision !== input.mutation.expectedRevision) {
        return { status: "concurrency_conflict", currentRevision };
      }
      const timestamp = Date.now();
      const result = input.perform();
      this.db.prepare(`INSERT INTO profile_mutation_receipts
        (principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key,payload_hash,
         expected_revision,resulting_revision,result_json,created_at,updated_at)
        VALUES (@principalId,@profileId,@endpointId,@resourceType,@resourceId,@idempotencyKey,@payloadHash,
          @expectedRevision,@resultingRevision,@resultJson,@timestamp,@timestamp)`).run({
        ...identity,
        payloadHash,
        expectedRevision: input.mutation.expectedRevision,
        resultingRevision: result.resultingRevision,
        resultJson: JSON.stringify(result.value),
        timestamp,
      });
      this.recordAudit({
        principalId: input.mutation.principalId,
        grantedScopes: input.mutation.grantedScopes,
        delegatedActorId: input.mutation.delegatedActorId,
        delegatedRequestId: input.mutation.delegatedRequestId,
        requestId: input.mutation.requestId,
        profileId: input.profileId,
        endpointId: input.endpointId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        operation: input.operation,
        outcome: "succeeded",
        timestamp,
      });
      return { status: "succeeded", value: result.value, replayed: false };
    })();
  }

  getInboxCollectionRevision(sessionId: string): number | undefined {
    return (this.db.prepare("SELECT revision FROM session_inbox_revisions WHERE session_id=?").get(sessionId) as { revision: number } | undefined)?.revision;
  }

  getInboxItem(sessionId: string, itemId: string): ProfileInboxItemRecord | undefined {
    const row = this.db.prepare(`SELECT id,session_id AS sessionId,content,status,decision,run_id AS runId,
      position,summary,priority,urgency,relation,execution_policy_json AS executionPolicyJson,revision,
      created_at AS createdAt,updated_at AS updatedAt
      FROM session_supervisor_inbox WHERE session_id=? AND id=?`).get(sessionId, itemId) as
      (Omit<ProfileInboxItemRecord, "executionPolicy"> & { executionPolicyJson: string }) | undefined;
    if (!row) return undefined;
    const { executionPolicyJson, ...item } = row;
    return {
      ...item,
      executionPolicy: executionPolicyJson ? JSON.parse(executionPolicyJson) as ProfileInboxItemRecord["executionPolicy"] : null,
    };
  }

  listInboxPage(sessionId: string, query: ProfilePageQuery): {
    items: ProfileInboxItemRecord[];
    snapshotRowId: number;
    collectionRevision: number;
  } | undefined {
    const collectionRevision = this.getInboxCollectionRevision(sessionId);
    if (collectionRevision === undefined) return undefined;
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(rowid),0) FROM session_supervisor_inbox WHERE session_id=?",
    ).pluck().get(sessionId));
    const afterClause = query.after
      ? "AND (created_at < @afterCreatedAt OR (created_at = @afterCreatedAt AND id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT id,session_id AS sessionId,content,status,decision,run_id AS runId,
      position,summary,priority,urgency,relation,execution_policy_json AS executionPolicyJson,revision,
      created_at AS createdAt,updated_at AS updatedAt
      FROM session_supervisor_inbox WHERE session_id=@sessionId AND rowid<=@snapshotRowId ${afterClause}
      ORDER BY created_at DESC,id DESC LIMIT @limit`).all({
      sessionId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<Omit<ProfileInboxItemRecord, "executionPolicy"> & { executionPolicyJson: string }>;
    return {
      items: rows.map(({ executionPolicyJson, ...row }) => ({
        ...row,
        executionPolicy: executionPolicyJson ? JSON.parse(executionPolicyJson) as ProfileInboxItemRecord["executionPolicy"] : null,
      })),
      snapshotRowId,
      collectionRevision,
    };
  }

  getTaskRunSessionId(taskRunId: string): string | undefined {
    return (this.db.prepare("SELECT session_id AS sessionId FROM runs WHERE id=?").get(taskRunId) as { sessionId: string } | undefined)?.sessionId;
  }

  listContextManifestPage(taskRunId: string, query: ProfilePageQuery): {
    items: ProfileContextManifestRecord[];
    snapshotRowId: number;
  } {
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(rowid),0) FROM context_manifests WHERE run_id=?",
    ).pluck().get(taskRunId));
    const afterClause = query.after
      ? "AND (created_at < @afterCreatedAt OR (created_at = @afterCreatedAt AND id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT id,run_id AS taskRunId,attempt,source,items_json AS itemsJson,
      manifest_hash AS manifestHash,created_at AS createdAt FROM context_manifests
      WHERE run_id=@taskRunId AND rowid<=@snapshotRowId ${afterClause}
      ORDER BY created_at DESC,id DESC LIMIT @limit`).all({
      taskRunId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<Omit<ProfileContextManifestRecord, "items"> & { itemsJson: string }>;
    return {
      items: rows.map(({ itemsJson, ...row }) => ({
        ...row,
        items: (JSON.parse(itemsJson) as ProfileContextManifestRecord["items"]).map((item) => ({
          kind: item.kind,
          sourceId: item.sourceId,
          selected: Boolean(item.selected),
          estimatedTokens: Math.max(0, Math.floor(Number(item.estimatedTokens) || 0)),
        })),
      })),
      snapshotRowId,
    };
  }

  getSessionSettings(sessionId: string): ProfileSessionSettingsRecord | undefined {
    return this.db.prepare(`SELECT id AS sessionId,title,model_id AS modelId,reasoning_effort AS reasoningEffort,
      revision,updated_at AS updatedAt FROM sessions WHERE id=?`).get(sessionId) as ProfileSessionSettingsRecord | undefined;
  }

  updateSessionSettings(input: {
    sessionId: string;
    settings: {
      title?: string;
      modelId?: string;
      reasoningEffort?: ProfileSessionSettingsRecord["reasoningEffort"];
    };
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileSessionSettingsRecord> {
    const identity = {
      principalId: input.mutation.principalId,
      profileId: "operator.session-settings.v1",
      endpointId: "operator.session_settings.update",
      resourceType: "session",
      resourceId: input.sessionId,
      idempotencyKey: input.mutation.idempotencyKey,
    };
    const payloadHash = createHash("sha256").update(input.mutation.canonicalPayload).digest("hex");
    return this.db.transaction((): ProfileMutationResult<ProfileSessionSettingsRecord> => {
      const existing = this.db.prepare(`SELECT payload_hash AS payloadHash,expected_revision AS expectedRevision,
        result_json AS resultJson FROM profile_mutation_receipts
        WHERE principal_id=@principalId AND profile_id=@profileId AND endpoint_id=@endpointId
          AND resource_type=@resourceType AND resource_id=@resourceId AND idempotency_key=@idempotencyKey`)
        .get(identity) as { payloadHash: string; expectedRevision: number; resultJson: string } | undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.expectedRevision !== input.mutation.expectedRevision) {
          return { status: "idempotency_conflict" };
        }
        return {
          status: "succeeded",
          value: JSON.parse(existing.resultJson) as ProfileSessionSettingsRecord,
          replayed: true,
        };
      }
      const current = this.getSessionSettings(input.sessionId);
      if (!current) return { status: "not_found" };
      if (current.revision !== input.mutation.expectedRevision) {
        return { status: "concurrency_conflict", currentRevision: current.revision };
      }
      const timestamp = Date.now();
      const changed = this.db.prepare(`UPDATE sessions SET title=?,model_id=?,reasoning_effort=?,revision=revision+1,updated_at=?
        WHERE id=? AND revision=?`).run(
        input.settings.title ?? current.title,
        input.settings.modelId ?? current.modelId,
        input.settings.reasoningEffort ?? current.reasoningEffort,
        timestamp,
        input.sessionId,
        current.revision,
      );
      if (changed.changes !== 1) {
        const latest = this.getSessionSettings(input.sessionId);
        return latest
          ? { status: "concurrency_conflict", currentRevision: latest.revision }
          : { status: "not_found" };
      }
      const result = this.getSessionSettings(input.sessionId)!;
      this.db.prepare(`INSERT INTO profile_mutation_receipts
        (principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key,payload_hash,
         expected_revision,resulting_revision,result_json,created_at,updated_at)
        VALUES (@principalId,@profileId,@endpointId,@resourceType,@resourceId,@idempotencyKey,@payloadHash,
          @expectedRevision,@resultingRevision,@resultJson,@timestamp,@timestamp)`).run({
        ...identity,
        payloadHash,
        expectedRevision: input.mutation.expectedRevision,
        resultingRevision: result.revision,
        resultJson: JSON.stringify(result),
        timestamp,
      });
      this.recordAudit({
        principalId: input.mutation.principalId,
        grantedScopes: input.mutation.grantedScopes,
        delegatedActorId: input.mutation.delegatedActorId,
        delegatedRequestId: input.mutation.delegatedRequestId,
        requestId: input.mutation.requestId,
        profileId: identity.profileId,
        endpointId: identity.endpointId,
        resourceType: identity.resourceType,
        resourceId: identity.resourceId,
        operation: "update",
        outcome: "succeeded",
        timestamp,
      });
      return { status: "succeeded", value: result, replayed: false };
    })();
  }

  getOperation(identity: ProfileOperationIdentity): ProfileOperationReceiptRecord | undefined {
    const row = this.db.prepare(`SELECT principal_id AS principalId,delegated_actor_id AS delegatedActorId,
      delegated_request_id AS delegatedRequestId,profile_id AS profileId,endpoint_id AS endpointId,
      resource_type AS resourceType,resource_id AS resourceId,idempotency_key AS idempotencyKey,
      payload_hash AS payloadHash,status,result_json AS resultJson,error_json AS errorJson,
      created_at AS createdAt,updated_at AS updatedAt,completed_at AS completedAt
      FROM profile_operation_receipts
      WHERE principal_id=@principalId AND profile_id=@profileId AND endpoint_id=@endpointId
        AND resource_type=@resourceType AND resource_id=@resourceId AND idempotency_key=@idempotencyKey`)
      .get(identity) as OperationRow | undefined;
    if (!row) return undefined;
    const { resultJson, errorJson, ...receipt } = row;
    return {
      ...receipt,
      result: resultJson ? JSON.parse(resultJson) as Record<string, unknown> : null,
      error: errorJson ? JSON.parse(errorJson) as Record<string, unknown> : null,
    };
  }

  findOperations(principalId: string, idempotencyKey: string, profileIdPrefix = ""): ProfileOperationReceiptRecord[] {
    const rows = this.db.prepare(`SELECT principal_id AS principalId,delegated_actor_id AS delegatedActorId,
      delegated_request_id AS delegatedRequestId,profile_id AS profileId,endpoint_id AS endpointId,
      resource_type AS resourceType,resource_id AS resourceId,idempotency_key AS idempotencyKey,
      payload_hash AS payloadHash,status,result_json AS resultJson,error_json AS errorJson,
      created_at AS createdAt,updated_at AS updatedAt,completed_at AS completedAt
      FROM profile_operation_receipts WHERE principal_id=? AND idempotency_key=? AND profile_id LIKE ?
      ORDER BY created_at DESC`).all(principalId, idempotencyKey, `${profileIdPrefix}%`) as OperationRow[];
    return rows.map(({ resultJson, errorJson, ...receipt }) => ({
      ...receipt,
      result: resultJson ? JSON.parse(resultJson) as Record<string, unknown> : null,
      error: errorJson ? JSON.parse(errorJson) as Record<string, unknown> : null,
    }));
  }

  claimOperation(input: ProfileOperationIdentity & {
    canonicalPayload: string;
    delegatedActorId?: string;
    delegatedRequestId?: string;
  }): { receipt: ProfileOperationReceiptRecord; claimed: boolean } {
    const payloadHash = createHash("sha256").update(input.canonicalPayload).digest("hex");
    return this.db.transaction(() => {
      const existing = this.getOperation(input);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new Error("Profile operation idempotency conflict: key is bound to a different canonical payload");
        }
        return { receipt: existing, claimed: false };
      }
      const timestamp = Date.now();
      this.db.prepare(`INSERT INTO profile_operation_receipts
        (principal_id,delegated_actor_id,delegated_request_id,profile_id,endpoint_id,resource_type,resource_id,
         idempotency_key,payload_hash,status,result_json,error_json,created_at,updated_at,completed_at)
        VALUES (@principalId,@delegatedActorId,@delegatedRequestId,@profileId,@endpointId,@resourceType,@resourceId,
          @idempotencyKey,@payloadHash,'started','','',@timestamp,@timestamp,NULL)`).run({
        ...input,
        delegatedActorId: input.delegatedActorId ?? null,
        delegatedRequestId: input.delegatedRequestId ?? null,
        payloadHash,
        timestamp,
      });
      return { receipt: this.getOperation(input)!, claimed: true };
    })();
  }

  settleOperation(
    identity: ProfileOperationIdentity,
    status: "succeeded" | "failed" | "outcome_unknown",
    result: Record<string, unknown> = {},
    error: Record<string, unknown> = {},
  ): ProfileOperationReceiptRecord {
    const timestamp = Date.now();
    this.db.prepare(`UPDATE profile_operation_receipts SET status=@status,result_json=@resultJson,error_json=@errorJson,
      updated_at=@timestamp,completed_at=@timestamp
      WHERE principal_id=@principalId AND profile_id=@profileId AND endpoint_id=@endpointId
        AND resource_type=@resourceType AND resource_id=@resourceId AND idempotency_key=@idempotencyKey
        AND status='started'`).run({
      ...identity,
      status,
      resultJson: Object.keys(result).length ? JSON.stringify(result) : "",
      errorJson: Object.keys(error).length ? JSON.stringify(error) : "",
      timestamp,
    });
    const receipt = this.getOperation(identity);
    if (!receipt) throw new Error("Profile operation receipt not found");
    return receipt;
  }

  recordAudit(input: Parameters<ProfileContractRepository["recordAudit"]>[0]): void {
    this.db.prepare(`INSERT INTO profile_audit_events
      (id,principal_id,granted_scopes_json,delegated_actor_id,delegated_request_id,request_id,profile_id,
       endpoint_id,resource_type,resource_id,operation,outcome,error_code,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), input.principalId, JSON.stringify([...input.grantedScopes]), input.delegatedActorId ?? null,
      input.delegatedRequestId ?? null, input.requestId, input.profileId, input.endpointId, input.resourceType,
      input.resourceId, input.operation, input.outcome, input.errorCode ?? "", input.timestamp ?? Date.now(),
    );
  }
}
