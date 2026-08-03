import { describe, expect, it } from "vitest";
import { PostgresMemoryAdapter } from "../src/memory/postgres/postgres-adapter.js";
import type { GraphEdge, GraphNode, TopicDescriptor, VectorDocument } from "../src/memory/types.js";

class QueryCounter {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (/count\(\*\).*cold_topics/i.test(text)) return { rows: [{ topics: "10000", cold_topics: "2500" }] };
    if (/count\(\*\)/i.test(text)) return { rows: [{ hot: "1", warm: "2", candidate: "3", active: "4", disputed: "5" }] };
    return { rows: [], rowCount: 0 };
  }
}

function adapterWith(counter: QueryCounter) {
  const adapter = new PostgresMemoryAdapter({ connectionString: "postgres://unused" });
  (adapter as unknown as { pool: QueryCounter }).pool = counter;
  return adapter;
}

const scope = { type: "workspace" as const, id: "performance-test" };

describe("PostgreSQL memory query shape", () => {
  it("keeps direct recall and status query counts constant as requested cardinality grows", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);
    await adapter.getByIds(Array.from({ length: 10_000 }, (_, index) => `id-${index}`), [scope]);
    expect(counter.calls).toHaveLength(2);
    expect(counter.calls.every((call) => /id::text=ANY/.test(call.text))).toBe(true);
    expect(counter.calls.every((call) => !/LIMIT\s+10000/i.test(call.text))).toBe(true);

    counter.calls = [];
    await adapter.getByTopicIds(Array.from({ length: 10_000 }, (_, index) => `topic-${index}`), [scope], ["fact", "preference"], 80);
    expect(counter.calls).toHaveLength(2);
    expect(counter.calls[0].text).toContain("topic_ids &&");

    counter.calls = [];
    await Promise.all([adapter.countSummary([scope]), adapter.countTopicSummary([scope])]);
    expect(counter.calls).toHaveLength(3);
    expect(counter.calls.some((call) => call.text.includes("LEFT JOIN memory.cold_revisions"))).toBe(true);
    expect(counter.calls.every((call) => !/SELECT \*/i.test(call.text))).toBe(true);
  });

  it("batches embedding, graph, and topic writes into one round trip per collection", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);
    const vectors: VectorDocument[] = Array.from({ length: 1_000 }, (_, index) => ({
      refType: "warm_record", refId: `record-${index}`, scope, kind: "fact", text: `record ${index}`,
      vector: [index / 1_000, 1], generation: "g1", contentHash: `hash-${index}`,
    }));
    const nodes: GraphNode[] = Array.from({ length: 1_000 }, (_, index) => ({ id: `node-${index}`, type: "entity", canonicalName: `Node ${index}`, aliases: [], scope }));
    const edges: GraphEdge[] = Array.from({ length: 1_000 }, (_, index) => ({ id: `edge-${index}`, fromId: `node-${index}`, predicate: "related", toId: `node-${(index + 1) % 1_000}`, scope, confidence: 1, status: "active" }));
    const topics: TopicDescriptor[] = Array.from({ length: 1_000 }, (_, index) => ({ topicId: `topic-${index}`, kind: "fact", scope, title: `Topic ${index}`, description: "description", aliases: [], entityIds: [], relatedTopicIds: [], embeddingText: `topic ${index}`, status: "active", updatedAt: index }));

    await adapter.upsert(vectors);
    await adapter.upsertNodes(nodes);
    await adapter.upsertEdges(edges);
    await adapter.upsertDescriptors(topics);
    expect(counter.calls).toHaveLength(4);
    expect(counter.calls.every((call) => call.text.includes("jsonb_to_recordset"))).toBe(true);
    expect(counter.calls.every((call) => typeof call.values?.[0] === "string" && JSON.parse(call.values[0] as string).length === 1_000)).toBe(true);
  });
});
