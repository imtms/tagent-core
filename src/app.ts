import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { requiredServiceScope, secureEqual, type ServiceCredential } from "./auth.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { artifactFilename, isMarkdownArtifact, isTextArtifact, loadArtifactDownload, loadArtifactSource } from "./artifact-content.js";
import type { PublicRuntimeConfig } from "./config.js";
import type { Store } from "./store/store.js";
import type { AgentService } from "./core/agent-service.js";
import type { MemoryFacade } from "./memory/memory-service.js";
import type { AccessContext, MemoryScope } from "./memory/types.js";
import type { LearningFeatureControl } from "./learning/feature-control.js";

export interface AppDependencies {
  store: Store;
  service: AgentService;
  webRoot?: string;
  workspaceRoot?: string;
  logger?: boolean;
  runtimeConfig?: PublicRuntimeConfig;
  serviceCredentials?: ServiceCredential[];
  memory?: MemoryFacade;
  closeResources?: () => Promise<void>;
  distillationWorker?: { snapshot: () => Record<string, unknown> };
  learningControl?: LearningFeatureControl;
}

export function createApp({ store, service, webRoot = path.resolve("dist/web"), workspaceRoot = process.cwd(), logger = true, runtimeConfig, serviceCredentials = [], memory, closeResources, distillationWorker, learningControl }: AppDependencies) {
  const app = Fastify({ logger });

  if (serviceCredentials.length) app.addHook("onRequest", async (request, reply) => {
    const requiredScope = requiredServiceScope(request.method, request.url);
    if (requiredScope === null) return;
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      const credential = serviceCredentials.find((candidate) => secureEqual(token, candidate.token));
      if (credential && requiredScope !== "admin" && credential.scopes.includes(requiredScope)) return;
      if (credential) return reply.code(403).send({ error: "insufficient service credential scope", requiredScope });
    }
    return reply.code(401).send({ error: "authentication required" });
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (pathname === "/api/learning/settings" || !isLearningRoute(pathname)) return;
    if (!learningControl) return;
    try { learningControl.requireLearning(); }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error), code: "learning_disabled" }); }
  });

  app.post("/api/memory/capture", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope; content?: string; idempotencyKey?: string };
    if (!body.scope || !body.content?.trim()) return reply.code(400).send({ error: "scope and content are required" });
    const idempotencyKey = body.idempotencyKey ?? `manual:${Date.now()}`;
    return memory.enqueueCapture({ access: memoryAccess(request, [body.scope], "capture"), sourceRefs: [{ sourceType: "manual", sourceId: idempotencyKey }], content: body.content.trim(), idempotencyKey, captureSource: { kind: "manual_input", role: "user", explicitIntent: true } });
  });
  app.post("/api/memory/jobs", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scopes?: MemoryScope[]; limit?: number };
    if (!body.scopes?.length) return reply.code(400).send({ error: "scopes are required" });
    return memory.listCaptureJobs?.(memoryAccess(request, body.scopes, "memory_admin"), Math.min(500, Math.max(1, body.limit ?? 100))) ?? [];
  });
  app.post("/api/memory/status", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scopes?: MemoryScope[] };
    if (!body.scopes?.length) return reply.code(400).send({ error: "scopes are required" });
    return memory.status(memoryAccess(request, body.scopes, "memory_admin"));
  });
  app.post("/api/memory/recall", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { cue?: string; scopes?: MemoryScope[]; kinds?: Array<"fact" | "preference" | "episode" | "procedure">; maxCards?: number; maxColdTopics?: number };
    if (!body.cue?.trim() || !body.scopes?.length) return reply.code(400).send({ error: "cue and scopes are required" });
    return memory.recall({ access: memoryAccess(request, body.scopes, "agent_recall"), cue: body.cue.trim(), kinds: body.kinds, maxCards: body.maxCards, maxColdTopics: body.maxColdTopics });
  });
  app.get("/api/memory/topics/:topicId", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const { topicId } = request.params as { topicId: string };
    const query = request.query as { scopeType?: MemoryScope["type"]; scopeId?: string };
    if (!query.scopeType || !query.scopeId) return reply.code(400).send({ error: "scopeType and scopeId are required" });
    const topic = await memory.getColdTopic(memoryAccess(request, [{ type: query.scopeType, id: query.scopeId }], "memory_admin"), topicId);
    return topic ?? reply.code(404).send({ error: "topic not found" });
  });
  app.post("/api/memory/records", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scopes?: MemoryScope[]; records?: import("./memory/types.js").WarmMemory[]; topics?: import("./memory/types.js").TopicDescriptor[] };
    if (!body.scopes?.length || !body.records?.length) return reply.code(400).send({ error: "scopes and records are required" });
    return memory.upsert(memoryAccess(request, body.scopes, "memory_admin"), body.records, body.topics);
  });
  app.post("/api/memory/export", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope };
    if (!body.scope) return reply.code(400).send({ error: "scope is required" });
    return memory.export(memoryAccess(request, [body.scope], "memory_admin"), body.scope);
  });
  app.post("/api/memory/forget", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope; ids?: string[]; topicIds?: string[]; reason?: string; gracePeriodMs?: number };
    if (!body.scope) return reply.code(400).send({ error: "scope is required" });
    return memory.forget({ access: memoryAccess(request, [body.scope], "memory_admin"), scope: body.scope, ids: body.ids, topicIds: body.topicIds, reason: body.reason, gracePeriodMs: body.gracePeriodMs });
  });

  app.post("/api/memory/restore", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope; ids?: string[]; topicIds?: string[] };
    if (!body.scope || (!body.ids?.length&&!body.topicIds?.length)) return reply.code(400).send({ error: "scope and ids or topicIds are required" });
    return memory.restore({ access: memoryAccess(request, [body.scope], "memory_admin"), scope: body.scope, ids: body.ids, topicIds: body.topicIds });
  });


  app.post("/api/memory/reindex", async (request, reply) => { if(!memory?.enqueueReindex)return reply.code(503).send({error:"durable reindex unavailable"});const body=request.body as {scope?:MemoryScope};if(!body.scope)return reply.code(400).send({error:"scope is required"});return memory.enqueueReindex(memoryAccess(request,[body.scope],"memory_admin")); });
  app.post("/api/memory/reindex/jobs", async (request, reply) => { if(!memory?.listReindexJobs)return reply.code(503).send({error:"durable reindex unavailable"});const body=request.body as {scopes?:MemoryScope[];limit?:number};if(!body.scopes?.length)return reply.code(400).send({error:"scopes are required"});return memory.listReindexJobs(memoryAccess(request,body.scopes,"memory_admin"),body.limit); });
  app.post("/api/memory/govern", async (request, reply) => { if(!memory?.govern)return reply.code(503).send({error:"memory governance unavailable"});const body=request.body as {scope?:MemoryScope;id?:string;action?:import("./memory/types.js").MemoryGovernanceAction;content?:string;title?:string;reason?:string;resolution?:"accept"|"reject"};if(!body.scope||!body.id||!body.action)return reply.code(400).send({error:"scope, id and action are required"});return memory.govern({access:memoryAccess(request,[body.scope],"memory_admin"),scope:body.scope,id:body.id,action:body.action,content:body.content,title:body.title,reason:body.reason,resolution:body.resolution}); });
  app.post("/api/memory/feedback", async (request, reply) => { if(!memory?.feedback)return reply.code(503).send({error:"memory feedback unavailable"});const body=request.body as {scope?:MemoryScope;recordId?:string;signal?:import("./memory/types.js").RecallFeedbackSignal;runId?:string;note?:string};if(!body.scope||!body.recordId||!body.signal)return reply.code(400).send({error:"scope, recordId and signal are required"});return memory.feedback(memoryAccess(request,[body.scope],"memory_admin"),body.scope,body.recordId,body.signal,{runId:body.runId,note:body.note}); });
  app.post("/api/memory/core-snapshot", async (request, reply) => { if(!memory?.getCoreSnapshot)return reply.code(503).send({error:"core snapshot unavailable"});const body=request.body as {scope?:MemoryScope;generate?:boolean;markdown?:string};if(!body.scope)return reply.code(400).send({error:"scope is required"});const access=memoryAccess(request,[body.scope],"memory_admin");if(typeof body.markdown==="string")return memory.updateCoreSnapshot!(access,body.markdown);if(body.generate)return memory.generateCoreSnapshot!(access);return memory.getCoreSnapshot(access); });
  app.post("/api/sessions/:id/workflows/teach", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { spec?: import("./learning/workflow-service.js").WorkflowSpec; sourceId?: string; activate?: boolean };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    if (!body.spec) return reply.code(400).send({ error: "spec is required" });
    try { return service.teachWorkflow(id, body.spec, body.sourceId); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/sessions/:id/workflows", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return service.listWorkflows(id);
  });
  app.post("/api/workflows/:id/activate", async (request, reply) => { const { id } = request.params as { id: string }; const body = (request.body ?? {}) as { revisionId?: string; approvalId?: string }; if(!body.approvalId)return reply.code(409).send({error:"Human approval is required; create and approve an activation request first"});try { return service.activateWorkflow(id, body.revisionId, body.approvalId); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/workflows/:id/activation-request", async (request, reply) => { const { id } = request.params as { id: string }; const body=(request.body??{}) as {revisionId?:string;actor?:string;reason?:string};try{return service.requestWorkflowActivation(id,body.revisionId,body.actor??"learning_center",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});} });
  app.post("/api/workflows/:id/suspend", async (request, reply) => { const { id } = request.params as { id: string }; const body = (request.body ?? {}) as { reason?: string }; try { return service.suspendWorkflow(id, body.reason); } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/workflows/:id/rollback", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { revisionId?: string }; if (!body.revisionId) return reply.code(400).send({ error: "revisionId is required" }); try { return service.rollbackWorkflow(id, body.revisionId); } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.delete("/api/workflows/:id", async (request, reply) => { const { id } = request.params as { id: string }; const body = (request.body ?? {}) as { reason?: string; gracePeriodMs?: number }; return service.forgetWorkflow(id, body.reason, body.gracePeriodMs) ? { ok: true } : reply.code(404).send({ error: "workflow not found" }); });
  app.post("/api/workflows/:id/restore", async (request, reply) => { const { id } = request.params as { id: string }; try { return service.restoreWorkflow(id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/api/sessions/:id/learning-center", async (request, reply) => { const { id } = request.params as { id: string }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); return service.getLearningCenter(id); });
  app.post("/api/workflow-bindings/:id/mode", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { mode?: "suggested" | "adopted" | "partially_adopted" | "rejected" }; if (!body.mode) return reply.code(400).send({ error: "mode is required" }); try { return service.setWorkflowBindingMode(id, body.mode); } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/workflow-bindings/:id/application", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as Omit<Parameters<AgentService["recordWorkflowApplication"]>[0], "bindingId">; if (!body.status) return reply.code(400).send({ error: "status is required" }); try { return service.recordWorkflowApplication({ bindingId: id, ...body }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/workflow-proposals/:id/approve", async (request, reply) => { const { id } = request.params as { id: string }; const body=(request.body??{}) as {actor?:string;reason?:string}; try{return service.decideWorkflowProposal(id,"approved",body.actor??"governor",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});} });
  app.post("/api/workflow-proposals/:id/reject", async (request, reply) => { const { id } = request.params as { id: string }; const body=(request.body??{}) as {actor?:string;reason?:string}; try{return service.decideWorkflowProposal(id,"rejected",body.actor??"governor",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});} });
  app.post("/api/workflow-proposals/:id/application-request", async (request,reply)=>{const{id}=request.params as{id:string};const body=(request.body??{}) as{actor?:string;reason?:string};try{return service.requestWorkflowProposalApplication(id,body.actor??"learning_center",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/workflow-proposals/:id/apply", async (request, reply) => { const { id } = request.params as { id: string }; const body=(request.body??{}) as {actor?:string;approvalId?:string};if(!body.approvalId)return reply.code(409).send({error:"Human approval is required before applying a revision proposal"});try{return service.applyWorkflowProposal(id,body.actor??"governor",body.approvalId);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});} });
  app.post("/api/workflow-distillation/run", async (request) => { const body=(request.body??{}) as {owner?:string}; return service.runWorkflowDistiller(body.owner); });
  app.get("/api/workflow-distillation/dead-letter", async (request) => service.listDeadLetterDistillations(Number((request.query as {limit?:string}).limit??100)));
  app.post("/api/workflow-distillation/:id/retry", async (request,reply)=>{const{id}=request.params as{id:string};const body=(request.body??{}) as{taskSignature?:string};try{return service.retryWorkflowDistillation(id,body);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/workflows/:id/evaluations", async (_request,reply)=>reply.code(410).send({error:"Evaluation statistics cannot be submitted by governance callers; use the trusted evaluator endpoint"}));
  app.post("/api/internal/workflows/:id/evaluate",async(request,reply)=>{const{id}=request.params as{id:string};const body=request.body as{candidateRevisionId?:string;baselineRevisionId?:string;kind?:"shadow"|"offline_replay";datasetId?:string;baselineRunIds?:string[];candidateRunIds?:string[]};if(!body.candidateRevisionId||!body.baselineRevisionId||!body.kind||!body.datasetId)return reply.code(400).send({error:"candidateRevisionId, baselineRevisionId, kind and datasetId are required"});try{return service.executeWorkflowEvaluation({workflowId:id,candidateRevisionId:body.candidateRevisionId,baselineRevisionId:body.baselineRevisionId,kind:body.kind,datasetId:body.datasetId,baselineRunIds:body.baselineRunIds??[],candidateRunIds:body.candidateRunIds??[]});}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.get("/api/workflow-evaluations/:id/verify",async(request)=>service.verifyWorkflowEvaluation((request.params as{id:string}).id));
  app.post("/api/workflows/:id/promotion-request",async(request,reply)=>{const{id}=request.params as{id:string};const body=request.body as{revisionId?:string;canaryPercent?:number;maxFailureDelta?:number;actor?:string};if(!body.revisionId)return reply.code(400).send({error:"revisionId is required"});try{return service.requestWorkflowPromotion(id,body.revisionId,body.canaryPercent,body.maxFailureDelta,body.actor??"learning_center");}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/workflows/:id/promote",async(request,reply)=>{const{id}=request.params as{id:string};const body=request.body as{revisionId?:string;canaryPercent?:number;maxFailureDelta?:number;approvalId?:string};if(!body.revisionId)return reply.code(400).send({error:"revisionId is required"});if(!body.approvalId)return reply.code(409).send({error:"Human approval is required before starting canary"});try{return service.promoteWorkflow(id,body.revisionId,body.canaryPercent,body.maxFailureDelta,body.approvalId);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.get("/api/sessions/:id/autonomy-approvals",async(request,reply)=>{const{id}=request.params as{id:string};if(!store.getSession(id))return reply.code(404).send({error:"session not found"});return service.listAutonomyApprovals(id,Number((request.query as{limit?:string}).limit??200));});
  app.post("/api/autonomy-approvals/:id/approve",async(request,reply)=>{const{id}=request.params as{id:string};const body=(request.body??{}) as{actor?:string;reason?:string};try{return service.decideAutonomyApproval(id,"approved",body.actor??"human_governor",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/autonomy-approvals/:id/reject",async(request,reply)=>{const{id}=request.params as{id:string};const body=(request.body??{}) as{actor?:string;reason?:string};try{return service.decideAutonomyApproval(id,"rejected",body.actor??"human_governor",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/autonomy-approvals/:id/revoke",async(request,reply)=>{const{id}=request.params as{id:string};const body=(request.body??{}) as{actor?:string;reason?:string};try{return service.revokeAutonomyApproval(id,body.actor??"human_governor",body.reason);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/autonomy-approvals/:id/execute",async(request,reply)=>{const{id}=request.params as{id:string};const body=(request.body??{}) as{actor?:string};try{return service.executeAutonomyApproval(id,body.actor??"human_governor");}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}});
  app.post("/api/workflows/:id/revise", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { patch?: Partial<import("./learning/workflow-service.js").WorkflowSpec>; sourceId?: string; changeSummary?: string }; if (!body.patch || !body.sourceId) return reply.code(400).send({ error: "patch and sourceId are required" }); try { return service.reviseWorkflow(id, body.patch, body.sourceId, body.changeSummary ?? "User correction"); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/workflows/:id/feedback", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { revisionId?: string; runId?: string; attempt?: number; signal?: import("./learning/workflow-service.js").WorkflowFeedbackSignal; idempotencyKey?: string; note?: string; adopted?: boolean; verified?: boolean }; if (!body.revisionId || !body.runId || !body.attempt || !body.signal || !body.idempotencyKey) return reply.code(400).send({ error: "revisionId, runId, attempt, signal and idempotencyKey are required" }); try { return service.recordWorkflowFeedback({ workflowId: id, revisionId: body.revisionId, runId: body.runId, attempt: body.attempt, signal: body.signal, idempotencyKey: body.idempotencyKey, note: body.note, adopted: body.adopted, verified: body.verified }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/runs/:id/learning-policy", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { policy?: "allow" | "metadata_only" | "deny"; reason?: string }; if (!store.getRun(id)) return reply.code(404).send({ error: "run not found" }); if (!body.policy) return reply.code(400).send({ error: "policy is required" }); return service.setRunLearningPolicy(id, body.policy, body.reason); });
  app.get("/api/sessions/:id/communication-profiles", async (request, reply) => { const { id } = request.params as { id: string }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); return service.listCommunicationProfiles(`session:${id}`); });
  app.post("/api/sessions/:id/communication-preferences", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { dimension?: import("./learning/learning-service.js").CommunicationDimension; value?: string | string[]; scopeType?: import("./learning/learning-service.js").CommunicationApplicability; scopeId?: string; sourceType?: "explicit_user" | "inferred" | "governance"; sourceRef?: string; confidence?: number; expiresAt?: number }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); if (!body.dimension || body.value == null) return reply.code(400).send({ error: "dimension and value are required" }); return service.setCommunicationPreference({ subjectId: `session:${id}`, scopeType: body.scopeType ?? "session", scopeId: body.scopeId ?? id, dimension: body.dimension, value: body.value, sourceType: body.sourceType ?? "explicit_user", sourceRef: body.sourceRef ?? `api:${Date.now()}`, confidence: body.confidence, expiresAt: body.expiresAt }); });
  app.post("/api/communication-profiles/:id/lock", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { locked?: boolean }; if (typeof body.locked !== "boolean") return reply.code(400).send({ error: "locked is required" }); return service.lockCommunicationProfile(id, body.locked) ?? reply.code(404).send({ error: "profile not found" }); });
  app.get("/api/sessions/:id/learning-events", async (request, reply) => { const { id } = request.params as { id: string }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); return service.listLearningEvents(id, Number((request.query as { limit?: string }).limit ?? 100)); });
  app.get("/api/sessions/:id/corrections", async (request, reply) => { const { id } = request.params as { id: string }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); return service.listCorrections(id, Number((request.query as { limit?: string }).limit ?? 100)); });
  app.post("/api/sessions/:id/corrections", async (request, reply) => { const { id } = request.params as { id: string }; const body = request.body as { runId?: string; attempt?: number; messageId?: number; correctionType?: string; targetType?: string; targetId?: string; content?: string }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); if (!body.content?.trim()) return reply.code(400).send({ error: "content is required" }); return service.recordCorrection({ sessionId: id, runId: body.runId, attempt: body.attempt, messageId: body.messageId, correctionType: body.correctionType, targetType: body.targetType, targetId: body.targetId, content: body.content }); });
  app.get("/api/sessions/:id/feedback-attribution", async (request, reply) => { const { id } = request.params as { id: string }; if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" }); return service.listFeedbackAttribution(id, Number((request.query as { limit?: string }).limit ?? 100)); });
  app.post("/api/feedback-attribution/drain", async (request) => service.drainFeedbackAttribution(Number(((request.body ?? {}) as { limit?: number }).limit ?? 100)));

  app.get("/api/health", async (_request, reply) => {
    const featureState=learningControl?.snapshot();
    const distillation=distillationWorker?.snapshot()??{running:false,ready:false};
    if(!memory){if(!learningControl&&!distillationWorker)return {ok:true,service:"tagent-core"};return {ok:true,service:"tagent-core",learning:featureState??{memoryEnabled:false,learningEnabled:false,autoExecutionEnabled:false},distillation};}
    const scopeId=runtimeConfig?.memoryWorkspaceScopeId; if(!scopeId)return {ok:false,service:"tagent-core",memory:{enabled:true,ready:false,degraded:true,reasons:["memory_scope_unavailable"]},distillation};
    const readiness=await memory.readiness({subjectId:"health",scopes:[{type:"workspace",id:scopeId}],purpose:"memory_admin"});
    const workerRequired=Boolean(featureState?.learningEnabled);const ok=readiness.ready&&(!workerRequired||Boolean(distillation.ready));if(!ok)reply.code(503); return {ok,service:"tagent-core",memory:{enabled:true,...readiness},learning:featureState,distillation};
  });
  app.get("/api/config/status", async () => runtimeConfig ? { ...runtimeConfig, ...(learningControl?.snapshot() ?? {}) } : null);
  app.get("/api/learning/settings", async () => learningControl?.snapshot() ?? { memoryAvailable: Boolean(memory), memoryEnabled: Boolean(memory), learningEnabled: false, autoExecutionEnabled: false, passiveLearningEnabled: false, activeExecutionRequiresApproval: true, updatedAt: 0, reason: "learning_control_unavailable" });
  app.patch("/api/learning/settings", async (request, reply) => {
    if (!learningControl) return reply.code(503).send({ error: "learning feature control unavailable" });
    const body = (request.body ?? {}) as { memoryEnabled?: boolean; learningEnabled?: boolean; autoExecutionEnabled?: boolean; reason?: string };
    try { return await learningControl.update({ memoryEnabled: body.memoryEnabled, learningEnabled: body.learningEnabled, autoExecutionEnabled: body.autoExecutionEnabled, reason: body.reason ?? "web_ui" }); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/sessions", async () => store.listSessions());
  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; requestId?: string };
    if (body.requestId != null && (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 300)) return reply.code(400).send({ error: "invalid requestId" });
    return store.createSession(body.title?.trim() || "New workspace", body.requestId?.trim());
  });
  app.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title is required" });
    const session = store.renameSession(id, body.title);
    return session ?? reply.code(404).send({ error: "session not found" });
  });
  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const query = request.query as { limit?: string; beforeId?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 80)));
    const beforeId = query.beforeId == null ? undefined : Number(query.beforeId);
    if (beforeId != null && (!Number.isFinite(beforeId) || beforeId <= 0)) return reply.code(400).send({ error: "beforeId must be a positive message id" });
    return store.listMessages(id, limit, beforeId);
  });
  app.get("/api/sessions/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const limit = Math.min(200, Math.max(1, Number((request.query as { limit?: string }).limit ?? 50)));
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return store.listRuns(id, limit).map((run) => run);
  });
  app.get("/api/sessions/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    const run = store.getLatestRun(id);
    return run ?? null;
  });
  app.get("/api/sessions/:id/submissions/:requestId", async (request, reply) => {
    const { id, requestId } = request.params as { id: string; requestId: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const item = store.getSessionSubmission(id, requestId);
    if (!item) return reply.code(404).send({ error: "submission not found" });
    return { requestId: item.requestId, sessionId: item.sessionId, inboxItemId: item.id, status: item.status, runId: item.runId, error: item.error, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    const content = body.content.trim();
    if (isOpaqueAutomationMarker(content)) return reply.code(422).send({ error: "opaque automation marker is not an executable task", reason: "non_actionable_prompt" });
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const result = await service.enqueueSessionInput(id, content, body.requestId);
    return { ...result, receipt: { requestId: result.item.requestId, sessionId: result.item.sessionId, inboxItemId: result.item.id, status: result.item.status, runId: result.item.runId, error: result.item.error, createdAt: result.item.createdAt, updatedAt: result.item.updatedAt } };
  });
  app.get("/api/sessions/:id/inbox", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return store.listSessionInbox(id);
  });
  app.put("/api/sessions/:id/inbox/order", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { itemIds?: string[] };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    if (!Array.isArray(body?.itemIds) || body.itemIds.some((itemId) => typeof itemId !== "string" || !itemId)) return reply.code(400).send({ error: "itemIds must be an array of ids" });
    const items = service.reorderSessionInputs(id, body.itemIds);
    if (!items) return reply.code(409).send({ error: "queued prompts changed; refresh and try again" });
    return items;
  });
  app.patch("/api/sessions/:id/inbox/:itemId", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as { content?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const item = await service.updateSessionInput(id, itemId, body.content);
    if (!item) return reply.code(409).send({ error: "inbox item is not queued" });
    return item;
  });
  app.post("/api/sessions/:id/inbox/:itemId/start", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const result = service.startSessionInputNow(id, itemId);
    if (result.status === "started") return result;
    if (result.status === "running") return reply.code(409).send({ error: "session already has a running TaskRun", reason: "running_taskrun", runId: result.runId });
    if (result.status === "continuation") return reply.code(409).send({ error: "a blocked TaskRun has a queued or running continuation", reason: "active_continuation", continuationId: result.continuationId });
    if (result.status === "closing") return reply.code(409).send({ error: "service is shutting down", reason: "service_closing" });
    if (result.status === "failed") return reply.code(500).send({ error: "inbox TaskRun failed to start", reason: "launch_failed" });
    return reply.code(409).send({ error: "inbox item is not queued", reason: "not_queued" });
  });
  app.post("/api/sessions/:id/inbox/:itemId/decision", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as { decision?: "pending" | "defer" };
    if (!body?.decision || !["pending","defer"].includes(body.decision)) return reply.code(400).send({ error: "invalid decision" });
    if (!service.decideSessionInput(id,itemId,body.decision)) return reply.code(409).send({ error: "inbox item is not queued" });
    return { ok: true };
  });
  app.post("/api/sessions/:id/inbox/:itemId/merge", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as { targetId?: string };
    if (!body?.targetId) return reply.code(400).send({ error: "targetId is required" });
    if (!service.mergeSessionInputs(id,itemId,body.targetId)) return reply.code(409).send({ error: "items are not mergeable" });
    return { ok: true };
  });
  app.delete("/api/sessions/:id/inbox/:itemId", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    if (!service.deleteSessionInput(id, itemId)) return reply.code(409).send({ error: "inbox item is not queued" });
    return { ok: true };
  });
  app.post("/api/runs/:id/retry-launch", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const result = service.retryInboxLaunch(id);
    if (result.status === "started") return result;
    if (result.status === "running") return reply.code(409).send({ error: "session already has a running TaskRun", reason: "running_taskrun", runId: result.runId });
    if (result.status === "continuation") return reply.code(409).send({ error: "a blocked TaskRun has a queued or running continuation", reason: "active_continuation", continuationId: result.continuationId });
    if (result.status === "closing") return reply.code(409).send({ error: "service is shutting down", reason: "service_closing" });
    if (result.status === "failed") return reply.code(500).send({ error: "inbox TaskRun failed to initialize", reason: "launch_failed" });
    return reply.code(409).send({ error: "run does not have a retryable launch failure", reason: "not_retryable" });
  });
  app.post("/api/runs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.cancel(id)) return reply.code(409).send({ error: "run is not active" });
    return { ok: true };
  });
  app.post("/api/runs/:id/steer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    const result = await service.steer(id, body.content.trim(), body.requestId);
    const status = result.status;
    if (status !== "accepted") return reply.code(status === "full" ? 429 : 409).send({ error: status === "inactive" ? "run is not active" : status === "closing" ? "service is closing" : "control inbox is full", status });
    return { ok: true, ...result };
  });
  app.post("/api/runs/:id/follow-up", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    const result = await service.followUp(id, body.content.trim(), body.requestId);
    const status = result.status;
    if (status !== "accepted") return reply.code(status === "full" ? 429 : 409).send({ error: status === "inactive" ? "run is not active" : status === "closing" ? "service is closing" : "control inbox is full", status });
    return { ok: true, ...result };
  });
  app.post("/api/runs/:id/compact", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { instructions?: string };
    const status = await service.compact(id, body.instructions?.trim() || undefined);
    if (status !== "completed") return reply.code(409).send({ error: status === "inactive" ? "run is not active" : "compaction failed", status });
    return { ok: true, status };
  });
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return await service.resume(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/user-input-requests/:id/submit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { response?: Record<string, unknown> };
    if (!body.response || typeof body.response !== "object" || Array.isArray(body.response)) return reply.code(400).send({ error: "response is required" });
    try { return await service.submitUserInput(id, Object.fromEntries(Object.entries(body.response).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]))); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/runs/:id/supervision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = service.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return { ...run.supervision, decisions: store.listSupervisorDecisions(id), edges: store.listTaskRunEdges(id) };
  });
  app.get("/api/runs/:id/context-manifests", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const query = request.query as { limit?: string };
    return store.listContextManifests(id, Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20)));
  });
  app.post("/api/approval-requests/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { resolution?: string };
    try { return await service.approveRunApproval(id, body.resolution?.trim() || undefined); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/approval-requests/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { resolution?: string };
    try { return service.rejectRunApproval(id, body.resolution?.trim() || undefined); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/runs/:id/spawn-proposals", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { goal?: string; acceptanceCriteria?: string[]; relation?: "depends_on" | "follow_up" | "parallel" | "derived" };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    if (!body?.goal?.trim()) return reply.code(400).send({ error: "goal is required" });
    return store.createSpawnProposal(id, body.goal.trim(), body.acceptanceCriteria ?? [], body.relation ?? "follow_up");
  });
  app.post("/api/spawn-proposals/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.approveSpawnProposal(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/spawn-proposals/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.rejectSpawnProposal(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/spawn-proposals/:id/spawn", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.spawnProposal(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/runs/:id/control-inbox", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listControlInbox(id);
  });
  app.get("/api/runs/:id/operations", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listOperations(id);
  });
  app.get("/api/runs/:id/transcript", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listTranscriptEntries(id);
  });
  app.get("/api/runs/:id/transcript-view", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listTranscriptView(id);
  });
  app.get("/api/runs/:id/artifacts/:artifactId/content", async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const artifact = store.getArtifact(id, artifactId);
    if (!artifact) return reply.code(404).send({ error: "artifact not found" });
    try {
      const source = await loadArtifactSource(artifact.content, artifact.uri, workspaceRoot);
      if (!isTextArtifact(artifact.kind, artifact.title, artifact.uri, source.content)) return reply.code(415).send({ error: "artifact is not a supported text file" });
      return { id: artifact.id, title: artifact.title, kind: artifact.kind, uri: artifact.uri, content: source.content, format: isMarkdownArtifact(artifact.kind, artifact.title, artifact.uri) ? "markdown" : "text", bytes: Buffer.byteLength(source.content), source: source.source };
    } catch (error) {
      return artifactReadError(reply, error);
    }
  });
  app.get("/api/runs/:id/artifacts/:artifactId/download", async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const artifact = store.getArtifact(id, artifactId);
    if (!artifact) return reply.code(404).send({ error: "artifact not found" });
    try {
      const source = await loadArtifactDownload(artifact.content, artifact.uri, workspaceRoot);
      const filename = artifactFilename(artifact.title, artifact.uri);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return reply.send(Buffer.from(source.content));
    } catch (error) {
      return artifactReadError(reply, error);
    }
  });
  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = service.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });
  app.post("/api/runs/:id/consumers/:consumerId/claim", async (request, reply) => {
    const { id, consumerId } = request.params as { id: string; consumerId: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    if (!consumerId || consumerId.length > 200) return reply.code(400).send({ error: "invalid consumer id" });
    return store.claimEventConsumer(id, consumerId);
  });
  app.post("/api/runs/:id/consumers/:consumerId/ack", async (request, reply) => {
    const { id, consumerId } = request.params as { id: string; consumerId: string };
    const body = request.body as { generation?: number; seq?: number };
    const status = store.ackEventConsumer(id, consumerId, Number(body?.generation), Number(body?.seq));
    if (status === "missing") return reply.code(404).send({ error: "run not found", status });
    if (status === "stale") return reply.code(409).send({ error: "consumer generation is stale", status });
    if (status === "invalid") return reply.code(400).send({ error: "invalid acknowledgement sequence", status });
    return { ok: true, status };
  });
  app.get("/api/runs/:id/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { after?: string; consumerId?: string; generation?: string };
    const after = Number(query.after ?? 0);
    const generation = Number(query.generation);
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const cursor = query.consumerId ? store.getEventConsumer(id, query.consumerId) : undefined;
    if (!cursor || cursor.generation !== generation) return reply.code(409).send({ error: "consumer generation is stale" });
    const replayAfter = Math.max(after, cursor.ackedSeq);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let unsubscribe = () => {};
    let replaying = true;
    const buffered: ReturnType<typeof service.replay> = [];
    const send = (event: ReturnType<typeof service.replay>[number]) => {
      if (store.getEventConsumer(id, query.consumerId!)?.generation !== generation) {
        unsubscribe();
        response.end();
        return false;
      }
      return response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    unsubscribe = service.subscribe(id, (event) => { if (replaying) buffered.push(event); else send(event); });
    let deliveredSeq = replayAfter;
    for (const event of service.replay(id, replayAfter)) {
      if (send(event) === false) return;
      deliveredSeq = event.seq;
    }
    replaying = false;
    for (const event of buffered) if (event.seq > deliveredSeq && send(event) === false) return;
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.all("/api/*", async (request, reply) => reply.code(404).send({ error: `API route not found: ${request.method} ${request.url}` }));

  const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  app.get("/*", async (request, reply) => {
    const requested = request.url.split("?")[0] === "/" ? "index.html" : request.url.split("?")[0].slice(1);
    const candidate = path.resolve(webRoot, requested);
    if (!candidate.startsWith(webRoot)) return reply.code(404).send("Not found");
    let filename = candidate;
    try { if ((await stat(filename)).isDirectory()) filename = path.join(filename, "index.html"); }
    catch { filename = path.join(webRoot, "index.html"); }
    try { return reply.type(mimeTypes[path.extname(filename)] ?? "application/octet-stream").send(await readFile(filename)); }
    catch { return reply.code(404).send("Web build not found. Run npm run build."); }
  });

  app.addHook("onClose", async () => { await service.closeRuntimes(); await closeResources?.(); store.close(); });
  return app;
}

function isLearningRoute(pathname: string) {
  return pathname.startsWith("/api/workflows/") || pathname.startsWith("/api/workflow-") || pathname.startsWith("/api/autonomy-approvals/") || pathname.startsWith("/api/internal/workflows/") || pathname.startsWith("/api/communication-profiles/") || pathname.startsWith("/api/feedback-attribution/") || /^\/api\/sessions\/[^/]+\/(?:workflows|learning-center|learning-events|corrections|communication-profiles|communication-preferences)/.test(pathname) || /^\/api\/runs\/[^/]+\/learning-policy$/.test(pathname);
}

function artifactReadError(reply: FastifyReply, error: unknown) {
  const cause = error as NodeJS.ErrnoException & { code?: string };
  if (cause.code === "ENOENT") return reply.code(404).send({ error: "artifact file not found" });
  if (cause.code === "ARTIFACT_TOO_LARGE") return reply.code(413).send({ error: cause.message });
  if (cause.code === "ARTIFACT_SOURCE_UNAVAILABLE" || cause.code === "EISDIR") return reply.code(422).send({ error: cause.message });
  if (cause.code === "ERR_INVALID_FILE_URL_HOST" || cause.code === "ERR_INVALID_FILE_URL_PATH") return reply.code(400).send({ error: "invalid artifact file URI" });
  return reply.code(500).send({ error: "artifact could not be read" });
}

function memoryAccess(request: FastifyRequest, scopes: MemoryScope[], purpose: AccessContext["purpose"]): AccessContext {
  return { subjectId: String(request.headers["x-tagent-subject"] ?? "local-admin"), scopes, purpose };
}

function isOpaqueAutomationMarker(content: string) {
  return /^(?:(?:final-)?ui-sync|release)-[a-z0-9._-]*\d{10,}$/i.test(content) && !/[\s：:，,。.!?？]/.test(content);
}
