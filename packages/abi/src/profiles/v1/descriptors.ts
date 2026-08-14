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
  resourceScope: "none" | "principal" | "workspace" | "session" | "task_run" | "memory" | "workflow" | "autonomy";
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
  profile({
    id: "admin.learning.v1", audience: "admin", pagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "admin.learning.settings.get", method: "GET", path: "/api/v1/admin/profiles/learning/settings", requiredScopes: ["admin:learning:read"], resourceScope: "principal" }),
      endpoint({ id: "admin.learning.settings.update", method: "PATCH", path: "/api/v1/admin/profiles/learning/settings", requiredScopes: ["admin:learning:write"], resourceScope: "principal", recovery: receipt("/api/v1/admin/operations/:requestId") }),
      endpoint({ id: "admin.learning.center.get", method: "GET", path: "/api/v1/admin/profiles/learning/sessions/:sessionId", requiredScopes: ["admin:learning:read"], resourceScope: "session" }),
      endpoint({ id: "admin.learning.policy.update", method: "PUT", path: "/api/v1/admin/profiles/learning/task-runs/:taskRunId/policy", requiredScopes: ["admin:learning:write"], resourceScope: "task_run", recovery: exactReplay }),
      endpoint({ id: "admin.operations.get", method: "GET", path: "/api/v1/admin/operations/:requestId", requiredScopes: ["admin:operations:read"], resourceScope: "principal" }),
    ],
  }),
  profile({
    id: "admin.workflow.v1", audience: "admin", pagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "admin.workflows.list", method: "GET", path: "/api/v1/admin/profiles/workflows", requiredScopes: ["admin:workflow:read"], resourceScope: "workflow" }),
      endpoint({ id: "admin.workflows.activation_request", method: "POST", path: "/api/v1/admin/profiles/workflows/:workflowId/activation-requests", requiredScopes: ["admin:workflow:write"], resourceScope: "workflow", recovery: receipt("/api/v1/admin/operations/:requestId") }),
      endpoint({ id: "admin.workflows.activate", method: "POST", path: "/api/v1/admin/profiles/workflows/:workflowId/activate", requiredScopes: ["admin:workflow:write"], resourceScope: "workflow", recovery: exactReplay }),
      endpoint({ id: "admin.workflows.suspend", method: "POST", path: "/api/v1/admin/profiles/workflows/:workflowId/suspend", requiredScopes: ["admin:workflow:write"], resourceScope: "workflow", recovery: exactReplay }),
      endpoint({ id: "admin.workflows.delete", method: "DELETE", path: "/api/v1/admin/profiles/workflows/:workflowId", requiredScopes: ["admin:workflow:write"], resourceScope: "workflow", recovery: exactReplay }),
      endpoint({ id: "admin.workflows.restore", method: "POST", path: "/api/v1/admin/profiles/workflows/:workflowId/restore", requiredScopes: ["admin:workflow:write"], resourceScope: "workflow", recovery: exactReplay }),
      endpoint({ id: "admin.operations.get", method: "GET", path: "/api/v1/admin/operations/:requestId", requiredScopes: ["admin:operations:read"], resourceScope: "principal" }),
    ],
  }),
  profile({
    id: "admin.autonomy.v1", audience: "admin", pagination, retention: durableRetention,
    endpoints: [
      endpoint({ id: "admin.autonomy.approvals.list", method: "GET", path: "/api/v1/admin/profiles/autonomy/approvals", requiredScopes: ["admin:autonomy:read"], resourceScope: "autonomy" }),
      endpoint({ id: "admin.autonomy.approvals.decide", method: "POST", path: "/api/v1/admin/profiles/autonomy/approvals/:approvalId/decision", requiredScopes: ["admin:autonomy:decide"], resourceScope: "autonomy", recovery: exactReplay }),
      endpoint({ id: "admin.autonomy.approvals.revoke", method: "POST", path: "/api/v1/admin/profiles/autonomy/approvals/:approvalId/revoke", requiredScopes: ["admin:autonomy:decide"], resourceScope: "autonomy", recovery: exactReplay }),
      endpoint({ id: "admin.autonomy.approvals.execute", method: "POST", path: "/api/v1/admin/profiles/autonomy/approvals/:approvalId/execute", requiredScopes: ["admin:autonomy:execute"], resourceScope: "autonomy", recovery: receipt("/api/v1/admin/operations/:requestId") }),
      endpoint({ id: "admin.operations.get", method: "GET", path: "/api/v1/admin/operations/:requestId", requiredScopes: ["admin:operations:read"], resourceScope: "principal" }),
    ],
  }),
];

export function capabilityProfileDescriptor(profileId: string): CapabilityProfileDescriptor | undefined {
  return CAPABILITY_PROFILE_DESCRIPTORS.find((profile) => profile.id === profileId);
}
