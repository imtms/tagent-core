import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RunStatus, TaskRun } from "@tagent/execution/domain";
import type { LearningFeatureControl } from "./feature-control.js";
import type { DecodedLearningProjection } from "./domain/learning-projection.js";
import {
  pickWorkflowSpec as pickSpec,
  sanitizeWorkflowIds as sanitizeIds,
  sanitizeWorkflowSpec as sanitizeSpec,
  workflowSpecHash as specHash,
  workflowSpecPatchPaths as patchPaths,
} from "./domain/workflow-spec.js";
import type { WorkflowLearningPersistencePort, WorkflowLearningRepository } from "./ports/index.js";
import type { SemanticJudge } from "./semantic-judge.js";
import type {
  AutonomyActionType,
  WorkflowApplicationStatus,
  WorkflowEvaluationCheckResult,
  WorkflowFeedbackSignal,
  WorkflowRecall,
  WorkflowRevision,
  WorkflowSkippedStep,
  WorkflowSourceType,
  WorkflowSpec,
  WorkflowVerificationMapping,
} from "./domain/workflow-types.js";

export type {
  AutonomyActionType,
  AutonomyApprovalRequest,
  AutonomyApprovalStatus,
  TrustedEvaluationInput,
  WorkflowApplicationStatus,
  WorkflowDefinition,
  WorkflowEvaluationCheckResult,
  WorkflowFeedbackSignal,
  WorkflowRecall,
  WorkflowRevision,
  WorkflowSkippedStep,
  WorkflowSourceType,
  WorkflowSpec,
  WorkflowStatus,
  WorkflowStep,
  WorkflowValueContract,
  WorkflowVerification,
  WorkflowVerificationMapping,
} from "./domain/workflow-types.js";

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

export class WorkflowLearningService {
  constructor(private readonly persistence: WorkflowLearningPersistencePort, private readonly evaluationSecret = process.env.TAGENT_EVALUATION_RECEIPT_SECRET ?? "", private readonly featureControl?: LearningFeatureControl, private readonly semanticJudge?: SemanticJudge) {}

  private requireLearning() { this.featureControl?.requireLearning(); }
  private requireAutoExecution() { this.featureControl?.requireAutoExecution(); }
  private learningAvailable() { return this.featureControl?.snapshot().learningEnabled ?? true; }

  setRunLearningPolicy(runId: string, policy: "allow" | "metadata_only" | "deny", reason = "user_requested") {
    return this.persistence.workflow.upsertRunLearningPolicy({ runId, policy, reason, updatedAt: now() });
  }

