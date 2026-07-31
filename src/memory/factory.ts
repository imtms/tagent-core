import path from "node:path";
import type { Store } from "../store/store.js";
import type { MemoryConfig } from "../config.js";
import { HashEmbeddingAdapter } from "./adapters/hash-embedding.js";
import { OpenAIEmbeddingAdapter } from "./adapters/openai-embedding.js";
import { HybridExtractor, LlmExtractor } from "./adapters/llm-extractor.js";
import { LlmSemanticConsolidator } from "./adapters/llm-consolidator.js";
import { InMemoryMemoryAdapter } from "./adapters/in-memory.js";
import { RuleBasedExtractor } from "./adapters/rule-extractor.js";
import { MemoryCaptureWorker } from "./capture-worker.js";
import { MemoryConsolidator } from "./consolidator.js";
import { MemoryLifecycle } from "./lifecycle.js";
import { MemoryService } from "./memory-service.js";
import { DefaultPolicyEngine } from "./policy/policy-engine.js";
import { ColdStorageReconciler } from "./reconciler.js";
import { LocalMemoryWorker } from "./runtime-worker.js";
import { LocalBlobStore } from "./storage/local-blob-store.js";
import type { AccessContext, SourceReference } from "./types.js";
import type { SourceLoaderPort } from "./ports.js";
export type MemoryRuntimeConfig = Extract<MemoryConfig, { enabled: true }>;
class StoreSourceLoader implements SourceLoaderPort { constructor(private readonly store:Store){} async load(_access:AccessContext,refs:SourceReference[]){const parts:string[]=[];for(const ref of refs){if(ref.sourceType==="message"){const row=this.store.db.prepare("SELECT role,content FROM messages WHERE id=?").get(Number(ref.sourceId)) as {role:string;content:string}|undefined;if(row)parts.push(`${row.role}: ${row.content}`);}else if(ref.sourceType==="run"){const run=this.store.getRun(ref.sourceId);if(run){parts.push(`goal: ${run.goal}`);parts.push(...this.store.listTranscriptView(ref.sourceId).map((entry)=>JSON.stringify(entry)));}}}return parts.join("\n\n");}}
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

export async function createMemoryRuntime(config:MemoryRuntimeConfig,store:Store){
  const postgresModule = config.backend === "postgres" ? await loadPostgresAdapter() : undefined;
  const postgresAdapter = postgresModule ? new postgresModule.PostgresMemoryAdapter(config.postgresUrl!) : undefined;
  if (postgresAdapter) await postgresAdapter.migrate();
  const adapter = postgresAdapter ?? new InMemoryMemoryAdapter();
  const blobs = config.coldBackend === "s3"
    ? new (await loadS3BlobStore()).S3BlobStore({bucket:config.s3Bucket!,prefix:config.s3Prefix,clientConfig:{endpoint:config.s3Endpoint,region:config.s3Region??"us-east-1",forcePathStyle:config.s3ForcePathStyle}})
    : new LocalBlobStore(path.resolve(config.coldPath));
  const policy=new DefaultPolicyEngine(adapter);
  const embeddings = config.embeddingProvider === "openai" ? new OpenAIEmbeddingAdapter({baseUrl:config.embeddingBaseUrl!,apiKey:config.embeddingApiKey!,model:config.embeddingModel!,dimensions:config.embeddingDimensions,batchSize:config.embeddingBatchSize,extraBody:config.embeddingExtraBody,maxRetries:2}) : config.embeddingProvider === "hash" ? new HashEmbeddingAdapter() : undefined;
  const service=new MemoryService({records:adapter,vectors:adapter,graph:adapter,topics:adapter,blobs,embeddings,jobs:adapter,policy});
  const lifecycle=new MemoryLifecycle(adapter,adapter,adapter,adapter,{warmAfterMs:config.warmAfterMs,hotTtlMs:config.hotTtlMs,coldMinimumRecords:config.coldMinimumRecords});
  const ruleExtractor=new RuleBasedExtractor();
  const extractor=config.extractorProvider === "hybrid" ? new HybridExtractor(ruleExtractor,new LlmExtractor({baseUrl:config.extractorBaseUrl!,apiKey:config.extractorApiKey!,model:config.extractorModel!,maxRetries:1})) : ruleExtractor;
  const capture=new MemoryCaptureWorker(adapter,new StoreSourceLoader(store),extractor,policy,service,lifecycle,undefined,(event)=>{for(const ref of event.sourceRefs.filter((x)=>x.sourceType==="run"))if(store.getRun(ref.sourceId))store.appendEvent(ref.sourceId,event.type,event.data);});
  const semanticConsolidator=config.extractorProvider==="hybrid"?new LlmSemanticConsolidator({baseUrl:config.extractorBaseUrl!,apiKey:config.extractorApiKey!,model:config.extractorModel!}):undefined;
  const consolidator=new MemoryConsolidator(adapter,adapter,service,{minimumRecords:config.coldMinimumRecords},semanticConsolidator); const reconciler=new ColdStorageReconciler(adapter,blobs);
  const access:AccessContext={subjectId:"memory-maintenance",scopes:[{type:"workspace",id:config.workspaceScopeId}],purpose:"capture"};
  // Backfill durable user messages with the same idempotency key used by live capture.
  // This repairs upgrades from pre-memory installations without making raw chat the recall source.
  const historicalMessages=store.db.prepare("SELECT id,content FROM messages WHERE role='user' ORDER BY id ASC").all() as Array<{id:number;content:string}>;
  for(const message of historicalMessages)if(isExplicitProfileCue(message.content))await service.enqueueCapture({access,sourceRefs:[{sourceType:"message",sourceId:String(message.id),revision:"user"}],content:`user: ${message.content}`,idempotencyKey:`user-message:${message.id}`});
  if(embeddings)await service.reindex(access).catch((error)=>console.warn("Memory reindex failed; lexical recall remains available",error));
  const worker=new LocalMemoryWorker(capture,lifecycle,consolidator,reconciler,access,config.workerIntervalMs,config.maintenanceIntervalMs);
  return{service,adapter,worker,lifecycle,consolidator,reconciler,start(){worker.start();},async close(){await worker.stop();if (postgresAdapter) await postgresAdapter.close();}};
}

function isExplicitProfileCue(content:string){return /记住|remember|我叫|我的名字|我的姓名|叫我|称呼我|my name is|call me|(?:我|用户).{0,20}(?:喜欢|偏好|希望|不喜欢|习惯|prefer)/i.test(content)&&!/[?？]/.test(content);}

export type MemoryRuntime = Awaited<ReturnType<typeof createMemoryRuntime>>;
