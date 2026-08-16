import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CreateSkillRevisionInput,
  SkillRevision,
  SkillSummary,
} from "@tagent/admission/domain";
import type {
  ProfileMutationContext,
  ProfileMutationResult,
  ProfilePageQuery,
  ProfileSkillCatalogPage,
  ProfileSkillDeleteValue,
  ProfileSkillMutationValue,
  ProfileSkillRevisionPage,
  ProfileWorkspaceSkillPage,
  ProfileWorkspaceSkillsMutationValue,
} from "@tagent/admission/ports";

const now = () => Date.now();

/** Skill catalog, immutable revisions, workspace bindings, and profile receipts. */
export class SqliteSkillRepository {
  constructor(private readonly db: Database.Database) {}

  createSkillRevision(input: CreateSkillRevisionInput): SkillRevision {
    return this.db.transaction(() => {
      const timestamp = now();
      let skill = input.skillId
        ? this.db.prepare("SELECT id,name FROM skills WHERE id=?").get(input.skillId) as { id: string; name: string } | undefined
        : this.db.prepare("SELECT id,name FROM skills WHERE name=?").get(input.name) as { id: string; name: string } | undefined;
      const createdSkill = !skill;
      if (input.skillId && !skill) throw new Error("Skill not found");
      if (!skill) {
        skill = { id: randomUUID(), name: input.name };
        this.db.prepare("INSERT INTO skills (id,name,created_at,updated_at) VALUES (?,?,?,?)")
          .run(skill.id, input.name, timestamp, timestamp);
      }
      const duplicate = this.db.prepare("SELECT id FROM skill_revisions WHERE skill_id=? AND sha256=?")
        .get(skill.id, input.sha256) as { id: string } | undefined;
      if (duplicate) {
        if (skill.name !== input.name) {
          this.db.prepare("UPDATE skills SET name=?,revision=revision+1,updated_at=? WHERE id=?")
            .run(input.name, timestamp, skill.id);
          this.touchSkillCatalogRevision(timestamp);
        }
        return this.getSkillRevision(duplicate.id)!;
      }
      if (skill.name !== input.name) {
        this.db.prepare("UPDATE skills SET name=?,updated_at=? WHERE id=?").run(input.name, timestamp, skill.id);
      }
      const revision = (this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM skill_revisions WHERE skill_id=?")
        .get(skill.id) as { revision: number }).revision;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO skill_revisions
        (id,skill_id,revision,description,content,file_path,sha256,disable_model_invocation,source_filename,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, skill.id, revision, input.description, input.content, input.filePath, input.sha256,
        Number(input.disableModelInvocation ?? false), input.sourceFilename, timestamp,
      );
      this.db.prepare(`UPDATE skills SET revision=revision+?,updated_at=? WHERE id=?`)
        .run(createdSkill ? 0 : 1, timestamp, skill.id);
      this.touchSkillCatalogRevision(timestamp);
      return this.getSkillRevision(id)!;
    })();
  }

  getSkillRevision(revisionId: string): SkillRevision | undefined {
    const row = this.db.prepare(`SELECT r.id,r.skill_id AS skillId,r.revision,s.name,r.description,r.content,
      r.file_path AS filePath,r.sha256,r.disable_model_invocation AS disableModelInvocation,
      r.source_filename AS sourceFilename,r.created_at AS createdAt
      FROM skill_revisions r JOIN skills s ON s.id=r.skill_id WHERE r.id=?`).get(revisionId) as
      (Omit<SkillRevision, "disableModelInvocation"> & { disableModelInvocation: number }) | undefined;
    return row ? { ...row, disableModelInvocation: Boolean(row.disableModelInvocation) } : undefined;
  }

  listSkills(): SkillSummary[] {
    return this.db.prepare(`SELECT s.id,s.name,r.revision AS latestRevision,r.id AS latestRevisionId,
      r.description,r.sha256,(SELECT COUNT(*) FROM workspace_skill_bindings bindings WHERE bindings.skill_id=s.id) AS workspaceCount,
      s.updated_at AS updatedAt FROM skills s JOIN skill_revisions r ON r.skill_id=s.id
      WHERE r.revision=(SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=s.id)
      ORDER BY s.updated_at DESC,s.name`).all() as SkillSummary[];
  }

