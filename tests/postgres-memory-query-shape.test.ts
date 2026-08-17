import { describe, expect, it } from "vitest";
import { PostgresMemoryAdapter } from "../packages/memory/src/postgres/postgres-adapter.js";

const scope = { type: "workspace" as const, id: "query-shape" };

describe("PostgreSQL Memory query safety", () => {
  it("publishes capture projections only after locking a live fenced lease", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("SELECT 1 FROM memory.capture_jobs")) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (sql.includes("UPDATE memory.capture_jobs SET status")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const adapter = new PostgresMemoryAdapter("postgres://unused");
    (adapter as any).pool = { connect: async () => client };
    const committed = await adapter.commitCapture({
      jobId: "10000000-0000-4000-8000-000000000001",
      owner: "worker-a",
      leaseToken: "10000000-0000-4000-8000-000000000002",
      fencingToken: 3,
      records: [{
        id: "10000000-0000-4000-8000-000000000003", kind: "fact", tier: "hot", scope,
        title: "capture", content: "atomic", summary: "atomic", topicIds: ["capture.topic"], entityIds: ["capture.entity"],
        status: "active", confidence: 1, importance: 1, sourceRefs: [], createdAt: 1, updatedAt: 1,
      }],
      topics: [{ topicId: "capture.topic", kind: "fact", scope, title: "Capture", description: "Atomic", aliases: [], entityIds: ["capture.entity"], relatedTopicIds: [], embeddingText: "atomic", status: "active", createdAt: 1, updatedAt: 1 }],
      nodes: [{ id: "capture.entity", type: "concept", canonicalName: "Capture", aliases: [], scope }],
      edges: [], vectors: [], removeVectorIds: [],
      completion: { extractedCount: 1, proposalCount: 1, persistedCount: 1 },
    });
    expect(committed).toBe(true);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toMatch(/lease_until>=.*clock_timestamp[\s\S]+FOR UPDATE/);
    expect(queries.some((query) => query.includes("INSERT INTO memory.records"))).toBe(true);
    expect(queries.some((query) => query.includes("INSERT INTO memory.topics"))).toBe(true);
    expect(queries.at(-2)).toContain("UPDATE memory.capture_jobs SET status");
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("returns the same lexical score expression used for ordering", async () => {
    const queries: string[] = [];
    const adapter = new PostgresMemoryAdapter("postgres://unused");
    (adapter as any).pool = { query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{
        id: "10000000-0000-4000-8000-000000000010",
        kind: "fact",
        tier: "warm",
        scope_type: scope.type,
        scope_id: scope.id,
        title: "中文标题",
        content: "包含中文关键词",
        summary: "中文摘要",
        topic_ids: [],
        entity_ids: [],
        status: "active",
        confidence: 1,
        importance: 1,
        source_refs: [],
        created_at: 1,
        updated_at: 1,
        score: 0.25,
      }] };
    } };
    const result = await adapter.search("中文关键词", [scope], ["fact"], 5);
    expect(result[0].score).toBe(0.25);
    expect(queries[0]).toMatch(/SELECT \*, GREATEST\([\s\S]+\) score/);
    expect(queries[0]).toMatch(/ORDER BY GREATEST\([\s\S]+\) DESC/);
    expect(queries[0]).toContain("THEN .25 ELSE 0 END");
  });

  it("applies scope and active-edge filters on every recursive graph hop", async () => {
    const queries: string[] = [];
    const adapter = new PostgresMemoryAdapter("postgres://unused");
    (adapter as any).pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } };
    await adapter.neighborhood(["entity-a"], [scope], 2, 10);
    expect(queries[0].match(/e\.status='active'/g)).toHaveLength(2);
    expect(queries[0].match(/e\.scope_type=/g)).toHaveLength(2);
  });

  it("keeps topic paging inside one snapshot and advances the tuple cursor", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const adapter = new PostgresMemoryAdapter("postgres://unused");
    (adapter as any).pool = { query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    } };
    await adapter.listDescriptorsPage?.([scope], ["fact"], {
      snapshotCreatedAt: 500,
      after: { createdAt: 400, topicId: "topic-z" },
      limit: 101,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("created_at<=$4");
    expect(calls[0].sql).toContain("created_at<$5 OR (created_at=$5 AND topic_id<$6)");
    expect(calls[0].sql).toContain("ORDER BY created_at DESC,topic_id DESC LIMIT $7");
    expect(calls[0].params).toEqual(["workspace", "query-shape", ["fact"], 500, 400, "topic-z", 101]);
  });
});
