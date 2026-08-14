import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "@tagent/core-service/application";
import { CoreClient } from "@tagent/core-client";
import { createApp } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite";
import { verifyGatewayProfileProvider } from "./support/gateway-profile-provider.js";
import { agentPersistence, httpTestResources } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Gateway profile provider harness", () => {
  it("checks canonical fixtures and every advertised route against a real listening Core", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-profile-provider-"));
    directories.push(workspace);
    const store = new Store(":memory:");
    const service = new AgentService(agentPersistence(store), workspace, () => ({
      prompt: async () => undefined,
      steer: async () => "accepted" as const,
      followUp: async () => "accepted" as const,
      compact: async () => undefined,
      abort: () => undefined,
      dispose: async () => undefined,
      getMessages: () => [],
      getError: () => undefined,
    }));
    const app = createApp({ ...httpTestResources(store), service, workspaceRoot: workspace, logger: false });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const report = await verifyGatewayProfileProvider(app, new CoreClient({ baseUrl: address, timeoutMs: 5_000 }));
    expect(report).toEqual({ profileCount: 8, uniqueEndpointCount: 41, routeCount: 41, fixtureCount: 19 });
  });
});
