import { createHash, randomUUID } from "node:crypto";
import type { ContextManifestItem, TaskRun } from "@tagent/execution/domain";
import type { MemoryFacade } from "@tagent/memory";
import type { MemoryScope, RecallFeedbackSignal } from "@tagent/memory/domain";
import type { LearningServicePersistencePort } from "./ports/learning-ledger-repository.js";
import type { SemanticJudge } from "./semantic-judge.js";

export type CommunicationDimension = "language" | "verbosity" | "technicalDepth" | "answerStructure" | "progressUpdatePolicy" | "clarificationTolerance" | "uncertaintyStyle" | "challengeLevel" | "forbiddenPatterns";
export type CommunicationApplicability = "global" | "workspace" | "project" | "session" | "task";
export interface CommunicationPreference {
  value: string | string[];
  status: "candidate" | "active";
  confidence: number;
  confirmations: number;
  counterexamples: number;
  sourceRefs: string[];
  expiresAt?: number;
  locked?: boolean;
}
export type CommunicationProfileValues = Partial<Record<CommunicationDimension, CommunicationPreference>>;
export interface ResolvedCommunicationProfile { profileIds: string[]; revisionIds: string[]; values: CommunicationProfileValues; promptSection: string; contextItems: ContextManifestItem[] }

const now = () => Date.now();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const redact = (value: string) => value.replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]").replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
const safeJson = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
const communicationDimensions=new Set<CommunicationDimension>(["language","verbosity","technicalDepth","answerStructure","progressUpdatePolicy","clarificationTolerance","uncertaintyStyle","challengeLevel","forbiddenPatterns"]);
const isCommunicationDimension=(value:string):value is CommunicationDimension=>communicationDimensions.has(value as CommunicationDimension);

export class LearningService {
  constructor(private readonly persistence: LearningServicePersistencePort, private readonly memory?: MemoryFacade, private readonly memoryScopeId = "default", private readonly semanticJudge?: SemanticJudge) {}

  recordCommunicationPreference(input: { subjectId: string; scopeType: CommunicationApplicability; scopeId: string; dimension: CommunicationDimension; value: string | string[]; sourceType: "explicit_user" | "inferred" | "governance"; sourceRef: string; confidence?: number; expiresAt?: number }) {
    const timestamp = now();
    const profile = this.persistence.learningLedger.updateCommunicationProfile({
      id: randomUUID(),
      subjectId: input.subjectId,
      storedSubjectId: redact(input.subjectId),
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      storedScopeId: redact(input.scopeId),
      timestamp,
    }, (currentProfile, previous) => {
      if (currentProfile.locked && input.sourceType === "inferred") return undefined;
      const values: CommunicationProfileValues = structuredClone(previous ? safeJson<CommunicationProfileValues>(previous.valuesJson, {}) : {});
      const current = values[input.dimension];
      const same = current && JSON.stringify(current.value) === JSON.stringify(input.value);
      const confirmations = same ? current.confirmations + 1 : 1;
      const explicit = input.sourceType === "explicit_user" || input.sourceType === "governance";
      const status = explicit || confirmations >= 2 ? "active" : "candidate";
      values[input.dimension] = {
        value: Array.isArray(input.value) ? input.value.map((item) => redact(String(item)).slice(0, 300)) : redact(String(input.value)).slice(0, 1000),
        status,
        confidence: explicit ? Math.max(.95, input.confidence ?? .95) : Math.min(.9, input.confidence ?? (.55 + confirmations * .15)),
        confirmations,
        counterexamples: same ? current.counterexamples : current ? current.counterexamples + 1 : 0,
        sourceRefs: [...new Set([...(same ? current.sourceRefs : []), redact(input.sourceRef).slice(0, 500)])].slice(-20),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(current?.locked ? { locked: true } : {}),
      };
      return {
        valuesJson: JSON.stringify(values),
        evidenceJson: JSON.stringify({ dimension: input.dimension, sourceRef: input.sourceRef, confirmations, status }),
        sourceType: input.sourceType,
        changeSummary: `${input.dimension} ${status}`,
      };
    });
    return this.getCommunicationProfile(profile.id)!;
  }

