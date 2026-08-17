export type MemoryKind = "fact" | "preference" | "episode" | "procedure";
export type MemoryTier = "hot" | "warm" | "cold";
export type MemoryStatus = "candidate" | "active" | "stale" | "superseded" | "disputed" | "quarantined" | "deleted";
export type ScopeType = "user" | "workspace" | "project" | "session";

export interface MemoryScope { type: ScopeType; id: string }
export interface AccessContext { subjectId: string; scopes: MemoryScope[]; purpose: "agent_recall" | "memory_admin" | "capture" }
export type MemoryEvidenceClass = "user_explicit" | "user_context_summary" | "tool_verified_fact" | "task_outcome" | "assistant_inference";
export type CaptureSourceKind = "user_message" | "context_summary" | "manual_input" | "tool_result" | "task_structure" | "assistant_message";
export interface CaptureSource { kind: CaptureSourceKind; role: MemorySourceRole; explicitIntent?: boolean }
export type MemoryTrustLevel = "high" | "medium" | "low" | "untrusted";
export type MemorySourceRole = "user" | "tool" | "task" | "assistant" | "system";
export type MemoryVerificationState = "explicit" | "verified" | "structured" | "inferred" | "unverified";
export const MEMORY_SOURCE_TYPES = ["message", "run", "transcript", "manual", "check", "artifact", "operation"] as const;
export type MemorySourceType = typeof MEMORY_SOURCE_TYPES[number];
export interface SourceReference { sourceType: MemorySourceType; sourceId: string; revision?: string }
export interface MemoryProvenance { evidenceClass: MemoryEvidenceClass; trustLevel: MemoryTrustLevel; sourceRole: MemorySourceRole; verificationState: MemoryVerificationState; sourceReliability?: number }
export interface CanonicalSPO { subject: string; predicate: string; object: string; polarity: "positive" | "negative" | "unknown" }
export interface MemoryLifecycleState {
  firstSeenAt: number;
  lastSeenAt: number;
  confirmationCount: number;
  lastRecalledAt?: number;
  recallCount?: number;
  staleAt?: number;
  deletedAt?: number;
  purgeAfter?: number;
  deleteReason?: string;
  previousStatus?: Exclude<MemoryStatus, "deleted">;
}
export interface MemoryRecord {
  id: string; kind: Exclude<MemoryKind, "preference">; tier: Exclude<MemoryTier, "cold">; scope: MemoryScope;
  title: string; content: string; summary: string; topicIds: string[]; entityIds: string[];
  status: MemoryStatus; confidence: number; importance: number; sourceRefs: SourceReference[]; provenance?: MemoryProvenance; semantic?: CanonicalSPO; lifecycle?: MemoryLifecycleState;
  validFrom?: number; validTo?: number; supersedesId?: string; expiresAt?: number; createdAt: number; updatedAt: number;
}
export interface PreferenceRecord {
  id: string; kind: "preference"; tier: Exclude<MemoryTier, "cold">; scope: MemoryScope;
  dimension: string; value: string; summary: string; topicIds: string[]; entityIds: string[];
  applicability: "global" | "workspace" | "project" | "task"; strength: number;
  origin: "explicit" | "repeated" | "inferred"; status: MemoryStatus; confidence: number;
  sourceRefs: SourceReference[]; provenance?: MemoryProvenance; semantic?: CanonicalSPO; lifecycle?: MemoryLifecycleState; supersedesId?: string; expiresAt?: number; createdAt: number; updatedAt: number;
}
export type WarmMemory = MemoryRecord | PreferenceRecord;
export interface TopicLifecycleState { deletedAt?: number; purgeAfter?: number; deleteReason?: string; previousStatus?: Exclude<MemoryStatus, "deleted"> }
export interface TopicDescriptor {
  topicId: string; kind: MemoryKind; scope: MemoryScope; title: string; description: string;
  aliases: string[]; entityIds: string[]; relatedTopicIds: string[]; coldRevisionId?: string;
  embeddingText: string; status: MemoryStatus; lifecycle?: TopicLifecycleState; createdAt: number; updatedAt: number;
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
export interface RecallRequest { access: AccessContext; cue: string; maxCards?: number; maxColdTopics?: number; maxColdTokens?: number; kinds?: MemoryKind[]; embeddingTimeoutMs?: number; signal: AbortSignal }
export type RetrievalChannel = "lexical" | "vector" | "topic" | "graph" | "canonical";
export interface RecallScoreBreakdown { route: number; confidence: number; importance: number; recency: number; scope: number; trust: number; validity: number; currentState: number; feedback: number; final: number }
export interface MemoryCard { id: string; kind: MemoryKind; tier: "hot" | "warm"; title: string; content: string; score: number; topicIds: string[]; confidence: number; sourceRefs: SourceReference[]; provenance?: MemoryProvenance; status: MemoryStatus; validFrom?: number; validTo?: number; semantic?: CanonicalSPO; retrievalChannels: RetrievalChannel[]; scoreBreakdown: RecallScoreBreakdown }
export interface RecallCandidateTrace { id: string; channels: RetrievalChannel[]; rawScores: Partial<Record<RetrievalChannel,number>>; finalScore?: number; scoreBreakdown?: RecallScoreBreakdown; outcome: "selected" | "below_threshold" | "domain_filtered" | "duplicate" | "conflict" | "policy_denied" | "mmr_dropped"; reason?: string }
export interface RecallTrace { version: 2; topicIds: string[]; candidateCount: number; deniedCount: number; embedding: { configured: boolean; degraded: boolean; generation?: string; error?: string }; policyTransforms: number; coldTopicRoutes: Array<{ topicId: string; channels: RetrievalChannel[]; selected: boolean; reason: string }>; candidates: RecallCandidateTrace[] }
export interface RecallResult { cards: MemoryCard[]; coldTopics: ColdTopicDocument[]; promptSection: string; trace: RecallTrace }
export interface CaptureRequest { access: AccessContext; sourceRefs: SourceReference[]; content?: string; idempotencyKey: string; requestedAt?: number; captureSource?: CaptureSource }
export interface CaptureJob { id: string; request: CaptureRequest; status: "queued" | "running" | "completed" | "completed_empty" | "retryable_failed" | "dead_letter"; attempts: number; leaseOwner?: string; leaseUntil?: number; leaseToken?: string; fencingToken?: number; errorCode?: string; extractedCount?: number; proposalCount?: number; persistedCount?: number; filterReasons?: Record<string,number>; createdAt: number; updatedAt: number }
export interface ForgetRequest { access: AccessContext; scope: MemoryScope; ids?: string[]; topicIds?: string[]; reason?: string; gracePeriodMs?: number }
export interface ForgetResult { records: number; topics: number; objects: number; purgeAfter?: number }
export interface RestoreMemoryRequest { access: AccessContext; scope: MemoryScope; ids?: string[]; topicIds?: string[] }
export interface RestoreMemoryResult { records: number; topics: number }
export type MemoryGovernanceAction = "approve" | "reject" | "correct" | "resolve";
export interface MemoryGovernanceRequest { access: AccessContext; scope: MemoryScope; id: string; action: MemoryGovernanceAction; content?: string; title?: string; reason?: string; resolution?: "accept" | "reject" }
export interface MemoryGovernanceReceipt { id: string; recordId: string; action: MemoryGovernanceAction; previousStatus: MemoryStatus; nextStatus: MemoryStatus; reason: string; actorId: string; createdAt: number }
export type RecallFeedbackSignal = "cited" | "helpful" | "confirmed" | "corrected" | "harmful" | "task_success" | "task_failure";
export interface RecallFeedbackReceipt { id: string; recordId: string; signal: RecallFeedbackSignal; weight: number; runId?: string; note?: string; actorId: string; createdAt: number }
export interface ReindexCheckpoint { phase: "scan_records" | "scan_topics" | "embed" | "activate" | "cleanup"; recordOffset: number; topicOffset: number; processed: number; indexed: number; skipped: number; failed: number; total?: number; rateLimitUntil?: number }
export interface ReindexJob { id: string; scope: MemoryScope; generation: string; status: "queued" | "running" | "ready" | "active" | "failed" | "cancelled"; checkpoint: ReindexCheckpoint; leaseOwner?: string; leaseUntil?: number; leaseToken?: string; fencingToken: number; errorCode?: string; createdAt: number; updatedAt: number; completedAt?: number }
export interface EmbeddingGenerationState { scope: MemoryScope; generation: string; status: "staging" | "ready" | "active" | "retired" | "failed"; expected: number; indexed: number; skipped: number; activatedAt?: number; updatedAt: number }
export interface CoreMemorySnapshot { scope: MemoryScope; revision: number; markdown: string; sourceRecordIds: string[]; checksum: string; tokenCount: number; generatedAt: number; editedAt?: number }

export interface MemoryMaintenanceResult { updated: number; stale: number; expired: number; purged: number }
export interface ExtractionProposal { records: WarmMemory[]; topics: TopicDescriptor[]; nodes: GraphNode[]; edges: GraphEdge[] }
