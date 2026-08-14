import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { AgentService } from "@tagent/core-service/application";
import { Store } from "@tagent/persistence-sqlite/store";
import { InMemoryMemoryAdapter } from "../packages/memory/src/adapters/in-memory.js";
import { HashEmbeddingAdapter } from "../packages/memory/src/adapters/hash-embedding.js";
import { LocalBlobStore } from "../packages/memory/src/storage/local-blob-store.js";
import { DefaultPolicyEngine } from "../packages/memory/src/policy/policy-engine.js";
import { MemoryService } from "../packages/memory/src/memory-service.js";
import { composeWorkspaceTools, createLocalSubprocessPort } from "@tagent/workspace-local";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { agentPersistence, httpTestResources } from "./support/test-persistence.js";

const testSignal = new AbortController().signal;

const scope = { type: "workspace" as const, id: "issue-regressions" };
const access = { subjectId: "tester", scopes: [scope], purpose: "memory_admin" as const };

async function memoryFixture() {
  const adapter = new InMemoryMemoryAdapter();
  const service = new MemoryService({
    records: adapter, vectors: adapter, graph: adapter, topics: adapter,
    blobs: new LocalBlobStore(await mkdtemp(path.join(tmpdir(), "tagent-issues-memory-"))),
    embeddings: new HashEmbeddingAdapter(16), jobs: adapter, policy: new DefaultPolicyEngine(adapter),
  });
  return { adapter, service };
}

function waitingRuntime() {
  let resolve!: () => void;
  return {
    prompt: () => new Promise<void>((done) => { resolve = done; }),
    steer: async () => "accepted" as const,
    abort: () => resolve?.(), getMessages: () => [], getError: () => undefined,
    dispose: async () => { resolve?.(); },
  };
}

