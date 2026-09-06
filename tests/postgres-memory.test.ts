import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { PostgresMemoryAdapter } from "../packages/memory/src/postgres/postgres-adapter.js";
import { LocalBlobStore } from "../packages/memory/src/storage/local-blob-store.js";
import { DefaultPolicyEngine } from "../packages/memory/src/policy/policy-engine.js";
import { HashEmbeddingAdapter } from "../packages/memory/src/adapters/hash-embedding.js";
import { MemoryService } from "@tagent/memory";

const configuredUrl = process.env.TAGENT_TEST_POSTGRES_URL;
const databaseName = configuredUrl ? decodeURIComponent(new URL(configuredUrl).pathname.slice(1)) : "";
if (configuredUrl && !/(?:^|[_-])test(?:$|[_-])/i.test(databaseName)) {
  throw new Error(`TAGENT_TEST_POSTGRES_URL must target a test-named database, received ${databaseName || "<empty>"}`);
}
const suite = configuredUrl ? describe : describe.skip;
const testSignal = new AbortController().signal;

suite("PostgreSQL memory adapter", () => {
  let adapter: PostgresMemoryAdapter;
  let service: MemoryService;
  let coldPath: string | undefined;
  const scope = { type: "workspace" as const, id: `test-${crypto.randomUUID()}` };
  const access = { subjectId: "integration", scopes: [scope], purpose: "agent_recall" as const };

  beforeAll(async () => {
    adapter = new PostgresMemoryAdapter(configuredUrl!);
    await adapter.initializeSchema();
    coldPath = await mkdtemp(path.join(tmpdir(), "tagent-pg-cold-"));
    service = new MemoryService({
      records: adapter,
      vectors: adapter,
      graph: adapter,
      topics: adapter,
      blobs: new LocalBlobStore(coldPath!),
      embeddings: new HashEmbeddingAdapter(16),
      jobs: adapter,
      policy: new DefaultPolicyEngine(adapter),
    });
  });

  afterAll(async () => {
    const pool = new Pool({ connectionString: configuredUrl! });
    try {
      await pool.query("BEGIN");
      await pool.query("UPDATE memory.topics SET current_cold_revision=NULL WHERE scope_type=$1 AND scope_id=$2", [scope.type, scope.id]);
      for (const table of ["cold_revisions", "embeddings", "edges", "entities", "preferences", "records", "topics", "reindex_jobs", "embedding_generations"]) {
        await pool.query(`DELETE FROM memory.${table} WHERE scope_type=$1 AND scope_id=$2`, [scope.type, scope.id]);
      }
      await pool.query("DELETE FROM memory.capture_jobs WHERE request->'access'->'scopes' @> $1::jsonb", [JSON.stringify([scope])]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    } finally {
      await pool.end();
      await adapter.close();
      if (coldPath) await rm(coldPath, { recursive: true, force: true });
    }
  });

  it("persists, vectors, publishes cold, recalls, and claims durable jobs", async () => {
    const now = Date.now();
    await service.persistExtracted(access, [{
      id: crypto.randomUUID(), kind: "fact", tier: "warm", scope, title: "PostgreSQL memory",
      content: "tagent memory uses PostgreSQL and pgvector", summary: "PostgreSQL pgvector",
      topicIds: [`tagent.memory.postgres.${scope.id}`], entityIds: [], status: "active",
      confidence: 1, importance: 1, sourceRefs: [], createdAt: now, updatedAt: now,
    }], []);
    const descriptor = {
      topicId: `tagent.memory.postgres.${scope.id}`, kind: "fact" as const, scope, title: "PostgreSQL memory",
      description: "PostgreSQL pgvector storage", aliases: ["memory database"], entityIds: [], relatedTopicIds: [],
      embeddingText: "PostgreSQL pgvector memory", status: "active" as const, createdAt: now, updatedAt: now,
    };
    await service.publishColdTopic(access, descriptor, "# PostgreSQL memory\n\nCold is read in full.");
    const recalled = await service.recall({ access, cue: "PostgreSQL pgvector", maxColdTopics: 1, signal: testSignal });
    expect(recalled.cards[0].content).toContain("pgvector");
    expect(recalled.coldTopics[0].body).toContain("read in full");
    const exported = await service.export(access, scope);
    expect(exported.records.some((record) => record.id === recalled.cards[0].id)).toBe(true);
    expect(exported.topics.some((topic) => topic.descriptor.topicId === descriptor.topicId)).toBe(true);
    const queued = await service.enqueueCapture({ access, sourceRefs: [], content: "User prefers concise answers", idempotencyKey: `job-${scope.id}` });
    expect(await service.listCaptureJobs(access, 10)).toEqual([
      expect.objectContaining({ id: queued.jobId, status: "queued" }),
    ]);
    const claimed = await adapter.claim("test", 1000);
    expect(claimed?.id).toBe(queued.jobId);
    await adapter.complete(queued.jobId,"test",claimed!.leaseToken!,claimed!.fencingToken!);
    const forgotten = await service.forget({ access, scope, ids: [recalled.cards[0].id] });
    expect(forgotten.records).toBe(1);
    expect((await service.recall({ access, cue: "PostgreSQL pgvector", maxColdTopics: 0, signal: testSignal })).cards).toEqual([]);
  });

  it("restores a retained whole-Topic Cold revision without reviving a partially invalidated page", async () => {
    const now = Date.now();
    const topicId = `tagent.memory.restore.${scope.id}`;
    const descriptor = {
      topicId, kind: "fact" as const, scope, title: "Restorable Cold Topic",
      description: "Two details", aliases: [], entityIds: [], relatedTopicIds: [],
      embeddingText: "restorable cold topic", status: "active" as const, createdAt: now, updatedAt: now,
    };
    const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
    await service.persistExtracted(access, [
      { id: firstId, kind: "fact", tier: "warm", scope, title: "Detail one", content: "Retained detail one", summary: "Retained detail one", topicIds: [topicId], entityIds: [], status: "active", confidence: 1, importance: 1, sourceRefs: [], createdAt: now, updatedAt: now },
      { id: secondId, kind: "fact", tier: "warm", scope, title: "Detail two", content: "Retained detail two", summary: "Retained detail two", topicIds: [topicId], entityIds: [], status: "active", confidence: 1, importance: 1, sourceRefs: [], createdAt: now + 1, updatedAt: now + 1 },
    ], [descriptor]);
    const body = "# Restorable Cold Topic\n\nRetained detail one. Retained detail two.";
    const published = await service.publishColdTopic(access, descriptor, body);

    await service.forget({ access: { ...access, purpose: "memory_admin" }, scope, topicIds: [topicId], gracePeriodMs: 60_000 });
    expect(await service.getColdTopic(access, topicId)).toBeNull();
    expect(await service.restore({ access, scope, topicIds: [topicId] })).toEqual({ records: 2, topics: 1 });
    expect(await service.getColdTopic(access, topicId)).toMatchObject({ body, revision: { id: published.revision.id } });

    await service.forget({ access: { ...access, purpose: "memory_admin" }, scope, ids: [firstId], gracePeriodMs: 60_000 });
    expect(await service.restore({ access, scope, ids: [firstId] })).toEqual({ records: 1, topics: 0 });
    expect(await service.getColdTopic(access, topicId)).toBeNull();
  });

  it("extracts graph projections and promotes records through the local lifecycle", async () => {
    const { RuleBasedExtractor } = await import("../packages/memory/src/adapters/rule-extractor.js");
    const { MemoryLifecycle } = await import("../packages/memory/src/lifecycle.js");
    const proposal = await new RuleBasedExtractor().extract("tagent-core uses PostgreSQL database. tagent-core depends on pgvector.", [], scope);
    const lifecycle = new MemoryLifecycle(adapter, adapter, adapter, adapter, { warmAfterMs: 0, coldMinimumRecords: 1 });
    const integrated = await lifecycle.integrate(access, proposal);
    await service.persistExtracted(access, integrated.records, integrated.topics, proposal.nodes, proposal.edges);
    await lifecycle.promote(access);
    const entities = await adapter.resolveEntities("tagent-core", [scope], 10);
    expect(entities.length).toBeGreaterThan(0);
    const graph = await adapter.neighborhood(entities.map((item) => item.id), [scope], 2, 20);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect((await lifecycle.topicCandidates(access)).length).toBeGreaterThan(0);
  });

  it("pages every record beyond 500 with immutable creation-order cursors", async () => {
    const base = Date.now();
    const existing = await adapter.list([scope], undefined, 10_000);
    const records = Array.from({ length: 501 }, (_, index) => ({
      id: crypto.randomUUID(), kind: "fact" as const, tier: "warm" as const, scope,
      title: `Paged record ${index}`, content: `Paged content ${index}`, summary: `Paged ${index}`,
      topicIds: [], entityIds: [], status: "active" as const, confidence: 1, importance: 1,
      sourceRefs: [], createdAt: base + index, updatedAt: base + index,
    }));
    await adapter.upsertRecords(records);
    const ids: string[] = [];
    let snapshotCreatedAt: number | undefined;
    let after: { createdAt: number; id: string } | undefined;
    do {
      const page = await service.listRecordsPage(access, scope, { snapshotCreatedAt, after, limit: 201 });
      snapshotCreatedAt = page.snapshotCreatedAt;
      const items = page.records.slice(0, 200);
      ids.push(...items.map((record) => record.id));
      if (ids.length === 200) {
        await adapter.upsertRecords([{ ...records[0], updatedAt: base + 10_000 }]);
      }
      const last = items.at(-1);
      after = page.records.length > 200 && last ? { createdAt: last.createdAt, id: last.id } : undefined;
    } while (after);
    expect(ids).toHaveLength(existing.length + records.length);
    expect(new Set(ids).size).toBe(existing.length + records.length);
    expect(records.every((record) => ids.includes(record.id))).toBe(true);
  });

  it("atomically rejects PostgreSQL vector writes from a reclaimed reindex lease", async () => {
    const generation = `fenced-${crypto.randomUUID()}`;
    const job = await adapter.enqueueReindex(scope, generation);
    const stale = await adapter.claimReindex("worker-a", 60_000);
    expect(stale?.id).toBe(job.id);
    await adapter.pool.query("UPDATE memory.reindex_jobs SET lease_until=$2 WHERE id=$1", [job.id, Date.now() - 1]);
    const fresh = await adapter.claimReindex("worker-b", 60_000);
    expect(fresh).toMatchObject({ id: job.id, fencingToken: stale!.fencingToken + 1 });
    const document = {
      refType: "warm_record" as const, refId: crypto.randomUUID(), scope, kind: "fact" as const,
      text: "fresh", vector: [2], generation, contentHash: "fresh-hash",
    };

    const second = { ...document, refId: crypto.randomUUID(), text: "second", contentHash: "second-hash" };
    await expect(adapter.upsertReindexVectors(job.id, "worker-b", fresh!.leaseToken!, fresh!.fencingToken, [document, second])).resolves.toBe(true);
    await expect(adapter.upsertReindexVectors(job.id, "worker-a", stale!.leaseToken!, stale!.fencingToken, [{ ...document, text: "stale", vector: [1], contentHash: "stale-hash" }])).resolves.toBe(false);

    const checkpoint = { phase: "cleanup" as const, recordOffset: 0, topicOffset: 0, processed: 2, indexed: 2, skipped: 0, failed: 0, total: 2 };
    await expect(adapter.finalizeReindex({ jobId: job.id, owner: "worker-b", leaseToken: fresh!.leaseToken!, fencingToken: fresh!.fencingToken, scope, generation, activeRefs: [document, second].map(({ refType, refId }) => ({ refType, refId })), checkpoint, expected: 2, indexed: 2, skipped: 0 })).resolves.toBe(true);
    await expect(adapter.finalizeReindex({ jobId: job.id, owner: "worker-a", leaseToken: stale!.leaseToken!, fencingToken: stale!.fencingToken, scope, generation, activeRefs: [{ refType: document.refType, refId: document.refId }], checkpoint: { ...checkpoint, processed: 1, total: 1 }, expected: 1, indexed: 1, skipped: 0 })).resolves.toBe(false);

    const persisted = await adapter.pool.query("SELECT ref_id::text,content_hash FROM memory.embeddings WHERE generation=$1 AND scope_type=$2 AND scope_id=$3 ORDER BY ref_id", [generation, scope.type, scope.id]);
    expect(persisted.rows).toEqual([
      { ref_id: document.refId, content_hash: "fresh-hash" },
      { ref_id: second.refId, content_hash: "second-hash" },
    ].sort((left, right) => left.ref_id.localeCompare(right.ref_id)));
    expect(await adapter.getGeneration(scope, generation)).toMatchObject({ status: "active", expected: 2, indexed: 2 });
    expect((await adapter.listReindexJobs([scope])).find((candidate) => candidate.id === job.id)).toMatchObject({ status: "active", checkpoint });
  });
});
