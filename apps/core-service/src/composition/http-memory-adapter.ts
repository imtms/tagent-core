import type { HttpMemoryPort } from "@tagent/http-fastify/ports";
import type { MemoryFacade } from "@tagent/memory";

export function assembleHttpMemory(memory: MemoryFacade): HttpMemoryPort {
  const adapter: HttpMemoryPort = {
    enqueueCapture: (request) => memory.enqueueCapture(request as Parameters<MemoryFacade["enqueueCapture"]>[0]),
    listCaptureJobs: memory.listCaptureJobs
      ? (access, limit) => memory.listCaptureJobs!(access, limit)
      : undefined,
    status: (access) => memory.status(access),
    recall: (request, signal) => memory.recall({
      ...(request as Omit<Parameters<MemoryFacade["recall"]>[0], "signal">),
      signal,
    }),
    getRecord:(access,id)=>memory.getRecord(access,id),
    getColdTopic: (access, topicId) => memory.getColdTopic(access, topicId),
    upsert: (access, records, topics) => memory.upsert(
      access,
      records as Parameters<MemoryFacade["upsert"]>[1],
      topics as Parameters<MemoryFacade["upsert"]>[2],
    ),
    export: (access, scope, limit) => memory.export(access, scope, limit),
    listRecordsPage: (access, scope, query) => memory.listRecordsPage(access, scope, query),
    listTopicsPage:(access,scope,query)=>memory.listTopicsPage(access,scope,query),
    forget: (request) => memory.forget(request as Parameters<MemoryFacade["forget"]>[0]),
    restore: (request) => memory.restore(request as Parameters<MemoryFacade["restore"]>[0]),
    enqueueReindex: memory.enqueueReindex
      ? (access) => memory.enqueueReindex!(access)
      : undefined,
    listReindexJobs: memory.listReindexJobs
      ? (access, limit) => memory.listReindexJobs!(access, limit)
      : undefined,
    govern: memory.govern
      ? (request) => memory.govern!(request as Parameters<NonNullable<MemoryFacade["govern"]>>[0])
      : undefined,
    feedback: memory.feedback
      ? (access, scope, recordId, signal, options) => memory.feedback!(
        access,
        scope,
        recordId,
        signal as Parameters<NonNullable<MemoryFacade["feedback"]>>[3],
        options,
      )
      : undefined,
    getCoreSnapshot: memory.getCoreSnapshot
      ? (access, signal) => memory.getCoreSnapshot!(access, signal)
      : undefined,
    generateCoreSnapshot: memory.generateCoreSnapshot
      ? (access) => memory.generateCoreSnapshot!(access)
      : undefined,
    updateCoreSnapshot: memory.updateCoreSnapshot
      ? (access, markdown) => memory.updateCoreSnapshot!(access, markdown)
      : undefined,
    readiness: (access) => memory.readiness(access),
  };
  return Object.freeze(adapter);
}
