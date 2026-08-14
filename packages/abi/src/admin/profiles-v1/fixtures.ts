import type {
  AdminAutonomyApprovalsResponse,
  AdminLearningCenterResponse,
  AdminMemoryStatusResponse,
  AdminWorkflowsResponse,
} from "./schemas.js";

export const adminMemoryStatusFixture = {
  data: { status: { available: true, ready: true, degraded: false, reasons: [] } },
  requestId: "request-admin-memory-status-001",
} as const satisfies AdminMemoryStatusResponse;

export const adminLearningCenterFixture = {
  data: { center: {
    sessionId: "session-learning-fixture",
    counts: { workflows: 1, bindings: 2, feedback: 3, proposals: 0, policies: 1, evaluations: 1, approvals: 0 },
    memoryEnabled: true, learningEnabled: true, autoExecutionEnabled: false,
  } },
  requestId: "request-admin-learning-center-001",
} as const satisfies AdminLearningCenterResponse;

export const adminWorkflowsFixture = {
  data: { items: [], pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-workflow-snapshot" } },
  requestId: "request-admin-workflows-001",
} as const satisfies AdminWorkflowsResponse;

export const adminAutonomyApprovalsFixture = {
  data: { items: [], pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-autonomy-snapshot" } },
  requestId: "request-admin-autonomy-001",
} as const satisfies AdminAutonomyApprovalsResponse;
