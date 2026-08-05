import { timingSafeEqual } from "node:crypto";

export type ServiceScope = "sessions:read" | "sessions:write" | "runs:read" | "runs:control" | "events:consume" | "workflows:teach" | "workflows:govern" | "workflows:approve" | "admin" | "internal";
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