  async analyzeUserMessage(input:{subjectId:string;scopeId:string;messageId:number;content:string;context?:string;runId?:string;attempt?:number}) {
    const failuresBefore=this.semanticJudge?.snapshot().failures??0;
    const semantic=this.semanticJudge?await this.semanticJudge.userMessage(input.content,input.context??""):undefined;
    if(this.semanticJudge&&!semantic&&this.semanticJudge.snapshot().failures>failuresBefore)throw new Error("Semantic user-message analysis failed");
    if(semantic){for(const preference of semantic.communicationPreferences){if(isCommunicationDimension(preference.dimension))this.recordCommunicationPreference({subjectId:input.subjectId,scopeType:"session",scopeId:input.scopeId,dimension:preference.dimension,value:preference.value,sourceType:"explicit_user",sourceRef:`message:${input.messageId}`,confidence:semantic.confidence});}if(semantic.correction)this.recordCorrection({sessionId:input.scopeId,runId:input.runId,attempt:input.attempt,messageId:input.messageId,correctionType:semantic.correctionType,targetType:"run",targetId:input.runId,content:input.content,source:"explicit_user"});return semantic;}
    this.captureExplicitCommunicationPreferences(input.subjectId,input.scopeId,input.messageId,input.content);
    if(/\b(?:correction|incorrect|wrong|inaccurate|learned wrong)\b|(?:不太对|不准确|不正确|不对|错了|学错|改为|纠正|不是.{0,20}而是|不要再)/i.test(input.content))this.recordCorrection({sessionId:input.scopeId,runId:input.runId,attempt:input.attempt,messageId:input.messageId,content:input.content,source:"explicit_user"});
    return undefined;
  }

  captureExplicitCommunicationPreferences(subjectId: string, scopeId: string, messageId: number, content: string) {
    const sourceRef = `message:${messageId}`; const recorded = [];
    const rules: Array<[CommunicationDimension, RegExp, (match: RegExpMatchArray) => string | string[]]> = [
      ["language", /(?:请|以后|始终|回答时)?(?:使用|用)(中文|英文|简体中文|繁体中文)(?:回答|回复)?/i, (m) => m[1]],
      ["verbosity", /(?:回答|回复).{0,8}(简洁|简短|详细|详尽)|(?:尽量|请)(简洁|详细)/i, (m) => (m[1] || m[2])],
      ["technicalDepth", /(?:技术深度|技术细节).{0,8}(浅显|基础|深入|专家级)|(?:给我|使用)(技术性强|面向专家|通俗易懂)的?(?:回答|解释)?/i, (m) => (m[1] || m[2])],
      ["answerStructure", /(?:回答|输出).{0,8}(使用列表|分点|先结论后细节|表格|不要表格)/i, (m) => m[1]],
      ["progressUpdatePolicy", /(?:进度更新|过程更新).{0,8}(不要|需要|简短|详细)|(?:不要|请)(?:频繁)?汇报进度/i, (m) => m[1] || (m[0].startsWith("不要") ? "不要频繁汇报" : "需要汇报")],
      ["clarificationTolerance", /(?:不确定时|信息不足时).{0,12}(先问我|直接做保守假设|不要反复追问)/i, (m) => m[1]],
      ["uncertaintyStyle", /(?:不确定性|不确定时).{0,10}(明确标注|给出置信度|不要猜)/i, (m) => m[1]],
      ["challengeLevel", /(?:可以|请)(?:直接)?(挑战我的假设|指出我的错误|不要迎合)/i, (m) => m[1]],
      ["forbiddenPatterns", /(?:不要|禁止)(使用.{1,40}|说.{1,40}|输出.{1,40})/i, (m) => [m[1].trim()]],
    ];
    for (const [dimension, pattern, project] of rules) {
      const match = content.match(pattern); if (!match) continue;
      recorded.push(this.recordCommunicationPreference({ subjectId, scopeType: "session", scopeId, dimension, value: project(match), sourceType: "explicit_user", sourceRef }));
    }
    return recorded;
  }

