import type { ConsoleV1 } from "@tagent/abi";

export interface Session {
  id: string;
  title: string;
  modelId: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  createdAt: number;
  updatedAt: number;
  latestRunStatus: ConsoleV1.ConsoleTaskRun["status"] | null;
  latestRunPhase: ConsoleV1.ConsoleTaskRun["phase"] | null;
}

export type GateProfile = "off" | "relaxed" | "strict";

export interface SessionInboxItem {
  id: string;
  sessionId: string;
  content: string;
  status: "queued" | "claimed" | "started" | "routed" | "deleted" | "failed";
  decision: "pending" | "start_taskrun" | "steer" | "follow_up" | "discussion" | "defer" | "merge" | "delete";
  runId: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  analysis: {
    summary: string;
    intent: "steer_active" | "follow_up_active" | "update_active_context" | "new_task" | "parallel_task" | "merge_candidate" | "discussion" | "clarification" | "defer";
    targetRunId: string | null;
    priority: number;
    urgency: "low" | "normal" | "high" | "critical";
    relation: "same_goal" | "correction" | "constraint" | "follow_up" | "parallel" | "derived" | "depends_on" | "independent";
    acceptanceCriteria: string[];
    confidence: number;
    reason: string;
  };
}

export type Message = ConsoleV1.ConsoleMessage;
export type ContextManifest = ConsoleV1.ConsoleContextManifest;
export type Artifact = ConsoleV1.ConsoleArtifact;
export interface ArtifactContent extends Artifact { content: string; format: "markdown" | "text"; bytes: number; source: "inline" | "file" }
export type UserInputRequest = ConsoleV1.ConsoleUserInputRequest;
export type TaskRun = ConsoleV1.ConsoleTaskRun;

export interface TaskRunSummary {
  id: string;
  goal: string;
  status: TaskRun["status"];
  phase: TaskRun["phase"];
  attempt: number;
  createdAt: number;
  updatedAt: number;
}

export interface EventConsumerCursor { runId: string; consumerId: string; generation: number; ackedSeq: number; claimedAt: number; updatedAt: number }
export interface RunEvent { runId: string; seq: number; type: string; data: Record<string, unknown>; createdAt: number }
type TranscriptBase = { seq: number; index?: number; attempt: number; createdAt: number };
export type TranscriptItem =
  | (TranscriptBase & { kind: "user"; text: string })
  | (TranscriptBase & { kind: "assistant"; text: string })
  | (TranscriptBase & { kind: "thinking"; text: string; redacted: boolean })
  | (TranscriptBase & { kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; error?: { name: string; code: string; message: string }; status: string });

export type RuntimeStatus = import("@tagent/abi").AdminConfigStatus;
export type MemoryKind = ConsoleV1.ConsoleMemoryKind;
export type MemoryStatus = ConsoleV1.ConsoleMemoryStatus;
export type MemoryScope = ConsoleV1.ConsoleMemoryScope;
export type PreferenceRecord = ConsoleV1.ConsolePreferenceRecord;
export type WarmMemory = ConsoleV1.ConsoleWarmMemory;
export type TopicDescriptor = ConsoleV1.ConsoleTopicDescriptor;
export type ColdTopic = ConsoleV1.ConsoleColdTopic;
export type CaptureJob = ConsoleV1.ConsoleCaptureJob;
export type MemoryStatusResult = ConsoleV1.ConsoleMemoryStatusResult;
export type ReindexJob = ConsoleV1.ConsoleReindexJob;
export type CoreMemorySnapshot = ConsoleV1.ConsoleCoreMemorySnapshot;
export type RecallResult = ConsoleV1.ConsoleRecallResult;