  getRunLearningPolicy(runId: string) {
    return this.persistence.workflow.getRunLearningPolicy(runId)
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
    return this.persistence.workflow.recordExperienceObservation({
      id,
      scopeId: redact(input.scopeId).slice(0, 500),
      runId: input.runId ?? null,
      attempt: input.attempt ?? null,
      lifecycle: input.lifecycle ?? "manual",
      outcome: input.outcome ?? "",
      eventSeq: input.eventSeq ?? 0,
      sourceType: input.sourceType,
      taskSignature: safeSignature,
      procedureSummary: safeSummary,
      checksPassedJson: JSON.stringify(safeChecksPassed),
      checksFailedJson: JSON.stringify(safeChecksFailed),
      sourceRefsJson: JSON.stringify(safeSourceRefs),
      learnPolicy: input.learnPolicy ?? "allow",
      observationHash,
      createdAt: now(),
    });
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
      if (this.semanticJudge) this.persistence.enqueueSemanticLearningJob("workflow_eligibility", { runId: run.id, scopeId: run.sessionId, taskSignature, observationId: observation?.id ?? "", input }, `semantic-workflow-eligibility:${run.id}:${run.attempt}:${lifecycle}:${projection?.eventSeq ?? 0}`, run.id, run.attempt);
      else this.applyWorkflowEligibility(run.sessionId,run.id,taskSignature,observation?.id,undefined,plan.length);
    }
    return observation;
  }

  /** Applies one already-decoded active projection without mutating TaskRun or invoking capabilities. */
  applyActiveProjection(projection: DecodedLearningProjection) {
    const snapshot = projection.taskRunSnapshot as unknown as TaskRun;
    if (snapshot.id !== projection.runId
      || !Array.isArray(snapshot.plan)
      || !Array.isArray(snapshot.checks)
      || typeof snapshot.sessionId !== "string"
      || typeof snapshot.goal !== "string") {
      throw new TypeError("Active Learning projection TaskRun snapshot is malformed");
    }
    const run: TaskRun = {
      ...snapshot,
      attempt: projection.attemptOrdinal,
      status: projection.outcome as RunStatus,
    };
    this.recordRunApplications(run);
    const observation = this.projectRun(run, run.status, {
      lifecycle: projection.lifecycle,
      eventSeq: projection.eventSeq,
      payload: projection.payload,
    });
    this.recordCanaryOutcome(run);
    return observation;
  }

  private applyWorkflowEligibility(scopeId:string,runId:string,taskSignature:string,observationId:string|undefined,semanticEligibility:Awaited<ReturnType<SemanticJudge["learningSample"]>>,stepCount:number) {
    const eligibility=semanticEligibility?{eligible:semanticEligibility.eligible&&semanticEligibility.reusable,reason:semanticEligibility.reason}:distillationEligibility(taskSignature,stepCount);
    if(eligibility.eligible){this.enqueueDistillation(scopeId,taskSignature);this.autonomyAudit(scopeId,"learn","distillation_enqueued","learning_projector",{sourceRunId:runId,evidence:observationId?[observationId]:[],metadata:{taskSignature,semantic:semanticEligibility??null}});}
    else this.autonomyAudit(scopeId,"learn","distillation_withheld","learning_projector",{sourceRunId:runId,evidence:observationId?[observationId]:[],metadata:{taskSignature,reason:eligibility.reason,semantic:semanticEligibility??null}});
  }

  async drainSemanticLearningJobs(limit = 100) {
    if (!this.semanticJudge) return 0;
    const owner = `semantic:${randomUUID()}`;
    let processed = 0;
    while (processed < limit) {
      const [row] = this.persistence.claimSemanticLearningJobs(owner, ["workflow_eligibility"], 1);
      if (!row) break;
      const heartbeat = setInterval(() => this.persistence.renewSemanticLearningJob(row.id, owner, row.leaseToken, row.fence), 10_000);
      heartbeat.unref?.();
      try {
        const payload=JSON.parse(row.payloadJson) as {runId:string;scopeId:string;taskSignature:string;observationId?:string;input:{taskSignature:string;procedureSummary:string;stepCount?:number;outcome?:string;requiredChecks?:Array<{key:string;status:string;stale:boolean}>}};
        const failuresBefore=this.semanticJudge.snapshot().failures;
        const decision=await this.semanticJudge.learningSample(payload.input);
        if(!decision&&this.semanticJudge.snapshot().failures>failuresBefore)throw new Error("Semantic workflow eligibility failed");
        this.applyWorkflowEligibility(payload.scopeId,payload.runId,payload.taskSignature,payload.observationId,decision,payload.input.stepCount??0);
        if (!this.persistence.completeSemanticLearningJob(row.id, owner, row.leaseToken, row.fence)) throw new Error("Semantic learning lease lost before completion");
      } catch(error){
        this.persistence.failSemanticLearningJob(row.id,owner,row.leaseToken,row.fence,row.attempts,error instanceof Error?error.message:String(error));
      } finally {
        clearInterval(heartbeat);
      }
      processed++;
    }
    return processed;
  }

  enqueueDistillation(scopeId: string, taskSignature: string) {
    this.requireLearning();
    const timestamp = now();
    return this.persistence.workflow.enqueueDistillationJob({
      id: randomUUID(), scopeId, taskSignature, signatureTermsJson: JSON.stringify(terms(taskSignature)), timestamp,
    });
  }

  claimDistillationJob(owner: string, leaseMs = 30_000) {
    if (!this.learningAvailable()) return undefined;
    const timestamp = now(); const token = randomUUID();
    return this.persistence.workflow.claimDistillationJob({ owner, token, timestamp, leaseUntil: timestamp + leaseMs });
  }

  renewDistillationLease(id: string, owner: string, token: string, fence: number, leaseMs = 30_000) {
    const timestamp = now();
    return this.persistence.workflow.renewDistillationLease({ id, owner, token, fence, timestamp, leaseUntil: timestamp + leaseMs });
  }

  checkpointDistillationJob(id: string, owner: string, token: string, fence: number, checkpoint: Record<string, unknown>, leaseMs = 30_000) {
    const timestamp = now();
    const changed = this.persistence.workflow.checkpointDistillationJob({
      id, owner, token, fence, checkpointJson: JSON.stringify(checkpoint), timestamp, leaseUntil: timestamp + leaseMs,
    });
    if (!changed) throw new Error("Distillation lease lost");
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
      const priorCheckpoint = JSON.parse(this.persistence.workflow.getDistillationCheckpoint(job.id)) as Record<string, unknown>;
      const changed = this.persistence.workflow.completeDistillationJob({
        id: job.id,
        owner,
        token: job.lease_token,
        fence: job.fence,
        workflowId: result?.id ?? null,
        checkpointJson: JSON.stringify({ phase: "completed", result: result?.id ? "candidate" : "withheld", workflowId: result?.id ?? null, detail: priorCheckpoint }),
        timestamp: now(),
      });
      if (!changed) throw new Error("Distillation lease lost before completion");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const status = job.attempts >= 3 ? "dead_letter" : "queued";
      this.persistence.workflow.failDistillationJob({ id: job.id, owner, token: job.lease_token, fence: job.fence, status,
        checkpointJson: JSON.stringify({ phase: "failed", error: redact(message) }), error: redact(message), timestamp: now() });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async distillRepeatedExperience(scopeId: string, taskSignature: string, options: { jobId?: string; semantic?: boolean; checkpoint?: (checkpoint: Record<string, unknown>) => void } = {}) {
    const checkpoint = (value: Record<string, unknown>) => {
      if (options.checkpoint) options.checkpoint(value);
      else if (options.jobId) this.persistence.workflow.updateDistillationCheckpoint(options.jobId, JSON.stringify(value), now());
    };
    checkpoint({ phase: "scan" });
    const candidates = this.persistence.workflow.listExperienceCandidates(scopeId, 500);
    const similar:Array<(typeof candidates)[number]&{similarity:number}>=[];
    for(const row of candidates){const lexical=options.semantic===false?Number(normalize(row.taskSignature)===normalize(taskSignature)):textSimilarity(taskSignature,row.taskSignature);if(lexical>=.72){similar.push({...row,similarity:lexical});continue;}if(this.semanticJudge&&options.semantic!==false){const decision=await this.semanticJudge.cluster(taskSignature,row.taskSignature);if(decision?.similar)similar.push({...row,similarity:decision.confidence});}else if(lexical>=.48)similar.push({...row,similarity:lexical});}
    const successes=[] as typeof similar;const failures=[] as typeof similar;
    for(const row of similar){if(row.sourceType==="task_experience"){const semantic=this.semanticJudge?await this.semanticJudge.learningSample({taskSignature:row.taskSignature,procedureSummary:row.procedureSummary,stepCount:parseProcedureSteps(row.procedureSummary).length,checksPassed:JSON.parse(row.checksPassedJson)}):undefined;if((semantic?semantic.eligible&&semantic.reusable:distillationEligibility(row.taskSignature,parseProcedureSteps(row.procedureSummary).length).eligible)&&!successes.some((item)=>item.runId===row.runId))successes.push(row);}else{const semantic=this.semanticJudge?await this.semanticJudge.learningSample({taskSignature:row.taskSignature,procedureSummary:row.procedureSummary,checksFailed:JSON.parse(row.checksFailedJson),outcome:"failed"}):undefined;if((semantic?semantic.failureIsCounterexample:failureIsCounterexample(row))&&!failures.some((item)=>item.runId===row.runId))failures.push(row);}}
    checkpoint({ phase: "clustered", scanned: candidates.length, matched: similar.length, successes: successes.length, failures: failures.length, runIds: successes.map((row) => row.runId) });
    if (successes.length < 2) return undefined;

    const evidenceIds = successes.map((row) => row.id).sort();
    const evidenceSetHash = hash(evidenceIds);
    const existing = this.persistence.workflow.findDistilledWorkflow(evidenceSetHash);
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
      if (options.jobId) this.persistence.workflow.recordDistillationConflict({ id: randomUUID(), jobId: options.jobId,
        scopeId, candidateSignature: taskSignature, workflowId: item.id, revisionId: revision.id,
        kind, similarity, reasonsJson: JSON.stringify(reasons), createdAt: now() });
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
    }, "task_experience", evidenceIds, "candidate", Math.min(0.85, 0.55 + successes.length * 0.1 - failures.length * 0.03 - orderConflicts * 0.02), `Distilled from ${successes.length} independent TaskRuns with ${failures.length} counterexample(s); ${consistentGroups.length} consistent step(s)`, counterexampleIds, { evidenceSetHash, createdAt: now() });
    checkpoint({ phase: "persisted", workflowId: workflow.id, evidenceSetHash, counterexamples: counterexampleIds.length });
    this.autonomyAudit(scopeId, "distill", "workflow_candidate_created", "experience_distiller", { workflowId: workflow.id, revisionId: workflow.revision?.id, evidence: evidenceIds, metadata: { evidenceSetHash, counterexampleIds, status: workflow.status } });
    return workflow;
  }

  createWorkflow(scopeId: string, spec: WorkflowSpec, sourceType: WorkflowSourceType, evidenceIds: string[], status: "candidate" = "candidate", confidence = 0.7, changeSummary = "Initial revision", counterexampleIds: string[] = [], distillation?: { evidenceSetHash: string; createdAt: number }) {
    if (status !== "candidate") {
      throw new Error("Learning can only create candidate workflows; activation requires Governance approval");
    }
    const timestamp = now(); const workflowId = randomUUID(); const revisionId = randomUUID();
    const sanitized = sanitizeSpec(spec);
    this.persistence.workflow.createWorkflow(
      { id: workflowId, scopeId: redact(scopeId).slice(0, 500), status: "candidate", activeRevisionId: null, createdAt: timestamp, updatedAt: timestamp },
      { id: revisionId, workflowId, specJson: JSON.stringify({ ...sanitized, counterexampleIds: sanitizeIds(counterexampleIds) }),
        specHash: specHash(sanitized), sourceType, sourceEvidenceJson: JSON.stringify(sanitizeIds(evidenceIds)),
        confidence, changeSummary: redact(changeSummary).slice(0, 2000), createdAt: timestamp },
      distillation,
    );
    return this.getWorkflow(workflowId)!;
  }

  revise(workflowId: string, patch: Partial<WorkflowSpec>, sourceType: WorkflowSourceType, evidenceIds: string[], changeSummary: string, expectedBaseRevisionId?: string) {
    const current = this.getWorkflow(workflowId, true); if (!current?.revision) throw new Error("Workflow not found");
    if (expectedBaseRevisionId && current.revision.id !== expectedBaseRevisionId) throw new Error("Proposal base revision is stale");
    const changedPaths = patchPaths(patch);
    if (!changedPaths.length) throw new Error("Workflow revision patch must be non-empty");
    const baseSpec = pickSpec(current.revision); const spec = sanitizeSpec({ ...baseSpec, ...patch });
    if (specHash(baseSpec) === specHash(spec)) throw new Error("Workflow revision must change the spec hash");
    const id = randomUUID();
    this.persistence.workflow.createWorkflowRevision({ id, workflowId,
      specJson: JSON.stringify({ ...spec, counterexampleIds: current.revision.counterexampleIds }), specHash: specHash(spec), sourceType,
      sourceEvidenceJson: JSON.stringify(sanitizeIds(evidenceIds)), confidence: current.revision.confidence,
      changeSummary: redact(changeSummary).slice(0, 2000), createdAt: now() });
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
    const existing = this.persistence.workflow.findActiveApprovalByHash(intentHash);
    if (existing && (existing.status === "pending" || existing.status === "approved")) return this.getApproval(existing.id)!;
    const id = randomUUID();
    const requestHash = existing ? hash({ ...payload, requestId: id }) : intentHash;
    const requestedBy = redact(input.requestedBy ?? "system").slice(0, 300);
    const requestReason = redact(input.reason ?? "").slice(0, 2000);
    this.persistence.workflow.createApproval({
      approval: {
        id, scopeId: input.scopeId, actionType: input.actionType, targetType: input.targetType, targetId: input.targetId,
        workflowId: input.workflowId ?? null, revisionId: input.revisionId ?? null, proposalId: input.proposalId ?? null,
        bindingId: input.bindingId ?? null, status: "pending", riskClass: input.riskClass,
        impactScopeJson: JSON.stringify(input.impactScope ?? {}), evidenceJson: JSON.stringify(sanitizeIds(input.evidence ?? [])),
        diffJson: JSON.stringify(input.diff ?? {}), rollbackJson: JSON.stringify(input.rollback ?? {}),
        requestedBy, requestReason, expiresAt, decidedBy: "", decisionReason: "", executionReceiptJson: "{}",
        requestHash, createdAt: timestamp, updatedAt: timestamp,
      },
      audit: this.buildAutonomyAudit(input.scopeId, "approval", "requested", input.requestedBy ?? "system", {
        approvalId: id, workflowId: input.workflowId, revisionId: input.revisionId, evidence: input.evidence, metadata: payload,
      }),
    });
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
    return this.persistence.workflow.getApproval(id);
  }

  listApprovals(scopeId: string, limit = 200) {
    this.expireApprovals();
    return this.persistence.workflow.listApprovals(scopeId, limit);
  }

  listApprovalsPage(scopeId: string, query: Parameters<WorkflowLearningRepository["listApprovalsPage"]>[1]) {
    this.expireApprovals();
    return this.persistence.workflow.listApprovalsPage(scopeId, query);
  }

  decideApproval(id: string, decision: "approved" | "rejected", actor: string, reason = "") {
    const approval = this.getApproval(id); if (!approval || approval.status !== "pending") throw new Error("Approval request is not pending");
    const timestamp = now(); if (approval.expiresAt <= timestamp) { this.expireApprovals(); throw new Error("Approval request has expired"); }
    this.persistence.workflow.decideApproval({ id, decision, actor: redact(actor), reason: redact(reason), timestamp,
      audit: this.buildAutonomyAudit(approval.scopeId, "approval", decision, actor, { approvalId: id,
        workflowId: approval.workflowId ?? undefined, revisionId: approval.revisionId ?? undefined, metadata: { reason } }) });
    return this.getApproval(id)!;
  }

  revokeApproval(id: string, actor: string, reason = "") {
    const approval = this.getApproval(id); if (!approval || !["pending", "approved"].includes(approval.status)) throw new Error("Approval request cannot be revoked");
    const timestamp = now();
    this.persistence.workflow.revokeApproval({ id, actor: redact(actor), reason: redact(reason), timestamp,
      audit: this.buildAutonomyAudit(approval.scopeId, "approval", "revoked", actor, { approvalId: id,
        workflowId: approval.workflowId ?? undefined, revisionId: approval.revisionId ?? undefined, metadata: { reason } }) });
    return this.getApproval(id)!;
  }

  private expireApprovals() {
    const timestamp = now();
    this.persistence.workflow.expireApprovals(timestamp, (rows) => rows.map((row) =>
      this.buildAutonomyAudit(row.scopeId, "approval", "expired", "system", {
        approvalId: row.id, workflowId: row.workflowId ?? undefined, revisionId: row.revisionId ?? undefined,
      })));
  }

  setBindingMode(bindingId: string, mode: "suggested" | "adopted" | "partially_adopted" | "rejected") {
    if (!this.persistence.workflow.setBindingMode(bindingId, mode)) throw new Error("Workflow binding not found");
    return { bindingId, mode };
  }

  recordApplication(input: { bindingId: string; status: WorkflowApplicationStatus; executedStepIds?: string[]; skippedSteps?: WorkflowSkippedStep[]; correctionObserved?: boolean; repeatedToolCalls?: number; continuationCount?: number; verificationMapping?: WorkflowVerificationMapping[] }) {
    this.requireAutoExecution();
    const mode = input.status === "adopted" ? "adopted" : input.status === "partial" ? "partially_adopted" : input.status === "rejected" ? "rejected" : "suggested";
    return this.persistence.workflow.recordApplication({ id: randomUUID(), bindingId: input.bindingId, status: input.status, mode,
      executedStepIdsJson: JSON.stringify(sanitizeIds(input.executedStepIds ?? [])),
      skippedStepsJson: JSON.stringify((input.skippedSteps ?? []).map((item) => ({ stepId: redact(item.stepId), reason: redact(item.reason) }))),
      correctionObserved: Number(input.correctionObserved ?? false), repeatedToolCalls: Math.max(0, input.repeatedToolCalls ?? 0),
      continuationCount: Math.max(0, input.continuationCount ?? 0), verificationMappingJson: JSON.stringify(input.verificationMapping ?? []),
      attributionLevel: input.status === "exposed" || input.status === "rejected" ? "exposed" : "adopted", createdAt: now() });
  }

  getApplicationReceipt(bindingId: string) { return this.persistence.workflow.getApplicationReceipt(bindingId); }

  recordRunApplications(run: TaskRun) {
    if (this.featureControl && !this.featureControl.snapshot().autoExecutionEnabled) return;
    const bindings = this.persistence.workflow.listRunBindings(run.id, run.attempt);
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
      this.persistence.workflow.recordRunApplication({ id: randomUUID(), bindingId: binding.id, runId: run.id,
        attempt: run.attempt, taskOutcome: run.status,
        applicationStatus: receipt?.application_status ?? (adopted ? "adopted" : "exposed"),
        passed, failed, attributionLevel, createdAt: now() });
      if (!adopted) continue;
      const signal: WorkflowFeedbackSignal = run.status === "completed" && verified ? "successful" : "failed";
      this.feedback({ workflowId: binding.workflowId, revisionId: binding.revisionId, runId: run.id, attempt: run.attempt, signal, idempotencyKey: `workflow-application:${binding.id}:v1`, adopted: true, verified });
    }
  }

  feedback(input: { workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; idempotencyKey: string; note?: string; adopted?: boolean; verified?: boolean }) {
    const weights: Record<WorkflowFeedbackSignal, number> = { successful: 1, helpful: 0.75, failed: -1, corrected: -1.5, harmful: -2 };
    const id = randomUUID();
    const { receipt, inserted } = this.persistence.workflow.recordFeedback({ id, workflowId: input.workflowId,
      revisionId: input.revisionId, runId: input.runId, attempt: input.attempt, signal: input.signal,
      weight: weights[input.signal], adopted: Number(input.adopted ?? true), verified: Number(input.verified ?? false),
      idempotencyKey: input.idempotencyKey, note: redact(input.note ?? ""), createdAt: now() });
    if (!inserted) return receipt;
    if (["corrected", "harmful"].includes(input.signal)) {
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
      const promotion = this.persistence.workflow.getCanaryPromotion(definition.id);
      let canaryReason = "";
      if (promotion) {
        const assignmentKey=`${scopeId}:${runId}:${definition.id}`; const assignmentHash=createHash("sha256").update(assignmentKey).digest("hex");
        const bucket=Number.parseInt(assignmentHash.slice(0,8),16)%10000; const variant=bucket<promotion.canaryPercent*100?"candidate":"baseline";
        const assignedRevisionId=variant==="candidate"?promotion.revisionId:promotion.previousRevisionId; const assigned=this.getRevision(assignedRevisionId);
        if (assigned) revision=assigned;
        const receiptPayload={promotionId:promotion.id,workflowId:definition.id,runId,attempt,scopeId,assignmentKey,assignmentHash,bucket,variant,revisionId:revision.id}; const receiptHash=hash(receiptPayload);
        this.persistence.workflow.recordCanaryAssignment({ id: randomUUID(), promotionId: promotion.id,
          workflowId: definition.id, runId, attempt, scopeId, assignmentKey, assignmentHash, bucket, variant,
          revisionId: revision.id, receiptHash, createdAt: now() });
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
      const persistedId = this.persistence.workflow.recordWorkflowBinding({ id: bindingId, runId, attempt,
        workflowId: definition.id, revisionId: revision.id, score, reasonsJson: JSON.stringify(reasons), createdAt: now() });
      this.recordSelectorReceipt(runId, attempt, definition.id, revision.id, "selected", reasons, score);
      return [{ definition, revision, score, reasons, bindingId: persistedId }];
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
    const row = this.persistence.workflow.workflowQuality(revisionId);
    const priorSamples = 4; const priorSuccess = 2;
    return { samples: row.samples, score: Math.max(0, Math.min(1, (priorSuccess + Math.max(0, row.weight)) / (priorSamples + row.samples))) };
  }

  private recordSelectorReceipt(runId: string, attempt: number, workflowId: string, revisionId: string, decision: "selected" | "excluded", reasons: string[], score?: number) {
    this.persistence.workflow.recordSelectorReceipt({ id: randomUUID(), runId, attempt, workflowId, revisionId,
      decision, reasonsJson: JSON.stringify(reasons), score: score ?? null, createdAt: now() });
  }

  listWorkflows(scopeId: string, includeDeleted = false) {
    const rows = this.persistence.workflow.listWorkflowDefinitions(scopeId, includeDeleted);
    return rows.map((row) => ({ ...row, revision: row.activeRevisionId ? this.getRevision(row.activeRevisionId) : this.listRevisions(row.id).at(-1) }));
  }
  getWorkflow(id: string, includeDeleted = false) { const row = this.persistence.workflow.getWorkflowDefinition(id, includeDeleted); return row ? { ...row, revision: row.activeRevisionId ? this.getRevision(row.activeRevisionId) : this.listRevisions(row.id).at(-1) } : undefined; }
  listBindings(scopeId: string, limit = 200) { return this.persistence.workflow.listBindings(scopeId, limit); }
  listFeedback(scopeId: string, limit = 200) { return this.persistence.workflow.listFeedback(scopeId, limit); }
  createProposal(workflowId: string, baseRevisionId: string, patch: Partial<WorkflowSpec>, reason: string, evidenceIds: string[] = []) {
    const base = this.getRevision(baseRevisionId);
    if (!base || base.workflowId !== workflowId) throw new Error("Proposal base revision not found");
    const changedPaths = patchPaths(patch); if (!changedPaths.length) throw new Error("Proposal patch must be non-empty");
    const proposed = sanitizeSpec({ ...pickSpec(base), ...patch }); const baseHash = specHash(pickSpec(base)); const proposedHash = specHash(proposed);
    if (baseHash === proposedHash) throw new Error("Proposal must produce a non-empty revision diff");
    const id = randomUUID();
    return this.persistence.workflow.createProposal({ id, workflowId, baseRevisionId, reason: redact(reason),
      evidenceJson: JSON.stringify(sanitizeIds(evidenceIds)), patchJson: JSON.stringify(patch), baseSpecHash: baseHash,
      proposedSpecHash: proposedHash, changedPathsJson: JSON.stringify(changedPaths), createdAt: now() });
  }
  listProposals(scopeId: string) { return this.persistence.workflow.listProposals(scopeId); }
  private validateProposal(id: string, requiredStatus: "candidate" | "approved") {
    const proposal = this.persistence.workflow.getProposal(id);
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
    const proposal = decision === "approved" ? this.validateProposal(id, "candidate") : this.persistence.workflow.getProposal(id);
    if (!proposal || proposal.status !== "candidate") throw new Error("Proposal is not pending");
    const timestamp = now();
    return this.persistence.workflow.decideProposal({ id, decision, actor: redact(actor), reason: redact(reason), timestamp,
      receipt: this.buildGovernanceReceipt(proposal.workflowId, `proposal_${decision}`, actor, reason, { proposalId: id }, timestamp) });
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
  listDistillationJobs(scopeId: string) { return this.persistence.workflow.listDistillationJobs(scopeId); }
  listRunLearningPolicies(scopeId: string) { return this.persistence.workflow.listRunLearningPolicies(scopeId); }
  listWorkflowQuality(scopeId: string) { const rows=this.persistence.workflow.listWorkflowQuality(scopeId);const priorSamples=4,priorSuccess=2;return rows.map((row)=>({workflowId:row.workflowId,revisionId:row.revisionId,samples:row.samples,score:Math.max(0,Math.min(1,(priorSuccess+Math.max(0,row.weight))/(priorSamples+row.samples)))})); }
  listEvaluations(scopeId: string) { return this.persistence.workflow.listEvaluations(scopeId); }
  listCanaryBindings(scopeId: string, limit=200) { return this.persistence.workflow.listCanaryBindings(scopeId,limit); }
  getDistillationMetrics(scopeId?:string) { return this.persistence.workflow.getDistillationMetrics(scopeId, now()); }
  listAutonomyAudit(scopeId: string, limit = 300) { return this.persistence.workflow.listAutonomyAudit(scopeId,limit); }
  private autonomyAudit(scopeId: string, category: "observe"|"learn"|"distill"|"evolve"|"approval"|"execute", action: string, actor: string,
    input: { sourceRunId?: string; workflowId?: string; revisionId?: string; approvalId?: string; evidence?: string[]; metadata?: unknown } = {}) {
    this.persistence.workflow.recordAutonomyAudit(this.buildAutonomyAudit(scopeId, category, action, actor, input));
  }
  private buildAutonomyAudit(scopeId: string, category: "observe"|"learn"|"distill"|"evolve"|"approval"|"execute", action: string, actor: string,
    input: { sourceRunId?: string; workflowId?: string; revisionId?: string; approvalId?: string; evidence?: string[]; metadata?: unknown } = {}) {
    const createdAt=now(); const payload={scopeId,category,action,actor:redact(actor),sourceRunId:input.sourceRunId??null,workflowId:input.workflowId??null,
      revisionId:input.revisionId??null,approvalId:input.approvalId??null,evidence:sanitizeIds(input.evidence??[]),metadata:input.metadata??{},createdAt};
    return { id: randomUUID(), scopeId, category, action, actor: payload.actor, sourceRunId: payload.sourceRunId,
      workflowId: payload.workflowId, revisionId: payload.revisionId, approvalId: payload.approvalId,
      evidenceJson: JSON.stringify(payload.evidence), metadataJson: JSON.stringify(payload.metadata),
      receiptHash: hash(payload), createdAt };
  }
  private buildGovernanceReceipt(workflowId: string, action: string, actor: string, reason: string,
    metadata: Record<string, unknown> = {}, createdAt = now()) {
    return { id: randomUUID(), workflowId, action, actor: redact(actor), reason: redact(reason), metadataJson: JSON.stringify(metadata), createdAt };
  }
  getLearningCenter(scopeId: string) { return { featureState:this.featureControl?.snapshot()??null,workflows:this.listWorkflows(scopeId,true),bindings:this.listBindings(scopeId),canaryBindings:this.listCanaryBindings(scopeId),feedback:this.listFeedback(scopeId),proposals:this.listProposals(scopeId),learningPolicies:this.listRunLearningPolicies(scopeId),quality:this.listWorkflowQuality(scopeId),distillationJobs:this.listDistillationJobs(scopeId),distillationMetrics:this.getDistillationMetrics(scopeId),evaluations:this.listEvaluations(scopeId),approvals:this.listApprovals(scopeId),autonomyAudit:this.listAutonomyAudit(scopeId) }; }
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
  verifyEvaluationReceipt(id:string) { const row=this.persistence.workflow.getEvaluationReceipt(id); if(!row)return false; const payload=evaluationPayloadFromRow(row); const receiptHash=hash(payload); if(receiptHash!==row.receipt_hash)return false; if(!this.evaluationSecret)return row.signature===receiptHash; const expected=createHmac("sha256",this.evaluationSecret).update(receiptHash).digest("hex"); return safeEqual(String(row.signature),expected); }
  private persistEvaluationReceipt(input:{workflowId:string;kind:"shadow"|"offline_replay"|"canary";status:string;sampleSize:number;successRate:number;baselineRate:number;riskClass:string;evaluatorId:string;evaluatorVersion:string;datasetId:string;datasetHash:string;baselineRevisionId:string;candidateRevisionId:string;evaluationRunIds:string[];checkResults:WorkflowEvaluationCheckResult[];evidence:Record<string,unknown>}) {
    const built = this.buildEvaluationReceipt(input);
    this.persistence.workflow.recordEvaluationReceipt(built.write);
    return built.receipt;
  }
  private buildEvaluationReceipt(input:{workflowId:string;kind:"shadow"|"offline_replay"|"canary";status:string;sampleSize:number;successRate:number;baselineRate:number;riskClass:string;evaluatorId:string;evaluatorVersion:string;datasetId:string;datasetHash:string;baselineRevisionId:string;candidateRevisionId:string;evaluationRunIds:string[];checkResults:WorkflowEvaluationCheckResult[];evidence:Record<string,unknown>}) {
    const id=randomUUID(); const createdAt=now(); const payload={id,workflowId:input.workflowId,revisionId:input.candidateRevisionId,kind:input.kind,status:input.status,sampleSize:input.sampleSize,successRate:input.successRate,baselineRate:input.baselineRate,riskClass:input.riskClass,evaluatorId:input.evaluatorId,evaluatorVersion:input.evaluatorVersion,datasetId:input.datasetId,datasetHash:input.datasetHash,baselineRevisionId:input.baselineRevisionId,candidateRevisionId:input.candidateRevisionId,evaluationRunIds:unique(input.evaluationRunIds).sort(),checkResults:input.checkResults,createdAt}; const receiptHash=hash(payload); const signature=this.evaluationSecret?createHmac("sha256",this.evaluationSecret).update(receiptHash).digest("hex"):receiptHash;
    return { receipt: {id,status:input.status,receiptHash,signature}, write: { id, workflowId: input.workflowId,
      revisionId: input.candidateRevisionId, kind: input.kind, status: input.status, sampleSize: input.sampleSize,
      successRate: input.successRate, baselineRate: input.baselineRate, riskClass: input.riskClass,
      evidenceJson: JSON.stringify(input.evidence), evaluatorId: input.evaluatorId, evaluatorVersion: input.evaluatorVersion,
      datasetId: input.datasetId, datasetHash: input.datasetHash, baselineRevisionId: input.baselineRevisionId,
      candidateRevisionId: input.candidateRevisionId, evaluationRunIdsJson: JSON.stringify(payload.evaluationRunIds),
      checkResultsJson: JSON.stringify(input.checkResults), receiptHash, signature, createdAt } };
  }
  private requireEvaluationRun(runId:string,workflowId:string,revisionId:string){const run=this.persistence.getRun(runId);if(!run)throw new Error(`Evaluation run not found: ${runId}`);if(!this.persistence.workflow.hasWorkflowBinding(runId,workflowId,revisionId))throw new Error(`Evaluation run ${runId} is not bound to revision ${revisionId}`);return run;}
  private evaluationRunResult(run:TaskRun,variant:"baseline"|"candidate"){const required=run.checks.filter(check=>check.required);const success=run.status==="completed"&&required.length>0&&required.every(check=>check.status==="passed"&&!check.stale);return{runId:run.id,variant,success,checkResults:required.map(check=>({runId:run.id,checkKey:check.key,required:true,status:check.status,stale:check.stale}))};}
  requestPromotion(workflowId:string,revisionId:string,canaryPercent=10,maxFailureDelta=0.02,actor="governor") {this.requireAutoExecution();const revision=this.getRevision(revisionId);const workflow=this.getWorkflow(workflowId,true);if(!workflow||!revision||revision.workflowId!==workflowId)throw new Error("Workflow revision not found");if(revision.riskClass!=="low")throw new Error("Canary is limited to low-risk workflows");const evaluations=this.persistence.workflow.listPassedEvaluations(workflowId,revisionId);if(!['shadow','offline_replay'].every(kind=>evaluations.some(item=>item.kind===kind&&this.verifyEvaluationReceipt(item.id))))throw new Error("Trusted shadow and offline replay receipts must pass before canary");if(!workflow.activeRevisionId)throw new Error("Canary requires an active baseline revision");return this.requestApproval({scopeId:workflow.scopeId,actionType:"start_canary",targetType:"workflow_revision",targetId:revisionId,workflowId,revisionId,riskClass:"low",requestedBy:actor,reason:"start guarded canary",impactScope:{scopeId:workflow.scopeId,canaryPercent:Math.max(1,Math.min(25,canaryPercent)),maxFailureDelta,baselineRevisionId:workflow.activeRevisionId},evidence:evaluations.map(item=>`evaluation:${item.id}:${item.receiptHash}`),diff:{baselineRevisionId:workflow.activeRevisionId,candidateRevisionId:revisionId,canaryPercent},rollback:{action:"automatic_rollback",revisionId:workflow.activeRevisionId}});}
  recordCanaryOutcome(run:TaskRun){if(!this.featureControl?.snapshot().autoExecutionEnabled&&this.featureControl)return;const bindings=this.persistence.workflow.listPendingCanaryBindings(run.id,run.attempt);for(const binding of bindings){const required=run.checks.filter(check=>check.required);const passed=required.filter(check=>check.status==='passed'&&!check.stale).length;const success=run.status==='completed'&&required.length>0&&passed===required.length;this.persistence.workflow.recordCanaryOutcome({id:binding.id,outcomeStatus:run.status,success:Number(success),requiredChecks:required.length,passedChecks:passed,timestamp:now()});}}
  retryDistillationJob(id:string,repair?:{taskSignature?:string}){return this.persistence.workflow.retryDistillationJob({id,checkpointJson:JSON.stringify({phase:'repaired',repair:repair??{}}),taskSignature:repair?.taskSignature,timestamp:now()});}
  listDeadLetterJobs(limit=100){return this.persistence.workflow.listDeadLetterJobs(limit);}
  listRevisions(workflowId: string) { return this.persistence.workflow.listWorkflowRevisionIds(workflowId).map((id) => this.getRevision(id)!); }
  getRevision(id: string): WorkflowRevision | undefined { const row = this.persistence.workflow.getWorkflowRevision(id); if (!row) return undefined; const stored = JSON.parse(row.specJson) as Partial<WorkflowSpec> & { counterexampleIds?: string[] }; return { id: row.id, workflowId: row.workflowId, revision: row.revision, ...sanitizeSpec(stored as WorkflowSpec), sourceType: row.sourceType, sourceEvidenceIds: JSON.parse(row.sourceEvidenceJson) as string[], counterexampleIds: sanitizeIds(stored.counterexampleIds ?? []), confidence: row.confidence, changeSummary: row.changeSummary, createdAt: row.createdAt }; }
}

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
function sameStrings(left:string[],right:string[]){return JSON.stringify([...left].sort())===JSON.stringify([...right].sort());}
function unique(values:string[]){return [...new Set(values.filter(Boolean))];}
function safeEqual(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function evaluationPayloadFromRow(row:Record<string,unknown>){return{id:String(row.id),workflowId:String(row.workflow_id),revisionId:String(row.revision_id),kind:String(row.kind),status:String(row.status),sampleSize:Number(row.sample_size),successRate:Number(row.success_rate),baselineRate:Number(row.baseline_rate),riskClass:String(row.risk_class),evaluatorId:String(row.evaluator_id),evaluatorVersion:String(row.evaluator_version),datasetId:String(row.dataset_id),datasetHash:String(row.dataset_hash),baselineRevisionId:String(row.baseline_revision_id),candidateRevisionId:String(row.candidate_revision_id),evaluationRunIds:JSON.parse(String(row.evaluation_run_ids_json||"[]")) as string[],checkResults:JSON.parse(String(row.check_results_json||"[]")) as WorkflowEvaluationCheckResult[],createdAt:Number(row.created_at)};}
