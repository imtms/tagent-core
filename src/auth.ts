import { timingSafeEqual } from "node:crypto";

export type ServiceScope = "sessions:read" | "sessions:write" | "runs:read" | "runs:control" | "events:consume";
export interface ServiceCredential { token: string; scopes: ServiceScope[] }

export function secureEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requiredServiceScope(method: string, url: string): ServiceScope | null | "admin" {
  const pathname = url.split("?")[0];
  if (pathname === "/api/health") return null;
  if (pathname === "/api/settings" || pathname === "/api/config/status") return "admin";
  if (/^\/api\/runs\/[^/]+\/consumers\/[^/]+\/(claim|ack)$/.test(pathname) || /^\/api\/runs\/[^/]+\/events$/.test(pathname)) return "events:consume";
  if (/^\/api\/runs\/[^/]+\/(cancel|steer|follow-up|resume|retry-launch)$/.test(pathname)) return "runs:control";
  if (/^\/api\/runs\/[^/]+(\/(supervision|control-inbox|operations|transcript|transcript-view))?$/.test(pathname) && method === "GET") return "runs:read";
  if (pathname.startsWith("/api/sessions")) return method === "GET" ? "sessions:read" : "sessions:write";
  return "admin";
}
