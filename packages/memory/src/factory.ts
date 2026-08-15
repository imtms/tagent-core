import path from "node:path";
import { HashEmbeddingAdapter } from "./adapters/hash-embedding.js";
import { OpenAIEmbeddingAdapter } from "./adapters/openai-embedding.js";
import { HybridExtractor, LlmExtractor } from "./adapters/llm-extractor.js";
import { LlmSemanticConsolidator } from "./adapters/llm-consolidator.js";
import { InMemoryMemoryAdapter } from "./adapters/in-memory.js";
import { RuleBasedExtractor } from "./adapters/rule-extractor.js";
import { MemoryCaptureWorker } from "./capture-worker.js";
import { MemoryConsolidator } from "./consolidator.js";
import { MemoryLifecycle } from "./lifecycle.js";
import { MemoryService, type MemoryRecallThresholds } from "./memory-service.js";
import { DefaultPolicyEngine } from "./policy/policy-engine.js";
import { ColdStorageReconciler } from "./reconciler.js";
import { LocalMemoryWorker } from "./runtime-worker.js";
import { DurableReindexWorker } from "./reindex-worker.js";
import { CoreMemorySnapshotService } from "./core-snapshot.js";
import { LocalBlobStore } from "./storage/local-blob-store.js";
import type { AccessContext, SourceReference } from "./types.js";
import type { MemoryRuntimeSourcePort, MemorySourceLoaderPort, MemorySourceViewPort } from "./ports.js";
import type { SemanticMemoryJudgePort } from "./semantic-memory-judge-port.js";
export interface MemoryRuntimeConfig {
  backend: "memory" | "postgres";
  postgresUrl?: string;
  coldBackend: "local" | "s3";
  coldPath: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Endpoint?: string;
  s3Region?: string;
  s3ForcePathStyle: boolean;
  workerIntervalMs: number;
  maintenanceIntervalMs: number;
  workspaceScopeId: string;
  coldMinimumRecords: number;
  warmAfterMs: number;
  hotTtlMs: number;
  candidateTtlMs: number;
  deletedGracePeriodMs: number;
  retentionFactStaleMs: number;
  retentionFactDeleteMs: number;
  retentionPreferenceStaleMs: number;
  retentionPreferenceDeleteMs: number;
  retentionEpisodeStaleMs: number;
  retentionEpisodeDeleteMs: number;
  retentionProcedureStaleMs: number;
  retentionProcedureDeleteMs: number;
  embeddingProvider: "hash" | "openai" | "none";
  embeddingBaseUrl?: string;
  resolveEmbeddingApiKey?: () => Promise<string | undefined>;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingBatchSize: number;
  embeddingExtraBody?: Record<string, unknown>;
  extractorProvider: "rule" | "hybrid";
  extractorBaseUrl?: string;
  resolveExtractorApiKey?: () => Promise<string | undefined>;
  extractorModel?: string;
  recallThresholds: MemoryRecallThresholds;
}
export class PersistenceMemorySourceLoader implements MemorySourceLoaderPort { constructor(private readonly source:MemorySourceViewPort){} async load(_access:AccessContext,refs:SourceReference[]){const parts:string[]=[];for(const ref of refs){if(ref.sourceType==="message"){const row=this.source.getMessageSource(Number(ref.sourceId));if(row)parts.push(`${row.role}: ${row.content}`);}else if(ref.sourceType==="run"){const run=this.source.getRun(ref.sourceId);if(run){parts.push(`goal: ${run.goal}`);parts.push(...this.source.listTranscriptView(ref.sourceId).map((entry)=>JSON.stringify(entry)));}}}return parts.join("\n\n");}}
async function loadPostgresAdapter() {
  try {
    return await import("./postgres/postgres-adapter.js");
  } catch (error) {
    throw new Error("Enabled PostgreSQL memory requires the optional pg dependency and a PostgreSQL server with pgvector", { cause: error });
  }
}

