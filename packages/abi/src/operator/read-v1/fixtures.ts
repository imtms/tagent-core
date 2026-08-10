import type {
  OperatorLatestSessionTaskRunResponse,
  OperatorReadCapabilitiesResponse,
  OperatorSessionListResponse,
  OperatorSessionTaskRunListResponse,
} from "./schemas.js";
import { OPERATOR_READ_ENDPOINT_IDS } from "./schemas.js";

const fixtureTime = "2026-08-10T12:00:00.000Z";

export const operatorReadCapabilitiesFixture = {
  data: {
    profileVersion: "1.0",
    endpointIds: [...OPERATOR_READ_ENDPOINT_IDS],
    pagination: {
      cursorVersion: "1", cursorOpaque: true, cursorExpiry: false, cursorSurvivesRestart: true,
      membershipConsistency: "snapshot", valueConsistency: "read_committed",
      sessionOrder: "created_at_desc_id_desc", taskRunOrder: "created_at_desc_id_desc",
      cursorBindings: ["endpoint", "resource", "filter", "snapshot"],
    },
    retention: { automaticDeletion: false, tombstones: false, missingResourceStatus: 404 },
    limits: {
      sessionListDefault: 50, sessionListMax: 200, taskRunListDefault: 50, taskRunListMax: 200,
      goalSummaryCharacters: 500, blockedReasonCharacters: 500,
    },
  },
  requestId: "request-operator-capabilities-001",
} as const satisfies OperatorReadCapabilitiesResponse;

export const operatorSessionListFixture = {
  data: {
    items: [{
      id: "session-operator-001", title: "Operator fixture", modelId: "gpt-5.6-sol", reasoningEffort: "high",
      createdAt: fixtureTime, updatedAt: fixtureTime, latestTaskRunId: "task-run-operator-001",
      latestTaskRunStatus: "running", latestTaskRunPhase: "implement", latestActivityAt: fixtureTime,
    }],
    pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-session-snapshot" },
  },
  requestId: "request-operator-sessions-001",
} as const satisfies OperatorSessionListResponse;

export const operatorTaskRunListFixture = {
  data: {
    items: [{
      id: "task-run-operator-001", sessionId: "session-operator-001", status: "running", phase: "implement",
      attempt: 1, currentAttemptId: "attempt:task-run-operator-001:1", goalSummary: "Implement Operator Read API",
      blockedReason: null, pendingInteractionKinds: [], lastEventSequence: 3,
      createdAt: fixtureTime, updatedAt: fixtureTime, completedAt: null, resumable: false,
    }],
    pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-task-run-snapshot" },
  },
  requestId: "request-operator-task-runs-001",
} as const satisfies OperatorSessionTaskRunListResponse;

export const operatorLatestTaskRunFixture = {
  data: operatorTaskRunListFixture.data.items[0],
  requestId: "request-operator-latest-task-run-001",
} as const satisfies OperatorLatestSessionTaskRunResponse;
