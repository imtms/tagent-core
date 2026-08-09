import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite/store";
import { httpTestResources } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const store = new Store(":memory:");
  const app = createApp({
    ...httpTestResources(store),
    service: { closeRuntimes: async () => undefined } as never,
    logger: false,
  });
  apps.push(app);
  return { app, store };
}

describe("Console performance paths", () => {
  it("returns lightweight Run summaries without durable payloads", async () => {
    const { app, store } = fixture();
    const session = store.createSession("Lightweight HTTP list");
    const run = store.createRun(session.id, "large durable run");
    store.addArtifact(run.id, {
      id: "large", title: "Large", kind: "report", content: "x".repeat(100_000), uri: "",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/console/sessions/${session.id}/task-runs?limit=10`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{
      id: run.id,
      goal: "large durable run",
      status: "running",
      phase: "discover",
      contract: null,
      attempt: 1,
      createdAt: run.createdAt,
      updatedAt: expect.any(Number),
    }]);
    expect(response.body).not.toContain("artifacts");
    expect(response.body).not.toContain("completionGate");
    expect(response.body).not.toContain("x".repeat(1_000));
  });

  it("validates transcript windows and returns only rows after the cursor", async () => {
    const { app, store } = fixture();
    const run = store.createRun(store.createSession().id, "incremental transcript");
    store.appendTranscript(run.id, 1, { role: "user", content: "first", timestamp: 1 });
    store.appendTranscript(run.id, 1, { role: "user", content: "second", timestamp: 2 });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/console/task-runs/${run.id}/transcript?after=1&limit=1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({ seq: 2, kind: "user", text: "second" }),
    ]);

    for (const query of ["after=-1", "after=1.5", "after=abc", "limit=0", "limit=201", "limit=1.5", "limit=abc"]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/api/v1/console/task-runs/${run.id}/transcript?${query}`,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { retryable: false } });
    }
  });
});
