import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeAbi,
  ErrorEnvelopeSchema,
  OperatorSkillCatalogResponseSchema,
  OperatorSkillResponseSchema,
  OperatorWorkspaceSkillsResponseSchema,
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
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-skills-profile-"));
  directories.push(workspace);
  const store = new Store(":memory:");
  const persistence = agentPersistence(store);
  const service = new AgentService(persistence, workspace, () => ({
    prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
    compact: async () => undefined, abort: () => undefined, dispose: async () => undefined,
    getMessages: () => [], getError: () => undefined,
  }));
  const app = createApp({ ...httpTestResources(store), service, workspaceRoot: workspace, logger: false, serviceCredentials: credentials });
  apps.push(app);
  return { app, store };
}

function skillSource(name: string, body: string) {
  return `---\nname: ${name}\ndescription: A profile contract test Skill\n---\n\n${body}\n`;
}

describe("Operator Skills profile", () => {
  it("publishes bounded reads and conditionally writes with exact replay and redaction", async () => {
    const { app, store } = await fixture();
    const catalogUrl = "/api/v1/operator/skills";
    const initial = await app.inject({ method: "GET", url: catalogUrl });
    expect(initial.headers.etag).toBe('"r1"');
    expect(decodeAbi(OperatorSkillCatalogResponseSchema, initial.json()).data.items).toEqual([]);

    const upload = {
      filename: "SKILL.md",
      contentBase64: Buffer.from(skillSource("gateway-check", "Verify the Gateway contract.")).toString("base64"),
    };
    const headers = { "idempotency-key": "skill-create-1", "if-match": '"r1"' };
    const createdResponse = await app.inject({ method: "POST", url: catalogUrl, headers, payload: upload });
    expect(createdResponse.statusCode).toBe(200);
    const created = decodeAbi(OperatorSkillResponseSchema, createdResponse.json()).data;
    expect(created).toMatchObject({ resourceRevision: 1, catalogRevision: 2, skill: { name: "gateway-check", revision: 1 } });
    expect(created.skill).not.toHaveProperty("filePath");
    expect(created.skill).not.toHaveProperty("sourceFilename");

    const replay = await app.inject({ method: "POST", url: catalogUrl, headers, payload: upload });
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(decodeAbi(OperatorSkillResponseSchema, replay.json()).data).toEqual(created);

    const conflict = await app.inject({
      method: "POST", url: catalogUrl, headers,
      payload: { ...upload, contentBase64: Buffer.from(skillSource("gateway-check", "Changed.")).toString("base64") },
    });
    expect(conflict.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, conflict.json()).error.code).toBe("idempotency.conflict");

    const updateHeaders = { "idempotency-key": "skill-update-1", "if-match": '"r1"' };
    const updatedResponse = await app.inject({
      method: "PATCH", url: `${catalogUrl}/${created.skill.skillId}`, headers: updateHeaders,
      payload: { name: "gateway-check", description: "Updated", content: "Updated contract checks.", disableModelInvocation: true },
    });
    const updated = decodeAbi(OperatorSkillResponseSchema, updatedResponse.json()).data;
    expect(updated).toMatchObject({ resourceRevision: 2, catalogRevision: 3, skill: { revision: 2, disableModelInvocation: true } });

    const stale = await app.inject({
      method: "PATCH", url: `${catalogUrl}/${created.skill.skillId}`,
      headers: { "idempotency-key": "skill-update-stale", "if-match": '"r1"' },
      payload: { name: "gateway-check", description: "Stale", content: "Stale update." },
    });
    expect(decodeAbi(ErrorEnvelopeSchema, stale.json()).error.code).toBe("concurrency.conflict");

    const session = store.createSession("Workspace");
    const bindingsUrl = `/api/v1/operator/workspaces/${session.id}/skills`;
    const binding = await app.inject({
      method: "PUT", url: bindingsUrl,
      headers: { "idempotency-key": "skill-bind-1", "if-match": '"r1"' },
      payload: { skillIds: [created.skill.skillId] },
    });
    expect(decodeAbi(OperatorWorkspaceSkillsResponseSchema, binding.json()).data).toMatchObject({
      bindingRevision: 2, items: [{ skillId: created.skill.skillId, revision: 2 }],
    });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM profile_audit_events WHERE profile_id='operator.skills.v1'").get())
      .toEqual({ count: 3 });
  });

  it("requires wildcard workspace authority for the global catalog and explicit authority for bindings", async () => {
    const token = "skills-profile-token-123456789";
    const { app, store } = await fixture([{
      token,
      scopes: ["operator:skills:read", "operator:skills:write"],
      principal: { subjectId: "gateway-skills", resourceScopes: [{ type: "workspace", id: "allowed" }] },
    }]);
    const authorization = { authorization: `Bearer ${token}` };
    const denied = await app.inject({ method: "GET", url: "/api/v1/operator/skills", headers: authorization });
    expect(decodeAbi(ErrorEnvelopeSchema, denied.json()).error.code).toBe("auth.resource_scope_denied");

    const session = store.createSession("Denied binding");
    const binding = await app.inject({
      method: "GET", url: `/api/v1/operator/workspaces/${session.id}/skills`, headers: authorization,
    });
    expect(binding.statusCode).toBe(403);
  });
});
