import type { OperatorInboxListResponse } from "./schemas.js";

export const operatorInboxListFixture = {
  data: {
    items: [{
      id: "inbox-fixture-1",
      sessionId: "session-fixture-1",
      content: "Implement the Gateway contract",
      status: "queued",
      decision: "pending",
      runId: null,
      position: 1,
      summary: "Implement Gateway contract",
      intent: "new_task",
      targetRunId: null,
      priority: 500,
      urgency: "normal",
      relation: "independent",
      acceptanceCriteria: ["Gateway contract is implemented"],
      confidence: 1,
      reason: "Explicit task request",
      gateProfile: "strict",
      revision: 1,
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
    }],
    pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-inbox-snapshot" },
    collectionRevision: 1,
  },
  requestId: "request-inbox-list-001",
} as const satisfies OperatorInboxListResponse;
