import type { CapabilityProfileDescriptor, ProfileServiceScope } from "./schemas.js";

const none = {
  kind: "none",
  idempotencyKeyRequired: false,
  revisionPreconditionRequired: false,
  operationLookupPath: null,
  interruptedEffectState: "not_applicable",
  automaticUnknownReplay: false,
} as const;

const exactReplay = {
  kind: "exact_replay_readback",
  idempotencyKeyRequired: true,
  revisionPreconditionRequired: true,
  operationLookupPath: null,
  interruptedEffectState: "not_applicable",
  automaticUnknownReplay: false,
} as const;

const receipt = (path: string) => ({
  kind: "durable_receipt_lookup" as const,
  idempotencyKeyRequired: true,
  revisionPreconditionRequired: false,
  operationLookupPath: path,
  interruptedEffectState: "outcome_unknown" as const,
  automaticUnknownReplay: false as const,
});

type EndpointInput = {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  requiredScopes: ProfileServiceScope[];
  resourceScope: "none" | "principal" | "workspace" | "session" | "task_run" | "memory";
  recovery?: typeof none | typeof exactReplay | ReturnType<typeof receipt>;
};

function endpoint(input: EndpointInput) {
  return { ...input, recovery: input.recovery ?? none };
}

const pagination = {
  style: "opaque_cursor" as const,
  cursorVersion: "1" as const,
  cursorOpaque: true,
  cursorExpiry: false,
  cursorSurvivesRestart: true,
  membershipConsistency: "snapshot" as const,
  defaultLimit: 50,
  maximumLimit: 200,
};

const noPagination = {
  style: "none" as const,
  cursorVersion: null,
  cursorOpaque: false,
  cursorExpiry: false,
  cursorSurvivesRestart: true,
  membershipConsistency: "not_applicable" as const,
  defaultLimit: null,
  maximumLimit: null,
};

const durableRetention = {
  automaticDeletion: false,
  tombstones: false,
  missingResourceStatus: 404 as const,
  operationReceiptDays: null,
};

function profile(input: Omit<CapabilityProfileDescriptor, "version" | "detailPath" | "endpointIds" | "compatibility">): CapabilityProfileDescriptor {
  return {
    ...input,
    version: "1.0",
    detailPath: `/api/v1/capability-profiles/${input.id}`,
    endpointIds: input.endpoints.map((item) => item.id),
    compatibility: {
      additiveChangesRequireMinor: true,
      incompatibleChangesRequireMajor: true,
      unknownResponseFields: "rejected",
    },
  };
}

