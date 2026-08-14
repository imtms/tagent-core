import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CAPABILITY_PROFILE_DESCRIPTORS,
  CapabilityProfileDetailResponseSchema,
  CapabilityProfileRegistryResponseSchema,
  CoreCapabilitiesResponseSchema,
  ErrorEnvelopeSchema,
  decodeAbi,
} from "@tagent/abi";
import { AgentService } from "@tagent/core-service/application";
import { createApp, type ServiceCredential } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite";
import { agentPersistence, httpTestResources } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(credentials: ServiceCredential[] = []) {
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-capability-profiles-"));
  directories.push(workspace);
  const store = new Store(":memory:");
  const service = new AgentService(agentPersistence(store), workspace, () => ({
    prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
    compact: async () => undefined, abort: () => undefined, dispose: async () => undefined,
    getMessages: () => [], getError: () => undefined,
  }));
  const app = createApp({
    ...httpTestResources(store), service, workspaceRoot: workspace, logger: false,
    serviceCredentials: credentials,
  });
  apps.push(app);
  return app;
}

describe("capability profile registry", () => {
  it("keeps the closed legacy capability response unchanged and publishes independent profiles", async () => {
    const app = await fixture();
    const legacyResponse = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    const legacy = decodeAbi(CoreCapabilitiesResponseSchema, legacyResponse.json());
    expect(legacy.data).not.toHaveProperty("profiles");

    const response = await app.inject({ method: "GET", url: "/api/v1/capability-profiles" });
    const registry = decodeAbi(CapabilityProfileRegistryResponseSchema, response.json());
    expect(registry.data.profiles.map((profile) => profile.id))
      .toEqual(CAPABILITY_PROFILE_DESCRIPTORS.map((profile) => profile.id));
    expect(registry.data.profiles.every((profile) => profile.authorization.status === "available")).toBe(true);

    for (const summary of registry.data.profiles) {
      const detailResponse = await app.inject({ method: "GET", url: summary.detailPath });
      const detail = decodeAbi(CapabilityProfileDetailResponseSchema, detailResponse.json());
      expect(detail.data.profile.id).toBe(summary.id);
      expect(detail.data.profile.endpointIds).toEqual(detail.data.profile.endpoints.map((endpoint) => endpoint.id));
      expect(detail.data.profile.compatibility).toMatchObject({
        additiveChangesRequireMinor: true,
        incompatibleChangesRequireMajor: true,
        unknownResponseFields: "rejected",
      });
    }
  });

  it("authenticates fail-closed and reports endpoint authorization for the actual principal", async () => {
    const token = "profile-registry-token-123456789";
    const app = await fixture([{
      token,
      scopes: ["operator:session-settings:read", "operator:inbox:read"],
      principal: { subjectId: "gateway-profile-probe", resourceScopes: [{ type: "workspace", id: "production" }] },
    }]);

    expect((await app.inject({ method: "GET", url: "/api/v1/capability-profiles" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: "/api/v1/capability-profiles", headers: { authorization: "Bearer invalid" },
    })).statusCode).toBe(401);

    const response = await app.inject({
      method: "GET", url: "/api/v1/capability-profiles", headers: { authorization: `Bearer ${token}` },
    });
    const registry = decodeAbi(CapabilityProfileRegistryResponseSchema, response.json());
    const settings = registry.data.profiles.find((profile) => profile.id === "operator.session-settings.v1");
    const inbox = registry.data.profiles.find((profile) => profile.id === "operator.session-inbox.v1");
    const memory = registry.data.profiles.find((profile) => profile.id === "admin.memory.v1");
    expect(settings?.authorization).toMatchObject({
      principalId: "gateway-profile-probe",
      status: "partially_available",
      availableEndpointIds: ["operator.session_settings.get"],
      missingScopes: ["operator:session-settings:write"],
    });
    expect(inbox?.authorization.availableEndpointIds).toEqual(["operator.session_inbox.list", "operator.operations.get"]);
    expect(memory?.authorization.status).toBe("unavailable");
  });

  it("returns a stable unsupported-capability error", async () => {
    const app = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/capability-profiles/not-supported.v1" });
    expect(response.statusCode).toBe(404);
    expect(decodeAbi(ErrorEnvelopeSchema, response.json()).error).toMatchObject({
      code: "capability.unsupported",
      retryable: false,
      details: { profileId: "not-supported.v1" },
    });
  });
});
