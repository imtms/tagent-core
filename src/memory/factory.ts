import path from "node:path";
import type { Store } from "../store/store.js";
import { HashEmbeddingAdapter } from "./adapters/hash-embedding.js";
import { InMemoryMemoryAdapter } from "./adapters/in-memory.js";
import { RuleBasedExtractor } from "./adapters/rule-extractor.js";
import { MemoryCaptureWorker } from "./capture-worker.js";
import { MemoryService } from "./memory-service.js";
import { DefaultPolicyEngine } from "./policy/policy-engine.js";
import { PostgresMemoryAdapter } from "./postgres/postgres-adapter.js";
import { LocalBlobStore } from "./storage/local-blob-store.js";
import { S3BlobStore } from "./storage/s3-blob-store.js";
import type { AccessContext, SourceReference } from "./types.js";
import type { SourceLoaderPort } from "./ports.js";
export interface MemoryRuntimeConfig { enabled:boolean; backend:"memory"|"postgres"; postgresUrl?:string; coldBackend:"local"|"s3"; coldPath:string; s3Bucket?:string; s3Prefix?:string; s3Endpoint?:string; s3Region?:string; s3ForcePathStyle?:boolean; workerIntervalMs:number; workspaceScopeId:string }
class StoreSourceLoader implements SourceLoaderPort { constructor(private readonly store:Store){} async load(_access:AccessContext,refs:SourceReference[]){const parts:string[]=[];for(const ref of refs){if(ref.sourceType==="message"){const row=this.store.db.prepare("SELECT role,content FROM messages WHERE id=?").get(Number(ref.sourceId)) as {role:string;content:string}|undefined;if(row)parts.push(`${row.role}: ${row.content}`);}else if(ref.sourceType==="run"){const run=this.store.getRun(ref.sourceId);if(run){parts.push(`goal: ${run.goal}`);parts.push(...this.store.listTranscriptView(ref.sourceId).map((entry)=>JSON.stringify(entry)));}}}return parts.join("\n\n");}}
export async function createMemoryRuntime(config:MemoryRuntimeConfig,store:Store){if(!config.enabled)return null;const adapter=config.backend==="postgres"?new PostgresMemoryAdapter(config.postgresUrl!):new InMemoryMemoryAdapter();if(adapter instanceof PostgresMemoryAdapter)await adapter.migrate();const blobs=config.coldBackend==="s3"?new S3BlobStore({bucket:config.s3Bucket!,prefix:config.s3Prefix,clientConfig:{endpoint:config.s3Endpoint,region:config.s3Region??"us-east-1",forcePathStyle:config.s3ForcePathStyle}}):new LocalBlobStore(path.resolve(config.coldPath));const policy=new DefaultPolicyEngine(adapter);const service=new MemoryService({records:adapter,vectors:adapter,graph:adapter,topics:adapter,blobs,embeddings:new HashEmbeddingAdapter(),jobs:adapter,policy});const worker=new MemoryCaptureWorker(adapter,new StoreSourceLoader(store),new RuleBasedExtractor(),policy,service);let timer:ReturnType<typeof setInterval>|undefined;return{service,adapter,worker,start(){timer=setInterval(()=>void worker.runOnce(),config.workerIntervalMs);timer.unref?.();},async close(){if(timer)clearInterval(timer);if(adapter instanceof PostgresMemoryAdapter)await adapter.close();}};}
