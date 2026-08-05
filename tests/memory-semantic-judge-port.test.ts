import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SemanticJudge } from "@tagent/learning";
import { InMemoryMemoryAdapter } from "../packages/memory/src/adapters/in-memory.js";
import { MemoryCaptureWorker } from "../packages/memory/src/capture-worker.js";
import { MemoryService } from "../packages/memory/src/memory-service.js";
import type {
  SemanticMemoryJudgePort,
  SemanticMemoryQualityDecision,
} from "@tagent/memory/ports";
import { DefaultPolicyEngine } from "../packages/memory/src/policy/policy-engine.js";
import type { WarmMemory } from "@tagent/memory/domain";

const scope = { type: "workspace" as const, id: "semantic-port" };

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const filename = path.join(root, name);
    return statSync(filename).isDirectory()
      ? sourceFiles(filename)
      : filename.endsWith(".ts") ? [filename] : [];
  });
}

function memoryRecord(overrides: Partial<WarmMemory> = {}): WarmMemory {
  const now = Date.now();
  return {
    id: "70000000-0000-4000-8000-000000000001",
    kind: "fact",
    tier: "hot",
    scope,
    title: "项目主数据库",
    content: "项目长期使用 PostgreSQL 作为主数据库",
    summary: "项目主数据库是 PostgreSQL",
    topicIds: [],
    entityIds: [],
    status: "active",
    confidence: 0.95,
    importance: 0.9,
    sourceRefs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WarmMemory;
}

function fixture(record: WarmMemory, judge: SemanticMemoryJudgePort) {
  const adapter = new InMemoryMemoryAdapter();
  const policy = new DefaultPolicyEngine(adapter);
  const service = new MemoryService({
    records: adapter,
    vectors: adapter,
    graph: adapter,
    topics: adapter,
    jobs: adapter,
    policy,
    blobs: {
      async putImmutable() { return { checksum: "unused", byteLength: 0 }; },
      async get() { return ""; },
      async delete() {},
      async exists() { return false; },
    },
  });
  const extractor = { extract: async () => ({ records: [record], topics: [], nodes: [], edges: [] }) };
  return { adapter, policy, service, extractor, judge };
}

function judge(options: {
  capture?: Awaited<ReturnType<SemanticMemoryJudgePort["memoryCapture"]>>;
  quality?: SemanticMemoryQualityDecision;
}) {
  const calls = { capture: 0, quality: 0 };
  const port: SemanticMemoryJudgePort = {
    snapshot: () => ({
      calls: calls.capture + calls.quality,
      cacheHits: 0,
      failures: 0,
      timeouts: 0,
      lowConfidence: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      latencyMs: 0,
      averageLatencyMs: 0,
      cacheHitRate: 0,
    }),
    memoryCapture: async () => {
      calls.capture++;
      return options.capture;
    },
    memoryQuality: async () => {
      calls.quality++;
      return options.quality;
    },
  };
  return { calls, port };
}

async function enqueueAndRun(
  value: ReturnType<typeof fixture>,
  idempotencyKey: string,
) {
  const job = await value.service.enqueueCapture({
    access: { subjectId: "user", scopes: [scope], purpose: "capture" },
    sourceRefs: [],
    content: "user: 项目长期使用 PostgreSQL 作为主数据库",
    idempotencyKey,
    captureSource: { kind: "user_message", role: "user" },
  });
  await new MemoryCaptureWorker(
    value.adapter,
    { load: async () => "" },
    value.extractor,
    value.policy,
    value.service,
    undefined,
    "semantic-port-test-worker",
    undefined,
    value.judge,
  ).runOnce();
  return value.adapter.jobs.get(job.jobId);
}

describe("Memory-owned semantic judge port", () => {
  it("accepts the Learning SemanticJudge through structural typing", () => {
    const memoryJudge: SemanticMemoryJudgePort = new SemanticJudge({
      model: {
        modelId: "test",
        request: async () => { throw new Error("not called"); },
      },
    });
    expect(memoryJudge.snapshot()).toMatchObject({ calls: 0, cacheHits: 0, failures: 0 });
  });

  it("keeps semantic capture rejection behavior", async () => {
    const semantic = judge({
      capture: {
        shouldCapture: false,
        durable: false,
        category: "none",
        confidence: 0.97,
        reason: "transient request",
      },
    });
    const value = fixture(memoryRecord(), semantic.port);
    let extractorCalls = 0;
    value.extractor.extract = async () => {
      extractorCalls++;
      return { records: [], topics: [], nodes: [], edges: [] };
    };

    const job = await enqueueAndRun(value, "capture-rejected");

    expect(semantic.calls).toEqual({ capture: 1, quality: 0 });
    expect(extractorCalls).toBe(0);
    expect(job).toMatchObject({
      status: "completed_empty",
      extractedCount: 0,
      proposalCount: 0,
      persistedCount: 0,
      filterReasons: { semantic_not_durable: 1 },
    });
  });

  it.each([
    [undefined, "semantic_low_confidence"],
    [{ accept: false, confidence: 0.94, reason: "unsupported", rejectionCode: "unsupported_claim" } as const, "unsupported_claim"],
  ])("preserves semantic quality fallback for %s", async (quality, reason) => {
    const semantic = judge({
      capture: {
        shouldCapture: true,
        durable: true,
        category: "fact",
        confidence: 0.97,
        reason: "durable fact",
      },
      quality,
    });
    const value = fixture(memoryRecord(), semantic.port);

    const job = await enqueueAndRun(value, `quality-${reason}`);

    expect(semantic.calls).toEqual({ capture: 1, quality: 1 });
    expect(job).toMatchObject({
      status: "completed_empty",
      extractedCount: 1,
      proposalCount: 0,
      persistedCount: 0,
      filterReasons: { [reason]: 1 },
    });
  });

  it("keeps hard quality rules ahead of the semantic judge", async () => {
    const semantic = judge({
      capture: {
        shouldCapture: true,
        durable: true,
        category: "episode",
        confidence: 0.97,
        reason: "candidate",
      },
      quality: { accept: true, confidence: 0.99, reason: "accept", rejectionCode: "none" },
    });
    const value = fixture(memoryRecord({ title: "TaskRun completed", content: "TaskRun completed" }), semantic.port);

    const job = await enqueueAndRun(value, "hard-rule-first");

    expect(semantic.calls).toEqual({ capture: 1, quality: 0 });
    expect(job?.filterReasons).toEqual({ control_plane: 1 });
  });

  it("has no source dependency from Memory to Learning", () => {
    const memoryRoot = path.join(process.cwd(), "packages", "memory", "src");
    const violations = sourceFiles(memoryRoot).flatMap((filename) => {
      const imported = ts.preProcessFile(readFileSync(filename, "utf8"), true, true).importedFiles;
      return imported
        .map((entry) => entry.fileName.replaceAll("\\", "/"))
        .filter((specifier) => /(^|\/)learning(?:\/|$)/.test(specifier))
        .map((specifier) => `${path.relative(process.cwd(), filename)} -> ${specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