export const CAPABILITY_PROFILE_DESCRIPTORS: CapabilityProfileDescriptor[] = [
  profile({
    id: "operator.session-settings.v1", audience: "operator", pagination: noPagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "operator.session_settings.get", method: "GET", path: "/api/v1/operator/sessions/:sessionId/settings", requiredScopes: ["operator:session-settings:read"], resourceScope: "session" }),
      endpoint({ id: "operator.session_settings.update", method: "PATCH", path: "/api/v1/operator/sessions/:sessionId/settings", requiredScopes: ["operator:session-settings:write"], resourceScope: "session", recovery: exactReplay }),
    ],
  }),
  profile({
    id: "operator.session-inbox.v1", audience: "operator", pagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "operator.session_inbox.list", method: "GET", path: "/api/v1/operator/sessions/:sessionId/inbox", requiredScopes: ["operator:inbox:read"], resourceScope: "session" }),
      endpoint({ id: "operator.session_inbox.reorder", method: "PUT", path: "/api/v1/operator/sessions/:sessionId/inbox/order", requiredScopes: ["operator:inbox:write"], resourceScope: "session", recovery: exactReplay }),
      endpoint({ id: "operator.session_inbox.update", method: "PATCH", path: "/api/v1/operator/sessions/:sessionId/inbox/:itemId", requiredScopes: ["operator:inbox:write"], resourceScope: "session", recovery: exactReplay }),
      endpoint({ id: "operator.session_inbox.decide", method: "POST", path: "/api/v1/operator/sessions/:sessionId/inbox/:itemId/decision", requiredScopes: ["operator:inbox:write"], resourceScope: "session", recovery: exactReplay }),
      endpoint({ id: "operator.session_inbox.merge", method: "POST", path: "/api/v1/operator/sessions/:sessionId/inbox/:itemId/merge", requiredScopes: ["operator:inbox:write"], resourceScope: "session", recovery: exactReplay }),
      endpoint({ id: "operator.session_inbox.delete", method: "DELETE", path: "/api/v1/operator/sessions/:sessionId/inbox/:itemId", requiredScopes: ["operator:inbox:write"], resourceScope: "session", recovery: exactReplay }),
      endpoint({ id: "operator.session_inbox.start", method: "POST", path: "/api/v1/operator/sessions/:sessionId/inbox/:itemId/start", requiredScopes: ["operator:inbox:control"], resourceScope: "session", recovery: receipt("/api/v1/operator/operations/:requestId") }),
      endpoint({ id: "operator.session_inbox.retry_launch", method: "POST", path: "/api/v1/operator/task-runs/:taskRunId/retry-launch", requiredScopes: ["operator:inbox:control"], resourceScope: "task_run", recovery: receipt("/api/v1/operator/operations/:requestId") }),
      endpoint({ id: "operator.operations.get", method: "GET", path: "/api/v1/operator/operations/:requestId", requiredScopes: ["operator:inbox:read"], resourceScope: "principal" }),
    ],
  }),
  profile({
    id: "operator.context-manifest.v1", audience: "operator", pagination, retention: durableRetention,
    endpoints: [endpoint({ id: "operator.context_manifests.list", method: "GET", path: "/api/v1/operator/task-runs/:taskRunId/context-manifests", requiredScopes: ["operator:context-manifests:read"], resourceScope: "task_run" })],
  }),
  profile({
    id: "operator.skills.v1", audience: "operator", pagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "operator.skills.list", method: "GET", path: "/api/v1/operator/skills", requiredScopes: ["operator:skills:read"], resourceScope: "workspace" }),
      endpoint({ id: "operator.skills.get", method: "GET", path: "/api/v1/operator/skills/:skillId", requiredScopes: ["operator:skills:read"], resourceScope: "workspace" }),
      endpoint({ id: "operator.skills.revisions.list", method: "GET", path: "/api/v1/operator/skills/:skillId/revisions", requiredScopes: ["operator:skills:read"], resourceScope: "workspace" }),
      endpoint({ id: "operator.skills.create", method: "POST", path: "/api/v1/operator/skills", requiredScopes: ["operator:skills:write"], resourceScope: "workspace", recovery: exactReplay }),
      endpoint({ id: "operator.skills.update", method: "PATCH", path: "/api/v1/operator/skills/:skillId", requiredScopes: ["operator:skills:write"], resourceScope: "workspace", recovery: exactReplay }),
      endpoint({ id: "operator.skills.delete", method: "DELETE", path: "/api/v1/operator/skills/:skillId", requiredScopes: ["operator:skills:write"], resourceScope: "workspace", recovery: exactReplay }),
      endpoint({ id: "operator.workspace_skills.list", method: "GET", path: "/api/v1/operator/workspaces/:workspaceId/skills", requiredScopes: ["operator:skills:read"], resourceScope: "workspace" }),
      endpoint({ id: "operator.workspace_skills.replace", method: "PUT", path: "/api/v1/operator/workspaces/:workspaceId/skills", requiredScopes: ["operator:skills:write"], resourceScope: "workspace", recovery: exactReplay }),
    ],
  }),
  profile({
    id: "admin.memory.v1", audience: "admin", pagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "admin.memory.status", method: "GET", path: "/api/v1/admin/profiles/memory/status", requiredScopes: ["admin:memory:read"], resourceScope: "principal" }),
      endpoint({ id: "admin.memory.recall", method: "POST", path: "/api/v1/admin/profiles/memory/recall", requiredScopes: ["admin:memory:read"], resourceScope: "principal" }),
      endpoint({ id: "admin.memory.records.list", method: "GET", path: "/api/v1/admin/profiles/memory/records", requiredScopes: ["admin:memory:read"], resourceScope: "memory" }),
      endpoint({ id: "admin.memory.capture", method: "POST", path: "/api/v1/admin/profiles/memory/captures", requiredScopes: ["admin:memory:write"], resourceScope: "memory", recovery: receipt("/api/v1/admin/operations/:requestId") }),
      endpoint({ id: "admin.memory.govern", method: "POST", path: "/api/v1/admin/profiles/memory/records/:memoryId/govern", requiredScopes: ["admin:memory:write"], resourceScope: "memory", recovery: receipt("/api/v1/admin/operations/:requestId") }),
      endpoint({ id: "admin.memory.forget", method: "DELETE", path: "/api/v1/admin/profiles/memory/records/:memoryId", requiredScopes: ["admin:memory:write"], resourceScope: "memory", recovery: receipt("/api/v1/admin/operations/:requestId") }),
      endpoint({ id: "admin.operations.get", method: "GET", path: "/api/v1/admin/operations/:requestId", requiredScopes: ["admin:operations:read"], resourceScope: "principal" }),
    ],
  }),
];

export function capabilityProfileDescriptor(profileId: string): CapabilityProfileDescriptor | undefined {
  return CAPABILITY_PROFILE_DESCRIPTORS.find((profile) => profile.id === profileId);
}
