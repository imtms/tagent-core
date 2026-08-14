import type { OperatorContextManifestListResponse } from "./schemas.js";

export const operatorContextManifestListFixture = {
  data: {
    items: [{
      id: "manifest-fixture-1",
      taskRunId: "task-run-fixture-1",
      attempt: 1,
      source: "session",
      manifestHash: "a".repeat(64),
      items: [{ kind: "skill", sourceRef: "b".repeat(32), selected: true, estimatedTokens: 120 }],
      stats: { itemCount: 1, selectedItemCount: 1, estimatedTokens: 120 },
      createdAt: "2026-08-14T12:00:00.000Z",
    }],
    pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-context-snapshot" },
  },
  requestId: "request-context-manifests-001",
} as const satisfies OperatorContextManifestListResponse;
