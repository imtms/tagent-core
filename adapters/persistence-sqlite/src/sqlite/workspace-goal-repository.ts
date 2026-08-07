import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  workspaceGoalContentHash,
  workspaceGoalNextAction,
  type CreateWorkspaceGoalInput,
  type LinkWorkspaceGoalEvidenceInput,
  type LinkWorkspaceGoalRunInput,
  type WorkspaceGoal,
  type WorkspaceGoalDecision,
  type WorkspaceGoalDecisionInput,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalEvidenceLink,
  type WorkspaceGoalPlan,
  type WorkspaceGoalRepository,
  type WorkspaceGoalRevision,
  type WorkspaceGoalRunLink,
  type WorkspaceGoalStatus,
  type WorkspaceGoalSummary,
} from "@tagent/governance";

const now = () => Date.now();

interface GoalRow { id: string; workspaceId: string; status: WorkspaceGoalStatus; activeDefinitionRevisionId: string | null; activePlanRevisionId: string | null; currentRunId: string | null; createdAt: number; updatedAt: number; completedAt: number | null }

export class SqliteWorkspaceGoalRepository implements WorkspaceGoalRepository {
  constructor(private readonly db: Database.Database) {}

  createGoal(input: CreateWorkspaceGoalInput): WorkspaceGoal {
    const payloadHash = workspaceGoalContentHash({ workspaceId: input.workspaceId, definition: input.definition, createdBy: input.createdBy });
    if (input.idempotencyKey) {
      const request = this.db.prepare("SELECT goal_id as goalId,payload_hash as payloadHash FROM workspace_goal_requests WHERE idempotency_key=?").get(input.idempotencyKey) as { goalId: string; payloadHash: string } | undefined;
      if (request) {
        if (request.payloadHash !== payloadHash) throw new Error("workspace Goal idempotency conflict");
        return this.requireGoal(request.goalId);
      }
    }
    const createdAt = now();
    const goalId = randomUUID();
    const revision = revisionRecord(goalId, "definition", 1, input.definition, null, input.createdBy, createdAt);
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(input.workspaceId)) throw new Error("workspace not found");
      this.db.prepare(`INSERT INTO workspace_goals
        (id,workspace_id,status,active_definition_revision_id,active_plan_revision_id,current_run_id,created_at,updated_at,completed_at)
        VALUES (?,?, 'draft',NULL,NULL,NULL,?,?,NULL)`).run(goalId, input.workspaceId, createdAt, createdAt);
      insertRevision(this.db, revision);
      if (input.idempotencyKey) this.db.prepare("INSERT INTO workspace_goal_requests (idempotency_key,goal_id,payload_hash,created_at) VALUES (?,?,?,?)").run(input.idempotencyKey, goalId, payloadHash, createdAt);
    })();
    return this.requireGoal(goalId);
  }

  listGoals(workspaceId: string): WorkspaceGoalSummary[] {
    return (this.db.prepare(`SELECT id,workspace_id as workspaceId,status,active_definition_revision_id as activeDefinitionRevisionId,
      active_plan_revision_id as activePlanRevisionId,current_run_id as currentRunId,created_at as createdAt,updated_at as updatedAt,
      completed_at as completedAt FROM workspace_goals WHERE workspace_id=? ORDER BY updated_at DESC`).all(workspaceId) as GoalRow[])
      .map((row) => this.summary(row));
  }

  getGoal(goalId: string): WorkspaceGoal | null {
    const row = this.goalRow(goalId);
    if (!row) return null;
    const definition = row.activeDefinitionRevisionId ? this.revision(row.activeDefinitionRevisionId) : this.latestRevision(goalId, "definition");
    const plan = row.activePlanRevisionId ? this.revision(row.activePlanRevisionId) : this.latestRevision(goalId, "plan");
    const decisions = this.decisions(goalId);
    const runLinks = this.runLinks(goalId);
    const evidenceLinks = this.evidenceLinks(goalId);
    const criteria = definition ? definitionContent(definition).criteria : [];
    const requiredKeys = criteria.filter((item) => item.required).map((item) => item.key);
    const validKeys = new Set(evidenceLinks.filter((item) => item.status === "valid").map((item) => item.criterionKey));
    const hasApprovedDefinition = decisions.some((item) => item.kind === "approve_goal" && item.targetRevisionId === definition?.id && item.targetHash === definition.contentHash);
    const hasApprovedPlan = decisions.some((item) => item.kind === "approve_plan" && item.targetRevisionId === plan?.id && item.targetHash === plan.contentHash && item.approvedItemIds.length > 0);
    const verifiedCriteria = requiredKeys.filter((key) => validKeys.has(key)).length;
    return {
      ...row,
      definition,
      plan,
      decisions,
      runLinks,
      evidenceLinks,
      requiredCriteria: requiredKeys.length,
      verifiedCriteria,
      nextAction: workspaceGoalNextAction({ status: row.status, hasDefinition: Boolean(definition), hasApprovedDefinition, hasPlan: Boolean(plan), hasApprovedPlan, currentRunId: row.currentRunId, requiredCriteria: requiredKeys.length, verifiedCriteria }),
    };
  }

  addDefinitionRevision(goalId: string, definition: WorkspaceGoalDefinition, createdBy: string): WorkspaceGoalRevision {
    return this.addRevision(goalId, "definition", definition, null, createdBy);
  }

  addPlanRevision(goalId: string, content: WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision {
    return this.addRevision(goalId, "plan", content, sourceArtifactId, createdBy);
  }

  decideGoal(input: WorkspaceGoalDecisionInput): WorkspaceGoalDecision {
    const goal = this.requireGoal(input.goalId);
    const revision = this.revision(input.targetRevisionId);
    if (!revision || revision.goalId !== input.goalId || revision.contentHash !== input.targetHash) throw new Error("workspace Goal revision is stale");
    if (input.kind === "approve_goal" && revision.kind !== "definition") throw new Error("approve_goal requires a definition revision");
    if (input.kind === "approve_plan" && revision.kind !== "plan") throw new Error("approve_plan requires a plan revision");
    if (input.kind === "approve_plan") {
      const plan = planContent(revision);
      const knownItemIds = new Set(plan.items.map((item) => item.id));
      if (!input.approvedItemIds?.length) throw new Error("approve_plan requires at least one approved item");
      if (input.approvedItemIds.some((itemId) => !knownItemIds.has(itemId))) throw new Error("approve_plan contains an unknown plan item");
    }
    const existing = this.db.prepare(`SELECT id,goal_id as goalId,target_revision_id as targetRevisionId,target_hash as targetHash,kind,
      approved_item_ids_json as approvedItemIdsJson,reason,actor_id as actorId,created_at as createdAt FROM workspace_goal_decisions
      WHERE goal_id=? AND kind=? AND target_revision_id=? AND target_hash=? AND actor_id=?`).get(input.goalId, input.kind, input.targetRevisionId, input.targetHash, input.actorId) as (Omit<WorkspaceGoalDecision, "approvedItemIds"> & { approvedItemIdsJson: string }) | undefined;
    if (existing) return decisionFromRow(existing);
    const createdAt = now();
    const decision: WorkspaceGoalDecision = { id: randomUUID(), goalId: input.goalId, targetRevisionId: input.targetRevisionId, targetHash: input.targetHash, kind: input.kind, approvedItemIds: input.approvedItemIds ?? [], reason: input.reason ?? "", actorId: input.actorId, createdAt };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspace_goal_decisions
        (id,goal_id,target_revision_id,target_hash,kind,approved_item_ids_json,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(decision.id, decision.goalId, decision.targetRevisionId, decision.targetHash, decision.kind, JSON.stringify(decision.approvedItemIds), decision.reason, decision.actorId, createdAt);
      let status = goal.status;
      let definitionId = goal.activeDefinitionRevisionId;
      let planId = goal.activePlanRevisionId;
      let completedAt = goal.completedAt;
      if (input.kind === "approve_goal") { status = "active"; definitionId = revision.id; planId = null; }
      if (input.kind === "approve_plan") { status = "active"; planId = revision.id; }
      if (input.kind === "request_change") status = "draft";
      if (input.kind === "pause") status = "paused";
      if (input.kind === "resume") status = "active";
      if (input.kind === "cancel") { status = "cancelled"; completedAt = createdAt; }
      if (input.kind === "close") {
        const projected = this.requireGoal(input.goalId);
        if (projected.requiredCriteria === 0 || projected.verifiedCriteria < projected.requiredCriteria) throw new Error("workspace Goal is not ready to close");
        status = "completed"; completedAt = createdAt;
      }
      this.db.prepare(`UPDATE workspace_goals SET status=?,active_definition_revision_id=?,active_plan_revision_id=?,updated_at=?,completed_at=? WHERE id=?`)
        .run(status, definitionId, planId, createdAt, completedAt, input.goalId);
    })();
    return decision;
  }

  linkRun(input: LinkWorkspaceGoalRunInput): WorkspaceGoal {
    const goal = this.requireGoal(input.goalId);
    const run = this.db.prepare("SELECT session_id as workspaceId FROM runs WHERE id=?").get(input.runId) as { workspaceId: string } | undefined;
    if (!run) throw new Error("TaskRun not found");
    if (run.workspaceId !== goal.workspaceId) throw new Error("TaskRun belongs to a different workspace");
    if (goal.status !== "active") throw new Error("workspace Goal must be active before linking a TaskRun");
    if (input.goalRevision !== goal.definition?.revision) throw new Error("workspace Goal definition revision is stale");
    if (input.criterionKeys?.some((key) => !definitionContent(goal.definition!).criteria.some((criterion) => criterion.key === key))) throw new Error("criterion not found");
    if (input.planRevisionId) {
      const plan = this.revision(input.planRevisionId);
      if (!plan || plan.goalId !== input.goalId || plan.kind !== "plan") throw new Error("plan revision not found");
      if (goal.activePlanRevisionId !== plan.id) throw new Error("plan revision is not active");
      const approval = goal.decisions.find((item) => item.kind === "approve_plan" && item.targetRevisionId === plan.id && item.targetHash === plan.contentHash);
      if (!approval) throw new Error("plan revision is not approved");
      if (input.approvedItemIds?.some((itemId) => !approval.approvedItemIds.includes(itemId))) throw new Error("TaskRun exceeds the approved plan slice");
    }
    const createdAt = now();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspace_goal_run_links
        (goal_id,run_id,goal_revision,plan_revision_id,approved_item_ids_json,criterion_keys_json,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(input.goalId, input.runId, input.goalRevision, input.planRevisionId ?? null, JSON.stringify(input.approvedItemIds ?? []), JSON.stringify(input.criterionKeys ?? []), createdAt);
      this.db.prepare("UPDATE workspace_goals SET current_run_id=?,updated_at=? WHERE id=?").run(input.runId, createdAt, goal.id);
    })();
    return this.requireGoal(input.goalId);
  }

  linkEvidence(input: LinkWorkspaceGoalEvidenceInput): WorkspaceGoalEvidenceLink {
    const goal = this.requireGoal(input.goalId);
    const run = this.db.prepare("SELECT session_id as workspaceId FROM runs WHERE id=?").get(input.runId) as { workspaceId: string } | undefined;
    if (!run) throw new Error("TaskRun not found");
    if (run.workspaceId !== goal.workspaceId) throw new Error("TaskRun belongs to a different workspace");
    const definition = goal.definition;
    if (!definition || input.goalRevision !== definition.revision) throw new Error("workspace Goal definition revision is stale");
    if (!definitionContent(definition).criteria.some((criterion) => criterion.key === input.criterionKey)) throw new Error("criterion not found");
    if (!goal.runLinks.some((link) => link.runId === input.runId)) throw new Error("TaskRun is not linked to this workspace Goal");
    if (!input.checkKey && !input.artifactId && !input.operationId) throw new Error("evidence must reference a check, artifact or operation");
    if (input.checkKey) {
      const check = this.db.prepare("SELECT status,stale,evidence FROM run_checks WHERE run_id=? AND check_key=?").get(input.runId, input.checkKey) as { status: string; stale: number; evidence: string } | undefined;
      if (!check) throw new Error("check evidence not found");
      if (input.status !== "stale" && input.status !== "contradicted" && (check.status !== "passed" || check.stale !== 0 || !check.evidence.trim())) throw new Error("check evidence is not valid");
    }
    if (input.artifactId && !this.db.prepare("SELECT 1 FROM artifacts WHERE run_id=? AND id=?").get(input.runId, input.artifactId)) throw new Error("artifact evidence not found");
    if (input.operationId) {
      const operation = this.db.prepare("SELECT status FROM operations WHERE run_id=? AND id=?").get(input.runId, input.operationId) as { status: string } | undefined;
      if (!operation) throw new Error("operation evidence not found");
      if (input.status !== "stale" && input.status !== "contradicted" && operation.status !== "succeeded") throw new Error("operation evidence is not valid");
    }
    const timestamp = now();
    const existing = this.db.prepare(`SELECT id FROM workspace_goal_evidence_links WHERE goal_id=? AND goal_revision=? AND criterion_key=? AND source_digest=?`)
      .get(input.goalId, input.goalRevision, input.criterionKey, input.sourceDigest) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db.prepare(`INSERT INTO workspace_goal_evidence_links
      (id,goal_id,goal_revision,criterion_key,run_id,check_key,artifact_id,operation_id,source_digest,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id,goal_revision,criterion_key,source_digest) DO UPDATE SET
      run_id=excluded.run_id,check_key=excluded.check_key,artifact_id=excluded.artifact_id,operation_id=excluded.operation_id,status=excluded.status,updated_at=excluded.updated_at`)
      .run(id, input.goalId, input.goalRevision, input.criterionKey, input.runId, input.checkKey ?? null, input.artifactId ?? null, input.operationId ?? null, input.sourceDigest, input.status ?? "valid", timestamp, timestamp);
    const projected = this.evidenceLinks(input.goalId).find((item) => item.id === id)!;
    const refreshed = this.requireGoal(input.goalId);
    if (refreshed.requiredCriteria > 0 && refreshed.verifiedCriteria >= refreshed.requiredCriteria && !["completed", "cancelled"].includes(refreshed.status)) {
      this.db.prepare("UPDATE workspace_goals SET status='ready_to_close',current_run_id=NULL,updated_at=? WHERE id=?").run(timestamp, input.goalId);
    }
    return projected;
  }

  private addRevision(goalId: string, kind: "definition" | "plan", content: WorkspaceGoalDefinition | WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision {
    const goal = this.requireGoal(goalId);
    if (["completed", "cancelled"].includes(goal.status)) throw new Error("terminal workspace Goal cannot be revised");
    const revisionNumber = Number((this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 as revision FROM workspace_goal_revisions WHERE goal_id=? AND kind=?").get(goalId, kind) as { revision: number }).revision);
    const revision = revisionRecord(goalId, kind, revisionNumber, content, sourceArtifactId, createdBy, now());
    insertRevision(this.db, revision);
    const status = kind === "definition" ? "draft" : goal.status;
    this.db.prepare(`UPDATE workspace_goals SET status=?,
      active_definition_revision_id=CASE WHEN ?='definition' THEN NULL ELSE active_definition_revision_id END,
      active_plan_revision_id=CASE WHEN ?='plan' OR ?='definition' THEN NULL ELSE active_plan_revision_id END,
      updated_at=? WHERE id=?`)
      .run(status, kind, kind, kind, revision.createdAt, goalId);
    return revision;
  }

  private summary(row: GoalRow): WorkspaceGoalSummary {
    const goal = this.getGoal(row.id)!;
    const definition = goal.definition ? definitionContent(goal.definition) : null;
    return { id: row.id, workspaceId: row.workspaceId, status: row.status, title: definition?.title ?? "Untitled Goal", outcome: definition?.outcome ?? "", requiredCriteria: goal.requiredCriteria, verifiedCriteria: goal.verifiedCriteria, currentRunId: row.currentRunId, nextAction: goal.nextAction, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  private requireGoal(goalId: string): WorkspaceGoal {
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error("workspace Goal not found");
    return goal;
  }
  private goalRow(goalId: string): GoalRow | null { return (this.db.prepare(`SELECT id,workspace_id as workspaceId,status,active_definition_revision_id as activeDefinitionRevisionId,active_plan_revision_id as activePlanRevisionId,current_run_id as currentRunId,created_at as createdAt,updated_at as updatedAt,completed_at as completedAt FROM workspace_goals WHERE id=?`).get(goalId) as GoalRow | undefined) ?? null; }
  private revision(id: string): WorkspaceGoalRevision | null { const row = this.db.prepare(`SELECT id,goal_id as goalId,kind,revision,content_json as contentJson,content_hash as contentHash,source_artifact_id as sourceArtifactId,created_by as createdBy,created_at as createdAt FROM workspace_goal_revisions WHERE id=?`).get(id) as RevisionRow | undefined; return row ? revisionFromRow(row) : null; }
  private latestRevision(goalId: string, kind: "definition" | "plan"): WorkspaceGoalRevision | null { const row = this.db.prepare(`SELECT id,goal_id as goalId,kind,revision,content_json as contentJson,content_hash as contentHash,source_artifact_id as sourceArtifactId,created_by as createdBy,created_at as createdAt FROM workspace_goal_revisions WHERE goal_id=? AND kind=? ORDER BY revision DESC LIMIT 1`).get(goalId, kind) as RevisionRow | undefined; return row ? revisionFromRow(row) : null; }
  private decisions(goalId: string): WorkspaceGoalDecision[] { return (this.db.prepare(`SELECT id,goal_id as goalId,target_revision_id as targetRevisionId,target_hash as targetHash,kind,approved_item_ids_json as approvedItemIdsJson,reason,actor_id as actorId,created_at as createdAt FROM workspace_goal_decisions WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as Array<Omit<WorkspaceGoalDecision, "approvedItemIds"> & { approvedItemIdsJson: string }>).map(decisionFromRow); }
  private runLinks(goalId: string): WorkspaceGoalRunLink[] { return (this.db.prepare(`SELECT goal_id as goalId,run_id as runId,goal_revision as goalRevision,plan_revision_id as planRevisionId,approved_item_ids_json as approvedItemIdsJson,criterion_keys_json as criterionKeysJson,created_at as createdAt FROM workspace_goal_run_links WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as Array<Omit<WorkspaceGoalRunLink, "approvedItemIds" | "criterionKeys"> & { approvedItemIdsJson: string; criterionKeysJson: string }>).map((row) => ({ ...row, approvedItemIds: JSON.parse(row.approvedItemIdsJson) as string[], criterionKeys: JSON.parse(row.criterionKeysJson) as string[] })); }
  private evidenceLinks(goalId: string): WorkspaceGoalEvidenceLink[] { return this.db.prepare(`SELECT id,goal_id as goalId,goal_revision as goalRevision,criterion_key as criterionKey,run_id as runId,check_key as checkKey,artifact_id as artifactId,operation_id as operationId,source_digest as sourceDigest,status,created_at as createdAt,updated_at as updatedAt FROM workspace_goal_evidence_links WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as WorkspaceGoalEvidenceLink[]; }
}

interface RevisionRow { id: string; goalId: string; kind: "definition" | "plan"; revision: number; contentJson: string; contentHash: string; sourceArtifactId: string | null; createdBy: string; createdAt: number }
function revisionRecord(goalId: string, kind: "definition" | "plan", revision: number, content: WorkspaceGoalDefinition | WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string, createdAt: number): WorkspaceGoalRevision { return { id: randomUUID(), goalId, kind, revision, content, contentHash: workspaceGoalContentHash(content), sourceArtifactId, createdBy, createdAt }; }
function insertRevision(db: Database.Database, revision: WorkspaceGoalRevision): void { db.prepare(`INSERT INTO workspace_goal_revisions (id,goal_id,kind,revision,content_json,content_hash,source_artifact_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(revision.id, revision.goalId, revision.kind, revision.revision, JSON.stringify(revision.content), revision.contentHash, revision.sourceArtifactId, revision.createdBy, revision.createdAt); }
function revisionFromRow(row: RevisionRow): WorkspaceGoalRevision { return { ...row, content: JSON.parse(row.contentJson) as WorkspaceGoalDefinition | WorkspaceGoalPlan }; }
function definitionContent(revision: WorkspaceGoalRevision): WorkspaceGoalDefinition { return revision.content as WorkspaceGoalDefinition; }
function planContent(revision: WorkspaceGoalRevision): WorkspaceGoalPlan { return revision.content as WorkspaceGoalPlan; }
function decisionFromRow(row: Omit<WorkspaceGoalDecision, "approvedItemIds"> & { approvedItemIdsJson: string }): WorkspaceGoalDecision { const { approvedItemIdsJson, ...decision } = row; return { ...decision, approvedItemIds: JSON.parse(approvedItemIdsJson) as string[] }; }
