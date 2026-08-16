import { timingSafeEqual } from "node:crypto";

export const SERVICE_SCOPES = [
  "sessions:read", "sessions:write", "runs:read", "runs:control", "events:consume",
  "admin", "internal",
  "operator:session-settings:read", "operator:session-settings:write",
  "operator:inbox:read", "operator:inbox:write", "operator:inbox:control",
  "operator:context-manifests:read", "operator:skills:read", "operator:skills:write",
  "admin:memory:read", "admin:memory:write",
  "admin:operations:read",
] as const;
export type ServiceScope = typeof SERVICE_SCOPES[number];
export interface ServiceResourceScope {
  type: "user" | "workspace" | "project" | "session";
  id: string;
}
export interface ServicePrincipal {
  subjectId: string;
  resourceScopes: ServiceResourceScope[];
}
export interface ServiceCredential {
  token: string;
  scopes: ServiceScope[];
  principal?: ServicePrincipal;
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
