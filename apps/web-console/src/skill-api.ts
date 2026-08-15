import {
  OperatorSkillCatalogResponseSchema,
  OperatorSkillResponseSchema,
  OperatorSkillRevisionsResponseSchema,
  OperatorWorkspaceSkillsResponseSchema,
  decodeAbi,
  type OperatorSkillRevision,
  type OperatorSkillSummary,
} from "@tagent/abi";
import { createRequestId } from "./id";

export type SkillRevision = OperatorSkillRevision;
export type SkillSummary = OperatorSkillSummary;

type Request = <T>(url: string, init: RequestInit | undefined, decode: (payload: unknown) => T | Promise<T>) => Promise<T>;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function mutationHeaders(revision: number): Headers {
  const headers = new Headers();
  headers.set("Idempotency-Key", createRequestId());
  headers.set("If-Match", `"r${revision}"`);
  return headers;
}

export function createSkillApi(request: Request) {
  let catalogRevision = 1;
  const skillResourceRevisions = new Map<string, number>();
  const workspaceRevisions = new Map<string, number>();

  const skills = async (): Promise<SkillSummary[]> => request("/api/v1/operator/skills?limit=200", undefined, (payload) => {
    const data = decodeAbi(OperatorSkillCatalogResponseSchema.properties.data, payload);
    catalogRevision = data.collectionRevision;
    for (const item of data.items) skillResourceRevisions.set(item.id, item.resourceRevision);
    return data.items;
  });

  const skill = async (skillId: string): Promise<SkillRevision> => request(`/api/v1/operator/skills/${encodeURIComponent(skillId)}`, undefined, (payload) => {
    const data = decodeAbi(OperatorSkillResponseSchema.properties.data, payload);
    skillResourceRevisions.set(skillId, data.resourceRevision);
    catalogRevision = data.catalogRevision;
    return data.skill;
  });

  const workspaceSkills = async (workspaceId: string): Promise<SkillRevision[]> => request(`/api/v1/operator/workspaces/${encodeURIComponent(workspaceId)}/skills?limit=32`, undefined, (payload) => {
    const data = decodeAbi(OperatorWorkspaceSkillsResponseSchema.properties.data, payload);
    workspaceRevisions.set(workspaceId, data.bindingRevision);
    return data.items;
  });

  return {
    skills,
    skill,
    skillRevisions: (skillId: string) => request(`/api/v1/operator/skills/${encodeURIComponent(skillId)}/revisions?limit=200`, undefined, (payload) => {
      const data = decodeAbi(OperatorSkillRevisionsResponseSchema.properties.data, payload);
      skillResourceRevisions.set(skillId, data.resourceRevision);
      return data.items;
    }),
    uploadSkill: async (file: File) => request("/api/v1/operator/skills", {
      method: "POST", headers: mutationHeaders(catalogRevision),
      body: JSON.stringify({ filename: file.name, contentBase64: base64(new Uint8Array(await file.arrayBuffer())) }),
    }, (payload) => {
      const data = decodeAbi(OperatorSkillResponseSchema.properties.data, payload);
      skillResourceRevisions.set(data.skill.skillId, data.resourceRevision);
      catalogRevision = data.catalogRevision;
      return data.skill;
    }),
    updateSkill: (skillId: string, input: Pick<SkillRevision, "name" | "description" | "content" | "disableModelInvocation">) => request(`/api/v1/operator/skills/${encodeURIComponent(skillId)}`, {
      method: "PATCH", headers: mutationHeaders(skillResourceRevisions.get(skillId) ?? 1), body: JSON.stringify(input),
    }, (payload) => {
      const data = decodeAbi(OperatorSkillResponseSchema.properties.data, payload);
      skillResourceRevisions.set(skillId, data.resourceRevision);
      catalogRevision = data.catalogRevision;
      return data.skill;
    }),
    deleteSkill: (skillId: string) => request(`/api/v1/operator/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE", headers: mutationHeaders(skillResourceRevisions.get(skillId) ?? 1),
    }, () => ({ ok: true as const })),
    workspaceSkills,
    replaceWorkspaceSkills: (workspaceId: string, skillIds: string[]) => request(`/api/v1/operator/workspaces/${encodeURIComponent(workspaceId)}/skills`, {
      method: "PUT", headers: mutationHeaders(workspaceRevisions.get(workspaceId) ?? 1), body: JSON.stringify({ skillIds }),
    }, (payload) => {
      const data = decodeAbi(OperatorWorkspaceSkillsResponseSchema.properties.data, payload);
      workspaceRevisions.set(workspaceId, data.bindingRevision);
      return data.items;
    }),
  };
}