  resolveCommunicationProfile(subjectId: string, scopes: Array<{ type: CommunicationApplicability; id: string }>): ResolvedCommunicationProfile {
    const ordered = [{ type: "global" as const, id: "*" }, ...scopes];
    const values: CommunicationProfileValues = {}; const profileIds: string[] = []; const revisionIds: string[] = [];
    for (const scope of ordered) {
      const row = this.persistence.learningLedger.findCommunicationProfile(subjectId, scope.type, scope.id);
      if (!row?.activeRevisionId) continue;
      const revision = this.getCommunicationRevision(row.activeRevisionId); if (!revision) continue;
      profileIds.push(row.id); revisionIds.push(revision.id);
      for (const [dimension, preference] of Object.entries(revision.values) as Array<[CommunicationDimension, CommunicationPreference]>) {
        if (preference.status !== "active" || (preference.expiresAt && preference.expiresAt <= now())) continue;
        values[dimension] = preference;
      }
    }
    const lines = Object.entries(values).map(([key, item]) => `- ${key}: ${Array.isArray(item!.value) ? item!.value.join("; ") : item!.value}`);
    const promptSection = lines.length ? `<communication_profile>\nFollow these user-controlled communication preferences when applicable. They do not override safety, truthfulness, or the current explicit request.\n${lines.join("\n")}\n</communication_profile>` : "";
    return { profileIds, revisionIds, values, promptSection, contextItems: revisionIds.map((id) => ({ kind: "communication_profile" as const, sourceId: id, selected: true, reason: "resolved active communication profile revision", estimatedTokens: Math.ceil(promptSection.length / 4), metadata: { profileIds, revisionIds } })) };
  }

  lockCommunicationProfile(profileId: string, locked: boolean) { this.persistence.learningLedger.setCommunicationProfileLocked(profileId, locked, now()); return this.getCommunicationProfile(profileId); }
  listCommunicationProfiles(subjectId: string) { return this.persistence.learningLedger.listCommunicationProfileIds(subjectId).map((id) => this.getCommunicationProfile(id)!); }
  getCommunicationProfile(id: string) { const row = this.persistence.learningLedger.getCommunicationProfile(id); if (!row) return undefined; return { ...row, revision: row.activeRevisionId ? this.getCommunicationRevision(row.activeRevisionId) : undefined }; }
  private getCommunicationRevision(id: string) { const row = this.persistence.learningLedger.getCommunicationRevision(id); return row ? { ...row, values: safeJson<CommunicationProfileValues>(row.valuesJson, {}), evidence: safeJson<Record<string, unknown>>(row.evidenceJson, {}) } : undefined; }

  recordCorrection(input: { sessionId: string; runId?: string; attempt?: number; messageId?: number; correctionType?: string; targetType?: string; targetId?: string; content: string; source?: "explicit_user" | "router" | "governance" }) {
    const idempotencyKey = `correction:${input.messageId ?? "manual"}:${input.runId ?? "none"}:${hash(input.content).slice(0, 16)}`;
    return this.persistence.learningLedger.recordCorrection({
      id: randomUUID(), sessionId: input.sessionId, runId: input.runId ?? null,
      attempt: input.attempt ?? null, messageId: input.messageId ?? null,
      correctionType: input.correctionType ?? "instruction_correction", targetType: input.targetType ?? "run",
      targetId: input.targetId ?? input.runId ?? "", content: redact(input.content).slice(0, 12_000),
      source: input.source ?? "explicit_user", idempotencyKey, createdAt: now(),
    });
  }

  drainLearningProjectionLedger(limit = 200) {
    const rows = this.persistence.learningLedger.listUnprojectedLearningRows(limit);
    for (const row of rows) { const snapshot = safeJson<TaskRun | null>(row.snapshotJson, null); const run = snapshot ?? this.persistence.getRun(row.runId); if (run) this.projectRun({ ...run, attempt: row.attempt }, row.lifecycle, row.eventSeq, row.outcome as TaskRun["status"]); }
    return rows.length;
  }

