import { describe, expect, it } from "vitest";
import { PostgresMemoryAdapter } from "../packages/memory/src/postgres/postgres-adapter.js";
import type { GraphEdge, GraphNode, TopicDescriptor, VectorDocument, WarmMemory } from "@tagent/memory/domain";

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
  if (!indexes.length) {
    expect(call.values ?? []).toHaveLength(0);
    return;
  }
  expect(Math.max(...indexes)).toBe(call.values?.length ?? 0);
  expect(call.text).not.toMatch(/(?:scope_type|scope_id|LIMIT|ANY\(|&&\s*)\d+/);
}

function expectTypedDynamicParameters(call: { text: string; values?: unknown[] }) {
  expectValidParameters(call);
  const values=call.values ?? [];
  for (const match of call.text.matchAll(/\bLIMIT\s+\$(\d+)/gi)) {
    expect(typeof values[Number(match[1])-1], call.text).toBe("number");
  }
  for (const match of call.text.matchAll(/(?:ANY\(|&&\s*)\$(\d+)::text\[\]/gi)) {
    const value=values[Number(match[1])-1];
    expect(Array.isArray(value), call.text).toBe(true);
    expect((value as unknown[]).every((item)=>typeof item === "string"), call.text).toBe(true);
  }
  for (const match of call.text.matchAll(/\$(\d+)::bigint/gi)) {
    const value=values[Number(match[1])-1];
    expect(value === null || typeof value === "number" || typeof value === "bigint", call.text).toBe(true);
  }
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

  it("binds dynamic search, list, vector, graph, topic, and job parameters to query-local values", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);

    await adapter.search("postgres", [scope], ["fact", "preference"], 7);
    await adapter.list([scope], ["fact", "preference"], 9);
    await adapter.searchVectors([0.1, 0.2], [scope], ["fact"], 11, "g1");
    await adapter.resolveEntities("tagent", [scope], 13);
    await adapter.neighborhood(["entity-1"], [scope], 2, 15);
    await adapter.searchTopics("memory", [scope], ["fact"], 17);
    await adapter.listJobs([scope], 19);
    await adapter.listReindexJobs([scope], 21);

    expect(counter.calls.length).toBeGreaterThanOrEqual(10);
    for (const call of counter.calls) expectTypedDynamicParameters(call);

    const preferenceSearch=counter.calls.find((call)=>call.text.includes("FROM memory.preferences") && call.text.includes("ts_rank_cd"));
    expect(preferenceSearch?.values).toEqual(["postgres", scope.type, scope.id, 7]);
    expect(preferenceSearch?.text).toContain("LIMIT $4");

    const preferenceList=counter.calls.find((call)=>call.text.includes("FROM memory.preferences") && !call.text.includes("ts_rank_cd"));
    expect(preferenceList?.values).toEqual([scope.type, scope.id, 9]);
    expect(preferenceList?.text).toContain("LIMIT $3");

    const captureJobs=counter.calls.find((call)=>call.text.includes("FROM memory.capture_jobs"));
    expect(captureJobs?.values).toEqual([JSON.stringify([{ type: scope.type, id: scope.id }]), 19]);
    expect(captureJobs?.text).toContain("request->'access'->'scopes' @> $1::jsonb");
    expect(captureJobs?.text).toContain("LIMIT $2");
  });

  it("binds each topic lookup LIMIT to the query-local numeric limit parameter", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);

    await adapter.getByTopicIds(["topic-1"], [scope], ["fact", "preference"], 8);

    expect(counter.calls).toHaveLength(2);
    const [records, preferences] = counter.calls;
    expect(records.values).toEqual([scope.type, scope.id, ["topic-1"], ["fact"], 8]);
    expect(records.text).toContain("kind=ANY($4::text[])");
    expect(records.text).toContain("LIMIT $5");
    expect(preferences.values).toEqual([scope.type, scope.id, ["topic-1"], 8]);
    expect(preferences.text).not.toContain("kind=ANY");
    expect(preferences.text).toContain("LIMIT $4");
    expect(typeof preferences.values?.[3]).toBe("number");
  });

  it("keeps preference-only topic reads independent from the records kind parameter", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);

    await adapter.getByTopicIds(["topic-1"], [scope], ["preference"], 6);

    expect(counter.calls).toHaveLength(1);
    expect(counter.calls[0].values).toEqual([scope.type, scope.id, ["topic-1"], 6]);
    expect(counter.calls[0].text).toContain("topic_ids && $3::text[]");
    expect(counter.calls[0].text).toContain("LIMIT $4");
    expect(counter.calls[0].text).not.toContain("$5");
    expectValidParameters(counter.calls[0]);
  });

  it("uses direct typed array parameters for id and descriptor reads", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);

    await adapter.getByIds(["record-1"], [scope]);
    await adapter.getDescriptors(["topic-1"], [scope]);

    expect(counter.calls).toHaveLength(3);
    for (const call of counter.calls) {
      expect(call.values).toEqual([scope.type, scope.id, [expect.any(String)]]);
      expect(call.text).toContain("ANY($3::text[])");
      expectValidParameters(call);
    }
  });

  it("keeps maintenance descriptor and expiry-cleanup parameters correctly typed", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);
    const now = 1_725_000_000_000;

    await adapter.listDescriptors([scope], ["fact", "preference"], 20);
    await adapter.purgeDeleted([scope], now, 10);
    await adapter.purgeDeletedTopics([scope], now, 5);

    const descriptor = counter.calls.find((call) => call.text.includes("FROM memory.topics") && call.text.includes("kind=ANY"));
    expect(descriptor?.values).toEqual([scope.type, scope.id, ["fact", "preference"], 20]);
    expect(descriptor?.text).toContain("kind=ANY($3::text[])");
    expect(descriptor?.text).toContain("LIMIT $4");

    const recordPurge = counter.calls.find((call) => call.text.includes("DELETE FROM memory.records"));
    const preferencePurge = counter.calls.find((call) => call.text.includes("DELETE FROM memory.preferences"));
    expect(recordPurge?.values).toEqual([scope.type, scope.id, now, 10]);
    expect(preferencePurge?.values).toEqual([scope.type, scope.id, now, 10]);
    expect(recordPurge?.text).toContain("::bigint<=$3 LIMIT $4");
    expect(preferencePurge?.text).toContain("::bigint<=$3 LIMIT $4");

    const topicPurge = counter.calls.find((call) => call.text.includes("SELECT topic_id FROM memory.topics"));
    expect(topicPurge?.values).toEqual([scope.type, scope.id, now, 5]);
    expect(topicPurge?.text).toContain("::bigint<=$3 LIMIT $4");
    for (const call of counter.calls) expectValidParameters(call);
  });

  it("guards empty forget and restores deleted records by record or Topic IDs with scoped typed parameters", async () => {
    const counter = new QueryCounter();
    const adapter = adapterWith(counter);

    await expect(adapter.forget([scope])).rejects.toThrow("requires at least one");
    expect(counter.calls).toHaveLength(0);

    await adapter.restore([scope], ["record-1"], ["topic-1"]);
    expect(counter.calls).toHaveLength(2);
    for (const call of counter.calls) {
      expect(call.values?.slice(0, 4)).toEqual([scope.type, scope.id, ["record-1"], ["topic-1"]]);
      expect(call.text).toContain("id::text=ANY($3::text[])");
      expect(call.text).toContain("topic_ids && $4::text[]");
      expect(call.text).toContain("status='deleted'");
      expectValidParameters(call);
    }
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
