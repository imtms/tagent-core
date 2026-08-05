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

suite("PostgreSQL memory adapter", () => {
  let adapter: PostgresMemoryAdapter;
  let service: MemoryService;
  let coldPath: string | undefined;
  const scope = { type: "workspace" as const, id: `test-${crypto.randomUUID()}` };
  const access = { subjectId: "integration", scopes: [scope], purpose: "agent_recall" as const };

  beforeAll(async () => {
    adapter = new PostgresMemoryAdapter(configuredUrl!);
    await adapter.migrate();
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
      for (const table of ["cold_revisions", "embeddings", "edges", "entities", "preferences", "records", "topics"]) {
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
      embeddingText: "PostgreSQL pgvector memory", status: "active" as const, updatedAt: now,
    };
    await service.publishColdTopic(access, descriptor, "# PostgreSQL memory\n\nCold is read in full.");
    const recalled = await service.recall({ access, cue: "PostgreSQL pgvector", maxColdTopics: 1 });
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
    expect((await service.recall({ access, cue: "PostgreSQL pgvector", maxColdTopics: 0 })).cards).toEqual([]);
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
});