  projectRun(run: TaskRun, lifecycle = `run.${run.status}`, eventSeq = run.lastEventSeq, projectedStatus: TaskRun["status"] = run.status) {
    const effectiveRun = projectedStatus === run.status ? run : { ...run, status: projectedStatus };
    const manifest = run.supervision.latestContextManifest?.attempt === run.attempt
      ? run.supervision.latestContextManifest
      : this.persistence.getContextManifestForAttempt(run.id, run.attempt);
    const continuations = run.continuations.length;
    const toolRows = this.persistence.learningLedger.listLearningToolAttempts(run.id, run.attempt);
    const repeatedToolCalls = toolRows.length - new Set(toolRows.map((item) => `${item.toolName}:${item.argsHash}`)).size;
    const requiredChecks = run.checks.filter((item) => item.required);
    const success = effectiveRun.status === "completed" && requiredChecks.length > 0 && requiredChecks.every((item) => item.status === "passed" && !item.stale);
    const correctionCount = this.persistence.learningLedger.countRunCorrections(run.id, run.attempt);
    const eventBody = {
      taskClassification: { domain: run.contract?.scope || "general", intent: run.contract?.intent ?? "unknown", risk: run.supervision.approvalRequests.length ? "elevated" : "normal", complexity: run.plan.length >= 8 ? "high" : run.plan.length >= 3 ? "medium" : "low" },
      strategySelected: manifest?.items.filter((item) => item.kind === "workflow_revision" || item.kind === "communication_profile").map((item) => ({ kind: item.kind, sourceId: item.sourceId, reason: item.reason, metadata: item.metadata })) ?? [],
      contextUsed: { manifestId: manifest?.id ?? null, manifestHash: manifest?.manifestHash ?? null, selectedMemoryIds: manifest?.items.filter((item) => item.kind === "memory_card" && item.selected).map((item) => item.sourceId) ?? [], selectedTopicIds: manifest?.items.filter((item) => item.kind === "cold_topic" && item.selected).map((item) => item.sourceId) ?? [] },
      executionTrace: { tools: toolRows.map((item) => ({ tool: item.toolName, status: item.status })), repeatedToolCalls, continuations, failures: toolRows.filter((item) => item.status !== "completed").map((item) => item.toolName) },
      outcome: { status: effectiveRun.status, gatePassed: run.completionGate.passed, requiredChecks: requiredChecks.length, requiredChecksPassed: requiredChecks.filter((item) => item.status === "passed" && !item.stale).length, success, correctionCount, durationMs: (run.completedAt ?? run.updatedAt) - run.createdAt, usage: run.usage },
      attribution: { conservative: true, positiveEligible: success && correctionCount === 0, reason: success ? "completed with non-empty fresh required checks" : "positive task attribution withheld" },
      policy: this.persistence.learningLedger.getRunLearningPolicyRecord(run.id) ?? { policy: "allow", reason: "default" },
    };
    const eventHash = hash({ runId: run.id, attempt: run.attempt, lifecycle, eventSeq, eventBody });
    const id = randomUUID();
    const labels: Array<[string, string, number, unknown[]]> = [
      ["terminal_status", effectiveRun.status, 1, [`run:${run.id}`]], ["task_success", String(success), 1, requiredChecks.map((item) => `check:${item.key}`)],
      ["gate_passed", String(run.completionGate.passed), 1, ["completion_gate"]], ["correction_observed", String(correctionCount > 0), 1, correctionCount ? [`corrections:${correctionCount}`] : []],
      ["cost_band", run.usage.cost > 1 ? "high" : run.usage.cost > .1 ? "medium" : "low", .9, [`cost:${run.usage.cost}`]],
    ];
    const eventId = this.persistence.learningLedger.recordLearningEvent({
      id,
      runId: run.id,
      attempt: run.attempt,
      lifecycle,
      eventSeq,
      taskClassificationJson: JSON.stringify(eventBody.taskClassification),
      strategySelectedJson: JSON.stringify(eventBody.strategySelected),
      contextUsedJson: JSON.stringify(eventBody.contextUsed),
      executionTraceJson: JSON.stringify(eventBody.executionTrace),
      outcomeJson: JSON.stringify(eventBody.outcome),
      attributionJson: JSON.stringify(eventBody.attribution),
      policyJson: JSON.stringify(eventBody.policy),
      eventHash,
      createdAt: now(),
      labels: labels.map(([label, value, confidence, evidence]) => ({
        id: randomUUID(),
        label,
        value,
        confidence,
        evidenceJson: JSON.stringify(evidence),
        idempotencyKey: `outcome:${id}:${label}`,
        createdAt: now(),
      })),
    });
    this.createConservativeFeedbackReceipts(run, manifest?.id ?? "", manifest?.items ?? [], success, correctionCount > 0);
    if (this.semanticJudge) this.persistence.enqueueSemanticLearningJob("feedback_attribution", { runId: run.id, attempt: run.attempt, manifestId: manifest?.id ?? "", items: manifest?.items ?? [], success, corrected: correctionCount > 0 }, `semantic-feedback:${run.id}:${run.attempt}:${manifest?.id ?? "none"}`, run.id, run.attempt);
    return this.getLearningEvent(eventId);
  }

