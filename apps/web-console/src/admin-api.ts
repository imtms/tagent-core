import { ConsoleDecode } from "@tagent/core-client";
import { createRequestId } from "./id";
import type { ApiRequest } from "./api-transport";
import type { MemoryKind, MemoryScope } from "./api-types";

export function createAdminApi(request: ApiRequest) {
  return {
    status: () => request("/api/v1/admin/config/status", undefined, ConsoleDecode.runtimeStatus),
    memoryJobs: (scope: MemoryScope) => request("/api/v1/admin/memory/jobs", { method: "POST", body: JSON.stringify({ scopes: [scope], limit: 100 }) }, ConsoleDecode.captureJobs),
    memoryStatus: (scope: MemoryScope) => request("/api/v1/admin/memory/status", { method: "POST", body: JSON.stringify({ scopes: [scope] }) }, ConsoleDecode.memoryStatus),
    memoryExport: (scope: MemoryScope, limit = 200) => request("/api/v1/admin/memory/export", { method: "POST", body: JSON.stringify({ scope, limit }) }, ConsoleDecode.memoryExport),
    memoryRecordsPage:(scope:MemoryScope,query:{snapshotCreatedAt?:number;after?:{createdAt:number;id:string};limit?:number}={})=>request("/api/v1/admin/memory/records/page",{method:"POST",body:JSON.stringify({scope,...query})},ConsoleDecode.memoryRecordPage),
    memoryTopicsPage:(scope:MemoryScope,query:{snapshotCreatedAt?:number;after?:{createdAt:number;topicId:string};limit?:number}={})=>request("/api/v1/admin/memory/topics/page",{method:"POST",body:JSON.stringify({scope,...query})},ConsoleDecode.memoryTopicPage),
    memoryRecord:(scope:MemoryScope,id:string)=>request("/api/v1/admin/memory/record",{method:"POST",body:JSON.stringify({scope,id})},ConsoleDecode.memoryRecord),
    memoryTopic:(scope:MemoryScope,topicId:string)=>request("/api/v1/admin/memory/topic",{method:"POST",body:JSON.stringify({scope,topicId})},ConsoleDecode.coldTopic),
    memoryRecall: (scope: MemoryScope, cue: string, kinds?: MemoryKind[]) => request("/api/v1/admin/memory/recall-console", { method: "POST", body: JSON.stringify({ scopes: [scope], cue, kinds, maxCards: 12, maxColdTopics: 4 }) }, ConsoleDecode.recallResult),
    memoryCapture: (scope: MemoryScope, content: string) => request("/api/v1/admin/memory/capture", { method: "POST", body: JSON.stringify({ scope, content, idempotencyKey: createRequestId() }) }, ConsoleDecode.captureJobId),
    memoryReindex: (scope: MemoryScope) => request("/api/v1/admin/memory/reindex", { method: "POST", body: JSON.stringify({ scope }) }, ConsoleDecode.reindexJob),
    memoryReindexJobs: (scope: MemoryScope) => request("/api/v1/admin/memory/reindex/jobs", { method: "POST", body: JSON.stringify({ scopes: [scope], limit: 20 }) }, ConsoleDecode.reindexJobs),
    memoryGovern: (scope: MemoryScope, id: string, action: "approve" | "reject" | "correct" | "resolve", options: Record<string, unknown> = {}) => request("/api/v1/admin/memory/govern", { method: "POST", body: JSON.stringify({ scope, id, action, ...options }) }, ConsoleDecode.jsonObject),
    memoryFeedback: (scope: MemoryScope, recordId: string, signal: "helpful" | "confirmed" | "harmful") => request("/api/v1/admin/memory/feedback", { method: "POST", body: JSON.stringify({ scope, recordId, signal }) }, ConsoleDecode.jsonObject),
    memoryCoreSnapshot: (scope: MemoryScope, options: Record<string, unknown> = {}) => request("/api/v1/admin/memory/core-snapshot", { method: "POST", body: JSON.stringify({ scope, ...options }) }, ConsoleDecode.coreMemorySnapshot),
    memoryRestore: (scope: MemoryScope, ids?: string[], topicIds?: string[]) => request("/api/v1/admin/memory/restore", { method: "POST", body: JSON.stringify({ scope, ids, topicIds }) }, ConsoleDecode.jsonObject),
    memoryForget: (scope: MemoryScope, ids?: string[], topicIds?: string[], reason = "forgotten_from_web_console") => request("/api/v1/admin/memory/forget", { method: "POST", body: JSON.stringify({ scope, ids, topicIds, reason }) }, ConsoleDecode.forgetResult),
  };
}
