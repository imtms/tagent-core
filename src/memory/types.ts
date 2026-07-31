export type MemoryKind = "fact" | "preference" | "episode" | "procedure";
export type MemoryTier = "hot" | "warm" | "cold";
export type MemoryStatus = "candidate" | "active" | "superseded" | "disputed" | "quarantined" | "deleted";
export type ScopeType = "user" | "workspace" | "project" | "session";

export interface MemoryScope { type: ScopeType; id: string }
export interface AccessContext { subjectId: string; scopes: MemoryScope[]; purpose: "agent_recall" | "memory_admin" | "capture" }
export interface SourceReference { sourceType: "message" | "run" | "transcript" | "manual"; sourceId: string; revision?: string }
export interface MemoryRecord {
  id: string; kind: Exclude<MemoryKind, "preference">; tier: Exclude<MemoryTier, "cold">; scope: MemoryScope;
  title: string; content: string; summary: string; topicIds: string[]; entityIds: string[];
  status: MemoryStatus; confidence: number; importance: number; sourceRefs: SourceReference[];
  validFrom?: number; validTo?: number; supersedesId?: string; expiresAt?: number; createdAt: number; updatedAt: number;
}
export interface PreferenceRecord {
  id: string; kind: "preference"; tier: Exclude<MemoryTier, "cold">; scope: MemoryScope;
  dimension: string; value: string; summary: string; topicIds: string[]; entityIds: string[];
  applicability: "global" | "workspace" | "project" | "task"; strength: number;
  origin: "explicit" | "repeated" | "inferred"; status: MemoryStatus; confidence: number;
  sourceRefs: SourceReference[]; supersedesId?: string; expiresAt?: number; createdAt: number; updatedAt: number;
}
export type WarmMemory = MemoryRecord | PreferenceRecord;
export interface TopicDescriptor {
  topicId: string; kind: MemoryKind; scope: MemoryScope; title: string; description: string;
  aliases: string[]; entityIds: string[]; relatedTopicIds: string[]; coldRevisionId?: string;
  embeddingText: string; status: MemoryStatus; updatedAt: number;
}
export interface ColdRevision {
  id: string; topicId: string; kind: MemoryKind; scope: MemoryScope; revision: number; state: "staged" | "published" | "superseded";
  objectKey: string; checksum: string; byteLength: number; tokenCount: number; createdAt: number; publishedAt?: number;
}
export interface ColdTopicDocument { descriptor: TopicDescriptor; revision: ColdRevision; body: string }
export interface VectorDocument { refType: "hot_record" | "warm_record" | "topic_descriptor"; refId: string; scope: MemoryScope; kind: MemoryKind; text: string; vector: number[]; generation: string }
export interface VectorHit { refType: VectorDocument["refType"]; refId: string; score: number }
export interface GraphNode { id: string; type: string; canonicalName: string; aliases: string[]; scope: MemoryScope }
export interface GraphEdge { id: string; fromId: string; predicate: string; toId: string; scope: MemoryScope; confidence: number; status: MemoryStatus }
export interface RecallRequest { access: AccessContext; cue: string; maxCards?: number; maxColdTopics?: number; tokenBudget?: number; kinds?: MemoryKind[] }
export interface MemoryCard { id: string; kind: MemoryKind; tier: "hot" | "warm"; title: string; content: string; score: number; topicIds: string[]; confidence: number }
export interface RecallResult { cards: MemoryCard[]; coldTopics: ColdTopicDocument[]; promptSection: string; trace: { topicIds: string[]; candidateCount: number; deniedCount: number } }
export interface CaptureRequest { access: AccessContext; sourceRefs: SourceReference[]; content?: string; idempotencyKey: string; requestedAt?: number }
export interface CaptureJob { id: string; request: CaptureRequest; status: "queued" | "running" | "completed" | "retryable_failed" | "dead_letter"; attempts: number; leaseOwner?: string; leaseUntil?: number; errorCode?: string; createdAt: number; updatedAt: number }
export interface ForgetRequest { access: AccessContext; scope: MemoryScope; ids?: string[]; topicIds?: string[] }
export interface ForgetResult { records: number; topics: number; objects: number }
export interface ExtractionProposal { records: WarmMemory[]; topics: TopicDescriptor[]; nodes: GraphNode[]; edges: GraphEdge[] }
