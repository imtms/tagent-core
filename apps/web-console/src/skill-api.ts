import type { ConsoleV1 } from "@tagent/abi";
import { ConsoleDecode } from "@tagent/core-client";

export type SkillRevision = ConsoleV1.ConsoleSkillRevision;
export type SkillSummary = ConsoleV1.ConsoleSkillSummary;

type Request = <T>(url: string, init: RequestInit | undefined, decode: (payload: unknown) => T | Promise<T>) => Promise<T>;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function createSkillApi(request: Request) {
  return {
    skills: () => request("/api/v1/console/skills", undefined, ConsoleDecode.skills),
    skill: (skillId: string) => request(`/api/v1/console/skills/${skillId}`, undefined, ConsoleDecode.skillRevision),
    skillRevisions: (skillId: string) => request(`/api/v1/console/skills/${skillId}/revisions`, undefined, ConsoleDecode.skillRevisions),
    uploadSkill: async (file: File) => request("/api/v1/console/skills", { method: "POST", body: JSON.stringify({ filename: file.name, contentBase64: base64(new Uint8Array(await file.arrayBuffer())) }) }, ConsoleDecode.skillRevision),
    updateSkill: (skillId: string, input: Pick<SkillRevision, "name" | "description" | "content" | "disableModelInvocation">) => request(`/api/v1/console/skills/${skillId}`, { method: "PATCH", body: JSON.stringify(input) }, ConsoleDecode.skillRevision),
    deleteSkill: (skillId: string) => request(`/api/v1/console/skills/${skillId}`, { method: "DELETE" }, ConsoleDecode.ok),
    workspaceSkills: (workspaceId: string) => request(`/api/v1/console/workspaces/${workspaceId}/skills`, undefined, ConsoleDecode.skillRevisions),
    replaceWorkspaceSkills: (workspaceId: string, skillIds: string[]) => request(`/api/v1/console/workspaces/${workspaceId}/skills`, { method: "PUT", body: JSON.stringify({ skillIds }) }, ConsoleDecode.skillRevisions),
  };
}
