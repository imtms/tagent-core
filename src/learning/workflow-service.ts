import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.js";
import type { ContextManifestItem, RunStatus, TaskRun } from "../core/types.js";
import type { LearningFeatureControl } from "./feature-control.js";
import type { SemanticJudge } from "./semantic-judge.js";

export type WorkflowStatus = "candidate" | "active" | "suspended" | "deprecated";
export type WorkflowApplicationStatus = "exposed" | "adopted" | "partial" | "rejected";
export interface WorkflowSkippedStep { stepId: string; reason: string }
export interface WorkflowVerificationMapping { verificationCheck: string; runCheckKey: string }
export type WorkflowSourceType = "explicit_user" | "task_experience" | "task_failure" | "user_correction";
export type WorkflowFeedbackSignal = "successful" | "failed" | "corrected" | "harmful" | "helpful";
export type AutonomyActionType = "activate_workflow" | "apply_revision" | "start_canary" | "execute_workflow";
export type AutonomyApprovalStatus = "pending" | "approved" | "rejected" | "revoked" | "expired" | "executed";

export interface WorkflowStep { stepId: string; instruction: string; required: boolean; expectedArtifact?: string; failureHandling?: string }
export interface WorkflowVerification { check: string; required: boolean; successCondition: string }
export interface WorkflowValueContract { name: string; description: string; required: boolean; schema?: string }
export interface WorkflowSpec {
  name: string;
  intent: string;
  cueTerms: string[];
  applicability: string[];
  nonApplicability: string[];
  preconditions: string[];
  inputContract: WorkflowValueContract[];
  outputContract: WorkflowValueContract[];
  steps: WorkflowStep[];
  verification: WorkflowVerification[];
  requiredCapabilities: string[];
  riskClass: "low" | "medium" | "high";
}
export interface WorkflowRevision extends WorkflowSpec {
  id: string; workflowId: string; revision: number; sourceType: WorkflowSourceType;
  sourceEvidenceIds: string[]; counterexampleIds: string[]; confidence: number; changeSummary: string; createdAt: number;
}
export interface WorkflowDefinition {
  id: string; scopeId: string; status: WorkflowStatus; activeRevisionId: string | null;
  deletedAt?: number | null; purgeAfter?: number | null; deleteReason?: string; previousStatus?: WorkflowStatus | null; previousActiveRevisionId?: string | null;
  createdAt: number; updatedAt: number; revision?: WorkflowRevision;
}
export interface WorkflowRecall {
  promptSection: string;
  contextItems: ContextManifestItem[];
  workflows: Array<{ definition: WorkflowDefinition; revision: WorkflowRevision; score: number; reasons: string[]; bindingId: string }>;
}
export interface WorkflowEvaluationCheckResult { runId: string; checkKey: string; required: boolean; status: string; stale: boolean }
export interface TrustedEvaluationInput {
  workflowId: string; kind: "shadow" | "offline_replay" | "canary"; evaluatorId: string; evaluatorVersion: string;
  datasetId: string; datasetHash: string; baselineRevisionId: string; candidateRevisionId: string;
  evaluationRunIds: string[]; checkResults: WorkflowEvaluationCheckResult[]; signature?: string;
}
export interface AutonomyApprovalRequest {
  id: string; scopeId: string; actionType: AutonomyActionType; targetType: string; targetId: string;
  workflowId: string | null; revisionId: string | null; proposalId: string | null; bindingId: string | null;
  status: AutonomyApprovalStatus; riskClass: "low" | "medium" | "high"; impactScopeJson: string;
  evidenceJson: string; diffJson: string; rollbackJson: string; requestedBy: string; requestReason: string;
  expiresAt: number; decidedBy: string; decisionReason: string; decidedAt: number | null; executedAt: number | null;
  executionReceiptJson: string; requestHash: string; createdAt: number; updatedAt: number;
}

const now = () => Date.now();
const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const terms = (value: string) => [...new Set(normalize(value).split(/\s+/).filter((item) => item.length >= 2))];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const characterNgrams = (value: string) => {
  const compact = normalize(value).replace(/\s+/g, "");
  const grams: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) grams.push(compact.slice(index, index + 2));
  return grams;
};
const semanticFeatures = (value: string) => new Set([...terms(value).map((item) => `t:${item}`), ...characterNgrams(value).map((item) => `g:${item}`)]);
const semanticSimilarity = (left: Set<string>, right: Set<string>) => {
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  return (2 * intersection) / (left.size + right.size);
};
const textSimilarity = (left: string, right: string) => semanticSimilarity(semanticFeatures(left), semanticFeatures(right));
const parseProcedureSteps = (summary: string) => summary.split(/\n+/).map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
const redact = (value: string) => value
  .replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]")
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");

export class WorkflowService {
  constructor(private readonly store: Store, private readonly evaluationSecret = process.env.TAGENT_EVALUATION_RECEIPT_SECRET ?? "", private readonly featureControl?: LearningFeatureControl, private readonly semanticJudge?: SemanticJudge) {}

  private requireLearning() { this.featureControl?.requireLearning(); }
  private requireAutoExecution() { this.featureControl?.requireAutoExecution(); }
  private learningAvailable() { return this.featureControl?.snapshot().learningEnabled ?? true; }