async function loadS3BlobStore() {
  try {
    return await import("./storage/s3-blob-store.js");
  } catch (error) {
    throw new Error("Enabled S3 Cold storage requires the optional AWS SDK dependencies", { cause: error });
  }
}

export async function createMemoryRuntime(config:MemoryRuntimeConfig,source:MemoryRuntimeSourcePort,semanticJudge?:SemanticMemoryJudgePort){
  const postgresModule = config.backend === "postgres" ? await loadPostgresAdapter() : undefined;
  const postgresAdapter = postgresModule ? new postgresModule.PostgresMemoryAdapter(config.postgresUrl!) : undefined;
  if (postgresAdapter) await postgresAdapter.initializeSchema();
  const adapter = postgresAdapter ?? new InMemoryMemoryAdapter();
  const blobs = config.coldBackend === "s3"
    ? new (await loadS3BlobStore()).S3BlobStore({bucket:config.s3Bucket!,prefix:config.s3Prefix,clientConfig:{endpoint:config.s3Endpoint,region:config.s3Region??"us-east-1",forcePathStyle:config.s3ForcePathStyle}})
    : new LocalBlobStore(path.resolve(config.coldPath));
  const policy=new DefaultPolicyEngine(adapter);
  const access:AccessContext={subjectId:"memory-maintenance",scopes:[{type:"workspace",id:config.workspaceScopeId}],purpose:"capture"};
  const embeddings = config.embeddingProvider === "openai" ? new OpenAIEmbeddingAdapter({baseUrl:config.embeddingBaseUrl!,resolveApiKey:config.resolveEmbeddingApiKey!,model:config.embeddingModel!,dimensions:config.embeddingDimensions,batchSize:config.embeddingBatchSize,extraBody:config.embeddingExtraBody,maxRetries:2}) : config.embeddingProvider === "hash" ? new HashEmbeddingAdapter() : undefined;
  const probe=embeddings?{probe:async()=>{const started=Date.now();try{await embeddings.embed(["readiness probe"]);return{ok:true,latencyMs:Date.now()-started};}catch(error){return{ok:false,latencyMs:Date.now()-started,error:String(error)}}}}:undefined;
  let extractorProbe:import("./ports.js").ProbePort|undefined;
  const core=new CoreMemorySnapshotService(adapter,adapter);
  const service=new MemoryService({records:adapter,vectors:adapter,graph:adapter,topics:adapter,blobs,embeddings,jobs:adapter,policy,reindex:adapter,operations:adapter,embeddingProbe:probe,coreSnapshots:{get:a=>core.get(a),generate:(a,o)=>core.generate(a,o),update:(a,m)=>core.update(a,m)}},config.recallThresholds);
  const lifecycle=new MemoryLifecycle(adapter,adapter,adapter,adapter,{warmAfterMs:config.warmAfterMs,hotTtlMs:config.hotTtlMs,coldMinimumRecords:config.coldMinimumRecords,candidateTtlMs:config.candidateTtlMs,deletedGracePeriodMs:config.deletedGracePeriodMs,retention:{fact:{staleAfterMs:config.retentionFactStaleMs,deleteAfterMs:config.retentionFactDeleteMs},preference:{staleAfterMs:config.retentionPreferenceStaleMs,deleteAfterMs:config.retentionPreferenceDeleteMs},episode:{staleAfterMs:config.retentionEpisodeStaleMs,deleteAfterMs:config.retentionEpisodeDeleteMs},procedure:{staleAfterMs:config.retentionProcedureStaleMs,deleteAfterMs:config.retentionProcedureDeleteMs}}});
  const ruleExtractor=new RuleBasedExtractor();
  const llmExtractor=config.extractorProvider === "hybrid"?new LlmExtractor({baseUrl:config.extractorBaseUrl!,resolveApiKey:config.resolveExtractorApiKey!,model:config.extractorModel!,maxRetries:1}):undefined; const extractor=new HybridExtractor(ruleExtractor,llmExtractor); extractorProbe=llmExtractor?{probe:async()=>{const started=Date.now();try{await llmExtractor.extract("user: readiness probe, do not persist",[],access.scopes[0]);return{ok:true,latencyMs:Date.now()-started};}catch(error){return{ok:false,latencyMs:Date.now()-started,error:String(error)}}}}:undefined; (service as any).deps.extractorProbe=extractorProbe;
  const capture=new MemoryCaptureWorker(adapter,new PersistenceMemorySourceLoader(source),extractor,policy,service,lifecycle,undefined,(event)=>{for(const ref of event.sourceRefs.filter((x)=>x.sourceType==="run"))if(source.getRun(ref.sourceId))source.appendEvent(ref.sourceId,event.type,event.data);},semanticJudge);
  const semanticConsolidator=config.extractorProvider==="hybrid"?new LlmSemanticConsolidator({baseUrl:config.extractorBaseUrl!,resolveApiKey:config.resolveExtractorApiKey!,model:config.extractorModel!}):undefined;
  const consolidator=new MemoryConsolidator(adapter,adapter,service,{minimumRecords:config.coldMinimumRecords},semanticConsolidator); const reconciler=new ColdStorageReconciler(adapter,blobs);
  // Capture explicit profile cues from durable user messages with the live idempotency identity.
  // This supports enabling Memory after a conversation without making raw chat the recall source.
  const historicalMessages=source.listDurableUserMessages();
  for(const message of historicalMessages)if(isExplicitProfileCue(message.content)){const subjectId=message.principalId??(message.sessionId?`session:${message.sessionId}`:undefined);if(!subjectId)continue;const scopes:AccessContext["scopes"]=message.principalId?[{type:"user",id:message.principalId},{type:"workspace",id:config.workspaceScopeId},...(message.sessionId?[{type:"session" as const,id:message.sessionId}]:[])]:[{type:"session",id:message.sessionId!},{type:"workspace",id:config.workspaceScopeId}];await service.enqueueCapture({access:{subjectId,scopes,purpose:"capture"},sourceRefs:[{sourceType:"message",sourceId:String(message.id),revision:"user"}],content:`user: ${message.content}`,idempotencyKey:`user-message:${message.id}`,captureSource:{kind:"user_message",role:"user",explicitIntent:true}});}
  const reindex=embeddings?new DurableReindexWorker(adapter,adapter,adapter,embeddings,adapter,access,config.embeddingBatchSize):undefined;if(reindex){const scopes=await adapter.listScopes();if(!scopes.some((scope)=>scope.type==="workspace"&&scope.id===config.workspaceScopeId))scopes.push(access.scopes[0]);for(const scope of scopes)await adapter.enqueueReindex(scope,embeddings!.generation);}
  const worker=new LocalMemoryWorker(capture,lifecycle,consolidator,reconciler,access,config.workerIntervalMs,config.maintenanceIntervalMs,async()=>{service.noteWorkerHeartbeat();await adapter.heartbeat("local-memory",access.scopes[0],"memory",Date.now());},()=>service.noteConsolidation(),reindex,core,adapter,blobs,adapter);
  let closeTask:Promise<void>|undefined;
  return{service,adapter,worker,lifecycle,consolidator,reconciler,start(){if(!closeTask)worker.start();},close(){if(!closeTask)closeTask=(async()=>{await worker.stop();if(postgresAdapter)await postgresAdapter.close();})();return closeTask;}};
}

function isExplicitProfileCue(content:string){return /记住|remember|我叫|我的名字|我的姓名|叫我|称呼我|my name is|call me|(?:我|用户).{0,20}(?:喜欢|偏好|希望|不喜欢|习惯|prefer)/i.test(content)&&!/[?？]/.test(content);}

export type MemoryRuntime = Awaited<ReturnType<typeof createMemoryRuntime>>;