  private createConservativeFeedbackReceipts(run: TaskRun, manifestId: string, items: ContextManifestItem[], success: boolean, corrected: boolean) {
    const assistant = this.persistence.listMessages(run.sessionId, 30).filter((item) => item.role === "assistant").at(-1)?.content ?? "";
    const selected = items.filter((item) => item.kind === "memory_card" && item.selected);
    for (const item of selected) {
      const explicitlyCited = assistant.includes(`[memory:${item.sourceId}]`) || assistant.includes(`memory://${item.sourceId}`);
      const correctionTargetsRecord = corrected && this.persistence.learningLedger.correctionReferencesRecord(run.id, item.sourceId);
      const signals: Array<{ signal: RecallFeedbackSignal; weight: number; basis: string }> = [];
      if (explicitlyCited) signals.push({ signal: "cited", weight: .15, basis: "explicit_record_citation_in_final_answer" });
      if (explicitlyCited && success && !corrected) signals.push({ signal: "task_success", weight: .2, basis: "cited_record_and_verified_task_success" });
      if (correctionTargetsRecord) signals.push({ signal: "corrected", weight: -.75, basis: "explicit_correction_named_record" });
      for (const entry of signals) {
        const key = `memory-attribution:${run.id}:${run.attempt}:${item.sourceId}:${entry.signal}`;
        this.persistence.learningLedger.recordFeedbackAttributionReceipt({ id: randomUUID(), runId: run.id, attempt: run.attempt, actorId: `session:${run.sessionId}`, recordId: item.sourceId, signal: entry.signal, weight: entry.weight, basis: entry.basis, contextManifestId: manifestId, evidenceJson: JSON.stringify([`manifest:${manifestId}`, `run:${run.id}`]), idempotencyKey: key, createdAt: now() });
      }
    }
  }

  private async createSemanticFeedbackReceipts(run:TaskRun,manifestId:string,items:ContextManifestItem[],success:boolean,corrected:boolean){
    const selected=items.filter((item)=>item.kind==="memory_card"&&item.selected);if(!selected.length)return;
    const assistant=this.persistence.listMessages(run.sessionId,30).filter((item)=>item.role==="assistant").at(-1)?.content??"";
    const corrections=this.persistence.learningLedger.listCorrectionContents(run.id,run.attempt);
    const failuresBefore=this.semanticJudge!.snapshot().failures;
    const decision=await this.semanticJudge!.feedbackAttribution({assistantAnswer:assistant,corrections,records:selected.map((item)=>({id:item.sourceId,reason:item.reason,metadata:item.metadata}))});
    if(!decision&&this.semanticJudge!.snapshot().failures>failuresBefore)throw new Error("Semantic feedback attribution failed");
    if(!decision)return;
    const selectedIds=new Set(selected.map((item)=>item.sourceId));
    for(const recordId of decision.usedRecordIds.filter((id)=>selectedIds.has(id))){for(const entry of [{signal:"cited" as const,weight:.1,basis:"semantic_answer_attribution"},...(success&&!corrected?[{signal:"task_success" as const,weight:.15,basis:"semantic_use_and_verified_task_success"}]:[])]){const key=`memory-attribution:${run.id}:${run.attempt}:${recordId}:${entry.signal}`;this.persistence.learningLedger.recordFeedbackAttributionReceipt({id:randomUUID(),runId:run.id,attempt:run.attempt,actorId:`session:${run.sessionId}`,recordId,signal:entry.signal,weight:entry.weight,basis:entry.basis,contextManifestId:manifestId,evidenceJson:JSON.stringify([`manifest:${manifestId}`,`semantic-confidence:${decision.confidence}`]),idempotencyKey:key,createdAt:now()});}}
    if(corrected)for(const recordId of decision.harmfulRecordIds.filter((id)=>selectedIds.has(id))){const key=`memory-attribution:${run.id}:${run.attempt}:${recordId}:corrected`;this.persistence.learningLedger.recordFeedbackAttributionReceipt({id:randomUUID(),runId:run.id,attempt:run.attempt,actorId:`session:${run.sessionId}`,recordId,signal:"corrected",weight:-.75,basis:"semantic_correction_attribution",contextManifestId:manifestId,evidenceJson:JSON.stringify([`manifest:${manifestId}`,`semantic-confidence:${decision.confidence}`]),idempotencyKey:key,createdAt:now()});}
  }

