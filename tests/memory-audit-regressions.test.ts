import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryMemoryAdapter } from "../packages/memory/src/adapters/in-memory.js";
import { HybridExtractor } from "../packages/memory/src/adapters/llm-extractor.js";
import { RuleBasedExtractor } from "../packages/memory/src/adapters/rule-extractor.js";
import { MemoryCaptureWorker } from "../packages/memory/src/capture-worker.js";
import { CoreMemorySnapshotService } from "../packages/memory/src/core-snapshot.js";
import { MemoryLifecycle } from "../packages/memory/src/lifecycle.js";
import { MemoryService } from "../packages/memory/src/memory-service.js";
import { DefaultPolicyEngine } from "../packages/memory/src/policy/policy-engine.js";
import { ColdStorageReconciler } from "../packages/memory/src/reconciler.js";
import { LocalBlobStore } from "../packages/memory/src/storage/local-blob-store.js";
import type { AccessContext, GraphEdge, GraphNode, PreferenceRecord, TopicDescriptor, WarmMemory } from "../packages/memory/src/types.js";

const scope = { type: "user" as const, id: "memory-audit-user" };
const access: AccessContext = { subjectId: scope.id, scopes: [scope], purpose: "capture" };

async function createService(options: { embeddings?: { generation: string; embed(): Promise<number[][]> }; core?: CoreMemorySnapshotService } = {}) {
  const adapter = new InMemoryMemoryAdapter();
  const blobs = new LocalBlobStore(await mkdtemp(path.join(tmpdir(), "tagent-memory-audit-")));
  const policy = new DefaultPolicyEngine(adapter);
  const service = new MemoryService({
    records: adapter,
    vectors: adapter,
    graph: adapter,
    topics: adapter,
    blobs,
    embeddings: options.embeddings,
    jobs: adapter,
    policy,
    reindex: adapter,
    coreSnapshots: options.core ? {
      get: (value) => options.core!.get(value),
      generate: (value, generationOptions) => options.core!.generate(value, generationOptions),
      update: (value, markdown) => options.core!.update(value, markdown),
    } : undefined,
  });
  return { adapter, blobs, policy, service };
}

