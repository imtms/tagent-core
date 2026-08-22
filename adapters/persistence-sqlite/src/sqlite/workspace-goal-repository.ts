import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  authorizeWorkspaceGoalRunMutation,
  planWorkspaceGoalDecision,
  planWorkspaceGoalRevision,
  shouldWorkspaceGoalBeReady,
  validateWorkspaceGoalEvidenceTarget,
  workspaceGoalContentHash,
  workspaceGoalNextAction,
  type CreateWorkspaceGoalInput,
  type LinkWorkspaceGoalEvidenceInput,
  type LinkWorkspaceGoalInboxInput,
  type LinkWorkspaceGoalRunInput,
  type WorkspaceGoal,
  type WorkspaceGoalDecision,
  type WorkspaceGoalDecisionInput,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalEvidenceLink,
  type WorkspaceGoalEvidenceStatus,
  type WorkspaceGoalRepository,
  type WorkspaceGoalRevision,
  type WorkspaceGoalRoadmap,
  type WorkspaceGoalRoadmapItemProgress,
  type WorkspaceGoalRunLink,
  type WorkspaceGoalRunLinkMode,
  type WorkspaceGoalStatus,
  type WorkspaceGoalSummary,
} from "@tagent/governance";
import type { CriterionCoverage } from "@tagent/governance/domain";
import type { RunStatus, TaskRunContractSnapshot, TaskRunWorkspaceGoalSnapshot } from "@tagent/execution/domain";
import { buildGoalRoadmapAdmission, matchesGoalRoadmapAdmission } from "@tagent/admission";

const now = () => Date.now();
type DbRevisionKind = WorkspaceGoalRevision["kind"];
type DbDecisionKind = WorkspaceGoalDecision["kind"];

interface GoalRow { id: string; workspaceId: string; status: WorkspaceGoalStatus; activeDefinitionRevisionId: string | null; activeRoadmapRevisionId: string | null; currentRunId: string | null; createdAt: number; updatedAt: number; completedAt: number | null }
interface RevisionRow { id: string; goalId: string; kind: DbRevisionKind; revision: number; contentJson: string; contentHash: string; sourceArtifactId: string | null; createdBy: string; createdAt: number }
interface DecisionRow { id: string; requestId: string | null; payloadHash: string; goalId: string; targetRevisionId: string; targetHash: string; kind: DbDecisionKind; approvedItemIdsJson: string; reason: string; actorId: string; createdAt: number }
interface RunLinkRow { goalId: string; runId: string; goalRevision: number; roadmapRevisionId: string | null; roadmapItemIdsJson: string; criterionKeysJson: string; mode: WorkspaceGoalRunLinkMode; createdAt: number; linkOrder: number }

