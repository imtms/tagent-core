import type { WarmMemory } from "./types.js";

export interface SemanticMemoryJudgeMetricsSnapshot {
  calls: number;
  cacheHits: number;
  failures: number;
  timeouts: number;
  lowConfidence: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
  averageLatencyMs: number;
  cacheHitRate: number;
}

export interface SemanticMemoryCaptureDecision {
  shouldCapture: boolean;
  durable: boolean;
  category: "fact" | "preference" | "episode" | "procedure" | "none";
  confidence: number;
  reason: string;
}

export interface SemanticMemoryQualityDecision {
  accept: boolean;
  confidence: number;
  reason: string;
  rejectionCode:
    | "none"
    | "one_off_request"
    | "operational_episode"
    | "semantic_inconsistent"
    | "unsupported_claim";
}

export interface SemanticMemoryQualityInput {
  source: string;
  record: WarmMemory;
}

export interface SemanticMemoryJudgePort {
  snapshot(): SemanticMemoryJudgeMetricsSnapshot;
  memoryCapture(content: string): Promise<SemanticMemoryCaptureDecision | undefined>;
  memoryQuality(input: SemanticMemoryQualityInput): Promise<SemanticMemoryQualityDecision | undefined>;
}
