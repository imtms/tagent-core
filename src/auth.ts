import { timingSafeEqual } from "node:crypto";

export type ServiceScope = "sessions:read" | "sessions:write" | "runs:read" | "runs:control" | "events:consume" | "workflows:teach" | "workflows:govern" | "workflows:approve";
export interface ServiceCredential { token: string; scopes: ServiceScope[] }

export function secureEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requiredServiceScope(method: string, url: string): ServiceScope | null | "admin" {
  const pathname = url.split("?")[0];
  if (pathname === "/api/health") return null;
  if (pathname === "/api/settings" || pathname === "/api/config/status" || pathname === "/api/learning/settings") return "admin";
  if (/^\/api\/runs\/[^/]+\/consumers\/[^/]+\/(claim|ack)$/.test(pathname) || /^\/api\/runs\/[^/]+\/events$/.test(pathname)) return "events:consume";
  if (/^\/api\/runs\/[^/]+\/(cancel|steer|follow-up|resume|retry-launch)$/.test(pathname)) return "runs:control";
  if (/^\/api\/sessions\/[^/]+\/workflows\/teach$/.test(pathname)) return "workflows:teach";
  if (/^\/api\/internal\/workflows\/[^/]+\/evaluate$/.test(pathname)) return "admin";
  if (/^\/api\/autonomy-approvals\/[^/]+\/(approve|reject|revoke|execute)$/.test(pathname)) return "workflows:approve";
  if (/^\/api\/sessions\/[^/]+\/inbox\/[^/]+\/parallel-start-request$/.test(pathname)) return "workflows:govern";
  if (/^\/api\/(workflows\/[^/]+\/(suspend|restore|evaluations|activation-request|promotion-request)|workflow-proposals\/[^/]+\/(approve|reject|application-request)|workflow-distillation\/(run|dead-letter|[^/]+\/retry)|workflow-evaluations\/[^/]+\/verify|communication-profiles\/[^/]+\/lock|feedback-attribution\/drain)$/.test(pathname)) return "workflows:govern";
  if (/^\/api\/(workflows\/[^/]+\/(activate|rollback|promote)|workflow-proposals\/[^/]+\/apply|workflow-bindings\/[^/]+\/(mode|application))$/.test(pathname)) return "workflows:approve";
  if (/^\/api\/runs\/[^/]+\/artifacts\/[^/]+\/(content|download)$/.test(pathname) && method === "GET") return "runs:read";
  if (/^\/api\/runs\/[^/]+(\/(supervision|control-inbox|operations|transcript|transcript-view))?$/.test(pathname) && method === "GET") return "runs:read";
  if (pathname.startsWith("/api/sessions")) return method === "GET" ? "sessions:read" : "sessions:write";
  return "admin";
}
