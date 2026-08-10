import type { AccessContext, CaptureJob, CaptureRequest, ColdRevision, CoreMemorySnapshot, EmbeddingGenerationState, ExtractionProposal, GraphEdge, GraphNode, MemoryGovernanceReceipt, MemoryGovernanceRequest, MemoryKind, MemoryRecord, MemoryScope, PreferenceRecord, RecallFeedbackReceipt, RecallFeedbackSignal, ReindexJob, SourceReference, TopicDescriptor, VectorDocument, VectorHit, WarmMemory } from "./types.js";

export type {
  SemanticMemoryCaptureDecision,
  SemanticMemoryJudgeMetricsSnapshot,
  SemanticMemoryJudgePort,
  SemanticMemoryQualityDecision,
  SemanticMemoryQualityInput,
} from "./semantic-memory-judge-port.js";

export interface MemoryMessageSourceView { role: string; content: string }
export interface MemoryRunSourceView { goal: string }
export interface MemoryDurableUserMessageView { id: number; content: string; sessionId?: string; principalId?: string | null }
export interface MemorySourceViewPort {
  getMessageSource(id: number): MemoryMessageSourceView | undefined;
  getRun(id: string): MemoryRunSourceView | undefined;
  listTranscriptView(id: string): readonly unknown[];
  listDurableUserMessages(): readonly MemoryDurableUserMessageView[];
}
export interface MemoryRunEventSinkPort {
  appendEvent(runId: string, type: string, data: Record<string, unknown>): void;
}
export type MemoryRuntimeSourcePort = MemorySourceViewPort & MemoryRunEventSinkPort;
export type MemorySourceRepository = MemoryRuntimeSourcePort;
export interface RecordStorePort {
  upsertRecords(records: WarmMemory[]): Promise<void>;
  search(query: string, scopes: MemoryScope[], kinds: MemoryKind[], limit: number): Promise<Array<{ record: WarmMemory; score: number }>>;
  getByIds(ids: string[], scopes: MemoryScope[]): Promise<WarmMemory[]>;
  getAnyByIds?(ids: string[], scopes: MemoryScope[]): Promise<WarmMemory[]>;
  getByTopicIds(topicIds: string[], scopes: MemoryScope[], kinds: MemoryKind[], limit: number): Promise<WarmMemory[]>;
  list(scopes: MemoryScope[], kinds?: MemoryKind[], limit?: number): Promise<WarmMemory[]>;
  listScopes?(): Promise<MemoryScope[]>;
  countSummary?(scopes: MemoryScope[]): Promise<{ hot: number; warm: number; candidate: number; active: number; disputed: number }>;
  forget(scopes: MemoryScope[], ids?: string[], topicIds?: string[], options?: { reason?: string; purgeAfter?: number }): Promise<number>;
  restore?(scopes: MemoryScope[], ids?: string[], topicIds?: string[]): Promise<number>;
  purgeDeleted?(scopes: MemoryScope[], now: number, limit: number): Promise<string[]>;
  noteRecall?(ids: string[], scopes: MemoryScope[], at: number): Promise<void>;
  govern?(request: MemoryGovernanceRequest): Promise<MemoryGovernanceReceipt | null>;
  addRecallFeedback?(scope: MemoryScope, recordId: string, signal: RecallFeedbackSignal, weight: number, actorId: string, runId?: string, note?: string): Promise<RecallFeedbackReceipt | null>;
  feedbackScores?(ids: string[], scopes: MemoryScope[]): Promise<Map<string, number>>;
}
export interface VectorIndexPort { upsert(documents: VectorDocument[]): Promise<void>; searchVectors(vector: number[], scopes: MemoryScope[], kinds: MemoryKind[], limit: number, generation?: string): Promise<VectorHit[]>; remove(refIds: string[]): Promise<void>; contentHashes?(refs:Array<{refType:VectorDocument["refType"];refId:string;generation:string}>):Promise<Map<string,string>>; removeMissing?(generation:string,active:Set<string>,scopes:MemoryScope[]):Promise<number>; garbageCollectGenerations?(activeGeneration:string,scopes:MemoryScope[]):Promise<number>; countGeneration?(generation:string,scopes:MemoryScope[]):Promise<number> }
export interface GraphStorePort { upsertNodes(nodes: GraphNode[]): Promise<void>; upsertEdges(edges: GraphEdge[]): Promise<void>; removeByEntityIds?(entityIds:string[],scopes:MemoryScope[]):Promise<void>; resolveEntities(cue: string, scopes: MemoryScope[], limit: number): Promise<GraphNode[]>; neighborhood(entityIds: string[], scopes: MemoryScope[], depth: 1 | 2, limit: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> }
export interface TopicCatalogPort {
  upsertDescriptors(topics: TopicDescriptor[]): Promise<void>; searchTopics(cue: string, scopes: MemoryScope[], kinds: MemoryKind[], limit: number): Promise<Array<{ descriptor: TopicDescriptor; score: number }>>;
  getDescriptors(topicIds: string[], scopes: MemoryScope[]): Promise<TopicDescriptor[]>; listDescriptors(scopes: MemoryScope[], kinds?: MemoryKind[], limit?: number): Promise<TopicDescriptor[]>; countTopicSummary?(scopes: MemoryScope[]): Promise<{ topics: number; coldTopics: number }>; stageRevision(revision: ColdRevision): Promise<void>; publishRevision(topicId: string, revisionId: string): Promise<void>; abandonRevision(revisionId: string): Promise<void>; listStagedRevisions(olderThan: number, limit: number): Promise<ColdRevision[]>; getCurrentRevision(topicId: string, scopes: MemoryScope[]): Promise<ColdRevision | null>; invalidateTopics?(topicIds:string[],scopes:MemoryScope[]):Promise<number>; forgetTopics(topicIds: string[], scopes: MemoryScope[], options?: { reason?: string; purgeAfter?: number }): Promise<ColdRevision[]>; restoreTopics?(topicIds: string[], scopes: MemoryScope[]): Promise<number>; listPurgeableTopics?(scopes:MemoryScope[],now:number,limit:number):Promise<Array<{topicId:string;revisions:ColdRevision[]}>>; purgeTopics?(topicIds:string[],scopes:MemoryScope[]):Promise<number>;
}
export interface BlobStorePort { putImmutable(key: string, body: string, metadata: Record<string, string>): Promise<{ checksum: string; byteLength: number }>; get(key: string): Promise<string>; delete(key: string): Promise<void>; exists(key: string): Promise<boolean> }
export interface EmbeddingRequestOptions { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal }
export interface EmbeddingPort { readonly generation: string; embed(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]> }
export interface ExtractorPort { extract(content: string, sourceRefs: SourceReference[], scope: MemoryScope): Promise<ExtractionProposal> }
export interface JobQueuePort { enqueue(request: CaptureRequest): Promise<CaptureJob>; claim(owner: string, leaseMs: number): Promise<CaptureJob | null>; renew(id: string, owner: string, leaseToken: string, fencingToken: number, leaseMs: number): Promise<boolean>; complete(id: string, owner: string, leaseToken: string, fencingToken: number, result?: { extractedCount: number; proposalCount: number; persistedCount: number; filterReasons?: Record<string,number> }): Promise<boolean>; fail(id: string, owner: string, leaseToken: string, fencingToken: number, errorCode: string, retryable: boolean): Promise<boolean>; listJobs?(scopes: MemoryScope[], limit?: number): Promise<CaptureJob[]>; getJob?(id: string): Promise<CaptureJob | null> }
export interface AuditPort { record(event: { action: string; subjectId: string; scope?: MemoryScope; decision: string; reasonCodes: string[]; payloadHash?: string; policyVersion: string; at: number }): Promise<void> }
export interface MemorySourceLoaderPort { load(access: AccessContext, refs: SourceReference[]): Promise<string> }
export type SourceLoaderPort = MemorySourceLoaderPort;
export interface MemoryTransactionPort { transaction<T>(operation: () => Promise<T>): Promise<T> }
export type FactWrite = MemoryRecord;
export type PreferenceWrite = PreferenceRecord;

export interface ReindexJobPort { enqueueReindex(scope:MemoryScope,generation:string):Promise<ReindexJob>; claimReindex(owner:string,leaseMs:number):Promise<ReindexJob|null>; renewReindex(id:string,owner:string,leaseToken:string,fencingToken:number,leaseMs:number):Promise<boolean>; checkpointReindex(job:ReindexJob,owner:string,leaseToken:string,fencingToken:number):Promise<boolean>; completeReindex(job:ReindexJob,owner:string,leaseToken:string,fencingToken:number):Promise<boolean>; failReindex(id:string,owner:string,leaseToken:string,fencingToken:number,errorCode:string):Promise<boolean>; listReindexJobs(scopes:MemoryScope[],limit?:number):Promise<ReindexJob[]>; getGeneration(scope:MemoryScope,generation?:string):Promise<EmbeddingGenerationState|null>; upsertGeneration(state:EmbeddingGenerationState):Promise<void> }
export interface OperationsStatePort { heartbeat(workerId:string,scope:MemoryScope,kind:string,at:number,metadata?:Record<string,unknown>):Promise<void>; workerHeartbeat(scope:MemoryScope,kind:string):Promise<{at:number;metadata:Record<string,unknown>}|null>; recordMetric(scope:MemoryScope,name:string,value:number,at:number):Promise<void>; metricSummary(scope:MemoryScope,name:string,since:number):Promise<{count:number;average:number;p95:number;latestAt?:number}>; recordDegraded(scope:MemoryScope,reason:string,at:number):Promise<void>; lastDegraded(scope:MemoryScope):Promise<{reason:string;at:number}|null> }
export interface CoreSnapshotPort { getSnapshot(scope:MemoryScope):Promise<CoreMemorySnapshot|null>; putSnapshot(snapshot:CoreMemorySnapshot):Promise<boolean> }
export interface ProbePort { probe():Promise<{ok:boolean;latencyMs:number;error?:string}> }
