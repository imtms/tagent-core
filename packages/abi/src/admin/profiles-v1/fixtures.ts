import type { AdminMemoryStatusResponse } from "./schemas.js";

export const adminMemoryStatusFixture = {
  data: { status: { available: true, ready: true, degraded: false, reasons: [] } },
  requestId: "request-admin-memory-status-001",
} as const satisfies AdminMemoryStatusResponse;
