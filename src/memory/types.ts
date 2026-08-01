export type MemoryKind = "fact" | "preference" | "episode" | "procedure";
export type MemoryTier = "hot" | "warm" | "cold";
export type MemoryStatus = "candidate" | "active" | "superseded" | "disputed" | "quarantined" | "deleted";
export type ScopeType = "user" | "workspace" | "project" | "session";

export interface MemoryScope { type: ScopeType; id: string }
export interface AccessContext { subjectId: string; scopes: MemoryScope[]; purpose: "agent_recall" | "memory_admin" | "capture" }
export type MemoryEvidenceClass = "user_explicit" | "user_context_summary" | "tool_verified_fact" | "task_outcome" | "assistant_inference";
export type CaptureSourceKind = "user_message" | "context_summary" | "manual_input" | "tool_result" | "task_structure" | "assistant_message";
export interface CaptureSource { kind: CaptureSourceKind; role: MemorySourceRole; explicitIntent?: boolean }
export type MemoryTrustLevel = "high" | "medium" | "low" | "untrusted";
export type MemorySourceRole = "user" | "tool" | "task" | "assistant" | "system";
export type MemoryVerificationState = "explicit" | "verified" | "structured" | "inferred" | "unverified";
export interface SourceReference { sourceType: "message" | "run" | "transcript" | "manual" | "check" | "artifact" | "operation"; sourceId: string; revision?: string }
export interface MemoryProvenance { evidenceClass: MemoryEvidenceClass; trustLevel: MemoryTrustLevel; sourceRole: MemorySourceRole; verificationState: MemoryVerificationState; sourceReliability?: number }
export interface CanonicalSPO { subject: string; predicate: string; object: string; polarity: "positive" | "negative" | "unknown" }
export interface MemoryRecord {
  id: string; kind: Exclude<MemoryKind, "preference">; tier: Exclude<MemoryTier, "cold">; scope: MemoryScope;
  title: string; content: string; summary: string; topicIds: string[]; entityIds: string[];
  status: MemoryStatus; confidence: number; importance: number; sourceRefs: SourceReference[]; provenance?: MemoryProvenance; semantic?: CanonicalSPO;
  validFrom?: number; validTo?: number; supersedesId?: string; expiresAt?: number; createdAt: number; updatedAt: number;
}
export interface PreferenceRecord {
  id: string; kind: "preference"; tier: Exclude<MemoryTier, "cold">; scope: MemoryScope;
  dimension: string; value: string; summary: string; topicIds: string[]; entityIds: string[];
  applicability: "global" | "workspace" | "project" | "task"; strength: number;
  origin: "explicit" | "repeated" | "inferred"; status: MemoryStatus; confidence: number;
  sourceRefs: SourceReference[]; provenance?: MemoryProvenance; semantic?: CanonicalSPO; supersedesId?: string; expiresAt?: number; createdAt: number; updatedAt: number;
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
export interface VectorDocument { refType: "hot_record" | "warm_record" | "topic_descriptor"; refId: string; scope: MemoryScope; kind: MemoryKind; text: string; vector: number[]; generation: string; contentHash?: string }
export interface VectorHit { refType: VectorDocument["refType"]; refId: string; score: number }
export interface GraphNode { id: string; type: string; canonicalName: string; aliases: string[]; scope: MemoryScope }
export interface GraphEdge { id: string; fromId: string; predicate: string; toId: string; scope: MemoryScope; confidence: number; status: MemoryStatus }
export interface RecallRequest { access: AccessContext; cue: string; maxCards?: number; maxColdTopics?: number; tokenBudget?: number; kinds?: MemoryKind[] }
export type RetrievalChannel = "lexical" | "vector" | "topic" | "graph" | "canonical";
export interface RecallScoreBreakdown { route: number; confidence: number; importance: number; recency: number; scope: number; trust: number; validity: number; currentState: number; feedback: number; final: number }
export interface MemoryCard { id: string; kind: MemoryKind; tier: "hot" | "warm"; title: string; content: string; score: number; topicIds: string[]; confidence: number; sourceRefs: SourceReference[]; provenance?: MemoryProvenance; status: MemoryStatus; validFrom?: number; validTo?: number; semantic?: CanonicalSPO; retrievalChannels: RetrievalChannel[]; scoreBreakdown: RecallScoreBreakdown }
export interface RecallCandidateTrace { id: string; channels: RetrievalChannel[]; rawScores: Partial<Record<RetrievalChannel,number>>; finalScore?: number; scoreBreakdown?: RecallScoreBreakdown; outcome: "selected" | "below_threshold" | "domain_filtered" | "duplicate" | "conflict" | "policy_denied" | "budget_dropped" | "mmr_dropped"; reason?: string }
export interface RecallTrace { version: 2; topicIds: string[]; candidateCount: number; deniedCount: number; embedding: { configured: boolean; degraded: boolean; generation?: string; error?: string }; policyTransforms: number; budgetDropped: number; coldTopicRoutes: Array<{ topicId: string; channels: RetrievalChannel[]; selected: boolean; reason: string }>; candidates: RecallCandidateTrace[] }
export interface RecallResult { cards: MemoryCard[]; coldTopics: ColdTopicDocument[]; promptSection: string; trace: RecallTrace }
export interface CaptureRequest { access: AccessContext; sourceRefs: SourceReference[]; content?: string; idempotencyKey: string; requestedAt?: number; captureSource?: CaptureSource; /** @deprecated record evidence is assigned after extraction */ provenance?: MemoryProvenance }
export interface CaptureJob { id: string; request: CaptureRequest; status: "queued" | "running" | "completed" | "completed_empty" | "retryable_failed" | "dead_letter"; attempts: number; leaseOwner?: string; leaseUntil?: number; leaseToken?: string; fencingToken?: number; errorCode?: string; proposalCount?: number; persistedCount?: number; createdAt: number; updatedAt: number }
export interface ForgetRequest { access: AccessContext; scope: MemoryScope; ids?: string[]; topicIds?: string[] }
export interface ForgetResult { records: number; topics: number; objects: number }
export interface ExtractionProposal { records: WarmMemory[]; topics: TopicDescriptor[]; nodes: GraphNode[]; edges: GraphEdge[] }