  setRunLearningPolicy(runId: string, policy: "allow" | "metadata_only" | "deny", reason = "user_requested") {
    this.store.db.prepare(`INSERT INTO run_learning_policies (run_id, policy, reason, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET policy=excluded.policy, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(runId, policy, reason, now());
    return this.getRunLearningPolicy(runId);
  }

  getRunLearningPolicy(runId: string) {
    return this.store.db.prepare("SELECT run_id as runId, policy, reason, updated_at as updatedAt FROM run_learning_policies WHERE run_id = ?").get(runId) as { runId: string; policy: "allow" | "metadata_only" | "deny"; reason: string; updatedAt: number } | undefined
      ?? { runId, policy: "allow" as const, reason: "default", updatedAt: 0 };
  }

  teach(scopeId: string, spec: WorkflowSpec, sourceId: string) {
    this.requireLearning();
    return this.createWorkflow(scopeId, sanitizeSpec(spec), "explicit_user", sanitizeIds([sourceId]), "candidate", 0.9, "Explicit user teaching");
  }

  recordExperience(input: { scopeId: string; runId?: string; attempt?: number; lifecycle?: string; outcome?: string; eventSeq?: number; sourceType: WorkflowSourceType; taskSignature: string; procedureSummary: string; checksPassed?: string[]; checksFailed?: string[]; sourceRefs?: string[]; learnPolicy?: "allow" | "metadata_only" | "deny" }) {
    if (!this.learningAvailable() || input.learnPolicy === "deny") return undefined;
    const safeSummary = input.learnPolicy === "metadata_only" ? "[metadata only]" : redact(input.procedureSummary).slice(0, 12_000);
    const safeSignature = normalize(redact(input.taskSignature)).slice(0, 1000);
    const safeChecksPassed = input.learnPolicy === "metadata_only" ? [] : sanitizeIds(input.checksPassed ?? []);
    const safeChecksFailed = input.learnPolicy === "metadata_only" ? [] : sanitizeIds(input.checksFailed ?? []);
    const safeSourceRefs = sanitizeIds(input.sourceRefs ?? []);
    const observationHash = hash({ runId: input.runId, attempt: input.attempt, lifecycle: input.lifecycle ?? "manual", eventSeq: input.eventSeq ?? 0, sourceType: input.sourceType, taskSignature: safeSignature, procedureSummary: safeSummary });
    const id = randomUUID();
    this.store.db.prepare(`INSERT OR IGNORE INTO experience_observations
      (id, scope_id, run_id, attempt, lifecycle, outcome, event_seq, source_type, task_signature, procedure_summary, checks_passed_json, checks_failed_json, source_refs_json, learn_policy, observation_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, redact(input.scopeId).slice(0, 500), input.runId ?? null, input.attempt ?? null, input.lifecycle ?? "manual", input.outcome ?? "", input.eventSeq ?? 0, input.sourceType, safeSignature, safeSummary,
        JSON.stringify(safeChecksPassed), JSON.stringify(safeChecksFailed), JSON.stringify(safeSourceRefs), input.learnPolicy ?? "allow", observationHash, now());
    return this.store.db.prepare("SELECT id FROM experience_observations WHERE observation_hash = ?").get(observationHash) as { id: string };
  }

  projectRun(run: TaskRun, outcome: RunStatus, projection?: { lifecycle?: string; eventSeq?: number; payload?: Record<string, unknown> }) {
    if (!this.learningAvailable()) return undefined;
    const policy = this.getRunLearningPolicy(run.id);
    if (policy.policy === "deny") return undefined;
    const requiredChecks = run.checks.filter((check) => check.required);
    const explicitConfirmation = Boolean(projection?.payload?.userConfirmed || projection?.payload?.explicitUserConfirmation);
    const completedWithEvidence = outcome === "completed" && ((requiredChecks.length > 0 && requiredChecks.every((check) => check.status === "passed" && !check.stale)) || explicitConfirmation);
    const sourceType: WorkflowSourceType = completedWithEvidence ? "task_experience" : "task_failure";
    const plan = run.plan.filter((item) => item.status === "done").sort((a, b) => a.position - b.position);
    const lifecycle = projection?.lifecycle ?? `run.${outcome}`;
    const summary = plan.length ? plan.map((item, index) => `${index + 1}. ${item.title}`).join("\n") : run.blockedReason || `Run lifecycle ${lifecycle}: ${outcome}`;
    const observation = this.recordExperience({
      scopeId: run.sessionId,
      runId: run.id,
      attempt: run.attempt,
      lifecycle,
      outcome,
      eventSeq: projection?.eventSeq ?? 0,
      sourceType,
      taskSignature: run.contract?.summary ?? run.goal,
      procedureSummary: summary,
      checksPassed: run.checks.filter((item) => item.status === "passed" && !item.stale).map((item) => item.key),
      checksFailed: run.checks.filter((item) => item.status === "failed" || item.stale).map((item) => item.key),
      sourceRefs: [`run:${run.id}:attempt:${run.attempt}`, `lifecycle:${lifecycle}`],
      learnPolicy: policy.policy,
    });
    this.autonomyAudit(run.sessionId, "observe", "run_outcome_projected", "learning_projector", { sourceRunId: run.id, evidence: observation ? [observation.id] : [], metadata: { attempt: run.attempt, lifecycle, outcome, policy: policy.policy, completedWithEvidence } });
    if (completedWithEvidence) {
      const taskSignature = normalize(run.contract?.summary ?? run.goal);
      const input={taskSignature,procedureSummary:summary,stepCount:plan.length,outcome,requiredChecks:requiredChecks.map((check)=>({key:check.key,status:check.status,stale:check.stale}))};
      if (this.semanticJudge) this.store.enqueueSemanticLearningJob("workflow_eligibility", { runId: run.id, scopeId: run.sessionId, taskSignature, observationId: observation?.id ?? "", input }, `semantic-workflow-eligibility:${run.id}:${run.attempt}:${lifecycle}:${projection?.eventSeq ?? 0}`, run.id, run.attempt);
      else this.applyWorkflowEligibility(run.sessionId,run.id,taskSignature,observation?.id,undefined,plan.length);
    }
    return observation;
  }

  private applyWorkflowEligibility(scopeId:string,runId:string,taskSignature:string,observationId:string|undefined,semanticEligibility:Awaited<ReturnType<SemanticJudge["learningSample"]>>,stepCount:number) {
    const eligibility=semanticEligibility?{eligible:semanticEligibility.eligible&&semanticEligibility.reusable,reason:semanticEligibility.reason}:distillationEligibility(taskSignature,stepCount);
    if(eligibility.eligible){this.enqueueDistillation(scopeId,taskSignature);this.autonomyAudit(scopeId,"learn","distillation_enqueued","learning_projector",{sourceRunId:runId,evidence:observationId?[observationId]:[],metadata:{taskSignature,semantic:semanticEligibility??null}});}
    else this.autonomyAudit(scopeId,"learn","distillation_withheld","learning_projector",{sourceRunId:runId,evidence:observationId?[observationId]:[],metadata:{taskSignature,reason:eligibility.reason,semantic:semanticEligibility??null}});
  }

  async drainSemanticLearningJobs(limit = 100) {
    if (!this.semanticJudge) return 0;
    const rows = this.store.listDueSemanticLearningJobs(limit).filter((row)=>row.kind==="workflow_eligibility");
    for (const row of rows) {
      try {
        const payload=JSON.parse(row.payloadJson) as {runId:string;scopeId:string;taskSignature:string;observationId?:string;input:{taskSignature:string;procedureSummary:string;stepCount?:number;outcome?:string;requiredChecks?:Array<{key:string;status:string;stale:boolean}>}};
        const failuresBefore=this.semanticJudge.snapshot().failures;
        const decision=await this.semanticJudge.learningSample(payload.input);
        if(!decision&&this.semanticJudge.snapshot().failures>failuresBefore)throw new Error("Semantic workflow eligibility failed");
        this.applyWorkflowEligibility(payload.scopeId,payload.runId,payload.taskSignature,payload.observationId,decision,payload.input.stepCount??0);
        this.store.completeSemanticLearningJob(row.id);
      } catch(error){this.store.failSemanticLearningJob(row.id,row.attempts,error instanceof Error?error.message:String(error));}
    }
    return rows.length;
  }

  drainProjectionOutbox(limit = 100) {
    const rows = this.store.listPendingLearningProjections(limit);
    for (const row of rows) {
      try {
        const snapshot = JSON.parse(row.snapshotJson || "null") as TaskRun | null;
        const run = snapshot ?? this.store.getRun(row.runId);
        if (run) {
          const projectedRun: TaskRun = { ...run, attempt: row.attempt, status: row.outcome as RunStatus };
          this.projectRun(projectedRun, row.outcome as RunStatus, { lifecycle: row.lifecycle, eventSeq: row.eventSeq, payload: JSON.parse(row.payloadJson) as Record<string, unknown> });
          this.recordCanaryOutcome(projectedRun);
        }
        this.store.completeLearningProjection(row.id);
      } catch (error) { this.store.failLearningProjection(row.id, error instanceof Error ? error.message : String(error)); }
    }
    return rows.length;
  }

  enqueueDistillation(scopeId: string, taskSignature: string) {
    this.requireLearning();
    const timestamp = now();
    this.store.db.prepare(`INSERT INTO workflow_distillation_jobs
      (id, scope_id, task_signature, signature_terms_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(scope_id, task_signature) DO UPDATE SET status=CASE WHEN workflow_distillation_jobs.status='running' THEN 'running' ELSE 'queued' END,
        signature_terms_json=excluded.signature_terms_json, error='', updated_at=excluded.updated_at`)
      .run(randomUUID(), scopeId, taskSignature, JSON.stringify(terms(taskSignature)), timestamp, timestamp);
    return this.store.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE scope_id=? AND task_signature=?").get(scopeId, taskSignature);
  }

  claimDistillationJob(owner: string, leaseMs = 30_000) {
    if (!this.learningAvailable()) return undefined;
    const timestamp = now(); const token = randomUUID();
    const transaction = this.store.db.transaction(() => {
      const row = this.store.db.prepare(`SELECT id FROM workflow_distillation_jobs WHERE status='queued'
        OR (status='running' AND (lease_until IS NULL OR lease_until<=?)) ORDER BY created_at LIMIT 1`).get(timestamp) as { id: string } | undefined;
      if (!row) return undefined;
      const changed = this.store.db.prepare(`UPDATE workflow_distillation_jobs SET status='running', attempts=attempts+1,
        lease_owner=?, lease_token=?, lease_until=?, fence=fence+1, updated_at=? WHERE id=?
        AND (status='queued' OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
        .run(owner, token, timestamp + leaseMs, timestamp, row.id, timestamp).changes;
      if (!changed) return undefined;
      return this.store.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE id=?").get(row.id) as Record<string, unknown>;
    });
    return transaction();
  }

  renewDistillationLease(id: string, owner: string, token: string, fence: number, leaseMs = 30_000) {
    const timestamp = now(); return this.store.db.prepare(`UPDATE workflow_distillation_jobs SET lease_until=?,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=? AND lease_until>?`)
      .run(timestamp + leaseMs, timestamp, id, owner, token, fence, timestamp).changes === 1;
  }

  checkpointDistillationJob(id: string, owner: string, token: string, fence: number, checkpoint: Record<string, unknown>, leaseMs = 30_000) {
    const timestamp = now();
    const changed = this.store.db.prepare(`UPDATE workflow_distillation_jobs SET checkpoint_json=?,lease_until=?,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=? AND lease_until>?`)
      .run(JSON.stringify(checkpoint), timestamp + leaseMs, timestamp, id, owner, token, fence, timestamp).changes;
    if (changed !== 1) throw new Error("Distillation lease lost");
  }

  async runNextDistillationJob(owner = `distiller:${randomUUID()}`) {
    if (!this.learningAvailable()) return undefined;
    const job = this.claimDistillationJob(owner) as { id: string; scope_id: string; task_signature: string; lease_token: string; fence: number; attempts: number; checkpoint_json: string } | undefined;
    if (!job) return undefined;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (!this.renewDistillationLease(job.id, owner, job.lease_token, job.fence)) leaseLost = true;
    }, 8_000);
    heartbeat.unref?.();
    try {
      this.checkpointDistillationJob(job.id, owner, job.lease_token, job.fence, { phase: "claimed", previous: JSON.parse(job.checkpoint_json || "{}") });
      const result = await this.distillRepeatedExperience(job.scope_id, job.task_signature, {
        semantic: true,
        checkpoint: (checkpoint) => {
          if (leaseLost) throw new Error("Distillation lease lost");
          this.checkpointDistillationJob(job.id, owner, job.lease_token, job.fence, checkpoint);
        },
        jobId: job.id,
      });
      if (leaseLost) throw new Error("Distillation lease lost");
      const priorCheckpoint = JSON.parse(String((this.store.db.prepare("SELECT checkpoint_json value FROM workflow_distillation_jobs WHERE id=?").get(job.id) as {value?:string}|undefined)?.value||"{}")) as Record<string,unknown>;
      const changed = this.store.db.prepare(`UPDATE workflow_distillation_jobs SET status='completed', workflow_id=?, checkpoint_json=?,
        lease_owner='',lease_token='',lease_until=NULL,error='',updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=?`)
        .run(result?.id ?? null, JSON.stringify({ phase: "completed", result: result?.id ? "candidate" : "withheld", workflowId: result?.id ?? null, detail: priorCheckpoint }), now(), job.id, owner, job.lease_token, job.fence).changes;
      if (changed !== 1) throw new Error("Distillation lease lost before completion");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const status = job.attempts >= 3 ? "dead_letter" : "queued";
      this.store.db.prepare(`UPDATE workflow_distillation_jobs SET status=?,checkpoint_json=?,error=?,lease_owner='',lease_token='',lease_until=NULL,updated_at=?
        WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND fence=?`).run(status, JSON.stringify({ phase: "failed", error: redact(message) }), redact(message), now(), job.id, owner, job.lease_token, job.fence);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async distillRepeatedExperience(scopeId: string, taskSignature: string, options: { jobId?: string; semantic?: boolean; checkpoint?: (checkpoint: Record<string, unknown>) => void } = {}) {
    const checkpoint = (value: Record<string, unknown>) => {
      if (options.checkpoint) options.checkpoint(value);
      else if (options.jobId) this.store.db.prepare("UPDATE workflow_distillation_jobs SET checkpoint_json=?,updated_at=? WHERE id=?").run(JSON.stringify(value), now(), options.jobId);
    };
    checkpoint({ phase: "scan" });
    const candidates = this.store.db.prepare(`SELECT id, run_id as runId, source_type as sourceType, task_signature as taskSignature,
      procedure_summary as procedureSummary, checks_passed_json as checksPassedJson, checks_failed_json as checksFailedJson, created_at as createdAt
      FROM experience_observations WHERE scope_id = ? AND learn_policy = 'allow' AND run_id IS NOT NULL
      AND source_type IN ('task_experience','task_failure') ORDER BY created_at DESC LIMIT 500`).all(scopeId) as Array<{ id: string; runId: string; sourceType: WorkflowSourceType; taskSignature: string; procedureSummary: string; checksPassedJson: string; checksFailedJson: string; createdAt: number }>;
    const similar:Array<(typeof candidates)[number]&{similarity:number}>=[];
    for(const row of candidates){const lexical=options.semantic===false?Number(normalize(row.taskSignature)===normalize(taskSignature)):textSimilarity(taskSignature,row.taskSignature);if(lexical>=.72){similar.push({...row,similarity:lexical});continue;}if(this.semanticJudge&&options.semantic!==false){const decision=await this.semanticJudge.cluster(taskSignature,row.taskSignature);if(decision?.similar)similar.push({...row,similarity:decision.confidence});}else if(lexical>=.48)similar.push({...row,similarity:lexical});}
    const successes=[] as typeof similar;const failures=[] as typeof similar;
    for(const row of similar){if(row.sourceType==="task_experience"){const semantic=this.semanticJudge?await this.semanticJudge.learningSample({taskSignature:row.taskSignature,procedureSummary:row.procedureSummary,stepCount:parseProcedureSteps(row.procedureSummary).length,checksPassed:JSON.parse(row.checksPassedJson)}):undefined;if((semantic?semantic.eligible&&semantic.reusable:distillationEligibility(row.taskSignature,parseProcedureSteps(row.procedureSummary).length).eligible)&&!successes.some((item)=>item.runId===row.runId))successes.push(row);}else{const semantic=this.semanticJudge?await this.semanticJudge.learningSample({taskSignature:row.taskSignature,procedureSummary:row.procedureSummary,checksFailed:JSON.parse(row.checksFailedJson),outcome:"failed"}):undefined;if((semantic?semantic.failureIsCounterexample:failureIsCounterexample(row))&&!failures.some((item)=>item.runId===row.runId))failures.push(row);}}
    checkpoint({ phase: "clustered", scanned: candidates.length, matched: similar.length, successes: successes.length, failures: failures.length, runIds: successes.map((row) => row.runId) });
    if (successes.length < 2) return undefined;

    const evidenceIds = successes.map((row) => row.id).sort();
    const evidenceSetHash = hash(evidenceIds);
    const existing = this.store.db.prepare("SELECT workflow_id as workflowId FROM workflow_distillations WHERE evidence_set_hash = ?").get(evidenceSetHash) as { workflowId: string } | undefined;
    if (existing) return this.getWorkflow(existing.workflowId);

    const procedures = successes.map((row) => parseProcedureSteps(row.procedureSummary));
    const minimumSupport = Math.max(2, Math.ceil(procedures.length * 0.67));
    const semanticProcedure=this.semanticJudge?await this.semanticJudge.procedure({successes:successes.map((row)=>({runId:row.runId,taskSignature:row.taskSignature,steps:parseProcedureSteps(row.procedureSummary),checksPassed:JSON.parse(row.checksPassedJson)})),failures:failures.map((row)=>({runId:row.runId,taskSignature:row.taskSignature,steps:parseProcedureSteps(row.procedureSummary),checksFailed:JSON.parse(row.checksFailedJson)})),minimumSupport}):undefined;
    let consistentGroups:Array<{instruction:string;occurrences:Array<{procedureIndex:number;position:number}>}>;let stepLines:string[];let orderConflicts:number;
    if(semanticProcedure){const runIndex=new Map(successes.map((row,index)=>[row.runId,index]));consistentGroups=semanticProcedure.commonSteps.filter((step)=>new Set(step.supportRunIds).size>=minimumSupport).map((step)=>({instruction:step.instruction,occurrences:step.supportRunIds.map((runId)=>({procedureIndex:runIndex.get(runId)??0,position:procedures[runIndex.get(runId)??0]?.findIndex((item)=>textSimilarity(item,step.instruction)>=.45)??0}))}));stepLines=consistentGroups.map((group)=>group.instruction).slice(0,30);orderConflicts=countOrderConflicts(consistentGroups);}else{const stepCandidates=procedures.flatMap((steps,procedureIndex)=>steps.map((instruction,position)=>({instruction,procedureIndex,position})));const groups:Array<{instruction:string;occurrences:Array<{procedureIndex:number;position:number}>}>=[];for(const candidate of stepCandidates){const group=groups.find((item)=>textSimilarity(item.instruction,candidate.instruction)>=.78);if(group){if(!group.occurrences.some((item)=>item.procedureIndex===candidate.procedureIndex))group.occurrences.push({procedureIndex:candidate.procedureIndex,position:candidate.position});}else groups.push({instruction:candidate.instruction,occurrences:[{procedureIndex:candidate.procedureIndex,position:candidate.position}]});}consistentGroups=groups.filter((group)=>group.occurrences.length>=minimumSupport).sort((left,right)=>average(left.occurrences.map((item)=>item.position))-average(right.occurrences.map((item)=>item.position)));stepLines=consistentGroups.map((group)=>group.instruction).slice(0,30);orderConflicts=countOrderConflicts(consistentGroups);}
    checkpoint({ phase: "steps", procedureCount: procedures.length, minimumSupport, consistentSteps: consistentGroups.length, orderConflicts, semantic:Boolean(semanticProcedure) });
    if (!stepLines.length) { checkpoint({ phase: "withheld", reason: "no_consistent_steps", procedureCount: procedures.length, minimumSupport }); return undefined; }

    const deterministicChecks = successes.map((row) => JSON.parse(row.checksPassedJson) as string[]).reduce<string[]>((common,current,index)=>index===0?current:common.filter((check)=>current.includes(check)),[]).slice(0,12);
    const checks=(semanticProcedure?.verificationChecks.filter((check)=>deterministicChecks.includes(check))??deterministicChecks).slice(0,12);
    if (!checks.length) { checkpoint({ phase: "withheld", reason: "no_common_verification", procedureCount: procedures.length }); return undefined; }
    const failedChecks = [...new Set(failures.flatMap((row) => JSON.parse(row.checksFailedJson) as string[]))].slice(0, 12);
    const counterexampleIds = failures.map((row) => row.id);
    const failureHandling = semanticProcedure?.failureHandling || (failedChecks.length
      ? `Stop when ${failedChecks.join(", ")} fails; preserve evidence, diagnose the failed check, and require a corrected retry before continuing.`
      : failures.length
        ? "Stop on a repeated failure pattern; preserve evidence, record the failing step, and request correction before retrying."
        : "Stop on verification failure, preserve evidence, and diagnose before retrying.");
    const nonApplicability = failures.slice(0, 8).map((row) => `Exclude contexts matching failed run: ${row.taskSignature}`);
    const cueTerms = terms(successes.map((row) => row.taskSignature).join(" ")).slice(0, 16);

    const existingWorkflows = this.listWorkflows(scopeId, true).filter((item) => item.revision);
    for (const item of existingWorkflows) {
      const revision = item.revision!;
      const similarity = textSimilarity(taskSignature, `${revision.intent} ${revision.cueTerms.join(" ")} ${revision.applicability.join(" ")}`);
      if (similarity < 0.72) continue;
      const existingSteps = revision.steps.map((step) => step.instruction);
      const stepAgreement = sequenceAgreement(stepLines, existingSteps);
      const kind = stepAgreement >= 0.7 ? "duplicate" : "conflict";
      const reasons = kind === "duplicate"
        ? [`semantic similarity ${similarity.toFixed(3)}`, `step agreement ${stepAgreement.toFixed(3)}`]
        : [`same applicability with divergent procedure`, `semantic similarity ${similarity.toFixed(3)}`, `step agreement ${stepAgreement.toFixed(3)}`];
      if (options.jobId) this.store.db.prepare(`INSERT OR IGNORE INTO workflow_distillation_conflicts
        (id,job_id,scope_id,candidate_signature,existing_workflow_id,existing_revision_id,kind,similarity,reasons_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'open',?)`).run(randomUUID(), options.jobId, scopeId, taskSignature, item.id, revision.id, kind, similarity, JSON.stringify(reasons), now());
      checkpoint({ phase: kind, workflowId: item.id, revisionId: revision.id, similarity, stepAgreement, reasons });
      if (kind === "duplicate") return item;
      return undefined;
    }

    const workflow = this.createWorkflow(scopeId, {
      name: taskSignature.slice(0, 120), intent: taskSignature, cueTerms,
      applicability: [taskSignature], nonApplicability, preconditions: [], inputContract: [], outputContract: [],
      steps: stepLines.map((instruction, index) => ({ stepId: `step-${index + 1}`, instruction, required: true, failureHandling })),
      verification: checks.map((check) => ({ check, required: true, successCondition: "check passes with fresh evidence" })),
      requiredCapabilities: [], riskClass: "low",
    }, "task_experience", evidenceIds, "candidate", Math.min(0.85, 0.55 + successes.length * 0.1 - failures.length * 0.03 - orderConflicts * 0.02), `Distilled from ${successes.length} independent TaskRuns with ${failures.length} counterexample(s); ${consistentGroups.length} consistent step(s)`, counterexampleIds);
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO workflow_distillations (evidence_set_hash, workflow_id, created_at) VALUES (?, ?, ?)").run(evidenceSetHash, workflow.id, now());
      checkpoint({ phase: "persisted", workflowId: workflow.id, evidenceSetHash, counterexamples: counterexampleIds.length });
    })();
    this.autonomyAudit(scopeId, "distill", "workflow_candidate_created", "experience_distiller", { workflowId: workflow.id, revisionId: workflow.revision?.id, evidence: evidenceIds, metadata: { evidenceSetHash, counterexampleIds, status: workflow.status } });
    return workflow;
  }

  createWorkflow(scopeId: string, spec: WorkflowSpec, sourceType: WorkflowSourceType, evidenceIds: string[], status: WorkflowStatus = "candidate", confidence = 0.7, changeSummary = "Initial revision", counterexampleIds: string[] = []) {
    const timestamp = now(); const workflowId = randomUUID(); const revisionId = randomUUID();
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO workflow_definitions (id, scope_id, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(workflowId, redact(scopeId).slice(0, 500), status, status === "active" ? revisionId : null, timestamp, timestamp);
      this.store.db.prepare(`INSERT INTO workflow_revisions
        (id, workflow_id, revision, spec_json, spec_hash, source_type, source_evidence_json, confidence, change_summary, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .run(revisionId, workflowId, JSON.stringify({ ...sanitizeSpec(spec), counterexampleIds: sanitizeIds(counterexampleIds) }), specHash(sanitizeSpec(spec)), sourceType, JSON.stringify(sanitizeIds(evidenceIds)), confidence, redact(changeSummary).slice(0, 2000), timestamp);
    }); transaction();
    return this.getWorkflow(workflowId)!;
  }

  revise(workflowId: string, patch: Partial<WorkflowSpec>, sourceType: WorkflowSourceType, evidenceIds: string[], changeSummary: string, expectedBaseRevisionId?: string) {
    const current = this.getWorkflow(workflowId, true); if (!current?.revision) throw new Error("Workflow not found");
    if (expectedBaseRevisionId && current.revision.id !== expectedBaseRevisionId) throw new Error("Proposal base revision is stale");
    const changedPaths = patchPaths(patch);
    if (!changedPaths.length) throw new Error("Workflow revision patch must be non-empty");
    const baseSpec = pickSpec(current.revision); const spec = sanitizeSpec({ ...baseSpec, ...patch });
    if (specHash(baseSpec) === specHash(spec)) throw new Error("Workflow revision must change the spec hash");
    const revision = (this.store.db.prepare("SELECT COALESCE(MAX(revision), 0) as revision FROM workflow_revisions WHERE workflow_id = ?").get(workflowId) as { revision: number }).revision + 1;
    const id = randomUUID();
    this.store.db.prepare(`INSERT INTO workflow_revisions (id, workflow_id, revision, spec_json, spec_hash, source_type, source_evidence_json, confidence, change_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workflowId, revision, JSON.stringify({ ...spec, counterexampleIds: current.revision.counterexampleIds }), specHash(spec), sourceType, JSON.stringify(sanitizeIds(evidenceIds)), current.revision.confidence, redact(changeSummary).slice(0, 2000), now());
    return this.getRevision(id)!;
  }

  requestApproval(input: { scopeId: string; actionType: AutonomyActionType; targetType: string; targetId: string; workflowId?: string; revisionId?: string; proposalId?: string; bindingId?: string; riskClass: "low" | "medium" | "high"; impactScope?: Record<string, unknown>; evidence?: string[]; diff?: Record<string, unknown>; rollback?: Record<string, unknown>; requestedBy?: string; reason?: string; expiresInMs?: number }) {
    this.requireAutoExecution();
    const timestamp = now();
    const expiresAt = timestamp + Math.max(60_000, Math.min(input.expiresInMs ?? 86_400_000, 2_592_000_000));
    const payload = { scopeId: input.scopeId, actionType: input.actionType, targetType: input.targetType, targetId: input.targetId,
      workflowId: input.workflowId ?? null, revisionId: input.revisionId ?? null, proposalId: input.proposalId ?? null,
      bindingId: input.bindingId ?? null, riskClass: input.riskClass, impactScope: input.impactScope ?? {},
      evidence: sanitizeIds(input.evidence ?? []), diff: input.diff ?? {}, rollback: input.rollback ?? {}, expiresAt };
    const intentHash = hash(payload);
    const existing = this.store.db.prepare(`SELECT id,status FROM autonomy_approval_requests WHERE request_hash=?`).get(intentHash) as { id: string; status: string } | undefined;
    if (existing && (existing.status === "pending" || existing.status === "approved")) return this.getApproval(existing.id)!;
    const id = randomUUID();
    const requestHash = existing ? hash({ ...payload, requestId: id }) : intentHash;
    this.store.db.prepare(`INSERT INTO autonomy_approval_requests
      (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,proposal_id,binding_id,status,risk_class,
       impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,request_reason,expires_at,request_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.scopeId, input.actionType, input.targetType, input.targetId, input.workflowId ?? null, input.revisionId ?? null,
        input.proposalId ?? null, input.bindingId ?? null, input.riskClass, JSON.stringify(input.impactScope ?? {}),
        JSON.stringify(sanitizeIds(input.evidence ?? [])), JSON.stringify(input.diff ?? {}), JSON.stringify(input.rollback ?? {}),
        redact(input.requestedBy ?? "system").slice(0, 300), redact(input.reason ?? "").slice(0, 2000), expiresAt, requestHash, timestamp, timestamp);
    this.autonomyAudit(input.scopeId, "approval", "requested", input.requestedBy ?? "system", { approvalId: id, workflowId: input.workflowId, revisionId: input.revisionId, evidence: input.evidence, metadata: payload });
    return this.getApproval(id)!;
  }

  requestActivation(workflowId: string, revisionId?: string, requestedBy = "governor", reason = "activate workflow") {
    const workflow = this.getWorkflow(workflowId, true); const revision = revisionId ? this.getRevision(revisionId) : this.listRevisions(workflowId).at(-1);
    if (!workflow || !revision || revision.workflowId !== workflowId) throw new Error("Workflow revision not found");
    return this.requestApproval({ scopeId: workflow.scopeId, actionType: "activate_workflow", targetType: "workflow_revision", targetId: revision.id,
      workflowId, revisionId: revision.id, riskClass: revision.riskClass, requestedBy, reason,
      impactScope: { scopeId: workflow.scopeId, futureRuns: true, behaviorChange: true }, evidence: revision.sourceEvidenceIds,
      diff: { fromStatus: workflow.status, fromRevisionId: workflow.activeRevisionId, toStatus: "active", toRevisionId: revision.id },
      rollback: { action: "restore_workflow_state", status: workflow.status, revisionId: workflow.activeRevisionId } });
  }

  getApproval(id: string) {
    this.expireApprovals();
    return this.store.db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,target_type as targetType,target_id as targetId,
      workflow_id as workflowId,revision_id as revisionId,proposal_id as proposalId,binding_id as bindingId,status,risk_class as riskClass,
      impact_scope_json as impactScopeJson,evidence_json as evidenceJson,diff_json as diffJson,rollback_json as rollbackJson,
      requested_by as requestedBy,request_reason as requestReason,expires_at as expiresAt,decided_by as decidedBy,
      decision_reason as decisionReason,decided_at as decidedAt,executed_at as executedAt,execution_receipt_json as executionReceiptJson,
      request_hash as requestHash,created_at as createdAt,updated_at as updatedAt FROM autonomy_approval_requests WHERE id=?`).get(id) as AutonomyApprovalRequest | undefined;
  }

  listApprovals(scopeId: string, limit = 200) {
    this.expireApprovals();
    return this.store.db.prepare(`SELECT id,scope_id as scopeId,action_type as actionType,target_type as targetType,target_id as targetId,
      workflow_id as workflowId,revision_id as revisionId,proposal_id as proposalId,binding_id as bindingId,status,risk_class as riskClass,
      impact_scope_json as impactScopeJson,evidence_json as evidenceJson,diff_json as diffJson,rollback_json as rollbackJson,
      requested_by as requestedBy,request_reason as requestReason,expires_at as expiresAt,decided_by as decidedBy,
      decision_reason as decisionReason,decided_at as decidedAt,executed_at as executedAt,execution_receipt_json as executionReceiptJson,
      request_hash as requestHash,created_at as createdAt,updated_at as updatedAt FROM autonomy_approval_requests WHERE scope_id=? ORDER BY created_at DESC LIMIT ?`).all(scopeId, limit) as AutonomyApprovalRequest[];
  }

  decideApproval(id: string, decision: "approved" | "rejected", actor: string, reason = "") {
    const approval = this.getApproval(id); if (!approval || approval.status !== "pending") throw new Error("Approval request is not pending");
    const timestamp = now(); if (approval.expiresAt <= timestamp) { this.expireApprovals(); throw new Error("Approval request has expired"); }
    this.store.db.prepare(`UPDATE autonomy_approval_requests SET status=?,decided_by=?,decision_reason=?,decided_at=?,updated_at=? WHERE id=? AND status='pending'`)
      .run(decision, redact(actor), redact(reason), timestamp, timestamp, id);
    this.autonomyAudit(approval.scopeId, "approval", decision, actor, { approvalId: id, workflowId: approval.workflowId ?? undefined, revisionId: approval.revisionId ?? undefined, metadata: { reason } });
    return this.getApproval(id)!;
  }

  revokeApproval(id: string, actor: string, reason = "") {
    const approval = this.getApproval(id); if (!approval || !["pending", "approved"].includes(approval.status)) throw new Error("Approval request cannot be revoked");
    this.store.db.prepare(`UPDATE autonomy_approval_requests SET status='revoked',decided_by=?,decision_reason=?,decided_at=?,updated_at=? WHERE id=? AND status IN ('pending','approved')`)
      .run(redact(actor), redact(reason), now(), now(), id);
    this.autonomyAudit(approval.scopeId, "approval", "revoked", actor, { approvalId: id, workflowId: approval.workflowId ?? undefined, revisionId: approval.revisionId ?? undefined, metadata: { reason } });
    return this.getApproval(id)!;
  }

  private requireExecutableApproval(id: string) {
    this.requireAutoExecution();
    const approval = this.getApproval(id); if (!approval || approval.status !== "approved") throw new Error("Approved request is required before execution");
    if (approval.expiresAt <= now()) { this.expireApprovals(); throw new Error("Approval request has expired"); }
    return approval;
  }

  private completeApprovalExecution(approval: AutonomyApprovalRequest, actor: string, result: unknown) {
    const receipt = { actionType: approval.actionType, targetId: approval.targetId, result, executedBy: actor, executedAt: now() };
    this.store.db.prepare(`UPDATE autonomy_approval_requests SET status='executed',executed_at=?,execution_receipt_json=?,updated_at=? WHERE id=? AND status='approved'`)
      .run(receipt.executedAt, JSON.stringify(receipt), receipt.executedAt, approval.id);
    this.autonomyAudit(approval.scopeId, "execute", approval.actionType, actor, { approvalId: approval.id, workflowId: approval.workflowId ?? undefined, revisionId: approval.revisionId ?? undefined, metadata: receipt });
    return { approval: this.getApproval(approval.id)!, result };
  }

  executeExternalApproval(id: string, actor: string, executor: (approval: AutonomyApprovalRequest) => unknown) {
    const approval = this.requireExecutableApproval(id);
    const result = executor(approval);
    return this.completeApprovalExecution(approval, actor, result);
  }

  executeApproval(id: string, actor: string) {
    const approval = this.requireExecutableApproval(id);
    let result: unknown;
    if (approval.actionType === "activate_workflow") result = this.activateApproved(approval.workflowId!, approval.revisionId!, actor, id);
    else if (approval.actionType === "apply_revision") result = this.applyProposalApproved(approval.proposalId!, actor, id);
    else if (approval.actionType === "start_canary") result = this.promoteApproved(approval.workflowId!, approval.revisionId!, JSON.parse(approval.impactScopeJson) as { canaryPercent?: number; maxFailureDelta?: number }, id);
    else throw new Error("This approved action requires its capability-scoped executor");
    return this.completeApprovalExecution(approval, actor, result);
  }

  private expireApprovals() {
    const timestamp = now();
    const rows = this.store.db.prepare(`SELECT id,scope_id as scopeId,workflow_id as workflowId,revision_id as revisionId FROM autonomy_approval_requests WHERE status IN ('pending','approved') AND expires_at<=?`).all(timestamp) as Array<{id:string;scopeId:string;workflowId:string|null;revisionId:string|null}>;
    this.store.db.prepare(`UPDATE autonomy_approval_requests SET status='expired',updated_at=? WHERE status IN ('pending','approved') AND expires_at<=?`).run(timestamp, timestamp);
    for (const row of rows) this.autonomyAudit(row.scopeId, "approval", "expired", "system", { approvalId: row.id, workflowId: row.workflowId ?? undefined, revisionId: row.revisionId ?? undefined });
  }

  private activateApproved(workflowId: string, revisionId: string, actor: string, approvalId: string) {
    const revision = this.getRevision(revisionId); if (!revision || revision.workflowId !== workflowId) throw new Error("Workflow revision not found");
    if (revision.riskClass === "high") throw new Error("High-risk workflows require capability-specific execution approval beyond workflow governance");
    this.store.db.prepare("UPDATE workflow_definitions SET status='active', active_revision_id=?, updated_at=? WHERE id=? AND deleted_at IS NULL").run(revision.id, now(), workflowId);
    this.governanceReceipt(workflowId, "activate", actor, "human-approved activation", { revisionId: revision.id, approvalId });
    return this.getWorkflow(workflowId)!;
  }

  activate(workflowId: string, revisionId?: string, approvalId?: string) {
    if (!approvalId) throw new Error("Human approval is required before workflow activation");
    const approval = this.getApproval(approvalId);
    if (!approval || approval.actionType !== "activate_workflow" || approval.workflowId !== workflowId || (revisionId && approval.revisionId !== revisionId)) throw new Error("Approval does not authorize this activation");
    return this.executeApproval(approvalId, approval.decidedBy || "approved_governor").result as WorkflowDefinition;
  }
  suspend(workflowId: string, reason = "governance") { this.setStatus(workflowId, "suspended", reason); return this.getWorkflow(workflowId)!; }
  disable(workflowId: string, reason = "user_requested") { return this.suspend(workflowId, reason); }
  rollback(workflowId: string, revisionId: string, approvalId?: string) { return this.activate(workflowId, revisionId, approvalId); }
  setBindingMode(bindingId: string, mode: "suggested" | "adopted" | "partially_adopted" | "rejected") {
    const result = this.store.db.prepare("UPDATE workflow_bindings SET application_mode = ? WHERE id = ?").run(mode, bindingId);
    if (result.changes !== 1) throw new Error("Workflow binding not found");
    return { bindingId, mode };
  }

  recordApplication(input: { bindingId: string; status: WorkflowApplicationStatus; executedStepIds?: string[]; skippedSteps?: WorkflowSkippedStep[]; correctionObserved?: boolean; repeatedToolCalls?: number; continuationCount?: number; verificationMapping?: WorkflowVerificationMapping[] }) {
    this.requireAutoExecution();
    const mode = input.status === "adopted" ? "adopted" : input.status === "partial" ? "partially_adopted" : input.status === "rejected" ? "rejected" : "suggested";
    this.setBindingMode(input.bindingId, mode);
    this.store.db.prepare(`INSERT INTO workflow_application_receipts
      (id, binding_id, run_id, attempt, task_outcome, application_status, executed_step_ids_json, skipped_steps_json,
       correction_observed, repeated_tool_calls, continuation_count, verification_mapping_json, required_checks_passed,
       required_checks_failed, attribution_level, receipt_version, created_at)
      SELECT ?, id, run_id, attempt, 'in_progress', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, ? FROM workflow_bindings WHERE id=?
      ON CONFLICT(binding_id, receipt_version) DO UPDATE SET application_status=excluded.application_status,
       executed_step_ids_json=excluded.executed_step_ids_json, skipped_steps_json=excluded.skipped_steps_json,
       correction_observed=excluded.correction_observed, repeated_tool_calls=excluded.repeated_tool_calls,
       continuation_count=excluded.continuation_count, verification_mapping_json=excluded.verification_mapping_json,
       attribution_level=excluded.attribution_level`)
      .run(randomUUID(), input.status, JSON.stringify(sanitizeIds(input.executedStepIds ?? [])), JSON.stringify((input.skippedSteps ?? []).map((item) => ({ stepId: redact(item.stepId), reason: redact(item.reason) }))), Number(input.correctionObserved ?? false), Math.max(0, input.repeatedToolCalls ?? 0), Math.max(0, input.continuationCount ?? 0), JSON.stringify(input.verificationMapping ?? []), input.status === "exposed" || input.status === "rejected" ? "exposed" : "adopted", now(), input.bindingId);
    return this.getApplicationReceipt(input.bindingId);
  }

  getApplicationReceipt(bindingId: string) { return this.store.db.prepare("SELECT * FROM workflow_application_receipts WHERE binding_id=? ORDER BY receipt_version DESC LIMIT 1").get(bindingId) as Record<string, unknown> | undefined; }

  forget(workflowId: string, reason = "user_requested", gracePeriodMs = 2_592_000_000, actor = "user") {
    const current = this.getWorkflow(workflowId); if (!current) return false;
    const timestamp = now(); const purgeAfter = timestamp + Math.max(0, gracePeriodMs);
    const transaction = this.store.db.transaction(() => {
      const changed = this.store.db.prepare(`UPDATE workflow_definitions SET status='deprecated', active_revision_id=NULL,
        deleted_at=?, purge_after=?, delete_reason=?, previous_status=?, previous_active_revision_id=?, updated_at=? WHERE id=? AND deleted_at IS NULL`)
        .run(timestamp, purgeAfter, redact(reason), current.status, current.activeRevisionId, timestamp, workflowId).changes === 1;
      if (changed) this.governanceReceipt(workflowId, "forget", actor, reason, { purgeAfter, previousStatus: current.status, previousActiveRevisionId: current.activeRevisionId });
      return changed;
    });
    return transaction();
  }

  restore(workflowId: string, actor = "user") {
    const row = this.store.db.prepare(`SELECT previous_status as previousStatus, previous_active_revision_id as previousActiveRevisionId,
      purge_after as purgeAfter FROM workflow_definitions WHERE id=? AND deleted_at IS NOT NULL`).get(workflowId) as { previousStatus: WorkflowStatus | null; previousActiveRevisionId: string | null; purgeAfter: number | null } | undefined;
    if (!row || (row.purgeAfter != null && row.purgeAfter < now())) throw new Error("Workflow is not restorable");
    const status = row.previousStatus ?? "suspended"; const timestamp = now();
    this.store.db.prepare(`UPDATE workflow_definitions SET status=?, active_revision_id=?, deleted_at=NULL, purge_after=NULL,
      delete_reason='', previous_status=NULL, previous_active_revision_id=NULL, updated_at=? WHERE id=?`)
      .run(status, status === "active" ? row.previousActiveRevisionId : null, timestamp, workflowId);
    this.governanceReceipt(workflowId, "restore", actor, "restore within grace period", { restoredStatus: status });
    return this.getWorkflow(workflowId)!;
  }

  private governanceReceipt(workflowId: string, action: string, actor: string, reason: string, metadata: Record<string, unknown> = {}) {
    this.store.db.prepare(`INSERT INTO workflow_governance_receipts (id, workflow_id, action, actor, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), workflowId, action, redact(actor), redact(reason), JSON.stringify(metadata), now());
  }

  private setStatus(workflowId: string, status: WorkflowStatus, reason: string) {
    const current = this.getWorkflow(workflowId); if (!current) throw new Error("Workflow not found");
    this.store.db.prepare("UPDATE workflow_definitions SET status=?, active_revision_id=CASE WHEN ?='active' THEN active_revision_id ELSE NULL END, updated_at=? WHERE id=?").run(status, status, now(), workflowId);
    this.store.db.prepare("INSERT INTO workflow_status_history (id, workflow_id, previous_status, next_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), workflowId, current.status, status, reason, now());
  }

  recordRunApplications(run: TaskRun) {
    if (this.featureControl && !this.featureControl.snapshot().autoExecutionEnabled) return;
    const bindings = this.store.db.prepare(`SELECT id, workflow_id as workflowId, revision_id as revisionId, application_mode as applicationMode
      FROM workflow_bindings WHERE run_id = ? AND attempt = ?`).all(run.id, run.attempt) as Array<{ id: string; workflowId: string; revisionId: string; applicationMode: string }>;
    const passed = run.checks.filter((check) => check.required && check.status === "passed" && !check.stale).length;
    const failed = run.checks.filter((check) => check.required && (check.status === "failed" || check.stale)).length;
    for (const binding of bindings) {
      const adopted = binding.applicationMode === "adopted" || binding.applicationMode === "partially_adopted";
      const receipt = this.getApplicationReceipt(binding.id) as { verification_mapping_json?: string; application_status?: WorkflowApplicationStatus } | undefined;
      const mappings = JSON.parse(receipt?.verification_mapping_json ?? "[]") as WorkflowVerificationMapping[];
      const revision = this.getRevision(binding.revisionId);
      const requiredVerification = revision?.verification.filter((item) => item.required) ?? [];
      const mappedChecks = new Map(mappings.map((item) => [normalize(item.verificationCheck), item.runCheckKey]));
      const verified = adopted && requiredVerification.length > 0 && requiredVerification.every((verification) => {
        const key = mappedChecks.get(normalize(verification.check));
        const check = key ? run.checks.find((item) => item.key === key) : undefined;
        return Boolean(check?.required && check.status === "passed" && !check.stale);
      });
      const attributionLevel = verified ? "verified_contribution" : adopted ? "adopted" : "exposed";
      this.store.db.prepare(`INSERT INTO workflow_application_receipts
        (id, binding_id, run_id, attempt, task_outcome, application_status, required_checks_passed, required_checks_failed, attribution_level, receipt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(binding_id, receipt_version) DO UPDATE SET task_outcome=excluded.task_outcome,
          required_checks_passed=excluded.required_checks_passed, required_checks_failed=excluded.required_checks_failed,
          attribution_level=excluded.attribution_level`)
        .run(randomUUID(), binding.id, run.id, run.attempt, run.status, receipt?.application_status ?? (adopted ? "adopted" : "exposed"), passed, failed, attributionLevel, now());
      if (!adopted) continue;
      const signal: WorkflowFeedbackSignal = run.status === "completed" && verified ? "successful" : "failed";
      this.feedback({ workflowId: binding.workflowId, revisionId: binding.revisionId, runId: run.id, attempt: run.attempt, signal, idempotencyKey: `workflow-application:${binding.id}:v1`, adopted: true, verified });
    }
  }

  feedback(input: { workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; idempotencyKey: string; note?: string; adopted?: boolean; verified?: boolean }) {
    const weights: Record<WorkflowFeedbackSignal, number> = { successful: 1, helpful: 0.75, failed: -1, corrected: -1.5, harmful: -2 };
    const id = randomUUID();
    this.store.db.prepare(`INSERT OR IGNORE INTO workflow_feedback
      (id, workflow_id, revision_id, run_id, attempt, signal, weight, adopted, verified, idempotency_key, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workflowId, input.revisionId, input.runId, input.attempt, input.signal, weights[input.signal], Number(input.adopted ?? true), Number(input.verified ?? false), input.idempotencyKey, redact(input.note ?? ""), now());
    const receipt = this.store.db.prepare("SELECT * FROM workflow_feedback WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown>;
    if (String(receipt.id) !== id) return receipt;
    if (["corrected", "harmful"].includes(input.signal)) {
      const definition = this.getWorkflow(input.workflowId);
      if (definition?.status === "active") this.suspend(input.workflowId, `automatic_${input.signal}`);
      const base = this.getRevision(input.revisionId);
      if (base) {
        const correctionRule = redact(input.note?.trim() || `${input.signal} outcome requires governance review`).slice(0, 500);
        this.createProposal(input.workflowId, input.revisionId, { nonApplicability: [...base.nonApplicability, correctionRule] }, input.note ?? input.signal, [input.idempotencyKey]);
      }
    }
    return receipt;
  }

  recall(scopeId: string, cue: string, runId: string, attempt: number, availableCapabilities: string[] = []): WorkflowRecall {
    if (!this.featureControl?.snapshot().autoExecutionEnabled && this.featureControl) return { promptSection: "", workflows: [], contextItems: [] };
    const cueSet = new Set(terms(cue));
    const definitions = this.listWorkflows(scopeId).filter((item) => item.status === "active" && item.revision);
    const selected = definitions.flatMap((definition) => {
      let revision = definition.revision!;
      const promotion = this.store.db.prepare(`SELECT id,revision_id as revisionId,previous_revision_id as previousRevisionId,canary_percent as canaryPercent
        FROM workflow_promotions WHERE workflow_id=? AND status='canary' ORDER BY created_at DESC LIMIT 1`).get(definition.id) as {id:string;revisionId:string;previousRevisionId:string;canaryPercent:number}|undefined;
      let canaryReason = "";
      if (promotion) {
        const assignmentKey=`${scopeId}:${runId}:${definition.id}`; const assignmentHash=createHash("sha256").update(assignmentKey).digest("hex");
        const bucket=Number.parseInt(assignmentHash.slice(0,8),16)%10000; const variant=bucket<promotion.canaryPercent*100?"candidate":"baseline";
        const assignedRevisionId=variant==="candidate"?promotion.revisionId:promotion.previousRevisionId; const assigned=this.getRevision(assignedRevisionId);
        if (assigned) revision=assigned;
        const receiptPayload={promotionId:promotion.id,workflowId:definition.id,runId,attempt,scopeId,assignmentKey,assignmentHash,bucket,variant,revisionId:revision.id}; const receiptHash=hash(receiptPayload);
        this.store.db.prepare(`INSERT OR IGNORE INTO workflow_canary_bindings (id,promotion_id,workflow_id,run_id,attempt,scope_id,assignment_key,assignment_hash,bucket,variant,revision_id,receipt_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),promotion.id,definition.id,runId,attempt,scopeId,assignmentKey,assignmentHash,bucket,variant,revision.id,receiptHash,now());
        canaryReason=`canary ${variant} bucket ${bucket}/10000`;
      }
      const normalizedCue = normalize(cue);
      const excluded = (reasons: string[]) => { this.recordSelectorReceipt(runId, attempt, definition.id, revision.id, "excluded", reasons); return []; };
      if (revision.riskClass === "high") return excluded(["riskClass=high hard-filtered; explicit per-run risk approval is required"]);
      if (revision.nonApplicability.some((rule) => normalizedCue.includes(normalize(rule)))) return excluded(["non-applicability rule matched"]);
      const capabilitySet = new Set(availableCapabilities.map(normalize));
      const missing = revision.requiredCapabilities.filter((capability) => !capabilitySet.has(normalize(capability)));
      if (missing.length) return excluded([`missing capabilities: ${missing.join(", ")}`]);
      const trigger = new Set([...revision.cueTerms, ...terms(revision.intent)]);
      const overlap = [...trigger].filter((term) => cueSet.has(normalize(term))).length;
      const phrase = revision.applicability.some((rule) => normalizedCue.includes(normalize(rule)) || normalize(rule).includes(normalizedCue));
      const quality = this.workflowQuality(revision.id);
      const ageDays = Math.max(0, (now() - revision.createdAt) / 86_400_000);
      const freshness = Math.max(0, 1 - ageDays / 365);
      const costPenalty = Math.min(0.1, revision.steps.length * 0.005);
      const riskPenalty = revision.riskClass === "medium" ? 0.08 : 0;
      const score = Math.min(1, overlap / Math.max(2, trigger.size) + (phrase ? 0.45 : 0) + revision.confidence * 0.15 + quality.score * 0.15 + freshness * 0.05 - costPenalty - riskPenalty);
      if (score < 0.2) return excluded([`score ${score.toFixed(3)} below threshold 0.2`]);
      const reasons = [canaryReason, phrase ? "applicability rule matched" : "", overlap ? `${overlap} trigger term(s) matched` : "", `confidence ${revision.confidence.toFixed(2)}`, `quality ${quality.score.toFixed(2)} from ${quality.samples} sample(s)`, `freshness ${freshness.toFixed(2)}`, costPenalty ? `step cost penalty ${costPenalty.toFixed(2)}` : "", riskPenalty ? `medium-risk penalty ${riskPenalty.toFixed(2)}` : ""].filter(Boolean);
      const bindingId = randomUUID();
      this.store.db.prepare(`INSERT OR IGNORE INTO workflow_bindings
        (id, run_id, attempt, workflow_id, revision_id, selector_version, relevance_score, selected_reason_json, application_mode, created_at)
        VALUES (?, ?, ?, ?, ?, 'workflow-selector-v1', ?, ?, 'suggested', ?)`)
        .run(bindingId, runId, attempt, definition.id, revision.id, score, JSON.stringify(reasons), now());
      const persisted = this.store.db.prepare("SELECT id FROM workflow_bindings WHERE run_id=? AND attempt=? AND workflow_id=? AND revision_id=?").get(runId, attempt, definition.id, revision.id) as { id: string };
      this.recordSelectorReceipt(runId, attempt, definition.id, revision.id, "selected", reasons, score);
      return [{ definition, revision, score, reasons, bindingId: persisted.id }];
    }).sort((a, b) => b.score - a.score).slice(0, 3);
    const promptSection = selected.length ? `<workflow_guidance>\n${selected.map(({ revision, reasons }) => [
      `Workflow: ${revision.name}@${revision.revision}`,
      `Why recalled: ${reasons.join("; ")}`,
      `Applicable when: ${revision.applicability.join("; ") || revision.intent}`,
      revision.nonApplicability.length ? `Do not apply when: ${revision.nonApplicability.join("; ")}` : "",
      `Suggested steps:\n${revision.steps.map((step) => `- [${step.required ? "required" : "optional"}] ${step.instruction}`).join("\n")}`,
      revision.inputContract.length ? `Inputs:\n${revision.inputContract.map((item) => `- ${item.name}${item.required ? " (required)" : ""}: ${item.description}`).join("\n")}` : "",
      revision.outputContract.length ? `Expected outputs:\n${revision.outputContract.map((item) => `- ${item.name}${item.required ? " (required)" : ""}: ${item.description}`).join("\n")}` : "",
      revision.verification.length ? `Verification:\n${revision.verification.map((item) => `- ${item.check}: ${item.successCondition}`).join("\n")}` : "",
      "This workflow is guidance only and grants no additional capability or approval.",
    ].filter(Boolean).join("\n")).join("\n\n")}\n</workflow_guidance>` : "";
    return {
      promptSection,
      workflows: selected,
      contextItems: selected.map(({ definition, revision, score, reasons, bindingId }) => ({ kind: "workflow_revision", sourceId: revision.id, selected: true, reason: reasons.join("; "), estimatedTokens: Math.ceil(JSON.stringify(revision).length / 4), metadata: { workflowId: definition.id, revision: revision.revision, score, bindingId, riskClass: revision.riskClass } })),
    };
  }

  private workflowQuality(revisionId: string) {
    const row = this.store.db.prepare(`SELECT COUNT(*) as samples, COALESCE(SUM(weight),0) as weight
      FROM workflow_feedback WHERE revision_id=? AND adopted=1`).get(revisionId) as { samples: number; weight: number };
    const priorSamples = 4; const priorSuccess = 2;
    return { samples: row.samples, score: Math.max(0, Math.min(1, (priorSuccess + Math.max(0, row.weight)) / (priorSamples + row.samples))) };
  }

  private recordSelectorReceipt(runId: string, attempt: number, workflowId: string, revisionId: string, decision: "selected" | "excluded", reasons: string[], score?: number) {
    this.store.db.prepare(`INSERT INTO workflow_selector_receipts
      (id, run_id, attempt, workflow_id, revision_id, decision, reasons_json, score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, attempt, workflow_id, revision_id) DO UPDATE SET decision=excluded.decision,
        reasons_json=excluded.reasons_json, score=excluded.score, created_at=excluded.created_at`)
      .run(randomUUID(), runId, attempt, workflowId, revisionId, decision, JSON.stringify(reasons), score ?? null, now());
  }

  listWorkflows(scopeId: string, includeDeleted = false) {
    const rows = this.store.db.prepare(`SELECT id, scope_id as scopeId, status, active_revision_id as activeRevisionId,
      deleted_at as deletedAt, purge_after as purgeAfter, delete_reason as deleteReason, previous_status as previousStatus,
      previous_active_revision_id as previousActiveRevisionId, created_at as createdAt, updated_at as updatedAt FROM workflow_definitions WHERE scope_id = ?
      ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY updated_at DESC`).all(scopeId) as WorkflowDefinition[];
    return rows.map((row) => ({ ...row, revision: row.activeRevisionId ? this.getRevision(row.activeRevisionId) : this.listRevisions(row.id).at(-1) }));
  }
  getWorkflow(id: string, includeDeleted = false) { const row = this.store.db.prepare(`SELECT id, scope_id as scopeId, status, active_revision_id as activeRevisionId, deleted_at as deletedAt, purge_after as purgeAfter, delete_reason as deleteReason, previous_status as previousStatus, previous_active_revision_id as previousActiveRevisionId, created_at as createdAt, updated_at as updatedAt FROM workflow_definitions WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as WorkflowDefinition | undefined; return row ? { ...row, revision: row.activeRevisionId ? this.getRevision(row.activeRevisionId) : this.listRevisions(row.id).at(-1) } : undefined; }
  listBindings(scopeId: string, limit = 200) { return this.store.db.prepare(`SELECT b.id, b.run_id as runId, b.attempt, b.workflow_id as workflowId,
    b.revision_id as revisionId, b.relevance_score as relevanceScore, b.application_mode as applicationMode, b.created_at as createdAt
    FROM workflow_bindings b JOIN workflow_definitions w ON w.id=b.workflow_id WHERE w.scope_id=? ORDER BY b.created_at DESC LIMIT ?`).all(scopeId, limit); }
  listFeedback(scopeId: string, limit = 200) { return this.store.db.prepare(`SELECT f.id, f.workflow_id as workflowId, f.revision_id as revisionId,
    f.run_id as runId, f.attempt, f.signal, f.weight, f.adopted, f.verified, f.note, f.created_at as createdAt
    FROM workflow_feedback f JOIN workflow_definitions w ON w.id=f.workflow_id WHERE w.scope_id=? ORDER BY f.created_at DESC LIMIT ?`).all(scopeId, limit); }
  createProposal(workflowId: string, baseRevisionId: string, patch: Partial<WorkflowSpec>, reason: string, evidenceIds: string[] = []) {
    const base = this.getRevision(baseRevisionId);
    if (!base || base.workflowId !== workflowId) throw new Error("Proposal base revision not found");
    const changedPaths = patchPaths(patch); if (!changedPaths.length) throw new Error("Proposal patch must be non-empty");
    const proposed = sanitizeSpec({ ...pickSpec(base), ...patch }); const baseHash = specHash(pickSpec(base)); const proposedHash = specHash(proposed);
    if (baseHash === proposedHash) throw new Error("Proposal must produce a non-empty revision diff");
    const id = randomUUID();
    this.store.db.prepare(`INSERT OR IGNORE INTO workflow_revision_proposals
      (id,workflow_id,base_revision_id,reason,evidence_json,patch_json,base_spec_hash,proposed_spec_hash,changed_paths_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'candidate',?)`).run(id, workflowId, baseRevisionId, redact(reason), JSON.stringify(sanitizeIds(evidenceIds)), JSON.stringify(patch), baseHash, proposedHash, JSON.stringify(changedPaths), now());
    return this.store.db.prepare("SELECT * FROM workflow_revision_proposals WHERE workflow_id=? AND base_revision_id=? AND reason=?").get(workflowId, baseRevisionId, redact(reason));
  }
  listProposals(scopeId: string) { return this.store.db.prepare(`SELECT p.id, p.workflow_id as workflowId, p.base_revision_id as baseRevisionId,
    p.reason, p.evidence_json as evidenceJson, p.patch_json as patchJson, p.base_spec_hash as baseSpecHash,
    p.proposed_spec_hash as proposedSpecHash,p.changed_paths_json as changedPathsJson,p.status,p.decided_by as decidedBy,
    p.decision_reason as decisionReason,p.decided_at as decidedAt,p.applied_revision_id as appliedRevisionId,p.created_at as createdAt
    FROM workflow_revision_proposals p JOIN workflow_definitions w ON w.id=p.workflow_id WHERE w.scope_id=? ORDER BY p.created_at DESC`).all(scopeId); }
  private validateProposal(id: string, requiredStatus: "candidate" | "approved") {
    const proposal = this.store.db.prepare(`SELECT workflow_id as workflowId,base_revision_id as baseRevisionId,patch_json as patchJson,
      base_spec_hash as baseSpecHash,proposed_spec_hash as proposedSpecHash,changed_paths_json as changedPathsJson,reason,evidence_json as evidenceJson,status
      FROM workflow_revision_proposals WHERE id=?`).get(id) as { workflowId:string;baseRevisionId:string;patchJson:string;baseSpecHash:string;proposedSpecHash:string;changedPathsJson:string;reason:string;evidenceJson:string;status:string }|undefined;
    if (!proposal || proposal.status !== requiredStatus) throw new Error(requiredStatus === "candidate" ? "Proposal is not pending" : "Proposal is not approved");
    const base = this.getRevision(proposal.baseRevisionId); if (!base) throw new Error("Proposal base revision not found");
    const patch = JSON.parse(proposal.patchJson || "{}") as Partial<WorkflowSpec>; const changedPaths = patchPaths(patch);
    if (!changedPaths.length) throw new Error("Proposal patch must be non-empty");
    const baseHash = specHash(pickSpec(base)); const proposedHash = specHash(sanitizeSpec({ ...pickSpec(base), ...patch }));
    if (baseHash === proposedHash) throw new Error("Proposal must produce a non-empty revision diff");
    if (proposal.baseSpecHash !== baseHash || proposal.proposedSpecHash !== proposedHash) throw new Error("Proposal spec hash validation failed");
    if (!sameStrings(JSON.parse(proposal.changedPathsJson || "[]") as string[], changedPaths)) throw new Error("Proposal changed paths validation failed");
    return { ...proposal, patch };
  }
  decideProposal(id: string, decision: "approved" | "rejected", actor: string, reason = "") {
    const proposal = decision === "approved" ? this.validateProposal(id, "candidate") : this.store.db.prepare("SELECT workflow_id as workflowId,status FROM workflow_revision_proposals WHERE id=?").get(id) as {workflowId:string;status:string}|undefined;
    if (!proposal || proposal.status !== "candidate") throw new Error("Proposal is not pending");
    this.store.db.prepare("UPDATE workflow_revision_proposals SET status=?,decided_by=?,decision_reason=?,decided_at=? WHERE id=? AND status='candidate'").run(decision,redact(actor),redact(reason),now(),id);
    this.governanceReceipt(proposal.workflowId,`proposal_${decision}`,actor,reason,{proposalId:id}); return this.store.db.prepare("SELECT * FROM workflow_revision_proposals WHERE id=?").get(id);
  }
  requestProposalApplication(id: string, actor: string, reason = "apply approved revision proposal") {
    this.requireAutoExecution();
    const proposal = this.validateProposal(id, "approved"); const workflow = this.getWorkflow(proposal.workflowId, true)!; const base = this.getRevision(proposal.baseRevisionId)!;
    const proposed = sanitizeSpec({ ...pickSpec(base), ...proposal.patch });
    return this.requestApproval({ scopeId: workflow.scopeId, actionType: "apply_revision", targetType: "workflow_proposal", targetId: id,
      workflowId: proposal.workflowId, revisionId: proposal.baseRevisionId, proposalId: id, riskClass: proposed.riskClass, requestedBy: actor, reason,
      impactScope: { scopeId: workflow.scopeId, registryChange: true, activeBehaviorUnchangedUntilActivation: true },
      evidence: JSON.parse(proposal.evidenceJson) as string[], diff: { changedPaths: patchPaths(proposal.patch), patch: proposal.patch, baseSpecHash: specHash(pickSpec(base)), proposedSpecHash: specHash(proposed) },
      rollback: { action: "retain_base_revision", revisionId: proposal.baseRevisionId } });
  }
  applyProposal(id: string, actor: string, approvalId?: string) {
    this.requireAutoExecution();
    if (!approvalId) throw new Error("Human approval is required before applying a workflow revision proposal");
    const approval = this.getApproval(approvalId);
    if (!approval || approval.actionType !== "apply_revision" || approval.proposalId !== id) throw new Error("Approval does not authorize this proposal application");
    return this.executeApproval(approvalId, actor).result as WorkflowRevision;
  }
  private applyProposalApproved(id: string, actor: string, approvalId: string) {
    const proposal = this.validateProposal(id, "approved");
    const revision = this.revise(proposal.workflowId, proposal.patch, "user_correction", JSON.parse(proposal.evidenceJson) as string[], proposal.reason, proposal.baseRevisionId);
    this.store.db.prepare("UPDATE workflow_revision_proposals SET status='applied',applied_revision_id=?,decided_by=?,decided_at=? WHERE id=?").run(revision.id,redact(actor),now(),id);
    this.governanceReceipt(proposal.workflowId,"proposal_applied",actor,proposal.reason,{proposalId:id,revisionId:revision.id,approvalId}); return revision;
  }
  listDistillationJobs(scopeId: string) { return this.store.db.prepare(`SELECT id,task_signature as taskSignature,status,checkpoint_json as checkpointJson,
    attempts,lease_owner as leaseOwner,lease_until as leaseUntil,fence,workflow_id as workflowId,error,created_at as createdAt,updated_at as updatedAt
    FROM workflow_distillation_jobs WHERE scope_id=? ORDER BY updated_at DESC`).all(scopeId); }
  listRunLearningPolicies(scopeId: string) { return this.store.db.prepare(`SELECT p.run_id as runId,p.policy,p.reason,p.updated_at as updatedAt
    FROM run_learning_policies p JOIN runs r ON r.id=p.run_id WHERE r.session_id=? ORDER BY p.updated_at DESC`).all(scopeId); }
  listWorkflowQuality(scopeId: string) { return this.listWorkflows(scopeId, true).map((workflow) => ({ workflowId: workflow.id, revisionId: workflow.revision?.id, ...(workflow.revision ? this.workflowQuality(workflow.revision.id) : { samples: 0, score: 0 }) })); }
  listEvaluations(scopeId: string) { return this.store.db.prepare(`SELECT e.id,e.workflow_id as workflowId,e.revision_id as revisionId,e.kind,e.status,e.sample_size as sampleSize,
    e.success_rate as successRate,e.baseline_rate as baselineRate,e.risk_class as riskClass,e.evaluator_id as evaluatorId,e.evaluator_version as evaluatorVersion,
    e.dataset_id as datasetId,e.dataset_hash as datasetHash,e.baseline_revision_id as baselineRevisionId,e.candidate_revision_id as candidateRevisionId,
    e.evaluation_run_ids_json as evaluationRunIdsJson,e.check_results_json as checkResultsJson,e.receipt_hash as receiptHash,e.signature,e.created_at as createdAt
    FROM workflow_evaluations e JOIN workflow_definitions w ON w.id=e.workflow_id WHERE w.scope_id=? ORDER BY e.created_at DESC`).all(scopeId); }
  listCanaryBindings(scopeId: string, limit=200) { return this.store.db.prepare(`SELECT c.id,c.promotion_id as promotionId,c.workflow_id as workflowId,c.run_id as runId,c.attempt,c.assignment_hash as assignmentHash,
    c.bucket,c.variant,c.revision_id as revisionId,c.receipt_hash as receiptHash,c.outcome_status as outcomeStatus,c.success,c.required_checks as requiredChecks,
    c.passed_checks as passedChecks,c.outcome_recorded_at as outcomeRecordedAt,c.created_at as createdAt FROM workflow_canary_bindings c
    JOIN workflow_definitions w ON w.id=c.workflow_id WHERE w.scope_id=? ORDER BY c.created_at DESC LIMIT ?`).all(scopeId,limit); }
  getDistillationMetrics() { const rows=this.store.db.prepare("SELECT status,COUNT(*) count,MIN(created_at) oldest FROM workflow_distillation_jobs GROUP BY status").all() as Array<{status:string;count:number;oldest:number}>; const byStatus=Object.fromEntries(rows.map(row=>[row.status,row.count]));const completed=this.store.db.prepare("SELECT checkpoint_json FROM workflow_distillation_jobs WHERE status='completed'").all() as Array<{checkpoint_json:string}>;const outcomes=completed.map(row=>JSON.parse(row.checkpoint_json||"{}") as {result?:string;detail?:{reason?:string}}),withheldReasons:Record<string,number>={};for(const outcome of outcomes)if(outcome.result==="withheld"){const reason=outcome.detail?.reason??"insufficient_evidence";withheldReasons[reason]=(withheldReasons[reason]??0)+1;}return {queued:byStatus.queued??0,running:byStatus.running??0,completed:byStatus.completed??0,deadLetter:byStatus.dead_letter??0,failed:byStatus.failed??0,candidates:outcomes.filter(item=>item.result==="candidate").length,withheld:outcomes.filter(item=>item.result==="withheld").length,withheldReasons,oldestQueuedAgeMs:rows.find(row=>row.status==='queued')?now()-(rows.find(row=>row.status==='queued')!.oldest):0}; }
  listAutonomyAudit(scopeId: string, limit = 300) { return this.store.db.prepare(`SELECT id,scope_id as scopeId,category,action,actor,source_run_id as sourceRunId,
    workflow_id as workflowId,revision_id as revisionId,approval_id as approvalId,evidence_json as evidenceJson,metadata_json as metadataJson,
    receipt_hash as receiptHash,created_at as createdAt FROM autonomy_audit_events WHERE scope_id=? ORDER BY created_at DESC LIMIT ?`).all(scopeId,limit); }
  private autonomyAudit(scopeId: string, category: "observe"|"learn"|"distill"|"evolve"|"approval"|"execute", action: string, actor: string,
    input: { sourceRunId?: string; workflowId?: string; revisionId?: string; approvalId?: string; evidence?: string[]; metadata?: unknown } = {}) {
    const createdAt=now(); const payload={scopeId,category,action,actor:redact(actor),sourceRunId:input.sourceRunId??null,workflowId:input.workflowId??null,
      revisionId:input.revisionId??null,approvalId:input.approvalId??null,evidence:sanitizeIds(input.evidence??[]),metadata:input.metadata??{},createdAt};
    const receiptHash=hash(payload); this.store.db.prepare(`INSERT OR IGNORE INTO autonomy_audit_events
      (id,scope_id,category,action,actor,source_run_id,workflow_id,revision_id,approval_id,evidence_json,metadata_json,receipt_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),scopeId,category,action,payload.actor,payload.sourceRunId,payload.workflowId,payload.revisionId,payload.approvalId,JSON.stringify(payload.evidence),JSON.stringify(payload.metadata),receiptHash,createdAt);
  }
  getLearningCenter(scopeId: string) { return { featureState:this.featureControl?.snapshot()??null,workflows:this.listWorkflows(scopeId,true),bindings:this.listBindings(scopeId),canaryBindings:this.listCanaryBindings(scopeId),feedback:this.listFeedback(scopeId),proposals:this.listProposals(scopeId),learningPolicies:this.listRunLearningPolicies(scopeId),quality:this.listWorkflowQuality(scopeId),distillationJobs:this.listDistillationJobs(scopeId),distillationMetrics:this.getDistillationMetrics(),evaluations:this.listEvaluations(scopeId),approvals:this.listApprovals(scopeId),autonomyAudit:this.listAutonomyAudit(scopeId) }; }
  executeEvaluation(input: {workflowId:string;candidateRevisionId:string;baselineRevisionId:string;kind:"shadow"|"offline_replay";datasetId:string;baselineRunIds:string[];candidateRunIds:string[]}) {
    const workflow=this.getWorkflow(input.workflowId,true); const candidate=this.getRevision(input.candidateRevisionId); const baseline=this.getRevision(input.baselineRevisionId);
    if(!workflow||!candidate||!baseline||candidate.workflowId!==workflow.id||baseline.workflowId!==workflow.id)throw new Error("Evaluation revisions not found");
    const baselineRuns=unique(input.baselineRunIds).map(id=>this.requireEvaluationRun(id,input.workflowId,input.baselineRevisionId));
    const candidateRuns=unique(input.candidateRunIds).map(id=>this.requireEvaluationRun(id,input.workflowId,input.candidateRevisionId));
    if(!baselineRuns.length||!candidateRuns.length)throw new Error("Evaluation requires actual baseline and candidate runs");
    const runResults=[...baselineRuns.map(run=>this.evaluationRunResult(run,"baseline")),...candidateRuns.map(run=>this.evaluationRunResult(run,"candidate"))];
    const baselineRate=average(runResults.filter(item=>item.variant==="baseline").map(item=>Number(item.success)));
    const successRate=average(runResults.filter(item=>item.variant==="candidate").map(item=>Number(item.success)));
    const sampleSize=candidateRuns.length; const status=sampleSize>=5&&baselineRuns.length>=5&&successRate>=baselineRate-0.02?"passed":"failed";
    return this.persistEvaluationReceipt({workflowId:input.workflowId,kind:input.kind,status,sampleSize,successRate,baselineRate,riskClass:candidate.riskClass,evaluatorId:"tagent.workflow-evaluator",evaluatorVersion:"2",datasetId:input.datasetId,datasetHash:hash({datasetId:input.datasetId,baselineRunIds:unique(input.baselineRunIds).sort(),candidateRunIds:unique(input.candidateRunIds).sort()}),baselineRevisionId:input.baselineRevisionId,candidateRevisionId:input.candidateRevisionId,evaluationRunIds:runResults.map(item=>item.runId),checkResults:runResults.flatMap(item=>item.checkResults),evidence:{runResults}});
  }
  verifyEvaluationReceipt(id:string) { const row=this.store.db.prepare("SELECT * FROM workflow_evaluations WHERE id=?").get(id) as Record<string,unknown>|undefined; if(!row)return false; const payload=evaluationPayloadFromRow(row); const receiptHash=hash(payload); if(receiptHash!==row.receipt_hash)return false; if(!this.evaluationSecret)return row.signature===receiptHash; const expected=createHmac("sha256",this.evaluationSecret).update(receiptHash).digest("hex"); return safeEqual(String(row.signature),expected); }
  private persistEvaluationReceipt(input:{workflowId:string;kind:"shadow"|"offline_replay"|"canary";status:string;sampleSize:number;successRate:number;baselineRate:number;riskClass:string;evaluatorId:string;evaluatorVersion:string;datasetId:string;datasetHash:string;baselineRevisionId:string;candidateRevisionId:string;evaluationRunIds:string[];checkResults:WorkflowEvaluationCheckResult[];evidence:Record<string,unknown>}) {
    const id=randomUUID(); const createdAt=now(); const payload={id,workflowId:input.workflowId,revisionId:input.candidateRevisionId,kind:input.kind,status:input.status,sampleSize:input.sampleSize,successRate:input.successRate,baselineRate:input.baselineRate,riskClass:input.riskClass,evaluatorId:input.evaluatorId,evaluatorVersion:input.evaluatorVersion,datasetId:input.datasetId,datasetHash:input.datasetHash,baselineRevisionId:input.baselineRevisionId,candidateRevisionId:input.candidateRevisionId,evaluationRunIds:unique(input.evaluationRunIds).sort(),checkResults:input.checkResults,createdAt}; const receiptHash=hash(payload); const signature=this.evaluationSecret?createHmac("sha256",this.evaluationSecret).update(receiptHash).digest("hex"):receiptHash;
    this.store.db.prepare(`INSERT INTO workflow_evaluations (id,workflow_id,revision_id,kind,status,sample_size,success_rate,baseline_rate,risk_class,evidence_json,evaluator_id,evaluator_version,dataset_id,dataset_hash,baseline_revision_id,candidate_revision_id,evaluation_run_ids_json,check_results_json,receipt_hash,signature,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.workflowId,input.candidateRevisionId,input.kind,input.status,input.sampleSize,input.successRate,input.baselineRate,input.riskClass,JSON.stringify(input.evidence),input.evaluatorId,input.evaluatorVersion,input.datasetId,input.datasetHash,input.baselineRevisionId,input.candidateRevisionId,JSON.stringify(payload.evaluationRunIds),JSON.stringify(input.checkResults),receiptHash,signature,createdAt); return {id,status:input.status,receiptHash,signature};
  }
  private requireEvaluationRun(runId:string,workflowId:string,revisionId:string){const run=this.store.getRun(runId);if(!run)throw new Error(`Evaluation run not found: ${runId}`);const binding=this.store.db.prepare("SELECT id FROM workflow_bindings WHERE run_id=? AND workflow_id=? AND revision_id=?").get(runId,workflowId,revisionId);if(!binding)throw new Error(`Evaluation run ${runId} is not bound to revision ${revisionId}`);return run;}
  private evaluationRunResult(run:TaskRun,variant:"baseline"|"candidate"){const required=run.checks.filter(check=>check.required);const success=run.status==="completed"&&required.length>0&&required.every(check=>check.status==="passed"&&!check.stale);return{runId:run.id,variant,success,checkResults:required.map(check=>({runId:run.id,checkKey:check.key,required:true,status:check.status,stale:check.stale}))};}
  requestPromotion(workflowId:string,revisionId:string,canaryPercent=10,maxFailureDelta=0.02,actor="governor") {this.requireAutoExecution();const revision=this.getRevision(revisionId);const workflow=this.getWorkflow(workflowId,true);if(!workflow||!revision||revision.workflowId!==workflowId)throw new Error("Workflow revision not found");if(revision.riskClass!=="low")throw new Error("Canary is limited to low-risk workflows");const evaluations=this.store.db.prepare("SELECT id,kind,receipt_hash receiptHash FROM workflow_evaluations WHERE workflow_id=? AND candidate_revision_id=? AND status='passed'").all(workflowId,revisionId) as Array<{id:string;kind:string;receiptHash:string}>;if(!['shadow','offline_replay'].every(kind=>evaluations.some(item=>item.kind===kind&&this.verifyEvaluationReceipt(item.id))))throw new Error("Trusted shadow and offline replay receipts must pass before canary");if(!workflow.activeRevisionId)throw new Error("Canary requires an active baseline revision");return this.requestApproval({scopeId:workflow.scopeId,actionType:"start_canary",targetType:"workflow_revision",targetId:revisionId,workflowId,revisionId,riskClass:"low",requestedBy:actor,reason:"start guarded canary",impactScope:{scopeId:workflow.scopeId,canaryPercent:Math.max(1,Math.min(25,canaryPercent)),maxFailureDelta,baselineRevisionId:workflow.activeRevisionId},evidence:evaluations.map(item=>`evaluation:${item.id}:${item.receiptHash}`),diff:{baselineRevisionId:workflow.activeRevisionId,candidateRevisionId:revisionId,canaryPercent},rollback:{action:"automatic_rollback",revisionId:workflow.activeRevisionId}});}
  promote(workflowId:string,revisionId:string,_canaryPercent=10,_maxFailureDelta=0.02,approvalId?:string){this.requireAutoExecution();if(!approvalId)throw new Error("Human approval is required before starting canary");const approval=this.getApproval(approvalId);if(!approval||approval.actionType!=="start_canary"||approval.workflowId!==workflowId||approval.revisionId!==revisionId)throw new Error("Approval does not authorize this canary");return this.executeApproval(approvalId,approval.decidedBy||"approved_governor").result as {id:string;status:"canary"};}
  private promoteApproved(workflowId:string,revisionId:string,options:{canaryPercent?:number;maxFailureDelta?:number},approvalId:string){const revision=this.getRevision(revisionId);if(!revision||revision.workflowId!==workflowId||revision.riskClass!=="low")throw new Error("Low-risk workflow revision not found");const current=this.getWorkflow(workflowId,true)!;if(!current.activeRevisionId)throw new Error("Canary requires an active baseline revision");const id=randomUUID(),timestamp=now();this.store.db.prepare(`INSERT INTO workflow_promotions (id,workflow_id,revision_id,previous_revision_id,status,canary_percent,max_failure_delta,reason,created_at,updated_at) VALUES (?,?,?,?,'canary',?,?,?, ?,?)`).run(id,workflowId,revisionId,current.activeRevisionId,Math.max(1,Math.min(25,options.canaryPercent??10)),options.maxFailureDelta??0.02,`human approval ${approvalId}`,timestamp,timestamp);this.governanceReceipt(workflowId,"canary_started","approved_governor","human-approved canary",{approvalId,promotionId:id,revisionId});return{id,status:"canary" as const};}
  private settleCanaryFromOutcomes(promotionId:string){const promotion=this.store.db.prepare("SELECT workflow_id workflowId,revision_id revisionId,previous_revision_id previousRevisionId,max_failure_delta maxFailureDelta,status FROM workflow_promotions WHERE id=?").get(promotionId) as {workflowId:string;revisionId:string;previousRevisionId:string;maxFailureDelta:number;status:string}|undefined;if(!promotion||promotion.status!=="canary")return undefined;const rows=this.store.db.prepare("SELECT variant,success,run_id runId FROM workflow_canary_bindings WHERE promotion_id=? AND outcome_recorded_at IS NOT NULL").all(promotionId) as Array<{variant:string;success:number;runId:string}>;const baseline=rows.filter(row=>row.variant==="baseline"),candidate=rows.filter(row=>row.variant==="candidate");if(baseline.length<5||candidate.length<5)return undefined;const baselineRate=average(baseline.map(row=>row.success)),successRate=average(candidate.map(row=>row.success)),pass=successRate>=baselineRate-promotion.maxFailureDelta,timestamp=now();if(pass){this.store.db.prepare("UPDATE workflow_definitions SET status='active',active_revision_id=?,updated_at=? WHERE id=?").run(promotion.revisionId,timestamp,promotion.workflowId);this.store.db.prepare("UPDATE workflow_promotions SET status='promoted',reason='canary passed',updated_at=? WHERE id=?").run(timestamp,promotionId);}else{this.store.db.prepare("UPDATE workflow_definitions SET status='active',active_revision_id=?,updated_at=? WHERE id=?").run(promotion.previousRevisionId,timestamp,promotion.workflowId);this.store.db.prepare("UPDATE workflow_promotions SET status='rolled_back',reason='canary regression',updated_at=? WHERE id=?").run(timestamp,promotionId);}const checkResults=rows.flatMap(row=>{const run=this.store.getRun(row.runId);return run?.checks.filter(check=>check.required).map(check=>({runId:row.runId,checkKey:check.key,required:true,status:check.status,stale:check.stale}))??[];});this.persistEvaluationReceipt({workflowId:promotion.workflowId,kind:"canary",status:pass?"passed":"rolled_back",sampleSize:candidate.length,successRate,baselineRate,riskClass:"low",evaluatorId:"tagent.canary-aggregator",evaluatorVersion:"2",datasetId:`canary:${promotionId}`,datasetHash:hash(rows.map(row=>row.runId).sort()),baselineRevisionId:promotion.previousRevisionId,candidateRevisionId:promotion.revisionId,evaluationRunIds:rows.map(row=>row.runId),checkResults,evidence:{promotionId}});this.governanceReceipt(promotion.workflowId,pass?"promote":"automatic_rollback","canary_aggregator",pass?"canary passed":"canary regression",{promotionId,sampleSize:candidate.length,successRate,baselineRate});return{promotionId,status:pass?"promoted":"rolled_back"};}
  recordCanaryOutcome(run:TaskRun){if(!this.featureControl?.snapshot().autoExecutionEnabled&&this.featureControl)return;const bindings=this.store.db.prepare("SELECT id,promotion_id promotionId FROM workflow_canary_bindings WHERE run_id=? AND attempt=? AND outcome_recorded_at IS NULL").all(run.id,run.attempt) as Array<{id:string;promotionId:string}>;for(const binding of bindings){const required=run.checks.filter(check=>check.required);const passed=required.filter(check=>check.status==='passed'&&!check.stale).length;const success=run.status==='completed'&&required.length>0&&passed===required.length;this.store.db.prepare("UPDATE workflow_canary_bindings SET outcome_status=?,success=?,required_checks=?,passed_checks=?,outcome_recorded_at=? WHERE id=?").run(run.status,Number(success),required.length,passed,now(),binding.id);this.settleCanaryFromOutcomes(binding.promotionId);}}
  retryDistillationJob(id:string,repair?:{taskSignature?:string}){const row=this.store.db.prepare("SELECT status FROM workflow_distillation_jobs WHERE id=?").get(id) as {status:string}|undefined;if(!row||!['dead_letter','failed'].includes(row.status))throw new Error("Distillation job is not retryable");this.store.db.prepare("UPDATE workflow_distillation_jobs SET status='queued',attempts=0,error='',checkpoint_json=?,task_signature=COALESCE(?,task_signature),lease_owner='',lease_token='',lease_until=NULL,updated_at=? WHERE id=?").run(JSON.stringify({phase:'repaired',repair:repair??{}}),repair?.taskSignature??null,now(),id);return this.store.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE id=?").get(id);}
  listDeadLetterJobs(limit=100){return this.store.db.prepare("SELECT * FROM workflow_distillation_jobs WHERE status='dead_letter' ORDER BY updated_at DESC LIMIT ?").all(limit);}
  listRevisions(workflowId: string) { return (this.store.db.prepare("SELECT id FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision").all(workflowId) as Array<{ id: string }>).map((row) => this.getRevision(row.id)!); }
  getRevision(id: string): WorkflowRevision | undefined { const row = this.store.db.prepare("SELECT id, workflow_id as workflowId, revision, spec_json as specJson, source_type as sourceType, source_evidence_json as sourceEvidenceJson, confidence, change_summary as changeSummary, created_at as createdAt FROM workflow_revisions WHERE id = ?").get(id) as { id: string; workflowId: string; revision: number; specJson: string; sourceType: WorkflowSourceType; sourceEvidenceJson: string; confidence: number; changeSummary: string; createdAt: number } | undefined; if (!row) return undefined; const stored = JSON.parse(row.specJson) as Partial<WorkflowSpec> & { counterexampleIds?: string[] }; return { id: row.id, workflowId: row.workflowId, revision: row.revision, ...sanitizeSpec(stored as WorkflowSpec), sourceType: row.sourceType, sourceEvidenceIds: JSON.parse(row.sourceEvidenceJson) as string[], counterexampleIds: sanitizeIds(stored.counterexampleIds ?? []), confidence: row.confidence, changeSummary: row.changeSummary, createdAt: row.createdAt }; }
}

function sanitizeSpec(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.name?.trim() || !spec.intent?.trim() || !spec.steps?.length) throw new Error("Workflow name, intent and at least one step are required");
  return {
    name: redact(spec.name.trim()).slice(0, 160), intent: redact(spec.intent.trim()).slice(0, 1000), cueTerms: (spec.cueTerms ?? []).map(redact).filter(Boolean).slice(0, 32),
    applicability: (spec.applicability ?? []).map(redact).filter(Boolean).slice(0, 20), nonApplicability: (spec.nonApplicability ?? []).map(redact).filter(Boolean).slice(0, 20), preconditions: (spec.preconditions ?? []).map(redact).filter(Boolean).slice(0, 20),
    inputContract: sanitizeContract(spec.inputContract ?? []), outputContract: sanitizeContract(spec.outputContract ?? []),
    steps: spec.steps.slice(0, 40).map((step, index) => ({ stepId: redact(step.stepId || `step-${index + 1}`).slice(0, 160), instruction: redact(step.instruction).slice(0, 2000), required: step.required !== false, expectedArtifact: step.expectedArtifact ? redact(step.expectedArtifact).slice(0, 1000) : undefined, failureHandling: step.failureHandling ? redact(step.failureHandling).slice(0, 1000) : undefined })),
    verification: (spec.verification ?? []).slice(0, 20).map((item) => ({ check: redact(item.check).slice(0, 1000), required: item.required !== false, successCondition: redact(item.successCondition).slice(0, 1000) })),
    requiredCapabilities: (spec.requiredCapabilities ?? []).map(normalize).filter(Boolean).slice(0, 20), riskClass: spec.riskClass ?? "low",
  };
}
function sanitizeContract(items: WorkflowValueContract[]) { return items.slice(0, 20).map((item) => ({ name: redact(item.name ?? "").slice(0, 160), description: redact(item.description ?? "").slice(0, 1000), required: item.required !== false, schema: item.schema ? redact(item.schema).slice(0, 2000) : undefined })).filter((item) => item.name && item.description); }
function sanitizeIds(items: string[]) { return items.map((item) => redact(String(item)).slice(0, 500)).filter(Boolean).slice(0, 100); }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function distillationEligibility(signature:string,stepCount:number){const normalized=normalize(signature);if(stepCount<2)return{eligible:false,reason:"insufficient_procedure_steps"};if(normalized.length<12||/^(?:回复一下|继续|再试一次|为什么|怎么回事|检查一下|看看|确认一下|reply|continue|retry|why)$/i.test(normalized))return{eligible:false,reason:"underspecified_task_signature"};return{eligible:true,reason:"eligible"};}
function failureIsCounterexample(row:{taskSignature:string;procedureSummary:string;checksFailedJson:string}){const failedChecks=JSON.parse(row.checksFailedJson||"[]") as string[];if(failedChecks.length)return true;return /(?:failed|failure|错误|失败|回滚|纠正|不正确|harmful)/i.test(`${row.taskSignature} ${row.procedureSummary}`);}
function countOrderConflicts(groups: Array<{ occurrences: Array<{ procedureIndex: number; position: number }> }>) {
  let conflicts = 0;
  for (let left = 0; left < groups.length; left += 1) for (let right = left + 1; right < groups.length; right += 1) {
    const comparisons = groups[left].occurrences.flatMap((first) => groups[right].occurrences
      .filter((second) => second.procedureIndex === first.procedureIndex).map((second) => first.position < second.position));
    if (comparisons.some(Boolean) && comparisons.some((value) => !value)) conflicts += 1;
  }
  return conflicts;
}
function sequenceAgreement(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  let rightIndex = 0; let matched = 0;
  for (const step of left) {
    const match = right.findIndex((candidate, index) => index >= rightIndex && textSimilarity(step, candidate) >= 0.78);
    if (match >= 0) { matched += 1; rightIndex = match + 1; }
  }
  return (2 * matched) / (left.length + right.length);
}
function pickSpec(revision: WorkflowRevision): WorkflowSpec { const { id: _id, workflowId: _workflowId, revision: _revision, sourceType: _sourceType, sourceEvidenceIds: _sourceEvidenceIds, counterexampleIds: _counterexampleIds, confidence: _confidence, changeSummary: _changeSummary, createdAt: _createdAt, ...spec } = revision; return spec; }
function stableObject(value:unknown):unknown { if(Array.isArray(value))return value.map(stableObject); if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stableObject(item)])); return value; }
function specHash(spec:WorkflowSpec){return createHash("sha256").update(JSON.stringify(stableObject(sanitizeSpec(spec)))).digest("hex");}
function patchPaths(patch:Partial<WorkflowSpec>){if(!patch||Array.isArray(patch)||typeof patch!=="object")return[];return Object.keys(patch).filter(key=>(patch as Record<string,unknown>)[key]!==undefined).sort();}
function sameStrings(left:string[],right:string[]){return JSON.stringify([...left].sort())===JSON.stringify([...right].sort());}
function unique(values:string[]){return [...new Set(values.filter(Boolean))];}
function safeEqual(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function evaluationPayloadFromRow(row:Record<string,unknown>){return{id:String(row.id),workflowId:String(row.workflow_id),revisionId:String(row.revision_id),kind:String(row.kind),status:String(row.status),sampleSize:Number(row.sample_size),successRate:Number(row.success_rate),baselineRate:Number(row.baseline_rate),riskClass:String(row.risk_class),evaluatorId:String(row.evaluator_id),evaluatorVersion:String(row.evaluator_version),datasetId:String(row.dataset_id),datasetHash:String(row.dataset_hash),baselineRevisionId:String(row.baseline_revision_id),candidateRevisionId:String(row.candidate_revision_id),evaluationRunIds:JSON.parse(String(row.evaluation_run_ids_json||"[]")) as string[],checkResults:JSON.parse(String(row.check_results_json||"[]")) as WorkflowEvaluationCheckResult[],createdAt:Number(row.created_at)};}
