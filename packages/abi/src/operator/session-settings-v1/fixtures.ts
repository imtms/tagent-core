import type { OperatorSessionSettingsResponse } from "./schemas.js";

export const operatorSessionSettingsFixture = {
  data: {
    settings: {
      sessionId: "session-settings-fixture",
      title: "Gateway workspace",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      revision: 3,
      updatedAt: "2026-08-14T12:00:00.000Z",
    },
  },
  requestId: "request-session-settings-001",
} as const satisfies OperatorSessionSettingsResponse;
