import { describe, expect, it } from "vitest";
import { goalStartBlockedReason, shortRunId } from "../apps/web-console/src/goal-start-feedback";

describe("Goal Start feedback", () => {
  it("explains that another TaskRun owns the Goal execution slot", () => {
    expect(goalStartBlockedReason("2ffe03a8-d9ff-4444-86d0-6c1c8017b0dd", false)).toBe(
      "This Goal already has an active TaskRun. Open or finish it before starting another Roadmap item.",
    );
  });

  it("distinguishes transient Goal operations and an available Start action", () => {
    expect(goalStartBlockedReason(null, true)).toBe("Another Goal operation is still being processed.");
    expect(goalStartBlockedReason(null, false)).toBeNull();
    expect(shortRunId("2ffe03a8-d9ff-4444-86d0-6c1c8017b0dd")).toBe("2ffe03a8-d9f");
  });
});