describe("GitHub issue regressions #24-#28", () => {
  it("#24 rejects empty forget at service, adapter, HTTP, and agent-tool boundaries without mutating records", async () => {
    const { adapter, service } = await memoryFixture();
    const now = Date.now();
    const record = { id: "24000000-0000-4000-8000-000000000024", kind: "fact" as const, tier: "warm" as const, scope, title: "safe", content: "must remain", summary: "safe", topicIds: [], entityIds: [], status: "active" as const, confidence: 1, importance: 1, sourceRefs: [], createdAt: now, updatedAt: now };
    await adapter.upsertRecords([record]);
    await expect(service.forget({ access, scope })).rejects.toThrow("requires at least one");
    await expect(adapter.forget([scope])).rejects.toThrow("requires at least one");
    expect(adapter.records.get(record.id)?.status).toBe("active");

    const store = new Store(":memory:");
    const app = createApp({ ...httpTestResources(store), service: { closeRuntimes: async () => undefined } as never, memory: service, logger: false });
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/memory/forget", payload: { scope } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "memory.forget_invalid", retryable: false } });
    await app.close();

    const capabilities = {
      runId: "00000000-0000-4000-8000-000000000024", getRun: () => ({ attempt: 1 }),
      isCurrentAttempt: () => true, authorizeExternalAction: () => ({ allowed: true, reason: "test" }),
      authorizeWorkspaceMutation: () => ({ allowed: true, reason: "test" }), advanceRunPhase: () => true, setRunPhase: () => true,
      claimOperation: () => ({ claimed: true, status: "running" }), updateOperation: () => ({}), listOperations: () => [], upsertPlanItem: () => ({}), markChecksStale: () => 0, upsertCheck: () => ({}), applyTaskRunBatch: () => undefined, addArtifact: () => ({}), requestUserInput: () => { throw new Error("unused"); }, publish: () => undefined,
      recordToolAttempt: () => ({ created: true, status: "running", guard: { blocked: false, reason: "" } }), completeToolAttempt: () => true, consumeAtomicallySettledToolCall: () => false,
      memory: { search: async () => [], getTopic: async () => undefined, getRecord: async () => undefined, forget: vi.fn(async () => ({})) },
    } as unknown as ToolCapabilityApplicationPort;
    const tool = composeWorkspaceTools(capabilities, await mkdtemp(path.join(tmpdir(), "tagent-issues-tools-")), createLocalSubprocessPort()).catalog.tools.find((item) => item.name === "memory_forget")!;
    await expect(tool.execute("empty-forget", {} as never, testSignal)).rejects.toThrow("requires at least one");
    expect(capabilities.memory!.forget).not.toHaveBeenCalled();
  });

  it("#25 restores records associated with a forgotten Topic", async () => {
    const { adapter, service } = await memoryFixture();
    const now = Date.now();
    const topic = { topicId: "topic.restore", kind: "fact" as const, scope, title: "Restore Topic", description: "restore topic", summary: "restore topic", aliases: [], keywords: ["restore"], entityIds: [], relatedTopicIds: [], embeddingText: "restore", status: "active" as const, createdAt: now, updatedAt: now };
    const record = { id: "25000000-0000-4000-8000-000000000025", kind: "fact" as const, tier: "warm" as const, scope, title: "topic record", content: "restored content", summary: "restore", topicIds: [topic.topicId], entityIds: [], status: "active" as const, confidence: 1, importance: 1, sourceRefs: [], createdAt: now, updatedAt: now };
    await adapter.upsertDescriptors([topic]);
    await adapter.stageRevision({ id: "topic-restore-revision", topicId: topic.topicId, kind: topic.kind, scope, revision: 1, state: "staged", objectKey: "topic.restore/revision.md", checksum: "checksum", byteLength: 1, tokenCount: 1, createdAt: now });
    await adapter.publishRevision(topic.topicId, "topic-restore-revision");
    await adapter.upsertRecords([record]);
    expect(await service.forget({ access, scope, topicIds: [topic.topicId], gracePeriodMs: 60_000 })).toMatchObject({ records: 1, topics: 1 });
    expect(adapter.records.get(record.id)?.status).toBe("deleted");
    expect(await service.restore({ access, scope, topicIds: [topic.topicId] })).toEqual({ records: 1, topics: 1 });
    expect(adapter.records.get(record.id)?.status).toBe("active");
    expect(adapter.topics.get(topic.topicId)?.status).toBe("active");
  });

  it("#26 terminalizes a TaskRun when runtime construction throws", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), await mkdtemp(path.join(tmpdir(), "tagent-issues-runtime-")), () => { throw new Error("factory exploded"); });
    const result = await service.enqueueSessionInput(session.id, "runtime factory regression", "issue-26");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getRun(result.run!.id)).toMatchObject({ status: "failed", blockedReason: "factory exploded" });
    expect(store.db.prepare("SELECT status, active FROM attempts WHERE run_id = ?").get(result.run!.id)).toMatchObject({ status: "failed", active: 0 });
    expect(store.getCheckpoint(result.run!.id)?.active ?? false).toBe(false);
    expect(service.cancel(result.run!.id)).toBe(false);
    store.close();
  });

  it("#27 maps malformed console pagination limits to non-retryable HTTP 400", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), await mkdtemp(path.join(tmpdir(), "tagent-issues-http-")), () => waitingRuntime());
    const app = createApp({ ...httpTestResources(store), service, logger: false });
    for (const suffix of [`messages?limit=abc`, `messages?limit=1.5`, `messages?limit=0`, `messages?limit=201`, `task-runs?limit=NaN`]) {
      const response = await app.inject({ method: "GET", url: `/api/v1/console/sessions/${session.id}/${suffix}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "pagination.limit_invalid", retryable: false } });
    }
    await app.close();
  });

  it("#28 returns the same result for identical retries and deterministic 409 for conflicting sequential/concurrent payloads", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), await mkdtemp(path.join(tmpdir(), "tagent-issues-idempotency-")), () => waitingRuntime());
    const app = createApp({ ...httpTestResources(store), service, logger: false });
    const post = (content: string) => app.inject({ method: "POST", url: `/api/v1/console/sessions/${session.id}/messages`, payload: { content, requestId: "issue-28-key" } });
    const first = await post("first payload");
    const replay = await post("first payload");
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.item.id).toBe(first.json().data.item.id);
    expect(store.getSessionPrincipalId(session.id)).toBe("local-admin");
    const sequentialConflict = await post("second payload");
    expect(sequentialConflict.statusCode).toBe(409);
    expect(sequentialConflict.json()).toMatchObject({ error: { code: "submission.idempotency_conflict", retryable: false } });

    const secondSession = store.createSession();
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: `/api/v1/console/sessions/${secondSession.id}/messages`, payload: { content: "alpha", requestId: "concurrent-key" } }),
      app.inject({ method: "POST", url: `/api/v1/console/sessions/${secondSession.id}/messages`, payload: { content: "beta", requestId: "concurrent-key" } }),
    ]);
    expect(concurrent.map((response: { statusCode: number }) => response.statusCode).sort()).toEqual([200, 409]);
    expect(store.listSessionInbox(secondSession.id, true)).toHaveLength(1);
    await service.closeRuntimes();
    await app.close();
  });
});
