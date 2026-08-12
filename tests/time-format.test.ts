import { describe, expect, it } from "vitest";
import { formatConversationDay, formatRelativeTime, localDayKey } from "../apps/web-console/src/time-format";

describe("Web time formatting", () => {
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();

  it("keeps relative recency compact and stable", () => {
    expect(formatRelativeTime(now - 25_000, now)).toBe("now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
    expect(formatRelativeTime(now + 60_000, now)).toBe("now");
  });

  it("labels nearby conversation days without UTC boundary drift", () => {
    const yesterday = new Date(2026, 7, 11, 23, 30, 0).getTime();
    expect(formatConversationDay(now, now)).toBe("Today");
    expect(formatConversationDay(yesterday, now)).toBe("Yesterday");
    expect(localDayKey(yesterday)).toBe("2026-08-11");
  });
});