  enqueueUserMessageAnalysis(input:{subjectId:string;scopeId:string;messageId:number;content:string;context?:string;runId?:string;attempt?:number}) {
    return this.persistence.enqueueSemanticLearningJob("user_message", input, `semantic-user-message:${input.scopeId}:${input.messageId}`, input.runId, input.attempt);
  }

  async drainSemanticLearningJobs(limit = 100) {
    if (!this.semanticJudge) return 0;
    const owner = `semantic:${randomUUID()}`;
    let processed = 0;
    while (processed < limit) {
      const [row] = this.persistence.claimSemanticLearningJobs(owner, ["user_message", "feedback_attribution"], 1);
      if (!row) break;
      const heartbeat = setInterval(() => this.persistence.renewSemanticLearningJob(row.id, owner, row.leaseToken, row.fence), 10_000);
      heartbeat.unref?.();
      try {
        const payload = safeJson<Record<string, unknown>>(row.payloadJson, {});
        if (row.kind === "user_message") await this.analyzeUserMessage(payload as Parameters<LearningService["analyzeUserMessage"]>[0]);
        else if (row.kind === "feedback_attribution") await this.createSemanticFeedbackReceipts(
          this.persistence.getRun(String(payload.runId)) ?? (()=>{throw new Error("Semantic feedback Run not found")})(),
          String(payload.manifestId ?? ""),
          (payload.items ?? []) as ContextManifestItem[],
          Boolean(payload.success),
          Boolean(payload.corrected),
        );
        else throw new Error(`Unsupported semantic learning job: ${row.kind}`);
        if (!this.persistence.completeSemanticLearningJob(row.id, owner, row.leaseToken, row.fence)) throw new Error("Semantic learning lease lost before completion");
      } catch (error) {
        this.persistence.failSemanticLearningJob(row.id, owner, row.leaseToken, row.fence, row.attempts, redact(error instanceof Error ? error.message : String(error)));
      } finally {
        clearInterval(heartbeat);
      }
      processed++;
    }
    return processed;
  }

  async drainFeedbackAttribution(limit = 100) {
    if (!this.memory?.feedback) return 0;
    const timestamp = now();
    const rows = this.persistence.learningLedger.listFeedbackAttributionWork(timestamp, limit);
    for (const row of rows) {
      const run = this.persistence.getRun(row.runId); if (!run) continue;
      const scope: MemoryScope = { type: "workspace", id: this.memoryScopeId };
      try {
        await this.memory.feedback({ subjectId: row.actorId, scopes: [scope, { type: "session", id: run.sessionId }], purpose: "memory_admin" }, scope, row.recordId, row.signal, { runId: row.runId, note: row.basis });
        this.persistence.learningLedger.completeFeedbackAttribution(row.id, now());
      } catch (error) {
        const attempts = row.attempts + 1;
        const status = attempts >= 5 ? "dead_letter" : "failed";
        const retryAt = status === "dead_letter" ? 0 : now() + Math.min(60 * 60_000, 2 ** attempts * 5_000);
        this.persistence.learningLedger.failFeedbackAttribution(row.id, status, attempts, retryAt, redact(error instanceof Error ? error.message : String(error)));
      }
    }
    return rows.length;
  }

  getLearningEvent(id: string) { const row = this.persistence.learningLedger.getLearningEventRow(id); if (!row) return undefined; return { ...row, taskClassification: safeJson(String(row.taskClassificationJson), {}), strategySelected: safeJson(String(row.strategySelectedJson), []), contextUsed: safeJson(String(row.contextUsedJson), {}), executionTrace: safeJson(String(row.executionTraceJson), {}), outcome: safeJson(String(row.outcomeJson), {}), attribution: safeJson(String(row.attributionJson), {}), policy: safeJson(String(row.policyJson), {}) }; }
  listLearningEvents(sessionId: string, limit = 100) { return this.persistence.learningLedger.listLearningEventIds(sessionId, limit).map((id) => this.getLearningEvent(id)!); }
  listCorrections(sessionId: string, limit = 100) { return this.persistence.learningLedger.listCorrectionRows(sessionId, limit); }
  listFeedbackAttribution(sessionId: string, limit = 100) { return this.persistence.learningLedger.listFeedbackAttributionRows(sessionId, limit); }
}
