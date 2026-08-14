import { describe, it, expect } from "vitest";
import {
  HybridExtractor,
  LlmExtractor,
} from "../packages/memory/src/adapters/llm-extractor.js";
import { RuleBasedExtractor } from "../packages/memory/src/adapters/rule-extractor.js";
import { OpenAIEmbeddingAdapter } from "../packages/memory/src/adapters/openai-embedding.js";
import { LocalMemoryWorker } from "../packages/memory/src/runtime-worker.js";
const scope = { type: "workspace" as const, id: "quality" };
const testSignal = new AbortController().signal;

describe("memory semantic quality", () => {
  it("hybrid extraction preserves rule fast paths and merges semantic proposals", async () => {
    const semantic = {
      extract: async () => ({
        records: [
          {
            id: "food",
            kind: "preference" as const,
            tier: "hot" as const,
            scope,
            dimension: "food",
            value: "用户 不喜欢吃 苹果",
            summary: "用户不爱吃苹果",
            topicIds: ["food"],
            entityIds: [],
            applicability: "global" as const,
            strength: 0.9,
            origin: "explicit" as const,
            status: "active" as const,
            confidence: 0.99,
            sourceRefs: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        topics: [],
        nodes: [],
        edges: [],
      }),
    };
    const result = await new HybridExtractor(
      new RuleBasedExtractor(),
      semantic,
    ).extract("<focus_user>我叫TMs，而且我不爱吃苹果</focus_user>", [], scope);
    expect(
      result.records.some(
        (r) => r.kind === "fact" && (r as any).content.includes("TMs"),
      ),
    ).toBe(true);
    expect(
      result.records.some(
        (r) => r.kind === "preference" && (r as any).value.includes("苹果"),
      ),
    ).toBe(true);
  });
  it("does not send one-off task requests to semantic extraction", async () => {
    let calls = 0;
    const semantic = {
      extract: async () => {
        calls++;
        return {
          records: [
            {
              id: "bad",
              kind: "episode" as const,
              tier: "hot" as const,
              scope,
              title: "task",
              content: "stored task",
              summary: "stored task",
              topicIds: ["task"],
              entityIds: [],
              status: "active" as const,
              confidence: 1,
              importance: 1,
              sourceRefs: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          topics: [],
          nodes: [],
          edges: [],
        };
      },
    };
    const result = await new HybridExtractor(
      new RuleBasedExtractor(),
      semantic,
    ).extract(
      "<focus_user>请检查 /opt/tagent-core 是否最新，并排查记忆数据库</focus_user>",
      [],
      scope,
    );
    expect(calls).toBe(0);
    expect(result.records).toEqual([]);
  });
  it("extracts explicit Chinese food preferences in the deterministic safety path", async () => {
    const extractor = new RuleBasedExtractor();
    const first = await extractor.extract(
      "user: 我爱吃西瓜，我有个朋友卢鹏程也爱吃西瓜",
      [],
      scope,
    );
    const values = first.records
      .filter((r) => r.kind === "preference")
      .map((r) => (r as any).value)
      .join("\n");
    expect(values).toContain("用户 喜欢吃 西瓜");
    expect(values).toContain("卢鹏程 喜欢吃 西瓜");
    const second = await extractor.extract("user: 我不爱吃苹果", [], scope);
    expect((second.records[0] as any).value).toContain("不喜欢吃 苹果");
  });
  it("uses prior turns only for Chinese pronoun resolution", async () => {
    const extractor = new HybridExtractor(new RuleBasedExtractor());
    const result = await extractor.extract(
      "<context>user: 我爱吃西瓜，我有个朋友卢鹏程也是</context><focus_user>他说苹果也很好吃但是我不爱吃</focus_user>",
      [],
      scope,
    );
    const values = result.records
      .filter((r) => r.kind === "preference")
      .map((r) => (r as any).value)
      .join("\n");
    expect(values).toContain("卢鹏程 喜欢吃 西瓜");
    expect(values).toContain("卢鹏程 喜欢吃 苹果");
    expect(values).toContain("用户 不喜欢吃 苹果");
  });
  it("extracts homes and cross-turn neighbor relations without relying on the LLM", async () => {
    const extractor = new HybridExtractor(new RuleBasedExtractor());
    const first = await extractor.extract(
      "<focus_user>Sway家在前滩</focus_user>",
      [],
      scope,
    );
    expect(
      first.records.some(
        (r) =>
          r.kind === "fact" && (r as any).content.includes("Sway 住在 前滩"),
      ),
    ).toBe(true);
    const second = await extractor.extract(
      "<context>user: Sway家在前滩</context><focus_user>乔哲家也是</focus_user>",
      [],
      scope,
    );
    expect(
      second.records.some(
        (r) =>
          r.kind === "fact" && (r as any).content.includes("乔哲 住在 前滩"),
      ),
    ).toBe(true);
    const third = await extractor.extract(
      "<context>user: Sway家在前滩\nassistant: 记住了：Sway 家在前滩。\nuser: 乔哲家也是</context><focus_user>他俩住隔壁</focus_user>",
      [],
      scope,
    );
    expect(
      third.records.some(
        (r) =>
          r.kind === "fact" &&
          (r as any).content.includes("Sway 与 乔哲是邻居"),
      ),
    ).toBe(true);
    expect(third.edges.some((edge) => edge.predicate === "neighbor_of")).toBe(
      true,
    );
  });
  it("falls back to deterministic rules when the semantic extractor fails", async () => {
    const failing = {
      extract: async () => {
        throw new Error("provider down");
      },
    };
    const extractor = new HybridExtractor(new RuleBasedExtractor(), failing);
    const result = await extractor.extract(
      "<focus_user>我叫TMs</focus_user>",
      [],
      scope,
    );
    expect(result.records).toHaveLength(1);
    await expect(
      extractor.extract(
        "<focus_user>这是一条规则无法识别的长期事实</focus_user>",
        [],
        scope,
      ),
    ).rejects.toThrow("provider down");
  });
  it("surfaces background maintenance failures", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const worker = new LocalMemoryWorker(
        { runOnce: async () => false } as any,
        {
          promote: async () => {
            throw new Error("maintenance failed");
          },
          topicCandidates: async () => [],
        } as any,
        { consolidate: async () => undefined } as any,
        {
          verify: async () => undefined,
          cleanupStaged: async () => undefined,
        } as any,
        { subjectId: "test", scopes: [scope], purpose: "capture" },
        1000,
        1000,
      );
      worker.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await worker.stop();
      expect(
        errors.some((args) =>
          String(args[0]).includes("Memory maintenance tick failed"),
        ),
      ).toBe(true);
    } finally {
      console.error = original;
    }
  });
  it("does not let slow maintenance starve capture processing", async () => {
    let release!: () => void;
    const maintenanceStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = 0;
    const capture = {
      runOnce: async () => {
        captured++;
        return false;
      },
    } as any;
    const lifecycle = {
      promote: async () => {
        await maintenanceStarted;
      },
      topicCandidates: async () => [],
    } as any;
    const worker = new LocalMemoryWorker(
      capture,
      lifecycle,
      { consolidate: async () => undefined } as any,
      {
        verify: async () => undefined,
        cleanupStaged: async () => undefined,
      } as any,
      { subjectId: "test", scopes: [scope], purpose: "capture" },
      1000,
      1000,
    );
    const maintenance = worker.maintenanceTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.captureTick();
    expect(captured).toBe(1);
    release();
    await maintenance;
  });
  it("batches OpenAI-compatible embeddings and exposes a generation", async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [0, 1] },
          ],
        }),
        { status: 200 },
      );
    };
    try {
      const adapter = new OpenAIEmbeddingAdapter({
        baseUrl: "https://embed.test/v1",
        resolveApiKey: async () => "secret",
        model: "semantic",
        batchSize: 2,
        extraBody: { input_type: "passage" },
      });
      expect(await adapter.embed(["a", "b"])).toEqual([
        [1, 0],
        [0, 1],
      ]);
      expect(adapter.generation).toContain("semantic");
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("resolves embedding credentials immediately before each provider request", async () => {
    const original = globalThis.fetch;
    let credential = "first";
    const authorizations: string[] = [];
    globalThis.fetch = async (_url, init) => {
      authorizations.push((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
    };
    try {
      const adapter = new OpenAIEmbeddingAdapter({
        baseUrl: "https://embed.test/v1",
        resolveApiKey: async () => credential,
        model: "semantic",
      });
      await adapter.embed(["first"]);
      credential = "second";
      await adapter.embed(["second"]);
      expect(authorizations).toEqual(["Bearer first", "Bearer second"]);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("bounds online embedding latency and disables retries for recall", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;
    try {
      const adapter = new OpenAIEmbeddingAdapter({
        baseUrl: "https://embed.test/v1",
        resolveApiKey: async () => "secret",
        model: "semantic",
        maxRetries: 5,
        timeoutMs: 30_000,
      });
      const startedAt = Date.now();
      await expect(adapter.embed(["cue"], { timeoutMs: 20, maxRetries: 0 })).rejects.toBeDefined();
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
  it.skipIf(!process.env.TAGENT_TEST_LLM_BASE_URL)(
    "resolves the reported Chinese food preference coreference with a live LLM",
    async () => {
      const extractor = new LlmExtractor({
        baseUrl: process.env.TAGENT_TEST_LLM_BASE_URL!,
        resolveApiKey: async () => process.env.TAGENT_TEST_LLM_API_KEY,
        model: process.env.TAGENT_TEST_LLM_MODEL!,
      });
      const result = await extractor.extract(
        "<context>user: 我爱吃西瓜，我有个朋友卢鹏程也是</context><focus_user>他说苹果也很好吃但是我不爱吃</focus_user>",
        [],
        scope,
      );
      const values = result.records
        .filter((r) => r.kind === "preference")
        .map((r) => (r as any).value)
        .join("\n");
      expect(values).toContain("卢鹏程");
      expect(values).toContain("苹果");
      expect(values).toMatch(/用户.*不/);
    },
    120_000,
  );
});

it("separates raw capture source from extracted record evidence", async () => {
  const { InMemoryMemoryAdapter } =
    await import("../packages/memory/src/adapters/in-memory.js");
  const { MemoryService } = await import("../packages/memory/src/memory-service.js");
  const { MemoryCaptureWorker } =
    await import("../packages/memory/src/capture-worker.js");
  const { DefaultPolicyEngine } =
    await import("../packages/memory/src/policy/policy-engine.js");
  const { LocalBlobStore } =
    await import("../packages/memory/src/storage/local-blob-store.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const adapter = new InMemoryMemoryAdapter(),
    policy = new DefaultPolicyEngine(adapter),
    service = new MemoryService({
      records: adapter,
      vectors: adapter,
      graph: adapter,
      topics: adapter,
      jobs: adapter,
      policy,
      blobs: new LocalBlobStore(
        await mkdtemp(path.join(tmpdir(), "capture-source-")),
      ),
    });
  await service.enqueueCapture({
    access: { subjectId: "u", scopes: [scope], purpose: "capture" },
    sourceRefs: [],
    content: "user: 我叫小明",
    idempotencyKey: "source-separation",
    captureSource: { kind: "user_message", role: "user" },
  });
  await new MemoryCaptureWorker(
    adapter,
    { load: async () => "" },
    new RuleBasedExtractor(),
    policy,
    service,
  ).runOnce();
  const job = [...adapter.jobs.values()][0],
    record = [...adapter.records.values()][0];
  expect(job.request.captureSource?.kind).toBe("user_message");
  expect(job.request.provenance).toBeUndefined();
  expect(record.provenance?.evidenceClass).toBe("user_explicit");
});

it("produces explainable ranking trace and incremental embedding skips", async () => {
  const { InMemoryMemoryAdapter } =
    await import("../packages/memory/src/adapters/in-memory.js");
  const { MemoryService } = await import("../packages/memory/src/memory-service.js");
  const { DefaultPolicyEngine } =
    await import("../packages/memory/src/policy/policy-engine.js");
  const { LocalBlobStore } =
    await import("../packages/memory/src/storage/local-blob-store.js");
  const { HashEmbeddingAdapter } =
    await import("../packages/memory/src/adapters/hash-embedding.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const adapter = new InMemoryMemoryAdapter(),
    embedding = new HashEmbeddingAdapter(16),
    service = new MemoryService({
      records: adapter,
      vectors: adapter,
      topics: adapter,
      graph: adapter,
      jobs: adapter,
      policy: new DefaultPolicyEngine(adapter),
      embeddings: embedding,
      blobs: new LocalBlobStore(await mkdtemp(path.join(tmpdir(), "trace-"))),
    });
  const now = Date.now();
  await service.upsert(
    { subjectId: "u", scopes: [scope], purpose: "capture" },
    [
      {
        id: "trace-record",
        kind: "fact",
        tier: "warm",
        scope,
        title: "用户姓名",
        content: "用户姓名或称呼是小明",
        summary: "用户叫小明",
        topicIds: [`${scope.type}.${scope.id}.fact.user-profile.identity`],
        entityIds: [],
        status: "active",
        confidence: 1,
        importance: 1,
        sourceRefs: [{ sourceType: "message", sourceId: "1" }],
        provenance: {
          evidenceClass: "user_explicit",
          trustLevel: "high",
          sourceRole: "user",
          verificationState: "explicit",
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
  );
  adapter.vectors.clear();
  const first = await service.reindex({
      subjectId: "u",
      scopes: [scope],
      purpose: "capture",
    }),
    second = await service.reindex({
      subjectId: "u",
      scopes: [scope],
      purpose: "capture",
    });
  expect(first.indexed).toBeGreaterThan(0);
  expect(second.indexed).toBe(0);
  const result = await service.recall({
    access: { subjectId: "u", scopes: [scope], purpose: "agent_recall" },
    cue: "我叫什么",
    maxColdTopics: 0,
    signal: testSignal,
  });
  expect(result.trace.version).toBe(2);
  expect(result.cards[0]).toMatchObject({
    sourceRefs: [{ sourceType: "message", sourceId: "1" }],
    retrievalChannels: ["canonical"],
  });
  expect(result.cards[0].scoreBreakdown.trust).toBe(1);
});

describe("memory pollution prevention", () => {
  it("rejects control-plane metadata and malformed Chinese negation before persistence", async () => {
    const { isDurableMemory } = await import("../packages/memory/src/quality.js");
    const now = Date.now();
    const base = {
      id: "10000000-0000-4000-8000-000000000001",
      kind: "fact" as const,
      tier: "hot" as const,
      scope,
      title: "Fact",
      summary: "Fact",
      topicIds: [],
      entityIds: [],
      status: "active" as const,
      confidence: 0.99,
      importance: 0.9,
      sourceRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    expect(
      isDurableMemory({
        ...base,
        title: "Verified check [build]",
        content: "Verified check [build] PASS",
      }),
    ).toBe(false);
    expect(
      isDurableMemory({
        ...base,
        title: "PR #9 仍存在冲突",
        content: "PR #9 不仍存在冲突",
      }),
    ).toBe(false);
    expect(
      isDurableMemory({
        ...base,
        title: "PR #9 无法干净合并",
        content: "PR #9 不与最新main存在合并冲突风险",
      }),
    ).toBe(false);
  });

  it("does not infer polarity from a Chinese subject ending in 不", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: "fact",
                      subject: "用户不",
                      predicate: "评价",
                      object: "当前记忆很混乱",
                      polarity: "positive",
                      summary: "用户认为当前记忆很混乱",
                      confidence: 0.99,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    try {
      const result = await new LlmExtractor({
        baseUrl: "https://extract.test/v1",
        resolveApiKey: async () => "x",
        model: "x",
      }).extract("<focus_user>记忆很混乱</focus_user>", [], scope);
      expect(result.records).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("routes all direct organization relationships to one canonical knowledge topic", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: "fact",
                      subject: "首席执行官",
                      predicate: "管理",
                      object: "运营总监",
                      polarity: "positive",
                      summary: "首席执行官管理运营总监",
                      confidence: 0.99,
                    },
                    {
                      kind: "fact",
                      subject: "运营总监",
                      predicate: "管理",
                      object: "主管C",
                      polarity: "positive",
                      summary: "运营总监管理主管C",
                      confidence: 0.99,
                    },
                    {
                      kind: "fact",
                      subject: "文件",
                      predicate: "包含",
                      object: "9个节点",
                      polarity: "positive",
                      summary: "文件有9个节点",
                      confidence: 0.99,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    try {
      const result = await new LlmExtractor({
        baseUrl: "https://extract.test/v1",
        resolveApiKey: async () => "x",
        model: "x",
      }).extract(
        "<focus_user>某公司的组织架构如下：首席执行官管理运营总监，运营总监管理主管C</focus_user>",
        [],
        scope,
      );
      expect(result.records).toHaveLength(2);
      expect(
        new Set(result.records.flatMap((record) => record.topicIds)),
      ).toEqual(new Set([`${scope.type}.${scope.id}.knowledge.organization`]));
      expect(result.topics).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
