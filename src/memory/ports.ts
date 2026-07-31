import type { AccessContext, CaptureJob, CaptureRequest, ColdRevision, ExtractionProposal, GraphEdge, GraphNode, MemoryKind, MemoryRecord, MemoryScope, PreferenceRecord, SourceReference, TopicDescriptor, VectorDocument, VectorHit, WarmMemory } from "./types.js";
export interface RecordStorePort {
  upsertRecords(records: WarmMemory[]): Promise<void>;
  search(query: string, scopes: MemoryScope[], kinds: MemoryKind[], limit: number): Promise<Array<{ record: WarmMemory; score: number }>>;
  getByIds(ids: string[], scopes: MemoryScope[]): Promise<WarmMemory[]>;
  list(scopes: MemoryScope[], kinds?: MemoryKind[], limit?: number): Promise<WarmMemory[]>;
  forget(scopes: MemoryScope[], ids?: string[], topicIds?: string[]): Promise<number>;
}
export interface VectorIndexPort { upsert(documents: VectorDocument[]): Promise<void>; searchVectors(vector: number[], scopes: MemoryScope[], kinds: MemoryKind[], limit: number, generation?: string): Promise<VectorHit[]>; remove(refIds: string[]): Promise<void> }
export interface GraphStorePort { upsertNodes(nodes: GraphNode[]): Promise<void>; upsertEdges(edges: GraphEdge[]): Promise<void>; resolveEntities(cue: string, scopes: MemoryScope[], limit: number): Promise<GraphNode[]>; neighborhood(entityIds: string[], scopes: MemoryScope[], depth: 1 | 2, limit: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> }
export interface TopicCatalogPort {
  upsertDescriptors(topics: TopicDescriptor[]): Promise<void>; searchTopics(cue: string, scopes: MemoryScope[], kinds: MemoryKind[], limit: number): Promise<Array<{ descriptor: TopicDescriptor; score: number }>>;
  getDescriptors(topicIds: string[], scopes: MemoryScope[]): Promise<TopicDescriptor[]>; listDescriptors(scopes: MemoryScope[], kinds?: MemoryKind[], limit?: number): Promise<TopicDescriptor[]>; stageRevision(revision: ColdRevision): Promise<void>; publishRevision(topicId: string, revisionId: string): Promise<void>; abandonRevision(revisionId: string): Promise<void>; listStagedRevisions(olderThan: number, limit: number): Promise<ColdRevision[]>; getCurrentRevision(topicId: string, scopes: MemoryScope[]): Promise<ColdRevision | null>; forgetTopics(topicIds: string[], scopes: MemoryScope[]): Promise<ColdRevision[]>;
}
export interface BlobStorePort { putImmutable(key: string, body: string, metadata: Record<string, string>): Promise<{ checksum: string; byteLength: number }>; get(key: string): Promise<string>; delete(key: string): Promise<void>; exists(key: string): Promise<boolean> }
export interface EmbeddingPort { readonly generation: string; embed(texts: string[]): Promise<number[][]> }
export interface ExtractorPort { extract(content: string, sourceRefs: SourceReference[], scope: MemoryScope): Promise<ExtractionProposal> }
export interface JobQueuePort { enqueue(request: CaptureRequest): Promise<CaptureJob>; claim(owner: string, leaseMs: number): Promise<CaptureJob | null>; complete(id: string): Promise<void>; fail(id: string, errorCode: string, retryable: boolean): Promise<void> }
export interface AuditPort { record(event: { action: string; subjectId: string; scope?: MemoryScope; decision: string; reasonCodes: string[]; payloadHash?: string; policyVersion: string; at: number }): Promise<void> }
export interface SourceLoaderPort { load(access: AccessContext, refs: SourceReference[]): Promise<string> }
export interface MemoryTransactionPort { transaction<T>(operation: () => Promise<T>): Promise<T> }
export type FactWrite = MemoryRecord;
export type PreferenceWrite = PreferenceRecord;