  getCatalogRevision(): number {
    return Number(this.db.prepare("SELECT revision FROM skill_catalog_state WHERE id=1").pluck().get());
  }

  getSkillResourceRevision(skillId: string): number | undefined {
    return (this.db.prepare("SELECT revision FROM skills WHERE id=?").get(skillId) as { revision: number } | undefined)?.revision;
  }

  getWorkspaceSkillRevision(workspaceId: string): number | undefined {
    return (this.db.prepare("SELECT revision FROM workspace_skill_revisions WHERE workspace_id=?").get(workspaceId) as
      { revision: number } | undefined)?.revision;
  }

  listProfileSkillsPage(query: ProfilePageQuery): ProfileSkillCatalogPage {
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) FROM skills").pluck().get());
    const afterClause = query.after
      ? "AND (s.created_at < @afterCreatedAt OR (s.created_at = @afterCreatedAt AND s.id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT s.id,s.name,r.revision AS latestRevision,r.id AS latestRevisionId,
      r.description,r.sha256,(SELECT COUNT(*) FROM workspace_skill_bindings bindings WHERE bindings.skill_id=s.id) AS workspaceCount,
      s.updated_at AS updatedAt,s.created_at AS orderCreatedAt FROM skills s JOIN skill_revisions r ON r.skill_id=s.id
      WHERE s.rowid<=@snapshotRowId AND r.revision=(SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=s.id)
      ${afterClause} ORDER BY s.created_at DESC,s.id DESC LIMIT @limit`).all({
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<SkillSummary & { orderCreatedAt: number }>;
    return {
      items: rows.map(({ orderCreatedAt: _orderCreatedAt, ...item }) => item),
      orderKeys: rows.map((item) => ({ createdAt: item.orderCreatedAt, id: item.id })),
      snapshotRowId,
      collectionRevision: this.getCatalogRevision(),
    };
  }

  listProfileSkillRevisionsPage(skillId: string, query: ProfilePageQuery): ProfileSkillRevisionPage | undefined {
    const resourceRevision = this.getSkillResourceRevision(skillId);
    if (resourceRevision === undefined) return undefined;
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(rowid),0) FROM skill_revisions WHERE skill_id=?",
    ).pluck().get(skillId));
    const afterClause = query.after
      ? "AND (created_at < @afterCreatedAt OR (created_at = @afterCreatedAt AND id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT id FROM skill_revisions WHERE skill_id=@skillId AND rowid<=@snapshotRowId
      ${afterClause} ORDER BY created_at DESC,id DESC LIMIT @limit`).all({
      skillId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<{ id: string }>;
    return { items: rows.map((row) => this.getSkillRevision(row.id)!), snapshotRowId, resourceRevision };
  }

  listProfileWorkspaceSkillsPage(workspaceId: string, query: ProfilePageQuery): ProfileWorkspaceSkillPage | undefined {
    const bindingRevision = this.getWorkspaceSkillRevision(workspaceId);
    if (bindingRevision === undefined) return undefined;
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare(
      "SELECT COALESCE(MAX(rowid),0) FROM workspace_skill_bindings WHERE session_id=?",
    ).pluck().get(workspaceId));
    const afterClause = query.after
      ? "AND (bindings.bound_at < @afterCreatedAt OR (bindings.bound_at = @afterCreatedAt AND bindings.skill_id < @afterId))"
      : "";
    const rows = this.db.prepare(`SELECT revisions.id,bindings.bound_at AS orderCreatedAt,bindings.skill_id AS orderId
      FROM workspace_skill_bindings bindings
      JOIN skill_revisions revisions ON revisions.skill_id=bindings.skill_id
      WHERE bindings.session_id=@workspaceId AND bindings.rowid<=@snapshotRowId AND revisions.revision=(
        SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=bindings.skill_id
      ) ${afterClause} ORDER BY bindings.bound_at DESC,bindings.skill_id DESC LIMIT @limit`).all({
      workspaceId,
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as Array<{ id: string; orderCreatedAt: number; orderId: string }>;
    return {
      items: rows.map((row) => this.getSkillRevision(row.id)!),
      orderKeys: rows.map((row) => ({ createdAt: row.orderCreatedAt, id: row.orderId })),
      snapshotRowId,
      bindingRevision,
    };
  }

  getSkill(skillId: string): SkillRevision | undefined {
    const row = this.db.prepare("SELECT id FROM skill_revisions WHERE skill_id=? ORDER BY revision DESC LIMIT 1")
      .get(skillId) as { id: string } | undefined;
    return row ? this.getSkillRevision(row.id) : undefined;
  }

  listSkillRevisions(skillId: string): SkillRevision[] {
    const rows = this.db.prepare("SELECT id FROM skill_revisions WHERE skill_id=? ORDER BY revision DESC")
      .all(skillId) as Array<{ id: string }>;
    return rows.map((row) => this.getSkillRevision(row.id)!);
  }

  listWorkspaceSkills(workspaceId: string): SkillRevision[] {
    const rows = this.db.prepare(`SELECT revisions.id FROM workspace_skill_bindings bindings
      JOIN skill_revisions revisions ON revisions.skill_id=bindings.skill_id
      WHERE bindings.session_id=? AND revisions.revision=(
        SELECT MAX(latest.revision) FROM skill_revisions latest WHERE latest.skill_id=bindings.skill_id
      ) ORDER BY bindings.bound_at,bindings.skill_id`).all(workspaceId) as Array<{ id: string }>;
    return rows.map((row) => this.getSkillRevision(row.id)!);
  }

  replaceWorkspaceSkills(workspaceId: string, skillIds: readonly string[]): SkillRevision[] | undefined {
    return this.db.transaction(() => {
      if (!this.getSession(workspaceId)) return undefined;
      const uniqueIds = [...new Set(skillIds)];
      for (const skillId of uniqueIds) if (!this.getSkill(skillId)) return undefined;
      this.db.prepare("DELETE FROM workspace_skill_bindings WHERE session_id=?").run(workspaceId);
      const insert = this.db.prepare("INSERT INTO workspace_skill_bindings (session_id,skill_id,bound_at) VALUES (?,?,?)");
      const timestamp = now();
      uniqueIds.forEach((skillId, index) => insert.run(workspaceId, skillId, timestamp + index));
      this.db.prepare(`INSERT INTO workspace_skill_revisions (workspace_id,revision,updated_at) VALUES (?,2,?)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_skill_revisions.revision+1,updated_at=excluded.updated_at`)
        .run(workspaceId, timestamp);
      this.touchSession(workspaceId);
      return this.listWorkspaceSkills(workspaceId);
    })();
  }

  deleteSkill(skillId: string): SkillRevision[] | undefined {
    return this.db.transaction(() => {
      const revisions = this.listSkillRevisions(skillId);
      if (!revisions.length) return undefined;
      const workspaceIds = (this.db.prepare("SELECT session_id AS workspaceId FROM workspace_skill_bindings WHERE skill_id=?")
        .all(skillId) as Array<{ workspaceId: string }>).map((row) => row.workspaceId);
      this.db.prepare("DELETE FROM workspace_skill_bindings WHERE skill_id=?").run(skillId);
      this.db.prepare("DELETE FROM skill_revisions WHERE skill_id=?").run(skillId);
      this.db.prepare("DELETE FROM skills WHERE id=?").run(skillId);
      const timestamp = now();
      this.touchSkillCatalogRevision(timestamp);
      for (const workspaceId of workspaceIds) {
        this.db.prepare("UPDATE workspace_skill_revisions SET revision=revision+1,updated_at=? WHERE workspace_id=?")
          .run(timestamp, workspaceId);
        this.touchSession(workspaceId);
      }
      return revisions;
    })();
  }

  createRevisionProfile(
    input: CreateSkillRevisionInput,
    mutation: ProfileMutationContext,
  ): ProfileMutationResult<ProfileSkillMutationValue> {
    const skillId = input.skillId;
    return this.runSkillProfileMutation({
      mutation,
      endpointId: skillId ? "operator.skills.update" : "operator.skills.create",
      resourceType: skillId ? "skill" : "skill_catalog",
      resourceId: skillId ?? "catalog",
      operation: skillId ? "update" : "create",
      currentRevision: () => skillId ? this.getSkillResourceRevision(skillId) : this.getCatalogRevision(),
      perform: () => {
        const skill = this.createSkillRevision(input);
        const resourceRevision = this.getSkillResourceRevision(skill.skillId)!;
        return {
          value: { skill, resourceRevision, catalogRevision: this.getCatalogRevision() },
          resultingRevision: skillId ? resourceRevision : this.getCatalogRevision(),
        };
      },
    });
  }

  deleteSkillProfile(skillId: string, mutation: ProfileMutationContext): ProfileMutationResult<ProfileSkillDeleteValue> {
    return this.runSkillProfileMutation({
      mutation,
      endpointId: "operator.skills.delete",
      resourceType: "skill",
      resourceId: skillId,
      operation: "delete",
      currentRevision: () => this.getSkillResourceRevision(skillId),
      perform: () => {
        if (!this.deleteSkill(skillId)) throw new Error("Skill disappeared during deletion");
        const catalogRevision = this.getCatalogRevision();
        return { value: { ok: true, skillId, catalogRevision }, resultingRevision: catalogRevision };
      },
    });
  }

  replaceWorkspaceSkillsProfile(
    workspaceId: string,
    skillIds: readonly string[],
    mutation: ProfileMutationContext,
  ): ProfileMutationResult<ProfileWorkspaceSkillsMutationValue> {
    return this.runSkillProfileMutation({
      mutation,
      endpointId: "operator.workspace_skills.replace",
      resourceType: "workspace",
      resourceId: workspaceId,
      operation: "replace",
      currentRevision: () => this.getWorkspaceSkillRevision(workspaceId),
      perform: () => {
        const skills = this.replaceWorkspaceSkills(workspaceId, skillIds);
        if (!skills) throw new Error("Workspace Skill replacement became invalid");
        const bindingRevision = this.getWorkspaceSkillRevision(workspaceId)!;
        return { value: { skills, bindingRevision }, resultingRevision: bindingRevision };
      },
    }, () => skillIds.some((skillId) => !this.getSkill(skillId)) ? "state_conflict" : undefined);
  }

  private runSkillProfileMutation<T>(input: {
    mutation: ProfileMutationContext;
    endpointId: string;
    resourceType: string;
    resourceId: string;
    operation: string;
    currentRevision: () => number | undefined;
    perform: () => { value: T; resultingRevision: number };
  }, precondition?: () => "state_conflict" | undefined): ProfileMutationResult<T> {
    const identity = {
      principalId: input.mutation.principalId,
      profileId: "operator.skills.v1",
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
      const currentRevision = input.currentRevision();
      if (currentRevision === undefined) return { status: "not_found" };
      if (currentRevision !== input.mutation.expectedRevision) {
        return { status: "concurrency_conflict", currentRevision };
      }
      const rejected = precondition?.();
      if (rejected) return { status: rejected };
      const timestamp = now();
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
      this.db.prepare(`INSERT INTO profile_audit_events
        (id,principal_id,granted_scopes_json,delegated_actor_id,delegated_request_id,request_id,profile_id,
         endpoint_id,resource_type,resource_id,operation,outcome,error_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'succeeded','',?)`).run(
        randomUUID(), input.mutation.principalId, JSON.stringify([...input.mutation.grantedScopes]),
        input.mutation.delegatedActorId ?? null, input.mutation.delegatedRequestId ?? null,
        input.mutation.requestId, identity.profileId, identity.endpointId, identity.resourceType,
        identity.resourceId, input.operation, timestamp,
      );
      return { status: "succeeded", value: result.value, replayed: false };
    })();
  }


  private getSession(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id));
  }

  private touchSession(id: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  private touchSkillCatalogRevision(timestamp = now()): void {
    this.db.prepare("UPDATE skill_catalog_state SET revision=revision+1,updated_at=? WHERE id=1").run(timestamp);
  }
}

