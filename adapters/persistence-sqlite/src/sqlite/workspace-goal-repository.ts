import { createHash, randomUUID } from "node:crypto";
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
  type WorkspaceGoalEvidenceStatus,
  type WorkspaceGoalPlan,
  type WorkspaceGoalRepository,
  type WorkspaceGoalRevision,
  type WorkspaceGoalRunLink,
  type WorkspaceGoalStatus,
  type WorkspaceGoalSummary,
} from "@tagent/governance";

const now = () => Date.now();
const TERMINAL_STATUSES = new Set<WorkspaceGoalStatus>(["completed", "cancelled"]);

interface GoalRow { id: string; workspaceId: string; status: WorkspaceGoalStatus; activeDefinitionRevisionId: string | null; activePlanRevisionId: string | null; currentRunId: string | null; createdAt: number; updatedAt: number; completedAt: number | null }
interface RevisionRow { id: string; goalId: string; kind: "definition" | "plan"; revision: number; contentJson: string; contentHash: string; sourceArtifactId: string | null; createdBy: string; createdAt: number }
interface DecisionRow { id: string; requestId: string | null; payloadHash: string; goalId: string; targetRevisionId: string; targetHash: string; kind: WorkspaceGoalDecision["kind"]; approvedItemIdsJson: string; reason: string; actorId: string; createdAt: number }

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
    const evidenceLinks = this.evidenceLinks(goalId).map((link) => this.projectEvidence(link));
    const currentRunId = this.projectCurrentRunId(row.currentRunId);
    const criteria = definition ? definitionContent(definition).criteria : [];
    const requiredKeys = criteria.filter((item) => item.required).map((item) => item.key);
    const validKeys = new Set(evidenceLinks.filter((item) => item.status === "valid").map((item) => item.criterionKey));
    const contradictedKeys = new Set(evidenceLinks.filter((item) => item.status === "contradicted").map((item) => item.criterionKey));
    const hasApprovedDefinition = decisions.some((item) => item.kind === "approve_goal" && item.targetRevisionId === definition?.id && item.targetHash === definition.contentHash);
    const hasApprovedPlan = decisions.some((item) => item.kind === "approve_plan" && item.targetRevisionId === plan?.id && item.targetHash === plan.contentHash && item.approvedItemIds.length > 0);
    const verifiedCriteria = requiredKeys.filter((key) => validKeys.has(key) && !contradictedKeys.has(key)).length;
    let status = row.status;
    if (status === "ready_to_close" && verifiedCriteria < requiredKeys.length) status = "active";
    return {
      ...row,
      status,
      currentRunId,
      definition,
      plan,
      decisions,
      runLinks,
      evidenceLinks,
      requiredCriteria: requiredKeys.length,
      verifiedCriteria,
      nextAction: workspaceGoalNextAction({ status, hasDefinition: Boolean(definition), hasApprovedDefinition, hasPlan: Boolean(plan), hasApprovedPlan, currentRunId, requiredCriteria: requiredKeys.length, verifiedCriteria }),
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
    this.assertDecisionAllowed(goal.status, input.kind);
    const revision = this.revision(input.targetRevisionId);
    if (!revision || revision.goalId !== input.goalId || revision.contentHash !== input.targetHash) throw new Error("workspace Goal revision is stale");
    if (input.kind === "approve_goal" && revision.kind !== "definition") throw new Error("approve_goal requires a definition revision");
    if (input.kind === "approve_plan" && revision.kind !== "plan") throw new Error("approve_plan requires a plan revision");
    const approvedItemIds = [...new Set(input.approvedItemIds ?? [])].sort();
    if (input.kind === "approve_plan") {
      const knownItemIds = new Set(planContent(revision).items.map((item) => item.id));
      if (!approvedItemIds.length) throw new Error("approve_plan requires at least one approved item");
      if (approvedItemIds.some((itemId) => !knownItemIds.has(itemId))) throw new Error("approve_plan contains an unknown plan item");
    }
    const requestId = input.requestId?.trim() || `legacy:${input.kind}:${input.targetRevisionId}:${input.actorId}`;
    const reason = input.reason ?? "";
    const payloadHash = workspaceGoalContentHash({ goalId: input.goalId, targetRevisionId: input.targetRevisionId, targetHash: input.targetHash, kind: input.kind, approvedItemIds, reason, actorId: input.actorId });
    const existing = this.db.prepare(`SELECT id,request_id as requestId,payload_hash as payloadHash,goal_id as goalId,target_revision_id as targetRevisionId,target_hash as targetHash,kind,
      approved_item_ids_json as approvedItemIdsJson,reason,actor_id as actorId,created_at as createdAt FROM workspace_goal_decisions
      WHERE goal_id=? AND request_id=?`).get(input.goalId, requestId) as DecisionRow | undefined;
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("workspace Goal decision idempotency conflict");
      return decisionFromRow(existing);
    }
    const createdAt = now();
    const decision: WorkspaceGoalDecision = { id: randomUUID(), requestId, payloadHash, goalId: input.goalId, targetRevisionId: input.targetRevisionId, targetHash: input.targetHash, kind: input.kind, approvedItemIds, reason, actorId: input.actorId, createdAt };
    this.db.transaction(() => {
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
        if (goal.requiredCriteria === 0 || goal.verifiedCriteria < goal.requiredCriteria) throw new Error("workspace Goal is not ready to close");
        status = "completed";
        completedAt = createdAt;
      }
      this.db.prepare(`INSERT INTO workspace_goal_decisions
        (id,request_id,payload_hash,goal_id,target_revision_id,target_hash,kind,approved_item_ids_json,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(decision.id, decision.requestId, decision.payloadHash, decision.goalId, decision.targetRevisionId, decision.targetHash, decision.kind, JSON.stringify(decision.approvedItemIds), decision.reason, decision.actorId, createdAt);
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
    const priorMutation = this.db.prepare(`SELECT 1 FROM operations WHERE run_id=? AND operation_type IN ('tool.write','tool.edit','tool.patch','tool.bash') LIMIT 1`).get(input.runId);
    if (priorMutation) throw new Error("TaskRun cannot be linked to a workspace Goal after mutation has started");
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

  authorizeRunMutation(runId: string): { allowed: boolean; reason: string } {
    const links = this.db.prepare(`SELECT goal_id as goalId,goal_revision as goalRevision,plan_revision_id as planRevisionId,approved_item_ids_json as approvedItemIdsJson FROM workspace_goal_run_links WHERE run_id=?`).all(runId) as Array<{ goalId: string; goalRevision: number; planRevisionId: string | null; approvedItemIdsJson: string }>;
    if (!links.length) return { allowed: true, reason: "ordinary TaskRun is not Goal-governed" };
    if (links.length !== 1) return { allowed: false, reason: "Goal-governed TaskRun has an ambiguous Goal link" };
    const link = links[0];
    const goal = this.getGoal(link.goalId);
    if (!goal || goal.status !== "active") return { allowed: false, reason: "Workspace Goal is not active" };
    if (!goal.definition || goal.definition.revision !== link.goalRevision || goal.activeDefinitionRevisionId !== goal.definition.id) return { allowed: false, reason: "Workspace Goal definition approval is stale" };
    if (!link.planRevisionId || goal.activePlanRevisionId !== link.planRevisionId || goal.plan?.id !== link.planRevisionId) return { allowed: false, reason: "Workspace Goal Plan is not active" };
    const approvedItemIds = JSON.parse(link.approvedItemIdsJson) as string[];
    const approval = goal.decisions.find((item) => item.kind === "approve_plan" && item.targetRevisionId === link.planRevisionId && item.targetHash === goal.plan?.contentHash);
    if (!approval || !approvedItemIds.length || approvedItemIds.some((itemId) => !approval.approvedItemIds.includes(itemId))) return { allowed: false, reason: "TaskRun exceeds the approved Goal Plan slice" };
    return { allowed: true, reason: "Goal Plan slice is approved" };
  }

  linkEvidence(input: LinkWorkspaceGoalEvidenceInput): WorkspaceGoalEvidenceLink {
    const goal = this.requireGoal(input.goalId);
    if (TERMINAL_STATUSES.has(goal.status)) throw new Error("terminal workspace Goal cannot accept evidence");
    const run = this.db.prepare("SELECT session_id as workspaceId FROM runs WHERE id=?").get(input.runId) as { workspaceId: string } | undefined;
    if (!run) throw new Error("TaskRun not found");
    if (run.workspaceId !== goal.workspaceId) throw new Error("TaskRun belongs to a different workspace");
    const definition = goal.definition;
    if (!definition || input.goalRevision !== definition.revision) throw new Error("workspace Goal definition revision is stale");
    if (!definitionContent(definition).criteria.some((criterion) => criterion.key === input.criterionKey)) throw new Error("criterion not found");
    if (!goal.runLinks.some((link) => link.runId === input.runId)) throw new Error("TaskRun is not linked to this workspace Goal");
    if (!input.checkKey && !input.artifactId && !input.operationId) throw new Error("evidence must reference a check, artifact or operation");
    const status = input.status ?? "valid";
    const sourceDigest = this.computeEvidenceDigest(input, status);
    const requestId = input.requestId?.trim();
    const requestHash = workspaceGoalContentHash({ ...input, requestId: undefined, sourceDigest, status });
    if (requestId) {
      const request = this.db.prepare("SELECT payload_hash as payloadHash,evidence_link_id as evidenceLinkId FROM workspace_goal_evidence_requests WHERE goal_id=? AND request_id=?").get(input.goalId, requestId) as { payloadHash: string; evidenceLinkId: string } | undefined;
      if (request) {
        if (request.payloadHash !== requestHash) throw new Error("workspace Goal evidence idempotency conflict");
        return this.evidenceLinks(input.goalId).find((item) => item.id === request.evidenceLinkId)!;
      }
    }
    const timestamp = now();
    const existing = this.db.prepare(`SELECT id FROM workspace_goal_evidence_links WHERE goal_id=? AND goal_revision=? AND criterion_key=? AND source_digest=?`)
      .get(input.goalId, input.goalRevision, input.criterionKey, sourceDigest) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspace_goal_evidence_links
        (id,goal_id,goal_revision,criterion_key,run_id,check_key,artifact_id,operation_id,source_digest,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id,goal_revision,criterion_key,source_digest) DO UPDATE SET
        run_id=excluded.run_id,check_key=excluded.check_key,artifact_id=excluded.artifact_id,operation_id=excluded.operation_id,status=excluded.status,updated_at=excluded.updated_at`)
        .run(id, input.goalId, input.goalRevision, input.criterionKey, input.runId, input.checkKey ?? null, input.artifactId ?? null, input.operationId ?? null, sourceDigest, status, timestamp, timestamp);
      if (requestId) this.db.prepare("INSERT INTO workspace_goal_evidence_requests (goal_id,request_id,payload_hash,evidence_link_id,created_at) VALUES (?,?,?,?,?)")
        .run(input.goalId, requestId, requestHash, id, timestamp);
      const refreshed = this.requireGoal(input.goalId);
      const ready = refreshed.requiredCriteria > 0 && refreshed.verifiedCriteria >= refreshed.requiredCriteria;
      if (ready) this.db.prepare("UPDATE workspace_goals SET status='ready_to_close',current_run_id=NULL,updated_at=? WHERE id=?").run(timestamp, input.goalId);
      else if (refreshed.status === "ready_to_close") this.db.prepare("UPDATE workspace_goals SET status='active',updated_at=? WHERE id=?").run(timestamp, input.goalId);
    })();
    return this.evidenceLinks(input.goalId).find((item) => item.id === id)!;
  }

  private addRevision(goalId: string, kind: "definition" | "plan", content: WorkspaceGoalDefinition | WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision {
    const goal = this.requireGoal(goalId);
    if (TERMINAL_STATUSES.has(goal.status)) throw new Error("terminal workspace Goal cannot be revised");
    const revisionNumber = Number((this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 as revision FROM workspace_goal_revisions WHERE goal_id=? AND kind=?").get(goalId, kind) as { revision: number }).revision);
    const revision = revisionRecord(goalId, kind, revisionNumber, content, sourceArtifactId, createdBy, now());
    this.db.transaction(() => {
      insertRevision(this.db, revision);
      const status = kind === "definition" ? "draft" : goal.status;
      this.db.prepare(`UPDATE workspace_goals SET status=?,
        active_definition_revision_id=CASE WHEN ?='definition' THEN NULL ELSE active_definition_revision_id END,
        active_plan_revision_id=CASE WHEN ?='plan' OR ?='definition' THEN NULL ELSE active_plan_revision_id END,
        updated_at=? WHERE id=?`)
        .run(status, kind, kind, kind, revision.createdAt, goalId);
    })();
    return revision;
  }

  private assertDecisionAllowed(status: WorkspaceGoalStatus, kind: WorkspaceGoalDecision["kind"]): void {
    if (TERMINAL_STATUSES.has(status)) throw new Error("terminal workspace Goal cannot accept decisions");
    if (kind === "resume" && status !== "paused") throw new Error("only a paused workspace Goal can be resumed");
    if (kind === "pause" && !["active", "ready_to_close"].includes(status)) throw new Error("only an active workspace Goal can be paused");
    if (kind === "close" && status !== "ready_to_close") throw new Error("workspace Goal is not ready to close");
    if (kind === "approve_plan" && status === "draft") throw new Error("workspace Goal definition must be approved before plan approval");
  }

  private computeEvidenceDigest(input: LinkWorkspaceGoalEvidenceInput, requestedStatus: WorkspaceGoalEvidenceStatus): string {
    const facts: Record<string, unknown> = { runId: input.runId };
    if (input.checkKey) {
      const check = this.db.prepare("SELECT status,stale,evidence,command,title FROM run_checks WHERE run_id=? AND check_key=?").get(input.runId, input.checkKey) as { status: string; stale: number; evidence: string; command: string; title: string } | undefined;
      if (!check) throw new Error("check evidence not found");
      if (requestedStatus === "valid" && (check.status !== "passed" || check.stale !== 0 || !check.evidence.trim())) throw new Error("check evidence is not valid");
      facts.check = { key: input.checkKey, ...check };
    }
    if (input.artifactId) {
      const artifact = this.db.prepare("SELECT kind,title,content,uri,created_at as createdAt FROM artifacts WHERE run_id=? AND id=?").get(input.runId, input.artifactId) as { kind: string; title: string; content: string; uri: string; createdAt: number } | undefined;
      if (!artifact) throw new Error("artifact evidence not found");
      const contentHash = artifact.content ? sha256(Buffer.from(artifact.content)) : artifact.uri ? `content-addressed-uri:${artifact.uri}` : "missing";
      facts.artifact = { id: input.artifactId, ...artifact, content: undefined, contentHash };
      if (requestedStatus === "valid" && contentHash === "missing") throw new Error("artifact evidence is not readable");
    }
    if (input.operationId) {
      const operation = this.db.prepare("SELECT operation_type as operationType,payload_hash as payloadHash,status,stage,effects_json as effectsJson,result_json as resultJson,error,completed_at as completedAt FROM operations WHERE run_id=? AND id=?").get(input.runId, input.operationId) as Record<string, unknown> | undefined;
      if (!operation) throw new Error("operation evidence not found");
      if (requestedStatus === "valid" && operation.status !== "succeeded") throw new Error("operation evidence is not valid");
      facts.operation = { id: input.operationId, ...operation };
    }
    return `sha256:${workspaceGoalContentHash(facts)}`;
  }

  private projectEvidence(link: WorkspaceGoalEvidenceLink): WorkspaceGoalEvidenceLink {
    if (link.status === "contradicted") return link;
    try {
      const currentDigest = this.computeEvidenceDigest(link, "valid");
      return { ...link, status: currentDigest === link.sourceDigest ? "valid" : "stale" };
    } catch {
      return { ...link, status: "stale" };
    }
  }

  private projectCurrentRunId(runId: string | null): string | null {
    if (!runId) return null;
    const run = this.db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status: string } | undefined;
    return run && ["running", "waiting_input", "interrupted"].includes(run.status) ? runId : null;
  }

  private summary(row: GoalRow): WorkspaceGoalSummary {
    const goal = this.getGoal(row.id)!;
    const definition = goal.definition ? definitionContent(goal.definition) : null;
    return { id: row.id, workspaceId: row.workspaceId, status: goal.status, title: definition?.title ?? "Untitled Goal", outcome: definition?.outcome ?? "", requiredCriteria: goal.requiredCriteria, verifiedCriteria: goal.verifiedCriteria, currentRunId: goal.currentRunId, nextAction: goal.nextAction, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  private requireGoal(goalId: string): WorkspaceGoal {
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error("workspace Goal not found");
    return goal;
  }

  private goalRow(goalId: string): GoalRow | null { return (this.db.prepare(`SELECT id,workspace_id as workspaceId,status,active_definition_revision_id as activeDefinitionRevisionId,active_plan_revision_id as activePlanRevisionId,current_run_id as currentRunId,created_at as createdAt,updated_at as updatedAt,completed_at as completedAt FROM workspace_goals WHERE id=?`).get(goalId) as GoalRow | undefined) ?? null; }
  private revision(id: string): WorkspaceGoalRevision | null { const row = this.db.prepare(`SELECT id,goal_id as goalId,kind,revision,content_json as contentJson,content_hash as contentHash,source_artifact_id as sourceArtifactId,created_by as createdBy,created_at as createdAt FROM workspace_goal_revisions WHERE id=?`).get(id) as RevisionRow | undefined; return row ? revisionFromRow(row) : null; }
  private latestRevision(goalId: string, kind: "definition" | "plan"): WorkspaceGoalRevision | null { const row = this.db.prepare(`SELECT id,goal_id as goalId,kind,revision,content_json as contentJson,content_hash as contentHash,source_artifact_id as sourceArtifactId,created_by as createdBy,created_at as createdAt FROM workspace_goal_revisions WHERE goal_id=? AND kind=? ORDER BY revision DESC LIMIT 1`).get(goalId, kind) as RevisionRow | undefined; return row ? revisionFromRow(row) : null; }
  private decisions(goalId: string): WorkspaceGoalDecision[] { return (this.db.prepare(`SELECT id,COALESCE(request_id,'') as requestId,payload_hash as payloadHash,goal_id as goalId,target_revision_id as targetRevisionId,target_hash as targetHash,kind,approved_item_ids_json as approvedItemIdsJson,reason,actor_id as actorId,created_at as createdAt FROM workspace_goal_decisions WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as DecisionRow[]).map(decisionFromRow); }
  private runLinks(goalId: string): WorkspaceGoalRunLink[] { return (this.db.prepare(`SELECT goal_id as goalId,run_id as runId,goal_revision as goalRevision,plan_revision_id as planRevisionId,approved_item_ids_json as approvedItemIdsJson,criterion_keys_json as criterionKeysJson,created_at as createdAt FROM workspace_goal_run_links WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as Array<Omit<WorkspaceGoalRunLink, "approvedItemIds" | "criterionKeys"> & { approvedItemIdsJson: string; criterionKeysJson: string }>).map((row) => ({ ...row, approvedItemIds: JSON.parse(row.approvedItemIdsJson) as string[], criterionKeys: JSON.parse(row.criterionKeysJson) as string[] })); }
  private evidenceLinks(goalId: string): WorkspaceGoalEvidenceLink[] { return this.db.prepare(`SELECT id,goal_id as goalId,goal_revision as goalRevision,criterion_key as criterionKey,run_id as runId,check_key as checkKey,artifact_id as artifactId,operation_id as operationId,source_digest as sourceDigest,status,created_at as createdAt,updated_at as updatedAt FROM workspace_goal_evidence_links WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as WorkspaceGoalEvidenceLink[]; }
}

function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function revisionRecord(goalId: string, kind: "definition" | "plan", revision: number, content: WorkspaceGoalDefinition | WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string, createdAt: number): WorkspaceGoalRevision { return { id: randomUUID(), goalId, kind, revision, content, contentHash: workspaceGoalContentHash(content), sourceArtifactId, createdBy, createdAt }; }
function insertRevision(db: Database.Database, revision: WorkspaceGoalRevision): void { db.prepare(`INSERT INTO workspace_goal_revisions (id,goal_id,kind,revision,content_json,content_hash,source_artifact_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(revision.id, revision.goalId, revision.kind, revision.revision, JSON.stringify(revision.content), revision.contentHash, revision.sourceArtifactId, revision.createdBy, revision.createdAt); }
function revisionFromRow(row: RevisionRow): WorkspaceGoalRevision { return { ...row, content: JSON.parse(row.contentJson) as WorkspaceGoalDefinition | WorkspaceGoalPlan }; }
function definitionContent(revision: WorkspaceGoalRevision): WorkspaceGoalDefinition { return revision.content as WorkspaceGoalDefinition; }
function planContent(revision: WorkspaceGoalRevision): WorkspaceGoalPlan { return revision.content as WorkspaceGoalPlan; }
function decisionFromRow(row: DecisionRow): WorkspaceGoalDecision { const { approvedItemIdsJson, requestId, ...decision } = row; return { ...decision, requestId: requestId ?? "", approvedItemIds: JSON.parse(approvedItemIdsJson) as string[] }; }
