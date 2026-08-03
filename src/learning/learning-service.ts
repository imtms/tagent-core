import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { ContextManifestItem, TaskRun } from "../core/types.js";
import type { MemoryFacade } from "../memory/memory-service.js";
import type { MemoryScope, RecallFeedbackSignal } from "../memory/types.js";
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
  constructor(private readonly store: Store, private readonly memory?: MemoryFacade, private readonly memoryScopeId = "default", private readonly semanticJudge?: SemanticJudge) {}

  recordCommunicationPreference(input: { subjectId: string; scopeType: CommunicationApplicability; scopeId: string; dimension: CommunicationDimension; value: string | string[]; sourceType: "explicit_user" | "inferred" | "governance"; sourceRef: string; confidence?: number; expiresAt?: number }) {
    const timestamp = now();
    const transaction = this.store.db.transaction(() => {
      let profile = this.store.db.prepare(`SELECT id,active_revision_id as activeRevisionId,locked FROM communication_profiles
        WHERE subject_id=? AND scope_type=? AND scope_id=? AND status='active'`).get(input.subjectId, input.scopeType, input.scopeId) as { id: string; activeRevisionId: string | null; locked: number } | undefined;
      if (!profile) {
        profile = { id: randomUUID(), activeRevisionId: null, locked: 0 };
        this.store.db.prepare(`INSERT INTO communication_profiles (id,subject_id,scope_type,scope_id,status,created_at,updated_at)
          VALUES (?,?,?,?,'active',?,?)`).run(profile.id, redact(input.subjectId), input.scopeType, redact(input.scopeId), timestamp, timestamp);
      }
      if (profile.locked && input.sourceType === "inferred") return this.getCommunicationProfile(profile.id)!;
      const previous = profile.activeRevisionId ? this.getCommunicationRevision(profile.activeRevisionId) : undefined;
      const values: CommunicationProfileValues = structuredClone(previous?.values ?? {});
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
      const revision = (this.store.db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM communication_profile_revisions WHERE profile_id=?").get(profile.id) as { revision: number }).revision + 1;
      const revisionId = randomUUID();
      this.store.db.prepare(`INSERT INTO communication_profile_revisions
        (id,profile_id,revision,values_json,evidence_json,source_type,change_summary,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(revisionId, profile.id, revision, JSON.stringify(values), JSON.stringify({ dimension: input.dimension, sourceRef: input.sourceRef, confirmations, status }), input.sourceType, `${input.dimension} ${status}`, timestamp);
      this.store.db.prepare("UPDATE communication_profiles SET active_revision_id=?,updated_at=? WHERE id=?").run(revisionId, timestamp, profile.id);
      return this.getCommunicationProfile(profile.id)!;
    });
    return transaction();
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
      const row = this.store.db.prepare(`SELECT id,active_revision_id as activeRevisionId FROM communication_profiles
        WHERE subject_id=? AND scope_type=? AND scope_id=? AND status='active' AND deleted_at IS NULL`).get(subjectId, scope.type, scope.id) as { id: string; activeRevisionId: string | null } | undefined;
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

  lockCommunicationProfile(profileId: string, locked: boolean) { this.store.db.prepare("UPDATE communication_profiles SET locked=?,updated_at=? WHERE id=?").run(Number(locked), now(), profileId); return this.getCommunicationProfile(profileId); }
  listCommunicationProfiles(subjectId: string) { return (this.store.db.prepare(`SELECT id FROM communication_profiles WHERE subject_id=? AND deleted_at IS NULL ORDER BY updated_at DESC`).all(subjectId) as Array<{ id: string }>).map((row) => this.getCommunicationProfile(row.id)!); }
  getCommunicationProfile(id: string) { const row = this.store.db.prepare(`SELECT id,subject_id as subjectId,scope_type as scopeType,scope_id as scopeId,status,active_revision_id as activeRevisionId,locked,created_at as createdAt,updated_at as updatedAt FROM communication_profiles WHERE id=?`).get(id) as Record<string, unknown> | undefined; if (!row) return undefined; return { ...row, locked: Boolean(row.locked), revision: row.activeRevisionId ? this.getCommunicationRevision(String(row.activeRevisionId)) : undefined }; }
  private getCommunicationRevision(id: string) { const row = this.store.db.prepare(`SELECT id,profile_id as profileId,revision,values_json as valuesJson,evidence_json as evidenceJson,source_type as sourceType,change_summary as changeSummary,created_at as createdAt FROM communication_profile_revisions WHERE id=?`).get(id) as { id: string; profileId: string; revision: number; valuesJson: string; evidenceJson: string; sourceType: string; changeSummary: string; createdAt: number } | undefined; return row ? { ...row, values: safeJson<CommunicationProfileValues>(row.valuesJson, {}), evidence: safeJson<Record<string, unknown>>(row.evidenceJson, {}) } : undefined; }

  recordCorrection(input: { sessionId: string; runId?: string; attempt?: number; messageId?: number; correctionType?: string; targetType?: string; targetId?: string; content: string; source?: "explicit_user" | "router" | "governance" }) {
    const idempotencyKey = `correction:${input.messageId ?? "manual"}:${input.runId ?? "none"}:${hash(input.content).slice(0, 16)}`;
    this.store.db.prepare(`INSERT OR IGNORE INTO user_corrections
      (id,session_id,run_id,attempt,message_id,correction_type,target_type,target_id,content,source,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.sessionId, input.runId ?? null, input.attempt ?? null, input.messageId ?? null, input.correctionType ?? "instruction_correction", input.targetType ?? "run", input.targetId ?? input.runId ?? "", redact(input.content).slice(0, 12_000), input.source ?? "explicit_user", idempotencyKey, now());
    return this.store.db.prepare("SELECT * FROM user_corrections WHERE idempotency_key=?").get(idempotencyKey);
  }

  drainLearningProjectionLedger(limit = 200) {
    const rows = this.store.db.prepare(`SELECT o.run_id as runId,o.attempt,o.lifecycle,o.outcome,o.event_seq as eventSeq,o.snapshot_json as snapshotJson
      FROM learning_projection_outbox o LEFT JOIN learning_events e
        ON e.run_id=o.run_id AND e.attempt=o.attempt AND e.lifecycle=o.lifecycle AND e.event_seq=o.event_seq
      WHERE e.id IS NULL ORDER BY o.created_at LIMIT ?`).all(limit) as Array<{ runId: string; attempt: number; lifecycle: string; outcome: TaskRun["status"]; eventSeq: number; snapshotJson: string }>;
    for (const row of rows) { const snapshot = safeJson<TaskRun | null>(row.snapshotJson, null); const run = snapshot ?? this.store.getRun(row.runId); if (run) this.projectRun({ ...run, attempt: row.attempt }, row.lifecycle, row.eventSeq, row.outcome); }
    return rows.length;
  }

  projectRun(run: TaskRun, lifecycle = `run.${run.status}`, eventSeq = run.lastEventSeq, projectedStatus: TaskRun["status"] = run.status) {
    const effectiveRun = projectedStatus === run.status ? run : { ...run, status: projectedStatus };
    const manifest = run.supervision.latestContextManifest?.attempt === run.attempt
      ? run.supervision.latestContextManifest
      : this.store.getContextManifestForAttempt(run.id, run.attempt);
    const continuations = run.continuations.length;
    const toolRows = this.store.db.prepare(`SELECT tool_name as toolName,args_hash as argsHash,status FROM tool_attempts WHERE run_id=? AND attempt=? ORDER BY id`).all(run.id, run.attempt) as Array<{ toolName: string; argsHash: string; status: string }>;
    const repeatedToolCalls = toolRows.length - new Set(toolRows.map((item) => `${item.toolName}:${item.argsHash}`)).size;
    const requiredChecks = run.checks.filter((item) => item.required);
    const success = effectiveRun.status === "completed" && requiredChecks.length > 0 && requiredChecks.every((item) => item.status === "passed" && !item.stale);
    const correctionCount = (this.store.db.prepare("SELECT COUNT(*) count FROM user_corrections WHERE run_id=? AND (attempt=? OR attempt IS NULL)").get(run.id, run.attempt) as { count: number }).count;
    const eventBody = {
      taskClassification: { domain: run.contract?.scope || "general", intent: run.contract?.intent ?? "unknown", risk: run.supervision.approvalRequests.length ? "elevated" : "normal", complexity: run.plan.length >= 8 ? "high" : run.plan.length >= 3 ? "medium" : "low" },
      strategySelected: manifest?.items.filter((item) => item.kind === "workflow_revision" || item.kind === "communication_profile").map((item) => ({ kind: item.kind, sourceId: item.sourceId, reason: item.reason, metadata: item.metadata })) ?? [],
      contextUsed: { manifestId: manifest?.id ?? null, manifestHash: manifest?.manifestHash ?? null, selectedMemoryIds: manifest?.items.filter((item) => item.kind === "memory_card" && item.selected).map((item) => item.sourceId) ?? [], selectedTopicIds: manifest?.items.filter((item) => item.kind === "cold_topic" && item.selected).map((item) => item.sourceId) ?? [] },
      executionTrace: { tools: toolRows.map((item) => ({ tool: item.toolName, status: item.status })), repeatedToolCalls, continuations, failures: toolRows.filter((item) => item.status !== "completed").map((item) => item.toolName) },
      outcome: { status: effectiveRun.status, gatePassed: run.completionGate.passed, requiredChecks: requiredChecks.length, requiredChecksPassed: requiredChecks.filter((item) => item.status === "passed" && !item.stale).length, success, correctionCount, durationMs: (run.completedAt ?? run.updatedAt) - run.createdAt, usage: run.usage },
      attribution: { conservative: true, positiveEligible: success && correctionCount === 0, reason: success ? "completed with non-empty fresh required checks" : "positive task attribution withheld" },
      policy: this.store.db.prepare("SELECT policy,reason FROM run_learning_policies WHERE run_id=?").get(run.id) ?? { policy: "allow", reason: "default" },
    };
    const eventHash = hash({ runId: run.id, attempt: run.attempt, lifecycle, eventSeq, eventBody });
    const id = randomUUID();
    this.store.db.prepare(`INSERT OR IGNORE INTO learning_events
      (id,run_id,attempt,lifecycle,event_seq,task_classification_json,strategy_selected_json,context_used_json,execution_trace_json,outcome_json,attribution_json,policy_json,event_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, run.id, run.attempt, lifecycle, eventSeq, JSON.stringify(eventBody.taskClassification), JSON.stringify(eventBody.strategySelected), JSON.stringify(eventBody.contextUsed), JSON.stringify(eventBody.executionTrace), JSON.stringify(eventBody.outcome), JSON.stringify(eventBody.attribution), JSON.stringify(eventBody.policy), eventHash, now());
    const event = this.store.db.prepare("SELECT id FROM learning_events WHERE run_id=? AND attempt=? AND lifecycle=? AND event_seq=?").get(run.id, run.attempt, lifecycle, eventSeq) as { id: string };
    const labels: Array<[string, string, number, unknown[]]> = [
      ["terminal_status", effectiveRun.status, 1, [`run:${run.id}`]], ["task_success", String(success), 1, requiredChecks.map((item) => `check:${item.key}`)],
      ["gate_passed", String(run.completionGate.passed), 1, ["completion_gate"]], ["correction_observed", String(correctionCount > 0), 1, correctionCount ? [`corrections:${correctionCount}`] : []],
      ["cost_band", run.usage.cost > 1 ? "high" : run.usage.cost > .1 ? "medium" : "low", .9, [`cost:${run.usage.cost}`]],
    ];
    for (const [label, value, confidence, evidence] of labels) this.store.db.prepare(`INSERT OR IGNORE INTO outcome_labels
      (id,learning_event_id,run_id,attempt,taxonomy_version,label,value,confidence,evidence_json,idempotency_key,created_at) VALUES (?,?,?,?, 'outcome-v1',?,?,?,?,?,?)`)
      .run(randomUUID(), event.id, run.id, run.attempt, label, value, confidence, JSON.stringify(evidence), `outcome:${event.id}:${label}`, now());
    this.createConservativeFeedbackReceipts(run, manifest?.id ?? "", manifest?.items ?? [], success, correctionCount > 0);
    if (this.semanticJudge) this.store.enqueueSemanticLearningJob("feedback_attribution", { runId: run.id, attempt: run.attempt, manifestId: manifest?.id ?? "", items: manifest?.items ?? [], success, corrected: correctionCount > 0 }, `semantic-feedback:${run.id}:${run.attempt}:${manifest?.id ?? "none"}`, run.id, run.attempt);
    return this.getLearningEvent(event.id);
  }

  private createConservativeFeedbackReceipts(run: TaskRun, manifestId: string, items: ContextManifestItem[], success: boolean, corrected: boolean) {
    const assistant = this.store.listMessages(run.sessionId, 30).filter((item) => item.role === "assistant").at(-1)?.content ?? "";
    const selected = items.filter((item) => item.kind === "memory_card" && item.selected);
    for (const item of selected) {
      const explicitlyCited = assistant.includes(`[memory:${item.sourceId}]`) || assistant.includes(`memory://${item.sourceId}`);
      const correctionTargetsRecord = corrected && this.store.db.prepare(`SELECT 1 FROM user_corrections WHERE run_id=? AND content LIKE ? LIMIT 1`).get(run.id, `%${item.sourceId}%`);
      const signals: Array<{ signal: RecallFeedbackSignal; weight: number; basis: string }> = [];
      if (explicitlyCited) signals.push({ signal: "cited", weight: .15, basis: "explicit_record_citation_in_final_answer" });
      if (explicitlyCited && success && !corrected) signals.push({ signal: "task_success", weight: .2, basis: "cited_record_and_verified_task_success" });
      if (correctionTargetsRecord) signals.push({ signal: "corrected", weight: -.75, basis: "explicit_correction_named_record" });
      for (const entry of signals) {
        const key = `memory-attribution:${run.id}:${run.attempt}:${item.sourceId}:${entry.signal}`;
        this.store.db.prepare(`INSERT OR IGNORE INTO feedback_attribution_receipts
          (id,run_id,attempt,actor_id,record_id,signal,weight,basis,context_manifest_id,evidence_json,status,idempotency_key,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(randomUUID(), run.id, run.attempt, `session:${run.sessionId}`, item.sourceId, entry.signal, entry.weight, entry.basis, manifestId, JSON.stringify([`manifest:${manifestId}`, `run:${run.id}`]), key, now());
      }
    }
  }

  private async createSemanticFeedbackReceipts(run:TaskRun,manifestId:string,items:ContextManifestItem[],success:boolean,corrected:boolean){
    const selected=items.filter((item)=>item.kind==="memory_card"&&item.selected);if(!selected.length)return;
    const assistant=this.store.listMessages(run.sessionId,30).filter((item)=>item.role==="assistant").at(-1)?.content??"";
    const corrections=this.store.db.prepare("SELECT content FROM user_corrections WHERE run_id=? AND (attempt=? OR attempt IS NULL)").all(run.id,run.attempt) as Array<{content:string}>;
    const failuresBefore=this.semanticJudge!.snapshot().failures;
    const decision=await this.semanticJudge!.feedbackAttribution({assistantAnswer:assistant,corrections:corrections.map((item)=>item.content),records:selected.map((item)=>({id:item.sourceId,reason:item.reason,metadata:item.metadata}))});
    if(!decision&&this.semanticJudge!.snapshot().failures>failuresBefore)throw new Error("Semantic feedback attribution failed");
    if(!decision)return;
    const selectedIds=new Set(selected.map((item)=>item.sourceId));
    for(const recordId of decision.usedRecordIds.filter((id)=>selectedIds.has(id))){for(const entry of [{signal:"cited" as const,weight:.1,basis:"semantic_answer_attribution"},...(success&&!corrected?[{signal:"task_success" as const,weight:.15,basis:"semantic_use_and_verified_task_success"}]:[])]){const key=`memory-attribution:${run.id}:${run.attempt}:${recordId}:${entry.signal}`;this.store.db.prepare(`INSERT OR IGNORE INTO feedback_attribution_receipts (id,run_id,attempt,actor_id,record_id,signal,weight,basis,context_manifest_id,evidence_json,status,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(randomUUID(),run.id,run.attempt,`session:${run.sessionId}`,recordId,entry.signal,entry.weight,entry.basis,manifestId,JSON.stringify([`manifest:${manifestId}`,`semantic-confidence:${decision.confidence}`]),key,now());}}
    if(corrected)for(const recordId of decision.harmfulRecordIds.filter((id)=>selectedIds.has(id))){const key=`memory-attribution:${run.id}:${run.attempt}:${recordId}:corrected`;this.store.db.prepare(`INSERT OR IGNORE INTO feedback_attribution_receipts (id,run_id,attempt,actor_id,record_id,signal,weight,basis,context_manifest_id,evidence_json,status,idempotency_key,created_at) VALUES (?,?,?,?,?,'corrected',-.75,'semantic_correction_attribution',?,?,'pending',?,?)`).run(randomUUID(),run.id,run.attempt,`session:${run.sessionId}`,recordId,manifestId,JSON.stringify([`manifest:${manifestId}`,`semantic-confidence:${decision.confidence}`]),key,now());}
  }

  enqueueUserMessageAnalysis(input:{subjectId:string;scopeId:string;messageId:number;content:string;context?:string;runId?:string;attempt?:number}) {
    return this.store.enqueueSemanticLearningJob("user_message", input, `semantic-user-message:${input.scopeId}:${input.messageId}`, input.runId, input.attempt);
  }

  async drainSemanticLearningJobs(limit = 100) {
    if (!this.semanticJudge) return 0;
    const rows = this.store.listDueSemanticLearningJobs(limit).filter((row)=>row.kind==="user_message"||row.kind==="feedback_attribution");
    for (const row of rows) {
      try {
        const payload = safeJson<Record<string, unknown>>(row.payloadJson, {});
        if (row.kind === "user_message") await this.analyzeUserMessage(payload as Parameters<LearningService["analyzeUserMessage"]>[0]);
        else if (row.kind === "feedback_attribution") await this.createSemanticFeedbackReceipts(
          this.store.getRun(String(payload.runId)) ?? (()=>{throw new Error("Semantic feedback Run not found")})(),
          String(payload.manifestId ?? ""),
          (payload.items ?? []) as ContextManifestItem[],
          Boolean(payload.success),
          Boolean(payload.corrected),
        );
        else throw new Error(`Unsupported semantic learning job: ${row.kind}`);
        this.store.completeSemanticLearningJob(row.id);
      } catch (error) { this.store.failSemanticLearningJob(row.id, row.attempts, redact(error instanceof Error ? error.message : String(error))); }
    }
    return rows.length;
  }

  async drainFeedbackAttribution(limit = 100) {
    if (!this.memory?.feedback) return 0;
    const timestamp = now();
    const rows = this.store.db.prepare(`SELECT id,run_id as runId,actor_id as actorId,record_id as recordId,signal,basis,attempts FROM feedback_attribution_receipts WHERE status IN ('pending','failed') AND next_retry_at<=? ORDER BY created_at LIMIT ?`).all(timestamp, limit) as Array<{ id: string; runId: string; actorId: string; recordId: string; signal: RecallFeedbackSignal; basis: string; attempts: number }>;
    for (const row of rows) {
      const run = this.store.getRun(row.runId); if (!run) continue;
      const scope: MemoryScope = { type: "workspace", id: this.memoryScopeId };
      try {
        await this.memory.feedback({ subjectId: row.actorId, scopes: [scope, { type: "session", id: run.sessionId }], purpose: "memory_admin" }, scope, row.recordId, row.signal, { runId: row.runId, note: row.basis });
        this.store.db.prepare("UPDATE feedback_attribution_receipts SET status='applied',applied_at=?,error='',next_retry_at=0 WHERE id=? AND status IN ('pending','failed')").run(now(), row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        const status = attempts >= 5 ? "dead_letter" : "failed";
        const retryAt = status === "dead_letter" ? 0 : now() + Math.min(60 * 60_000, 2 ** attempts * 5_000);
        this.store.db.prepare("UPDATE feedback_attribution_receipts SET status=?,attempts=?,next_retry_at=?,error=? WHERE id=? AND status IN ('pending','failed')").run(status, attempts, retryAt, redact(error instanceof Error ? error.message : String(error)), row.id);
      }
    }
    return rows.length;
  }

  getLearningEvent(id: string) { const row = this.store.db.prepare(`SELECT id,run_id as runId,attempt,lifecycle,event_seq as eventSeq,task_classification_json as taskClassificationJson,strategy_selected_json as strategySelectedJson,context_used_json as contextUsedJson,execution_trace_json as executionTraceJson,outcome_json as outcomeJson,attribution_json as attributionJson,policy_json as policyJson,created_at as createdAt FROM learning_events WHERE id=?`).get(id) as Record<string, unknown> | undefined; if (!row) return undefined; return { ...row, taskClassification: safeJson(String(row.taskClassificationJson), {}), strategySelected: safeJson(String(row.strategySelectedJson), []), contextUsed: safeJson(String(row.contextUsedJson), {}), executionTrace: safeJson(String(row.executionTraceJson), {}), outcome: safeJson(String(row.outcomeJson), {}), attribution: safeJson(String(row.attributionJson), {}), policy: safeJson(String(row.policyJson), {}) }; }
  listLearningEvents(sessionId: string, limit = 100) { return (this.store.db.prepare(`SELECT e.id FROM learning_events e JOIN runs r ON r.id=e.run_id WHERE r.session_id=? ORDER BY e.created_at DESC LIMIT ?`).all(sessionId, limit) as Array<{ id: string }>).map((row) => this.getLearningEvent(row.id)!); }
  listCorrections(sessionId: string, limit = 100) { return this.store.db.prepare(`SELECT id,session_id as sessionId,run_id as runId,attempt,message_id as messageId,correction_type as correctionType,target_type as targetType,target_id as targetId,content,source,applied,created_at as createdAt FROM user_corrections WHERE session_id=? ORDER BY created_at DESC LIMIT ?`).all(sessionId, limit); }
  listFeedbackAttribution(sessionId: string, limit = 100) { return this.store.db.prepare(`SELECT f.id,f.run_id as runId,f.attempt,f.record_id as recordId,f.signal,f.weight,f.basis,f.context_manifest_id as contextManifestId,f.status,f.attempts,f.next_retry_at as nextRetryAt,f.error,f.created_at as createdAt,f.applied_at as appliedAt FROM feedback_attribution_receipts f JOIN runs r ON r.id=f.run_id WHERE r.session_id=? ORDER BY f.created_at DESC LIMIT ?`).all(sessionId, limit); }
}
