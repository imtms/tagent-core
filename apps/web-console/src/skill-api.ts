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
    sessionSkill: (sessionId: string) => request(`/api/v1/console/sessions/${sessionId}/skill`, undefined, ConsoleDecode.skillRevisionOrNull),
    uploadSkill: async (sessionId: string, file: File) => request(`/api/v1/console/sessions/${sessionId}/skill/upload`, { method: "POST", body: JSON.stringify({ filename: file.name, contentBase64: base64(new Uint8Array(await file.arrayBuffer())) }) }, ConsoleDecode.skillRevision),
    bindSkill: (sessionId: string, revisionId: string) => request(`/api/v1/console/sessions/${sessionId}/skill`, { method: "PUT", body: JSON.stringify({ revisionId }) }, ConsoleDecode.skillRevision),
    unbindSkill: (sessionId: string) => request(`/api/v1/console/sessions/${sessionId}/skill`, { method: "DELETE" }, ConsoleDecode.ok),
  };
}
