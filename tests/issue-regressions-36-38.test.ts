import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { LearningService, WorkflowService } from "@tagent/learning";
import { Store } from "@tagent/persistence-sqlite/store";
import { createRuntimeHost } from "@tagent/core-service/composition";
import { attemptIdFor } from "@tagent/execution/domain";
import { createExecutionCollaborationAdapters } from "../apps/core-service/src/composition/execution-collaboration-adapters.js";
import { agentPersistence, httpTestResources, learningPersistence, workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  stores.splice(0).forEach((store) => store.close());
});

function collaborationFixture(principalId = "session:alice", withMemory = true) {
  const store = new Store(":memory:"); stores.push(store);
  const session = store.createSessionIdempotent({
    title: "Configured principal",
    principalId,
    idempotencyKey: "configured-principal",
    canonicalPayload: "configured-principal",
  }).session;
  const persistence = agentPersistence(store);
  const learning = new LearningService(learningPersistence(store));
  const workflows = new WorkflowService(workflowPersistence(store));
  const captureRequests: any[] = [];
  const adapters = createExecutionCollaborationAdapters({
    persistence,
    memory: withMemory ? {
      enqueueCapture: async (request: unknown) => { captureRequests.push(request); return { jobId: "capture" }; },
      recall: async (request: unknown) => ({
        cards: [], coldTopics: [], promptSection: "", trace: { version: 1, topicIds: [], candidates: [], request },
      }),
      getCoreSnapshot: async () => undefined,
    } as never : undefined,
    memoryScopeId: "default",
    learningService: learning,
    workflowService: workflows,
    publish: () => undefined,
  });
  return { store, session, persistence, learning, adapters, captureRequests };
}

function runtimeHost(store: Store, sessionId: string, subjectId: string, memory: { recall: ReturnType<typeof vi.fn> }) {
  const persistence = agentPersistence(store);
  const run = store.createRun(sessionId, "memory scope regression");
  const attempt = persistence.attempts.getAttemptForRun(run.id, run.attempt)!;
  const ownerId = `issue-36:${run.id}`;
  const lease = persistence.attempts.acquireExecutionLease({ attemptId: attempt.id, expectedVersion: attempt.version, ownerId, leaseMs: 30_000 });
  return createRuntimeHost({
    persistence,
    token: {
      runId: run.id,
      attemptId: attemptIdFor(run.id, run.attempt),
      ordinal: run.attempt,
      expectedVersion: attempt.version,
      ownerId,
      leaseToken: lease.token,
      executionFence: lease.fence,
    },
    workspace: process.cwd(),
    onActivity: () => undefined,
    onEvent: () => undefined,
    memory: memory as never,
    memoryScopeId: "default",
    memorySubjectId: subjectId,
  });
}

async function executeMemorySearch(host: ReturnType<typeof createRuntimeHost>) {
  const tool = host.capabilities.tools.find((candidate) => candidate.name === "memory_search")!;
  await tool.execute("issue-36-search", { query: "configured subject" } as never, undefined);
}

describe("GitHub issue regressions #36-#38", () => {
  it("#36 retains user scope for configured subject IDs beginning with session: while omitting only the exact fallback identity", async () => {
    const { store, session, adapters, captureRequests } = collaborationFixture();
    const run = store.createRun(session.id, "configured identity capture");
    const message = store.appendMessage(session.id, "user", "记住我使用 PostgreSQL");
    adapters.userMessageObserver.observe({ run, messageId: message.id, content: message.content, context: "" });
    await vi.waitFor(() => expect(captureRequests).toHaveLength(1));
    expect(captureRequests[0].access.scopes).toEqual([
      { type: "user", id: "session:alice" },
      { type: "workspace", id: "default" },
      { type: "session", id: session.id },
    ]);

    const configuredRecall = vi.fn(async (_input: unknown) => ({ cards: [], coldTopics: [], promptSection: "", trace: { version: 1, topicIds: [], candidates: [] } }));
    await executeMemorySearch(runtimeHost(store, session.id, "session:alice", { recall: configuredRecall }));
    expect((configuredRecall.mock.calls[0]![0] as { access: { scopes: unknown[] } }).access.scopes).toEqual([
      { type: "user", id: "session:alice" },
      { type: "workspace", id: "default" },
      { type: "session", id: session.id },
    ]);

    const fallbackSession = store.createSession();
    const fallbackRecall = vi.fn(async (_input: unknown) => ({ cards: [], coldTopics: [], promptSection: "", trace: { version: 1, topicIds: [], candidates: [] } }));
    await executeMemorySearch(runtimeHost(store, fallbackSession.id, `session:${fallbackSession.id}`, { recall: fallbackRecall }));
    expect((fallbackRecall.mock.calls[0]![0] as { access: { scopes: unknown[] } }).access.scopes).toEqual([
      { type: "workspace", id: "default" },
      { type: "session", id: fallbackSession.id },
    ]);
  });

  it("#37 keeps explicitly task/session-local Chinese and English communication preferences out of unrelated sessions", async () => {
    const { store, session, learning, adapters } = collaborationFixture("user:37", false);
    const second = store.createSessionIdempotent({ title: "Unrelated", principalId: "user:37", idempotencyKey: "unrelated", canonicalPayload: "unrelated" }).session;
    const firstRun = store.createRun(session.id, "first task");
    const secondRun = store.createRun(second.id, "second task");

    for (const [index, content] of ["这次任务我偏好回答简洁", "For this session, I prefer concise answers"].entries()) {
      const message = store.appendMessage(session.id, "user", content);
      adapters.userMessageObserver.observe({ run: firstRun, messageId: message.id, content, context: "" });
      await vi.waitFor(() => expect(store.db.prepare("SELECT COUNT(*) count FROM semantic_learning_jobs WHERE status='completed'").get()).toEqual({ count: index + 1 }));
    }

    expect(learning.listCommunicationProfiles("user:37").map((profile) => profile.scopeType)).toEqual(["session"]);
    expect(adapters.contextEnrichment.prepareWithoutRecall(firstRun, "current task").promptSection).toContain("verbosity: 简洁");
    expect(adapters.contextEnrichment.prepareWithoutRecall(secondRun, "unrelated task").promptSection).not.toContain("verbosity: 简洁");
  });

  it("#38 generates collision-resistant durable keys when console session requestId is omitted across app restarts", async () => {
    const databasePath = path.join(await mkdtemp(path.join(tmpdir(), "tagent-issue-38-")), "core.db");
    const openApp = () => {
      const store = new Store(databasePath);
      const app = createApp({ ...httpTestResources(store), service: { closeRuntimes: async () => undefined } as never, logger: false });
      apps.push(app);
      return { store, app };
    };

    const first = openApp();
    const firstResponse = await first.app.inject({ method: "POST", url: "/api/v1/console/sessions", payload: { title: "First" } });
    expect(firstResponse.statusCode).toBe(200);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);

    const second = openApp();
    const replayAfterRestart = await second.app.inject({ method: "POST", url: "/api/v1/console/sessions", payload: { title: "First" } });
    expect(replayAfterRestart.statusCode).toBe(200);
    expect(replayAfterRestart.json().data.id).not.toBe(firstResponse.json().data.id);
    await second.app.close(); apps.splice(apps.indexOf(second.app), 1);

    const third = openApp();
    const changedTitleAfterRestart = await third.app.inject({ method: "POST", url: "/api/v1/console/sessions", payload: { title: "Second" } });
    expect(changedTitleAfterRestart.statusCode).toBe(200);
    expect((third.store.db.prepare("SELECT COUNT(*) count FROM sessions").get() as { count: number }).count).toBe(3);
  });
});
