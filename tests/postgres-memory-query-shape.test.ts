import { describe, expect, it } from "vitest";
import { PostgresMemoryAdapter } from "../packages/memory/src/postgres/postgres-adapter.js";

const scope = { type: "workspace" as const, id: "query-shape" };

describe("PostgreSQL Memory query safety", () => {
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
});
