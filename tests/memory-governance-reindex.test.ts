import { describe, it, expect } from "vitest";
import { InMemoryMemoryAdapter } from "../packages/memory/src/adapters/in-memory.js";
import { HashEmbeddingAdapter } from "../packages/memory/src/adapters/hash-embedding.js";
import { DurableReindexWorker } from "../packages/memory/src/reindex-worker.js";
import { CoreMemorySnapshotService } from "../packages/memory/src/core-snapshot.js";
const scope = { type: "workspace" as const, id: "governance" },
  access = {
    subjectId: "admin",
    scopes: [scope],
    purpose: "memory_admin" as const,
  };
function record(status: "candidate" | "active" | "disputed" = "active") {
  const now = Date.now();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "fact" as const,
    tier: "warm" as const,
    scope,
    title: "Preferred language",
    content: "用户偏好中文",
    summary: "偏好中文",
    topicIds: ["workspace.governance.fact.profile"],
    entityIds: [],
    status,
    confidence: 0.95,
    importance: 0.9,
    sourceRefs: [],
    createdAt: now,
    updatedAt: now,
  };
}
describe("memory 0.1.5 governance", () => {
  it("uses fenced durable reindex and skips unchanged content", async () => {
    const a = new InMemoryMemoryAdapter();
    await a.upsertRecords([record()]);
    const e = new HashEmbeddingAdapter(),
      w = new DurableReindexWorker(a, a, a, e, a, access, 1);
    const first = await w.enqueue();
    expect(first.status).toBe("queued");
    await w.runOnce("worker-a");
    const [done] = await a.listReindexJobs([scope]);
    expect(done.status).toBe("active");
    expect(done.checkpoint.indexed).toBe(1);
    const active = await a.getGeneration(scope);
    expect(active?.status).toBe("active");
    a.reindexJobs.clear();
    await w.enqueue();
    await w.runOnce("worker-b");
    const [again] = await a.listReindexJobs([scope]);
    expect(again.checkpoint.skipped).toBe(1);
  });
  it("fences vector writes from a reindex worker after its lease is reclaimed", async () => {
    const a = new InMemoryMemoryAdapter();
    await a.upsertRecords([{ ...record(), title: "old", summary: "old" }]);
    let releaseStaleEmbedding!: () => void;
    let staleEmbeddingStarted!: () => void;
    const staleEmbeddingGate = new Promise<void>((resolve) => { releaseStaleEmbedding = resolve; });
    const staleEmbeddingReady = new Promise<void>((resolve) => { staleEmbeddingStarted = resolve; });
    const staleEmbeddings = {
      generation: "lease-fenced",
      async embed() {
        staleEmbeddingStarted();
        await staleEmbeddingGate;
        return [[1]];
      },
    };
    const freshEmbeddings = { generation: "lease-fenced", async embed() { return [[2]]; } };
    const staleWorker = new DurableReindexWorker(a, a, a, staleEmbeddings, a, access, 1, 20);
    const freshWorker = new DurableReindexWorker(a, a, a, freshEmbeddings, a, access, 1, 20);
    await staleWorker.enqueue();
    const staleRun = staleWorker.runOnce("worker-a");
    await staleEmbeddingReady;

    const running = [...a.reindexJobs.values()][0];
    running.leaseUntil = Date.now() - 1;
    await a.upsertRecords([{ ...record(), title: "new", summary: "new", updatedAt: Date.now() + 1 }]);
    await expect(freshWorker.runOnce("worker-b")).resolves.toBe(true);
    expect(a.vectors.get(`warm_record:${record().id}:lease-fenced`)?.vector).toEqual([2]);

    releaseStaleEmbedding();
    await expect(staleRun).rejects.toThrow("reindex_lease_lost");
    expect(a.vectors.get(`warm_record:${record().id}:lease-fenced`)?.vector).toEqual([2]);
    expect((await a.getGeneration(scope, "lease-fenced"))?.status).toBe("active");
  });
  it("tombstones and restores topics without deleting revisions", async () => {
    const a = new InMemoryMemoryAdapter(),
      now = Date.now(),
      topic = {
        topicId: "topic",
        kind: "fact" as const,
        scope,
        title: "Topic",
        description: "D",
        aliases: [],
        entityIds: [],
        relatedTopicIds: [],
        embeddingText: "Topic",
        status: "active" as const,
        updatedAt: now,
      };
    await a.upsertDescriptors([topic]);
    await a.stageRevision({
      id: "22222222-2222-4222-8222-222222222222",
      topicId: "topic",
      kind: "fact",
      scope,
      revision: 1,
      state: "staged",
      objectKey: "topic.md",
      checksum: "x",
      byteLength: 1,
      tokenCount: 1,
      createdAt: now,
    });
    await a.publishRevision("topic", "22222222-2222-4222-8222-222222222222");
    const revisions = await a.forgetTopics(["topic"], [scope], {
      purgeAfter: now + 10000,
    });
    expect(revisions).toHaveLength(1);
    expect(a.revisions.size).toBe(1);
    expect(await a.restoreTopics(["topic"], [scope])).toBe(1);
    expect((await a.getDescriptors(["topic"], [scope]))[0].status).toBe(
      "active",
    );
  });
  it("closes candidate governance, records feedback, and produces editable core snapshot", async () => {
    const a = new InMemoryMemoryAdapter();
    await a.upsertRecords([record("candidate")]);
    const receipt = await a.govern({
      access,
      scope,
      id: record().id,
      action: "approve",
      reason: "confirmed",
    });
    expect(receipt?.nextStatus).toBe("active");
    await a.addRecallFeedback(scope, record().id, "helpful", 0.35, "admin");
    expect(
      (await a.feedbackScores([record().id], [scope])).get(record().id),
    ).toBeGreaterThan(1);
    const core = new CoreMemorySnapshotService(a, a);
    const generated = await core.generate(access);
    expect(generated.markdown).toContain("偏好中文");
    expect(generated.markdown).not.toContain("TaskRun completed");
    const edited = await core.update(
      access,
      generated.markdown + "\n- Human note\n",
    );
    expect(edited.revision).toBe(2);
    expect(edited.editedAt).toBeDefined();
  });
});