interface LinkSpec {
  goal: WorkspaceGoal;
  goalRevision: number;
  roadmapRevisionId: string | null;
  roadmapItemIds: string[];
  criterionKeys: string[];
  mode: WorkspaceGoalRunLinkMode;
}

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
        (id,workspace_id,status,active_definition_revision_id,active_roadmap_revision_id,current_run_id,created_at,updated_at,completed_at)
        VALUES (?,?,'draft',NULL,NULL,NULL,?,?,NULL)`).run(goalId, input.workspaceId, createdAt, createdAt);
      insertRevision(this.db, revision);
      if (input.idempotencyKey) this.db.prepare("INSERT INTO workspace_goal_requests (idempotency_key,goal_id,payload_hash,created_at) VALUES (?,?,?,?)").run(input.idempotencyKey, goalId, payloadHash, createdAt);
    })();
    return this.requireGoal(goalId);
  }

  listGoals(workspaceId: string): WorkspaceGoalSummary[] {
    return (this.db.prepare(`SELECT id,workspace_id as workspaceId,status,active_definition_revision_id as activeDefinitionRevisionId,
      active_roadmap_revision_id as activeRoadmapRevisionId,current_run_id as currentRunId,created_at as createdAt,updated_at as updatedAt,
      completed_at as completedAt FROM workspace_goals WHERE workspace_id=? ORDER BY updated_at DESC`).all(workspaceId) as GoalRow[])
      .map((row) => this.summary(row));
  }

  getGoal(goalId: string): WorkspaceGoal | null {
    const row = this.goalRow(goalId);
    if (!row) return null;
    const definition = row.activeDefinitionRevisionId ? this.revision(row.activeDefinitionRevisionId) : this.latestRevision(goalId, "definition");
    const roadmap = row.activeRoadmapRevisionId ? this.revision(row.activeRoadmapRevisionId) : this.latestRevision(goalId, "roadmap");
    const decisions = this.decisions(goalId);
    const runLinks = this.runLinks(goalId);
    const allEvidenceLinks = this.evidenceLinks(goalId).map((link) => this.projectEvidence(link));
    const currentRun = this.projectCurrentRun(goalId, row.currentRunId);
    const criteria = definition ? definitionContent(definition).criteria : [];
    const requiredKeys = criteria.filter((item) => item.required).map((item) => item.key);
    const currentEvidence = definition ? allEvidenceLinks.filter((link) => link.goalRevision === definition.revision) : [];
    const decisiveEvidence = new Map<string, WorkspaceGoalEvidenceLink>();
    for (const link of currentEvidence.filter((item) => item.status !== "stale")) {
      const prior = decisiveEvidence.get(link.criterionKey);
      if (!prior || link.updatedAt > prior.updatedAt || link.updatedAt === prior.updatedAt && link.id > prior.id) {
        decisiveEvidence.set(link.criterionKey, link);
      }
    }
    const hasApprovedDefinition = row.activeDefinitionRevisionId === definition?.id
      && decisions.some((item) => item.kind === "approve_goal" && item.targetRevisionId === definition.id && item.targetHash === definition.contentHash);
    const roadmapApproval = row.activeRoadmapRevisionId === roadmap?.id
      ? [...decisions].reverse().find((item) => item.kind === "approve_roadmap" && item.targetRevisionId === roadmap.id && item.targetHash === roadmap.contentHash && item.approvedItemIds.length > 0)
      : undefined;
    const roadmapProgress = roadmap ? this.roadmapProgress(goalId, roadmap, roadmapApproval?.approvedItemIds ?? []) : [];
    const verifiedCriteria = requiredKeys.filter((key) => decisiveEvidence.get(key)?.status === "valid").length;
    let status = row.status;
    if (status === "ready_to_close" && (verifiedCriteria < requiredKeys.length || !hasApprovedDefinition || !roadmapApproval)) status = "active";
    return {
      ...row,
      status,
      currentRunId: currentRun.id,
      definition,
      roadmap,
      decisions,
      runLinks,
      roadmapProgress,
      evidenceLinks: allEvidenceLinks,
      requiredCriteria: requiredKeys.length,
      verifiedCriteria,
      nextAction: workspaceGoalNextAction({
        status,
        hasDefinition: Boolean(definition),
        hasApprovedDefinition,
        hasRoadmap: Boolean(roadmap),
        hasApprovedRoadmap: Boolean(roadmapApproval),
        currentRunId: currentRun.id,
        currentRunStatus: currentRun.status,
        requiredCriteria: requiredKeys.length,
        verifiedCriteria,
        roadmapProgress,
        approvedItemIds: roadmapApproval?.approvedItemIds ?? [],
      }),
    };
  }

  addDefinitionRevision(goalId: string, definition: WorkspaceGoalDefinition, createdBy: string): WorkspaceGoalRevision {
    return this.addRevision(goalId, "definition", definition, null, createdBy);
  }

  addRoadmapRevision(goalId: string, content: WorkspaceGoalRoadmap, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision {
    return this.addRevision(goalId, "roadmap", content, sourceArtifactId, createdBy);
  }

  decideGoal(input: WorkspaceGoalDecisionInput): WorkspaceGoalDecision {
    const goal = this.requireGoal(input.goalId);
    const approvedItemIds = [...new Set(input.approvedItemIds ?? [])].sort();
    const requestId = input.requestId?.trim() || randomUUID();
    const reason = input.reason ?? "";
    const payloadHash = workspaceGoalContentHash({ goalId: input.goalId, targetRevisionId: input.targetRevisionId, targetHash: input.targetHash, kind: input.kind, approvedItemIds, reason, actorId: input.actorId });
    const existing = this.decisionByRequest(input.goalId, requestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("workspace Goal decision idempotency conflict");
      return decisionFromRow(existing);
    }
    const revision = this.revision(input.targetRevisionId);
    if (!revision) throw new Error("workspace Goal revision is stale");
    if (["approve_goal", "approve_roadmap", "request_change", "pause", "cancel", "close"].includes(input.kind)
      && this.hasPendingInboxWork(input.goalId)) {
      throw new Error("workspace Goal cannot change or end while an approved Roadmap TaskRun is queued");
    }
    const transition=planWorkspaceGoalDecision({goal,revision,decision:{...input,approvedItemIds},hasOtherGuidingGoal:this.hasOtherGuidingGoal(goal)});
    const createdAt = now();
    const decision: WorkspaceGoalDecision = { id: randomUUID(), requestId, payloadHash, goalId: input.goalId, targetRevisionId: input.targetRevisionId, targetHash: input.targetHash, kind: input.kind, approvedItemIds, reason, actorId: input.actorId, createdAt };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspace_goal_decisions
        (id,request_id,payload_hash,goal_id,target_revision_id,target_hash,kind,approved_item_ids_json,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(decision.id, decision.requestId, decision.payloadHash, decision.goalId, decision.targetRevisionId, decision.targetHash, decision.kind, JSON.stringify(decision.approvedItemIds), decision.reason, decision.actorId, createdAt);
      this.db.prepare(`UPDATE workspace_goals SET status=?,active_definition_revision_id=?,active_roadmap_revision_id=?,updated_at=?,completed_at=? WHERE id=?`)
        .run(transition.status, transition.activeDefinitionRevisionId, transition.activeRoadmapRevisionId, createdAt, transition.complete ? createdAt : goal.completedAt, input.goalId);
      if (input.kind === "approve_roadmap") {
        for (const itemId of approvedItemIds) this.db.prepare(`INSERT INTO workspace_goal_roadmap_item_progress
          (goal_id,roadmap_revision_id,item_id,status,run_id,updated_at,completed_at) VALUES (?,?,?,'pending',NULL,?,NULL)
          ON CONFLICT(goal_id,roadmap_revision_id,item_id) DO NOTHING`).run(input.goalId, revision.id, itemId, createdAt);
      }
    })();
    if (["approve_roadmap", "resume"].includes(input.kind)) this.refreshReadyStatus(input.goalId, createdAt);
    return decision;
  }

  linkInbox(input: LinkWorkspaceGoalInboxInput): void {
    const inbox = this.db.prepare("SELECT session_id as workspaceId,status FROM session_supervisor_inbox WHERE id=?").get(input.inboxItemId) as { workspaceId: string; status: string } | undefined;
    if (!inbox) throw new Error("Session Inbox item not found");
    const existing = this.db.prepare("SELECT goal_id as goalId,goal_revision as goalRevision,roadmap_revision_id as roadmapRevisionId,roadmap_item_ids_json as roadmapItemIdsJson,criterion_keys_json as criterionKeysJson FROM workspace_goal_inbox_links WHERE inbox_item_id=?").get(input.inboxItemId) as { goalId: string; goalRevision: number; roadmapRevisionId: string; roadmapItemIdsJson: string; criterionKeysJson: string } | undefined;
    const expected = workspaceGoalContentHash({ goalId: input.goalId, goalRevision: input.goalRevision, roadmapRevisionId: input.roadmapRevisionId, roadmapItemIds: [...new Set(input.roadmapItemIds)], criterionKeys: [...new Set(input.criterionKeys)] });
    if (existing) {
      const actual = workspaceGoalContentHash({ goalId: existing.goalId, goalRevision: existing.goalRevision, roadmapRevisionId: existing.roadmapRevisionId, roadmapItemIds: JSON.parse(existing.roadmapItemIdsJson), criterionKeys: JSON.parse(existing.criterionKeysJson) });
      if (actual !== expected) throw new Error("Workspace Goal Roadmap TaskRun idempotency conflict");
      return;
    }
    if (inbox.status !== "queued") throw new Error("Session Inbox item is not queued");
    const spec = this.resolveLinkSpec({ ...input, runId: "pending", mode: "roadmap" });
    if (spec.goal.workspaceId !== inbox.workspaceId) throw new Error("Session Inbox item belongs to a different workspace");
    if (spec.roadmapItemIds.length !== 1) throw new Error("Goal Roadmap Inbox launch requires exactly one Roadmap item");
    const priorRuns = this.db.prepare(`SELECT r.id,r.status FROM workspace_goal_run_links l
      JOIN runs r ON r.id=l.run_id
      WHERE l.goal_id=? AND l.roadmap_revision_id=? AND l.link_mode='roadmap'
        AND EXISTS (SELECT 1 FROM json_each(l.approved_item_ids_json) selected
          WHERE selected.value IN (SELECT requested.value FROM json_each(?) requested))
      ORDER BY l.created_at DESC,l.rowid DESC`).all(input.goalId, input.roadmapRevisionId, JSON.stringify(spec.roadmapItemIds)) as Array<{ id: string; status: RunStatus }>;
    if (priorRuns.some((prior) => prior.status === "completed")) throw new Error("Goal Roadmap item is already completed");
    const activePrior = priorRuns.find((prior) => ["running", "waiting_input", "blocked", "interrupted"].includes(prior.status));
    if (activePrior && ["running", "waiting_input"].includes(activePrior.status)) throw new Error("Goal Roadmap item already has a running TaskRun");
    if (activePrior) throw new Error("Goal Roadmap item has a blocked TaskRun that must be resolved first");
    const itemProgress = this.db.prepare(`SELECT status,run_id as runId FROM workspace_goal_roadmap_item_progress
      WHERE goal_id=? AND roadmap_revision_id=? AND item_id IN (SELECT value FROM json_each(?))
      ORDER BY CASE status WHEN 'completed' THEN 0 WHEN 'running' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END LIMIT 1`)
      .get(input.goalId, input.roadmapRevisionId, JSON.stringify(spec.roadmapItemIds)) as { status: string; runId: string | null } | undefined;
    if (itemProgress?.status === "completed") throw new Error("Goal Roadmap item is already completed");
    const queuedLinks = this.db.prepare(`SELECT l.roadmap_item_ids_json as roadmapItemIdsJson
      FROM workspace_goal_inbox_links l JOIN session_supervisor_inbox i ON i.id=l.inbox_item_id
      WHERE l.goal_id=? AND l.roadmap_revision_id=? AND i.status IN ('queued','claimed')`).all(input.goalId, input.roadmapRevisionId) as Array<{ roadmapItemIdsJson: string }>;
    const requestedItems = new Set(spec.roadmapItemIds);
    if (queuedLinks.some((row) => (JSON.parse(row.roadmapItemIdsJson) as string[]).some((itemId) => requestedItems.has(itemId)))) {
      throw new Error("Goal Roadmap item already has a queued TaskRun");
    }
    const createdAt = now();
    this.db.prepare(`INSERT INTO workspace_goal_inbox_links
      (inbox_item_id,goal_id,goal_revision,roadmap_revision_id,roadmap_item_ids_json,criterion_keys_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(input.inboxItemId, input.goalId, input.goalRevision, input.roadmapRevisionId, JSON.stringify(spec.roadmapItemIds), JSON.stringify(spec.criterionKeys), createdAt);
  }

  attachRun(runId: string, inboxItemId: string | null): WorkspaceGoal | null {
    const existing = this.runLinkForRun(runId);
    if (existing) return this.requireGoal(existing.goalId);
    const run = this.runRow(runId);
    if (!run) throw new Error("TaskRun not found");
    const pending = inboxItemId ? this.pendingInboxLink(inboxItemId) : undefined;
    let spec: LinkSpec | null;
    if (pending) {
      spec = this.resolveLinkSpec({
        goalId: pending.goalId,
        runId,
        goalRevision: pending.goalRevision,
        roadmapRevisionId: pending.roadmapRevisionId,
        roadmapItemIds: JSON.parse(pending.roadmapItemIdsJson) as string[],
        criterionKeys: JSON.parse(pending.criterionKeysJson) as string[],
        mode: "roadmap",
      });
      this.assertCanonicalRoadmapAdmission(run, spec);
    } else {
      const contract = run.contractJson ? JSON.parse(run.contractJson) as TaskRunContractSnapshot : null;
      if (contract?.routerVersion === "workspace-goal-roadmap-v1") {
        throw new Error("Goal Roadmap TaskRun is missing its durable Inbox authorization");
      }
      const guiding = this.guidingGoal(run.workspaceId);
      if (!guiding) return null;
      spec = this.resolveLinkSpec({
        goalId: guiding.id,
        runId,
        goalRevision: guiding.definition!.revision,
        roadmapRevisionId: null,
        roadmapItemIds: [],
        criterionKeys: [],
        mode: "workspace",
      }, guiding);
    }
    return this.persistRunLinkAndSnapshot(run, spec);
  }

  linkRun(input: LinkWorkspaceGoalRunInput): WorkspaceGoal {
    const run = this.runRow(input.runId);
    if (!run) throw new Error("TaskRun not found");
    const priorMutation = this.db.prepare(`SELECT 1 FROM operations
      WHERE run_id=? AND status <> 'pre_effect_rejected'
        AND (operation_type IN ('tool.write','tool.edit','tool.patch','tool.memory_forget')
          OR (operation_type='tool.bash' AND NOT EXISTS (
            SELECT 1 FROM json_each(operations.effects_json)
            WHERE json_extract(value,'$.kind')='workspace' AND json_extract(value,'$.action')='read_only'
          ))) LIMIT 1`).get(input.runId);
    if (priorMutation) throw new Error("TaskRun cannot be linked to a workspace Goal after mutation has started");
    if (this.runLinkForRun(input.runId)) throw new Error("TaskRun is already linked to a workspace Goal");
    const spec = this.resolveLinkSpec({ ...input, mode: input.mode ?? "workspace" });
    if (run.workspaceId !== spec.goal.workspaceId) throw new Error("TaskRun belongs to a different workspace");
    return this.persistRunLinkAndSnapshot(run, spec);
  }

  authorizeRunMutation(runId: string): { allowed: boolean; reason: string } {
    const row = this.runLinkForRun(runId);
    if (!row) {
      const run = this.runRow(runId);
      const contract = run?.contractJson ? JSON.parse(run.contractJson) as TaskRunContractSnapshot : null;
      const pendingAuthorization = this.db.prepare(`SELECT 1 FROM workspace_goal_inbox_links l
        JOIN session_supervisor_inbox i ON i.id=l.inbox_item_id WHERE i.run_id=? LIMIT 1`).get(runId);
      if (contract?.routerVersion === "workspace-goal-roadmap-v1" || pendingAuthorization) {
        return { allowed: false, reason: "Workspace Goal Roadmap TaskRun is missing its durable Run authorization" };
      }
    }
    return authorizeWorkspaceGoalRunMutation(row?this.getGoal(row.goalId):null,row?runLinkFromRow(row):undefined);
  }

  reconcileRunState(): string[] {
    const repaired: string[] = [];
    const missing = this.db.prepare(`SELECT i.run_id as runId,i.id as inboxItemId FROM workspace_goal_inbox_links l
      JOIN session_supervisor_inbox i ON i.id=l.inbox_item_id
      WHERE i.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_goal_run_links linked WHERE linked.run_id=i.run_id
      ) ORDER BY l.created_at,l.rowid`).all() as Array<{ runId: string; inboxItemId: string }>;
    for (const item of missing) {
      try {
        if (this.attachRun(item.runId, item.inboxItemId)) repaired.push(item.runId);
      } catch { /* Invalid historical authorization remains fail-closed in authorizeRunMutation. */ }
    }
    const linked = this.db.prepare("SELECT run_id as runId FROM workspace_goal_run_links ORDER BY created_at,rowid").all() as Array<{ runId: string }>;
    for (const { runId } of linked) {
      this.recordRunOutcome(runId);
      if (!repaired.includes(runId)) repaired.push(runId);
    }
    return repaired;
  }

  linkEvidence(input: LinkWorkspaceGoalEvidenceInput): WorkspaceGoalEvidenceLink {
    const goal = this.requireGoal(input.goalId);
    const run = this.runRow(input.runId);
    if (!run) throw new Error("TaskRun not found");
    validateWorkspaceGoalEvidenceTarget(goal,input,run.workspaceId);
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
    const latestEvidenceTimestamp = this.db.prepare(`SELECT MAX(updated_at) as updatedAt FROM workspace_goal_evidence_links
      WHERE goal_id=? AND goal_revision=? AND criterion_key=?`).get(input.goalId, input.goalRevision, input.criterionKey) as { updatedAt: number | null };
    const timestamp = Math.max(now(), (latestEvidenceTimestamp.updatedAt ?? 0) + 1);
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
    })();
    this.refreshReadyStatus(input.goalId, timestamp);
    return this.evidenceLinks(input.goalId).find((item) => item.id === id)!;
  }

  recordRunOutcome(runId: string): WorkspaceGoal | null {
    const link = this.runLinkForRun(runId);
    if (!link) return null;
    const run = this.runRow(runId);
    if (!run) return null;
    const selectedRunId = this.goalRow(link.goalId)?.currentRunId ?? null;
    const timestamp = now();
    const itemIds = link.mode === "roadmap" ? JSON.parse(link.roadmapItemIdsJson) as string[] : [];
    const progressStatus = run.status === "completed" ? "completed" : ["running", "waiting_input"].includes(run.status) ? "running" : "blocked";
    this.db.transaction(() => {
      if (link.roadmapRevisionId) for (const itemId of itemIds) {
        const owner = this.db.prepare(`SELECT run_id as runId FROM workspace_goal_roadmap_item_progress
          WHERE goal_id=? AND roadmap_revision_id=? AND item_id=?`).get(link.goalId, link.roadmapRevisionId, itemId) as { runId: string | null } | undefined;
        const ownerLink = owner?.runId && owner.runId !== runId ? this.runLinkForRun(owner.runId) : undefined;
        const ownerIsNewer = ownerLink && (ownerLink.createdAt > link.createdAt
          || ownerLink.createdAt === link.createdAt && ownerLink.linkOrder > link.linkOrder);
        if (ownerIsNewer) continue;
        this.db.prepare(`INSERT INTO workspace_goal_roadmap_item_progress
          (goal_id,roadmap_revision_id,item_id,status,run_id,updated_at,completed_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(goal_id,roadmap_revision_id,item_id) DO UPDATE SET status=excluded.status,run_id=excluded.run_id,updated_at=excluded.updated_at,completed_at=excluded.completed_at`)
          .run(link.goalId, link.roadmapRevisionId, itemId, progressStatus, runId, timestamp, progressStatus === "completed" ? timestamp : null);
      }
      const retainCurrent = ["running", "waiting_input", "blocked", "interrupted"].includes(run.status);
      const preferredRunId = selectedRunId === runId && !retainCurrent ? null : selectedRunId;
      const nextCurrent = this.findActiveGuidedRun(link.goalId, preferredRunId);
      this.db.prepare("UPDATE workspace_goals SET current_run_id=?,updated_at=? WHERE id=?").run(nextCurrent.id, timestamp, link.goalId);
    })();
    if (!["running", "waiting_input"].includes(run.status)) this.harvestSupervisorEvidence(link, run.contractJson);
    this.refreshReadyStatus(link.goalId, timestamp);
    return this.requireGoal(link.goalId);
  }

  private harvestSupervisorEvidence(link: RunLinkRow, contractJson: string): void {
    const contract = contractJson ? JSON.parse(contractJson) as TaskRunContractSnapshot : null;
    const snapshot = contract?.workspaceGoal;
    if (!snapshot || snapshot.goalId !== link.goalId || !snapshot.criterionPrompts.length) return;
    const row = this.db.prepare(`SELECT evaluation.attempt,evaluation.checkpoint_seq as checkpointSeq,evaluation.criterion_coverage_json as coverageJson
      FROM gate_evaluations evaluation JOIN runs run ON run.id=evaluation.run_id AND run.attempt=evaluation.attempt
      WHERE evaluation.run_id=? AND evaluation.gate_type='contract' AND evaluation.evaluator='llm'
      ORDER BY evaluation.checkpoint_seq DESC,evaluation.created_at DESC LIMIT 1`).get(link.runId) as { attempt: number; checkpointSeq: number; coverageJson: string } | undefined;
    if (!row) return;
    const coverage = JSON.parse(row.coverageJson) as CriterionCoverage[];
    for (const target of snapshot.criterionPrompts) {
      const verdict = coverage.find((item) => item.criterion === target.prompt && ["covered", "contradicted"].includes(item.status));
      if (!verdict) continue;
      for (const ref of verdict.evidenceRefs) {
        const [kind, id] = splitEvidenceRef(ref);
        if (!id || !["check", "artifact", "operation"].includes(kind)) continue;
        try {
          this.linkEvidence({
            goalId: link.goalId,
            requestId: `supervisor:${link.runId}:attempt:${row.attempt}:checkpoint:${row.checkpointSeq}:${target.key}:${kind}:${id}`,
            goalRevision: link.goalRevision,
            criterionKey: target.key,
            runId: link.runId,
            checkKey: kind === "check" ? id : null,
            artifactId: kind === "artifact" ? id : null,
            operationId: kind === "operation" ? id : null,
            status: verdict.status === "covered" ? "valid" : "contradicted",
          });
        } catch { /* Supervisor references are proposals; invalid or stale Core receipts are ignored. */ }
      }
    }
  }

  private persistRunLinkAndSnapshot(run: ReturnType<SqliteWorkspaceGoalRepository["runRow"]> & {}, spec: LinkSpec): WorkspaceGoal {
    if (run.workspaceId !== spec.goal.workspaceId) throw new Error("TaskRun belongs to a different workspace");
    if (spec.mode === "roadmap") this.assertRoadmapRunAvailable(spec);
    const createdAt = now();
    const snapshot = this.executionSnapshot(spec, createdAt);
    const contract = mergeGoalSnapshot(run, snapshot);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspace_goal_run_links
        (goal_id,run_id,goal_revision,roadmap_revision_id,approved_item_ids_json,criterion_keys_json,created_at,link_mode)
        VALUES (?,?,?,?,?,?,?,?)`).run(spec.goal.id, run.id, spec.goalRevision, spec.roadmapRevisionId, JSON.stringify(spec.roadmapItemIds), JSON.stringify(spec.criterionKeys), createdAt, spec.mode);
      this.db.prepare("UPDATE runs SET contract_json=?,updated_at=? WHERE id=?").run(JSON.stringify(contract), createdAt, run.id);
      this.db.prepare(`UPDATE workspace_goals SET current_run_id=?,status=CASE WHEN status='ready_to_close' THEN 'active' ELSE status END,updated_at=? WHERE id=?`).run(run.id, createdAt, spec.goal.id);
      if (spec.roadmapRevisionId && spec.mode === "roadmap") for (const itemId of spec.roadmapItemIds) this.db.prepare(`INSERT INTO workspace_goal_roadmap_item_progress
        (goal_id,roadmap_revision_id,item_id,status,run_id,updated_at,completed_at) VALUES (?,?,?,'running',?,?,NULL)
        ON CONFLICT(goal_id,roadmap_revision_id,item_id) DO UPDATE SET status='running',run_id=excluded.run_id,updated_at=excluded.updated_at,completed_at=NULL`)
        .run(spec.goal.id, spec.roadmapRevisionId, itemId, run.id, createdAt);
    })();
    return this.requireGoal(spec.goal.id);
  }

  private executionSnapshot(spec: LinkSpec, attachedAt: number): TaskRunWorkspaceGoalSnapshot {
    const definition = spec.goal.definition!;
    const definitionValue = definitionContent(definition);
    const roadmap = spec.roadmapRevisionId && spec.goal.roadmap?.id === spec.roadmapRevisionId ? spec.goal.roadmap : null;
    const roadmapValue = roadmap ? roadmapContent(roadmap) : null;
    const approval = roadmap ? this.latestRoadmapApproval(spec.goal, roadmap.id) : undefined;
    const targetCriterionKeys = spec.mode === "roadmap" ? spec.criterionKeys : [];
    const criterionPrompts = targetCriterionKeys.map((key) => {
      const criterion = definitionValue.criteria.find((item) => item.key === key)!;
      return { key, prompt: `[Workspace Goal criterion ${key}] ${criterion.title}` };
    });
    return {
      goalId: spec.goal.id,
      mode: spec.mode,
      definitionRevisionId: definition.id,
      definitionRevision: definition.revision,
      definitionHash: definition.contentHash,
      title: definitionValue.title,
      outcome: definitionValue.outcome,
      scope: [...definitionValue.scope],
      nonGoals: [...definitionValue.nonGoals],
      criteria: definitionValue.criteria.map((criterion) => ({ ...criterion })),
      roadmapRevisionId: roadmap?.id ?? null,
      roadmapRevision: roadmap?.revision ?? null,
      roadmapHash: roadmap?.contentHash ?? null,
      approvedRoadmapItemIds: [...(approval?.approvedItemIds ?? [])],
      targetRoadmapItemIds: spec.mode === "roadmap" ? [...spec.roadmapItemIds] : [],
      roadmapItems: roadmapValue?.items.filter((item) => spec.roadmapItemIds.includes(item.id)).map((item) => ({ ...item, criterionKeys: [...item.criterionKeys] })) ?? [],
      targetCriterionKeys,
      criterionPrompts,
      attachedAt,
    };
  }

  private resolveLinkSpec(input: LinkWorkspaceGoalRunInput, loadedGoal?: WorkspaceGoal): LinkSpec {
    const goal = loadedGoal?.id === input.goalId ? loadedGoal : this.requireGoal(input.goalId);
    if (!["active", "ready_to_close"].includes(goal.status)) throw new Error("workspace Goal must be active before linking a TaskRun");
    if (!goal.definition || input.goalRevision !== goal.definition.revision || goal.activeDefinitionRevisionId !== goal.definition.id) throw new Error("workspace Goal definition revision is stale");
    const mode = input.mode ?? "workspace";
    const roadmapItemIds = [...new Set(input.roadmapItemIds ?? [])];
    const criterionKeys = [...new Set(input.criterionKeys ?? [])];
    const knownCriteria = new Set(definitionContent(goal.definition).criteria.map((criterion) => criterion.key));
    if (criterionKeys.some((key) => !knownCriteria.has(key))) throw new Error("criterion not found");
    if (input.roadmapRevisionId) {
      const roadmap = this.revision(input.roadmapRevisionId);
      if (!roadmap || roadmap.goalId !== input.goalId || roadmap.kind !== "roadmap") throw new Error("Roadmap revision not found");
      if (goal.activeRoadmapRevisionId !== roadmap.id) throw new Error("Roadmap revision is not active");
      const approval = this.latestRoadmapApproval(goal, roadmap.id);
      if (!approval) throw new Error("Roadmap revision is not approved");
      if (roadmapItemIds.some((itemId) => !approval.approvedItemIds.includes(itemId))) throw new Error("TaskRun exceeds the approved Roadmap slice");
      if (mode === "roadmap" && !roadmapItemIds.length) throw new Error("Goal Roadmap TaskRun requires at least one Roadmap item");
      const selected = roadmapContent(roadmap).items.filter((item) => roadmapItemIds.includes(item.id));
      if (selected.length !== roadmapItemIds.length) throw new Error("Roadmap item not found");
      const selectedCriteria = new Set(selected.flatMap((item) => item.criterionKeys));
      if (mode === "roadmap" && criterionKeys.some((key) => !selectedCriteria.has(key))) throw new Error("TaskRun criterion is outside the selected Roadmap item");
    } else if (roadmapItemIds.length) {
      throw new Error("Roadmap items require an active Roadmap revision");
    }
    return { goal, goalRevision: input.goalRevision, roadmapRevisionId: input.roadmapRevisionId ?? null, roadmapItemIds, criterionKeys, mode };
  }

  private assertRoadmapRunAvailable(spec: LinkSpec): void {
    if (!spec.roadmapRevisionId) return;
    const priorRuns = this.db.prepare(`SELECT r.status FROM workspace_goal_run_links l JOIN runs r ON r.id=l.run_id
      WHERE l.goal_id=? AND l.roadmap_revision_id=? AND l.link_mode='roadmap'
        AND EXISTS (SELECT 1 FROM json_each(l.approved_item_ids_json) selected
          WHERE selected.value IN (SELECT requested.value FROM json_each(?) requested))`)
      .all(spec.goal.id, spec.roadmapRevisionId, JSON.stringify(spec.roadmapItemIds)) as Array<{ status: RunStatus }>;
    if (priorRuns.some((prior) => prior.status === "completed")) throw new Error("Goal Roadmap item is already completed");
    const active = priorRuns.find((prior) => ["running", "waiting_input", "blocked", "interrupted"].includes(prior.status));
    if (active && ["running", "waiting_input"].includes(active.status)) throw new Error("Goal Roadmap item already has a running TaskRun");
    if (active) throw new Error("Goal Roadmap item has a blocked TaskRun that must be resolved first");
  }

  private addRevision(goalId: string, kind: WorkspaceGoalRevision["kind"], content: WorkspaceGoalDefinition | WorkspaceGoalRoadmap, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision {
    const goal = this.requireGoal(goalId);
    if (this.hasPendingInboxWork(goalId)) throw new Error("workspace Goal cannot be revised while an approved Roadmap TaskRun is queued");
    const transition=planWorkspaceGoalRevision(goal,kind);
    const dbKind = kind;
    const revisionNumber = Number((this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 as revision FROM workspace_goal_revisions WHERE goal_id=? AND kind=?").get(goalId, dbKind) as { revision: number }).revision);
    const revision = revisionRecord(goalId, kind, revisionNumber, content, sourceArtifactId, createdBy, now());
    this.db.transaction(() => {
      insertRevision(this.db, revision);
      this.db.prepare(`UPDATE workspace_goals SET status=?,
        active_definition_revision_id=?,active_roadmap_revision_id=?,updated_at=? WHERE id=?`)
        .run(transition.status,transition.activeDefinitionRevisionId,transition.activeRoadmapRevisionId,revision.createdAt,goalId);
    })();
    return revision;
  }

  private hasOtherGuidingGoal(goal: WorkspaceGoal): boolean {
    const other = this.db.prepare(`SELECT id FROM workspace_goals WHERE workspace_id=? AND id<>? AND status IN ('active','ready_to_close') LIMIT 1`).get(goal.workspaceId, goal.id) as { id: string } | undefined;
    return Boolean(other);
  }

  private hasPendingInboxWork(goalId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM workspace_goal_inbox_links l
      JOIN session_supervisor_inbox i ON i.id=l.inbox_item_id
      WHERE l.goal_id=? AND i.status IN ('queued','claimed') LIMIT 1`).get(goalId));
  }

  private assertCanonicalRoadmapAdmission(run: ReturnType<SqliteWorkspaceGoalRepository["runRow"]> & {}, spec: LinkSpec): void {
    if (spec.mode !== "roadmap" || spec.roadmapItemIds.length !== 1 || !spec.goal.definition || !spec.goal.roadmap) {
      throw new Error("Goal Roadmap Inbox authorization is incomplete");
    }
    const roadmapItem = roadmapContent(spec.goal.roadmap).items.find((item) => item.id === spec.roadmapItemIds[0]);
    if (!roadmapItem) throw new Error("Goal Roadmap item not found");
    const expected = buildGoalRoadmapAdmission({
      goalId: spec.goal.id,
      goalOutcome: definitionContent(spec.goal.definition).outcome,
      roadmapItem,
    });
    const contract = run.contractJson ? JSON.parse(run.contractJson) as TaskRunContractSnapshot : null;
    if (!contract || !matchesGoalRoadmapAdmission({
      content: contract.sourceInput,
      analysis: {
        summary: contract.summary,
        objectives: contract.objectives,
        intent: contract.intent,
        targetRunId: contract.parentRunId,
        priority: 700,
        urgency: "normal",
        relation: contract.relation,
        acceptanceCriteria: contract.acceptanceCriteria,
        scope: contract.scope,
        nonGoals: contract.nonGoals,
        confidence: 1,
        reason: contract.decisionReason,
        routerVersion: contract.routerVersion,
        executionPolicy: contract.executionPolicy ?? undefined,
      },
    }, expected)) {
      throw new Error("Workspace Goal Roadmap Inbox content no longer matches its durable authorization");
    }
  }

  private guidingGoal(workspaceId: string): WorkspaceGoal | null {
    const rows = this.db.prepare(`SELECT id FROM workspace_goals WHERE workspace_id=? AND status IN ('active','ready_to_close') AND active_definition_revision_id IS NOT NULL ORDER BY updated_at DESC`).all(workspaceId) as Array<{ id: string }>;
    if (!rows.length) return null;
    if (rows.length > 1) throw new Error("Workspace has multiple active Goals; pause all but one before starting a TaskRun");
    return this.requireGoal(rows[0].id);
  }

  private computeEvidenceDigest(input: LinkWorkspaceGoalEvidenceInput, requestedStatus: WorkspaceGoalEvidenceStatus): string {
    const facts: Record<string, unknown> = { runId: input.runId };
    const requiresTrustedReceipt = requestedStatus === "valid" || requestedStatus === "contradicted";
    const runState = this.db.prepare(`SELECT r.attempt,a.started_at as attemptStartedAt FROM runs r
      JOIN attempts a ON a.run_id=r.id AND a.ordinal=r.attempt WHERE r.id=?`).get(input.runId) as { attempt: number; attemptStartedAt: number } | undefined;
    if (!runState) throw new Error("TaskRun not found");
    facts.attempt = runState.attempt;
    if (input.checkKey) {
      const check = this.db.prepare(`SELECT status,stale,evidence,command,title,source_operation_id as sourceOperationId,observed_at as observedAt
        FROM run_checks WHERE run_id=? AND check_key=?`).get(input.runId, input.checkKey) as { status: string; stale: number; evidence: string; command: string; title: string; sourceOperationId: string | null; observedAt: number | null } | undefined;
      if (!check) throw new Error("check evidence not found");
      const operation = check.sourceOperationId ? this.db.prepare(`SELECT attempt,operation_type as operationType,payload_json as payloadJson,status,result_json as resultJson,completed_at as completedAt
        FROM operations WHERE run_id=? AND id=?`).get(input.runId, check.sourceOperationId) as { attempt: number; operationType: string; payloadJson: string; status: string; resultJson: string; completedAt: number | null } | undefined : undefined;
      const payload = operation?.payloadJson ? JSON.parse(operation.payloadJson) as Record<string, unknown> : undefined;
      const result = operation?.resultJson ? JSON.parse(operation.resultJson) as Record<string, unknown> : undefined;
      const details = result?.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details as Record<string, unknown> : undefined;
      const trustedOperation = operation && operation.attempt === runState.attempt && operation.operationType === "tool.bash" && operation.status === "succeeded"
        && operation.completedAt === check.observedAt;
      const trusted = check.status === "passed" && check.stale === 0 && Boolean(check.evidence.trim()) && Boolean(trustedOperation)
        && typeof payload?.command === "string" && payload.command.trim() === check.command.trim() && details?.exitCode === 0;
      if (requiresTrustedReceipt && !trusted) throw new Error("check evidence is not bound to a successful current-Attempt Bash receipt");
      facts.check = { key: input.checkKey, ...check, operation };
    }
    if (input.artifactId) {
      const artifact = this.db.prepare("SELECT kind,title,content,uri,created_at as createdAt FROM artifacts WHERE run_id=? AND id=?").get(input.runId, input.artifactId) as { kind: string; title: string; content: string; uri: string; createdAt: number } | undefined;
      if (!artifact) throw new Error("artifact evidence not found");
      const operationRows = this.db.prepare(`SELECT id,result_json as resultJson,completed_at as completedAt FROM operations
        WHERE run_id=? AND attempt=? AND status='succeeded' AND completed_at IS NOT NULL`).all(input.runId, runState.attempt) as Array<{ id: string; resultJson: string; completedAt: number }>;
      const receipt = operationRows.map((operation) => {
        const result = operation.resultJson ? JSON.parse(operation.resultJson) as Record<string, unknown> : undefined;
        const details = result?.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details as Record<string, unknown> : undefined;
        return { ...operation, details };
      }).find((operation) => operation.details?.artifactId === input.artifactId
        && operation.details?.artifactUri === artifact.uri && typeof operation.details?.sha256 === "string");
      // Artifact rows predate Attempt identity in the immutable schema. An
      // equal millisecond is ambiguous across an Attempt transition, so inline
      // provenance must be strictly later than the current Attempt start.
      const inline = artifact.content.trim().length > 0 && artifact.createdAt > runState.attemptStartedAt;
      const receiptBacked = Boolean(receipt && /^\.tagent\/artifacts\//.test(artifact.uri));
      if (requiresTrustedReceipt && !inline && !receiptBacked) throw new Error("artifact evidence is not backed by current-Attempt inline content or a successful current-Attempt artifact receipt");
      const contentHash = inline ? sha256(Buffer.from(artifact.content)) : receiptBacked ? `sha256:${String(receipt!.details!.sha256)}` : "missing";
      facts.artifact = { id: input.artifactId, ...artifact, content: undefined, contentHash, receipt: receipt ? { operationId: receipt.id, completedAt: receipt.completedAt } : null };
    }
    if (input.operationId) {
      const operation = this.db.prepare("SELECT attempt,operation_type as operationType,payload_hash as payloadHash,status,stage,effects_json as effectsJson,result_json as resultJson,error,completed_at as completedAt FROM operations WHERE run_id=? AND id=?").get(input.runId, input.operationId) as Record<string, unknown> | undefined;
      if (!operation) throw new Error("operation evidence not found");
      if (requiresTrustedReceipt && (operation.status !== "succeeded" || operation.attempt !== runState.attempt || operation.completedAt === null || !operation.resultJson)) {
        throw new Error("operation evidence is not a successful current-Attempt receipt");
      }
      facts.operation = { id: input.operationId, ...operation };
    }
    return `sha256:${workspaceGoalContentHash(facts)}`;
  }

  private projectEvidence(link: WorkspaceGoalEvidenceLink): WorkspaceGoalEvidenceLink {
    if (link.status === "stale") return link;
    try {
      const currentDigest = this.computeEvidenceDigest(link, link.status);
      return { ...link, status: currentDigest === link.sourceDigest ? link.status : "stale" };
    } catch {
      return { ...link, status: "stale" };
    }
  }

  private refreshReadyStatus(goalId: string, timestamp: number): void {
    const refreshed = this.requireGoal(goalId);
    const ready = shouldWorkspaceGoalBeReady(refreshed);
    const raw = this.goalRow(goalId)!;
    if (ready && raw.status === "active") this.db.prepare("UPDATE workspace_goals SET status='ready_to_close',current_run_id=NULL,updated_at=? WHERE id=?").run(timestamp, goalId);
    else if (!ready && raw.status === "ready_to_close") this.db.prepare("UPDATE workspace_goals SET status='active',updated_at=? WHERE id=?").run(timestamp, goalId);
  }

  private roadmapProgress(goalId: string, roadmap: WorkspaceGoalRevision, approvedItemIds: string[]): WorkspaceGoalRoadmapItemProgress[] {
    const rows = this.db.prepare(`SELECT p.goal_id as goalId,p.roadmap_revision_id as roadmapRevisionId,p.item_id as itemId,p.status,p.run_id as runId,
      p.updated_at as updatedAt,p.completed_at as completedAt,r.status as runStatus
      FROM workspace_goal_roadmap_item_progress p LEFT JOIN runs r ON r.id=p.run_id
      WHERE p.goal_id=? AND p.roadmap_revision_id=?`).all(goalId, roadmap.id) as Array<WorkspaceGoalRoadmapItemProgress & { runStatus: RunStatus | null }>;
    const queuedRows = this.db.prepare(`SELECT l.inbox_item_id as inboxItemId,l.roadmap_item_ids_json as roadmapItemIdsJson,
      i.status as queueStatus,l.created_at as createdAt FROM workspace_goal_inbox_links l
      JOIN session_supervisor_inbox i ON i.id=l.inbox_item_id
      WHERE l.goal_id=? AND l.roadmap_revision_id=? AND i.status IN ('queued','claimed')
      ORDER BY l.created_at,l.rowid`).all(goalId, roadmap.id) as Array<{ inboxItemId: string; roadmapItemIdsJson: string; queueStatus: "queued" | "claimed"; createdAt: number }>;
    const queuedByItem = new Map<string, { inboxItemId: string; queueStatus: "queued" | "claimed"; createdAt: number }>();
    for (const queued of queuedRows) {
      for (const itemId of JSON.parse(queued.roadmapItemIdsJson) as string[]) queuedByItem.set(itemId, queued);
    }
    const byItem = new Map(rows.map(({ runStatus, ...row }) => {
      const status = projectedRoadmapStatus(row.status, runStatus);
      return [row.itemId, { ...row, status, runStatus, retryable: status === "blocked" && Boolean(runStatus && ["failed", "cancelled"].includes(runStatus)) }];
    }));
    const approved = new Set(approvedItemIds);
    return roadmapContent(roadmap).items.map((item) => {
      const queued = queuedByItem.get(item.id);
      if (!approved.has(item.id)) return {
        goalId,
        roadmapRevisionId: roadmap.id,
        itemId: item.id,
        status: "unapproved" as const,
        queueStatus: null,
        inboxItemId: null,
        runId: null,
        runStatus: null,
        retryable: false,
        updatedAt: roadmap.createdAt,
        completedAt: null,
      };
      const progress = byItem.get(item.id) ?? {
        goalId,
        roadmapRevisionId: roadmap.id,
        itemId: item.id,
        status: "pending" as const,
        runId: null,
        runStatus: null,
        retryable: false,
        updatedAt: roadmap.createdAt,
        completedAt: null,
      };
      return { ...progress, queueStatus: queued?.queueStatus ?? null, inboxItemId: queued?.inboxItemId ?? null, updatedAt: Math.max(progress.updatedAt, queued?.createdAt ?? 0) };
    });
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

  private latestRoadmapApproval(goal: WorkspaceGoal, roadmapRevisionId: string) {
    return [...goal.decisions].reverse().find((item) => item.kind === "approve_roadmap" && item.targetRevisionId === roadmapRevisionId && item.targetHash === goal.roadmap?.contentHash && item.approvedItemIds.length > 0);
  }

  private projectCurrentRun(goalId: string, preferredRunId: string | null): { id: string | null; status: string | null } {
    return this.findActiveGuidedRun(goalId, preferredRunId);
  }

  private findActiveGuidedRun(goalId: string, preferredRunId: string | null): { id: string | null; status: string | null } {
    // Blocked/interrupted Runs remain resumable history, but only the selected
    // one owns Goal attention after a newer guided Run has taken over.
    const run = this.db.prepare(`SELECT r.id,r.status FROM workspace_goal_run_links l
      JOIN runs r ON r.id=l.run_id
      WHERE l.goal_id=? AND (r.status IN ('running','waiting_input')
        OR (r.id=? AND r.status IN ('interrupted','blocked')))
      ORDER BY CASE WHEN r.id=? THEN 0 ELSE 1 END,l.created_at DESC,l.rowid DESC LIMIT 1`)
      .get(goalId, preferredRunId, preferredRunId) as { id: string; status: string } | undefined;
    return run ?? { id: null, status: null };
  }

  private runRow(runId: string) {
    return this.db.prepare("SELECT id,session_id as workspaceId,status,goal,contract_json as contractJson FROM runs WHERE id=?").get(runId) as { id: string; workspaceId: string; status: string; goal: string; contractJson: string } | undefined;
  }

  private runLinkForRun(runId: string): RunLinkRow | undefined {
    return this.db.prepare(`SELECT goal_id as goalId,run_id as runId,goal_revision as goalRevision,roadmap_revision_id as roadmapRevisionId,
      approved_item_ids_json as roadmapItemIdsJson,criterion_keys_json as criterionKeysJson,link_mode as mode,created_at as createdAt,rowid as linkOrder
      FROM workspace_goal_run_links WHERE run_id=?`).get(runId) as RunLinkRow | undefined;
  }

  private pendingInboxLink(inboxItemId: string) {
    return this.db.prepare(`SELECT goal_id as goalId,goal_revision as goalRevision,roadmap_revision_id as roadmapRevisionId,
      roadmap_item_ids_json as roadmapItemIdsJson,criterion_keys_json as criterionKeysJson FROM workspace_goal_inbox_links WHERE inbox_item_id=?`).get(inboxItemId) as { goalId: string; goalRevision: number; roadmapRevisionId: string; roadmapItemIdsJson: string; criterionKeysJson: string } | undefined;
  }

  private goalRow(goalId: string): GoalRow | null { return (this.db.prepare(`SELECT id,workspace_id as workspaceId,status,active_definition_revision_id as activeDefinitionRevisionId,active_roadmap_revision_id as activeRoadmapRevisionId,current_run_id as currentRunId,created_at as createdAt,updated_at as updatedAt,completed_at as completedAt FROM workspace_goals WHERE id=?`).get(goalId) as GoalRow | undefined) ?? null; }
  private revision(id: string): WorkspaceGoalRevision | null { const row = this.db.prepare(`SELECT id,goal_id as goalId,kind,revision,content_json as contentJson,content_hash as contentHash,source_artifact_id as sourceArtifactId,created_by as createdBy,created_at as createdAt FROM workspace_goal_revisions WHERE id=?`).get(id) as RevisionRow | undefined; return row ? revisionFromRow(row) : null; }
  private latestRevision(goalId: string, kind: WorkspaceGoalRevision["kind"]): WorkspaceGoalRevision | null { const row = this.db.prepare(`SELECT id,goal_id as goalId,kind,revision,content_json as contentJson,content_hash as contentHash,source_artifact_id as sourceArtifactId,created_by as createdBy,created_at as createdAt FROM workspace_goal_revisions WHERE goal_id=? AND kind=? ORDER BY revision DESC LIMIT 1`).get(goalId, kind) as RevisionRow | undefined; return row ? revisionFromRow(row) : null; }
  private decisionByRequest(goalId: string, requestId: string) { return this.db.prepare(`SELECT id,request_id as requestId,payload_hash as payloadHash,goal_id as goalId,target_revision_id as targetRevisionId,target_hash as targetHash,kind,approved_item_ids_json as approvedItemIdsJson,reason,actor_id as actorId,created_at as createdAt FROM workspace_goal_decisions WHERE goal_id=? AND request_id=?`).get(goalId, requestId) as DecisionRow | undefined; }
  private decisions(goalId: string): WorkspaceGoalDecision[] { return (this.db.prepare(`SELECT id,COALESCE(request_id,'') as requestId,payload_hash as payloadHash,goal_id as goalId,target_revision_id as targetRevisionId,target_hash as targetHash,kind,approved_item_ids_json as approvedItemIdsJson,reason,actor_id as actorId,created_at as createdAt FROM workspace_goal_decisions WHERE goal_id=? ORDER BY created_at ASC,id ASC`).all(goalId) as DecisionRow[]).map(decisionFromRow); }
  private runLinks(goalId: string): WorkspaceGoalRunLink[] { return (this.db.prepare(`SELECT goal_id as goalId,run_id as runId,goal_revision as goalRevision,roadmap_revision_id as roadmapRevisionId,approved_item_ids_json as roadmapItemIdsJson,criterion_keys_json as criterionKeysJson,link_mode as mode,created_at as createdAt,rowid as linkOrder FROM workspace_goal_run_links WHERE goal_id=? ORDER BY created_at,rowid`).all(goalId) as RunLinkRow[]).map(runLinkFromRow); }
  private evidenceLinks(goalId: string): WorkspaceGoalEvidenceLink[] { return this.db.prepare(`SELECT id,goal_id as goalId,goal_revision as goalRevision,criterion_key as criterionKey,run_id as runId,check_key as checkKey,artifact_id as artifactId,operation_id as operationId,source_digest as sourceDigest,status,created_at as createdAt,updated_at as updatedAt FROM workspace_goal_evidence_links WHERE goal_id=? ORDER BY created_at ASC`).all(goalId) as WorkspaceGoalEvidenceLink[]; }
}

function mergeGoalSnapshot(run: { goal: string; contractJson: string }, snapshot: TaskRunWorkspaceGoalSnapshot): TaskRunContractSnapshot {
  const existing = run.contractJson ? JSON.parse(run.contractJson) as TaskRunContractSnapshot : null;
  const criterionPrompts = snapshot.criterionPrompts.map((item) => item.prompt);
  return {
    sourceInput: existing?.sourceInput ?? run.goal,
    summary: existing?.summary ?? run.goal,
    objectives: existing?.objectives ?? [{ id: "objective-1", summary: run.goal, timing: "current", kind: "other" }],
    acceptanceCriteria: [...new Set([...(existing?.acceptanceCriteria ?? []), ...criterionPrompts])],
    scope: existing?.scope ?? run.goal,
    nonGoals: [...new Set([...(existing?.nonGoals ?? []), ...snapshot.nonGoals])],
    sourceInboxIds: existing?.sourceInboxIds ?? [],
    parentRunId: existing?.parentRunId ?? null,
    relation: existing?.relation ?? "independent",
    intent: existing?.intent ?? "new_task",
    decisionReason: existing?.decisionReason ?? "TaskRun was attached to the active Workspace Goal before execution.",
    routerVersion: existing?.routerVersion ?? "workspace-goal-v1",
    workspaceGoal: snapshot,
  };
}

function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function revisionRecord(goalId: string, kind: WorkspaceGoalRevision["kind"], revision: number, content: WorkspaceGoalDefinition | WorkspaceGoalRoadmap, sourceArtifactId: string | null, createdBy: string, createdAt: number): WorkspaceGoalRevision { return { id: randomUUID(), goalId, kind, revision, content, contentHash: workspaceGoalContentHash(content), sourceArtifactId, createdBy, createdAt }; }
function insertRevision(db: Database.Database, revision: WorkspaceGoalRevision): void { db.prepare(`INSERT INTO workspace_goal_revisions (id,goal_id,kind,revision,content_json,content_hash,source_artifact_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(revision.id, revision.goalId, revision.kind, revision.revision, JSON.stringify(revision.content), revision.contentHash, revision.sourceArtifactId, revision.createdBy, revision.createdAt); }
function revisionFromRow(row: RevisionRow): WorkspaceGoalRevision {
  const content = JSON.parse(row.contentJson) as WorkspaceGoalDefinition | WorkspaceGoalRoadmap;
  if (workspaceGoalContentHash(content) !== row.contentHash) throw new Error(`workspace Goal revision ${row.id} content hash mismatch`);
  const { contentJson: _contentJson, kind, ...revision } = row;
  return { ...revision, kind, content };
}
function definitionContent(revision: WorkspaceGoalRevision): WorkspaceGoalDefinition { return revision.content as WorkspaceGoalDefinition; }
function roadmapContent(revision: WorkspaceGoalRevision): WorkspaceGoalRoadmap { return revision.content as WorkspaceGoalRoadmap; }
function decisionFromRow(row: DecisionRow): WorkspaceGoalDecision { const { approvedItemIdsJson, requestId, ...decision } = row; return { ...decision, requestId: requestId ?? "", approvedItemIds: JSON.parse(approvedItemIdsJson) as string[] }; }
function runLinkFromRow(row: RunLinkRow): WorkspaceGoalRunLink { return { goalId: row.goalId, runId: row.runId, goalRevision: row.goalRevision, roadmapRevisionId: row.roadmapRevisionId, roadmapItemIds: JSON.parse(row.roadmapItemIdsJson) as string[], criterionKeys: JSON.parse(row.criterionKeysJson) as string[], mode: row.mode, createdAt: row.createdAt }; }
function splitEvidenceRef(ref: string): [string, string] { const index = ref.indexOf(":"); return index < 1 ? ["", ""] : [ref.slice(0, index), ref.slice(index + 1)]; }
function projectedRoadmapStatus(persisted: WorkspaceGoalRoadmapItemProgress["status"], runStatus: RunStatus | null): WorkspaceGoalRoadmapItemProgress["status"] {
  if (runStatus === "completed") return "completed";
  if (runStatus === "running" || runStatus === "waiting_input") return "running";
  if (runStatus && ["blocked", "interrupted", "cancelled", "failed"].includes(runStatus)) return "blocked";
  return persisted;
}