function preference(id: string, value: string, object: string, sourceId = id): PreferenceRecord {
  const now = Date.now();
  return {
    id,
    kind: "preference",
    tier: "hot",
    scope,
    dimension: "food",
    value,
    summary: value,
    topicIds: [`${scope.type}.${scope.id}.preference.food`],
    entityIds: [],
    applicability: "global",
    strength: 0.9,
    origin: "explicit",
    status: "active",
    confidence: 0.95,
    semantic: { subject: "用户", predicate: "偏好食物", object, polarity: "positive" },
    sourceRefs: [{ sourceType: "message", sourceId }],
    lifecycle: { firstSeenAt: now, lastSeenAt: now, confirmationCount: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

function fact(id: string, topicId: string, entityIds: string[] = []): WarmMemory {
  const now = Date.now();
  return {
    id,
    kind: "fact",
    tier: "warm",
    scope,
    title: "User identity",
    content: "用户姓名或称呼是 SecretName",
    summary: "用户姓名或称呼是 SecretName",
    topicIds: [topicId],
    entityIds,
    status: "active",
    confidence: 0.99,
    importance: 1,
    provenance: { evidenceClass: "user_explicit", trustLevel: "high", sourceRole: "user", verificationState: "explicit", sourceReliability: 1 },
    semantic: { subject: "用户", predicate: "identity", object: "SecretName", polarity: "positive" },
    sourceRefs: [{ sourceType: "message", sourceId: id }],
    createdAt: now,
    updatedAt: now,
  };
}

describe("Memory audit regressions", () => {
  it("extracts only focus_user when deterministic capture receives context wrappers", async () => {
    const proposal = await new HybridExtractor(new RuleBasedExtractor()).extract(
      "<context>\nuser: 我叫旧名字\nassistant: 好的\n</context>\n<focus_user>\n我叫新名字\n</focus_user>",
      [{ sourceType: "message", sourceId: "focus" }],
      scope,
    );
    const contents = proposal.records.flatMap((record) => record.kind === "fact" ? [record.content] : []);
    expect(contents).toEqual([expect.stringContaining("新名字")]);
    expect(contents.join(" ")).not.toContain("旧名字");
  });

  it("keeps independent multi-value preferences and does not strengthen a same-source retry", async () => {
    const adapter = new InMemoryMemoryAdapter();
    const lifecycle = new MemoryLifecycle(adapter, adapter, adapter, adapter);
    const apple = preference("10000000-0000-4000-8000-000000000001", "用户喜欢苹果", "苹果", "same-source");
    await adapter.upsertRecords([apple]);
    const retry = await lifecycle.integrate(access, { records: [{ ...apple, id: "10000000-0000-4000-8000-000000000002" }], topics: [], nodes: [], edges: [] });
    expect(retry.records[0]).toMatchObject({ id: apple.id, tier: "hot", strength: 0.9, confidence: 0.95 });
    expect(retry.records[0].lifecycle?.confirmationCount).toBe(1);
    const banana = preference("10000000-0000-4000-8000-000000000003", "用户喜欢香蕉", "香蕉");
    const integrated = await lifecycle.integrate(access, { records: [banana], topics: [], nodes: [], edges: [] });
    expect(integrated.records).toEqual([expect.objectContaining({ id: banana.id, status: "active" })]);
  });

  it("backs off a transient capture failure instead of exhausting retries in one poll", async () => {
    const { adapter, policy, service } = await createService();
    const queued = await service.enqueueCapture({ access, sourceRefs: [], content: "user: durable fact", idempotencyKey: "transient-retry" });
    const worker = new MemoryCaptureWorker(adapter, { load: async () => "" }, { extract: async () => { throw new Error("temporary"); } }, policy, service);
    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(worker.runOnce()).resolves.toBe(false);
    expect(adapter.jobs.get(queued.jobId)).toMatchObject({ status: "retryable_failed", attempts: 1 });
  });

  it("does not write graph projections before the final write policy allows evidence", async () => {
    const { adapter, blobs } = await createService();
    const denyWrites = { evaluate: async (stage: string, _access: AccessContext, payload: { text: string; scope: unknown }) => stage === "write" ? { action: "deny" as const, payload, reasonCodes: ["test"], policyVersion: "test" } : { action: "allow" as const, payload, reasonCodes: [], policyVersion: "test" } } as never;
    const service = new MemoryService({ records: adapter, vectors: adapter, graph: adapter, topics: adapter, blobs, jobs: adapter, policy: denyWrites });
    const lifecycle = new MemoryLifecycle(adapter, adapter, adapter, adapter);
    const node: GraphNode = { id: `${scope.type}:${scope.id}:entity:denied`, type: "concept", canonicalName: "denied", aliases: [], scope };
    const edge: GraphEdge = { id: `${scope.type}:${scope.id}:edge:denied`, fromId: node.id, predicate: "uses", toId: node.id, scope, confidence: 1, status: "active" };
    const integrated = await lifecycle.integrate(access, { records: [fact("10000000-0000-4000-8000-000000000004", "denied-topic", [node.id])], topics: [], nodes: [node], edges: [edge] });
    await service.persistExtracted(access, integrated.records, integrated.topics, [node], [edge]);
    expect(adapter.records.size).toBe(0);
    expect(adapter.nodes.size).toBe(0);
    expect(adapter.edges.size).toBe(0);
  });

  it("invalidates Cold, Core, graph, and vectors immediately when a record is forgotten", async () => {
    const adapter = new InMemoryMemoryAdapter();
    const core = new CoreMemorySnapshotService(adapter, adapter);
    const blobs = new LocalBlobStore(await mkdtemp(path.join(tmpdir(), "tagent-memory-forget-")));
    const composed = new MemoryService({ records: adapter, vectors: adapter, graph: adapter, topics: adapter, blobs, jobs: adapter, policy: new DefaultPolicyEngine(adapter), coreSnapshots: { get: (value) => core.get(value), generate: (value, options) => core.generate(value, options), update: (value, markdown) => core.update(value, markdown) } });
    const topicId = `${scope.type}.${scope.id}.fact.identity`, entityIds = [`${scope.type}:${scope.id}:entity:user`, `${scope.type}:${scope.id}:entity:name`], record = fact("10000000-0000-4000-8000-000000000005", topicId, entityIds);
    const descriptor: TopicDescriptor = { topicId, kind: "fact", scope, title: "Identity", description: record.kind === "preference" ? record.value : record.content, aliases: ["SecretName"], entityIds, relatedTopicIds: [], embeddingText: "SecretName identity", status: "active", updatedAt: Date.now() };
    const nodes: GraphNode[] = entityIds.map((id, index) => ({ id, type: index ? "person" : "user", canonicalName: index ? "SecretName" : "用户", aliases: [], scope }));
    const edge: GraphEdge = { id: `${scope.type}:${scope.id}:edge:identity`, fromId: entityIds[0], predicate: "called", toId: entityIds[1], scope, confidence: 1, status: "active" };
    await composed.persistExtracted(access, [record], [descriptor], nodes, [edge]);
    const published = await composed.publishColdTopic(access, descriptor, "# Identity\n\nSecretName is the remembered name.");
    expect((await composed.getCoreSnapshot(access))?.markdown).toContain("SecretName");
    expect(await composed.getColdTopic(access, topicId)).not.toBeNull();
    const budgeted = await composed.recall({ access, cue: "SecretName", maxColdTokens: 0 });
    expect(budgeted.coldTopics).toEqual([]);
    expect(budgeted.trace.coldTopicRoutes).toContainEqual(expect.objectContaining({ topicId, selected: false, reason: "cold token budget exceeded" }));
    await composed.forget({ access: { ...access, purpose: "memory_admin" }, scope, ids: [record.id], gracePeriodMs: 0 });
    expect(await composed.getColdTopic(access, topicId)).toBeNull();
    expect((await composed.getCoreSnapshot(access))?.markdown).not.toContain("SecretName");
    expect(adapter.edges.size).toBe(0);
    expect([...adapter.vectors.values()].some((vector) => vector.refId === record.id || vector.refId === topicId)).toBe(false);
    expect(adapter.topics.get(topicId)?.status).toBe("deleted");
    await new ColdStorageReconciler(adapter, blobs).purgeExpired(access);
    expect(await blobs.exists(published.revision.objectKey)).toBe(false);
    expect(adapter.topics.has(topicId)).toBe(false);
  });

  it("removes record and topic vectors when forgetting by topic only", async () => {
    const { adapter, service } = await createService({
      embeddings: {
        generation: "topic-forget-generation",
        embed: async () => [[1, 0], [0, 1]],
      },
    });
    const topicId = `${scope.type}.${scope.id}.fact.topic-forget`;
    const record = fact("10000000-0000-4000-8000-000000000009", topicId);
    const descriptor: TopicDescriptor = {
      topicId,
      kind: "fact",
      scope,
      title: "Topic-only forget",
      description: record.kind === "preference" ? record.value : record.content,
      aliases: [],
      entityIds: [],
      relatedTopicIds: [],
      embeddingText: "topic-only forget",
      status: "active",
      updatedAt: Date.now(),
    };
    await service.persistExtracted(access, [record], [descriptor]);
    expect([...adapter.vectors.values()].map((vector) => vector.refId)).toEqual(expect.arrayContaining([record.id, topicId]));

    await service.forget({ access: { ...access, purpose: "memory_admin" }, scope, topicIds: [topicId] });

    expect(adapter.records.get(record.id)?.status).toBe("deleted");
    expect([...adapter.vectors.values()].some((vector) => vector.refId === record.id || vector.refId === topicId)).toBe(false);
  });

  it("queues a repair reindex when incremental embedding fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { adapter, service } = await createService({ embeddings: { generation: "broken-generation", embed: async () => { throw new Error("provider down"); } } });
      await service.persistExtracted(access, [fact("10000000-0000-4000-8000-000000000006", "repair-topic")], []);
      expect(await adapter.listReindexJobs([scope])).toEqual([expect.objectContaining({ generation: "broken-generation", status: "queued" })]);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves manual Core text during automatic sync but allows explicit regeneration", async () => {
    const adapter = new InMemoryMemoryAdapter();
    const core = new CoreMemorySnapshotService(adapter, adapter);
    const first = fact("10000000-0000-4000-8000-000000000007", "core-one");
    await adapter.upsertRecords([first]);
    await core.generate(access);
    await core.update(access, "# My Core\n\nKeep this manual note.\n");
    const second = { ...fact("10000000-0000-4000-8000-000000000008", "core-two"), content: "用户姓名或称呼是 AnotherName", summary: "用户姓名或称呼是 AnotherName" };
    await adapter.upsertRecords([second]);
    const synchronized = await core.generate(access);
    expect(synchronized.markdown).toContain("Keep this manual note");
    expect((await core.generate(access)).revision).toBe(synchronized.revision);
    const forced = await core.generate(access, { force: true });
    expect(forced.markdown).not.toContain("Keep this manual note");
    expect(forced.markdown).toContain("AnotherName");
  });
});
