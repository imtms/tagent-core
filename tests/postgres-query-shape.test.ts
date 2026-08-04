import { describe, expect, it } from "vitest";
import { PostgresMemoryAdapter } from "../src/memory/postgres/postgres-adapter.js";
import type { GraphEdge, GraphNode, TopicDescriptor, VectorDocument, WarmMemory } from "../src/memory/types.js";

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
function expectValidParameters(call: { text: string; values?: unknown[] }) {
  const indexes=[...call.text.matchAll(/\$(\d+)/g)].map((match)=>Number(match[1]));
  expect(indexes.length).toBeGreaterThan(0);
  expect(Math.max(...indexes)).toBe(call.values?.length ?? 0);
  expect(call.text).not.toMatch(/(?:scope_type|scope_id|LIMIT|ANY\(|&&\s*)\d+/);
}


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
    for (const call of counter.calls) expectValidParameters(call);
  });

  it("uses legal numbered placeholders for every audited direct PostgreSQL query", async () => {
    const counter = new QueryCounter(); const adapter = adapterWith(counter);
    await adapter.getByIds(["id-1"], [scope]);
    await adapter.getByTopicIds(["topic-1"], [scope], ["fact", "preference"], 8);
    await adapter.countSummary([scope]);
    await adapter.countTopicSummary([scope]);
    await adapter.getDescriptors(["topic-1"], [scope]);
    await adapter.removeMissing("g1", new Set(), [scope]);
    for (const call of counter.calls) expectValidParameters(call);
  });

  it("batches ordinary and preference record upserts into at most two data statements", async () => {
    const counter = new QueryCounter();
    (counter as QueryCounter & { connect: () => Promise<QueryCounter & { release: () => void }> }).connect = async () => Object.assign(counter, { release() {} });
    const adapter = adapterWith(counter); const at=Date.now();
    const records:WarmMemory[]=[
      {id:"11111111-1111-4111-8111-111111111111",kind:"fact",tier:"warm",scope,title:"A",content:"A",summary:"A",topicIds:[],entityIds:[],status:"active",confidence:1,importance:1,sourceRefs:[],createdAt:at,updatedAt:at},
      {id:"22222222-2222-4222-8222-222222222222",kind:"preference",tier:"warm",scope,dimension:"verbosity",value:"short",summary:"short",topicIds:[],entityIds:[],applicability:"global",strength:1,origin:"explicit",status:"active",confidence:1,sourceRefs:[],createdAt:at,updatedAt:at},
    ];
    await adapter.upsertRecords(records);
    const data=counter.calls.filter((call)=>call.text.includes("jsonb_to_recordset"));
    expect(data).toHaveLength(2);
    expect(counter.calls.map((call)=>call.text)).toEqual(expect.arrayContaining(["BEGIN","COMMIT"]));
    for (const call of data) expectValidParameters(call);
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
