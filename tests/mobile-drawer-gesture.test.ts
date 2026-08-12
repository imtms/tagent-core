import { describe, expect, it } from "vitest";
import { drawerGestureDecision, shouldSettleDrawerOpen } from "../apps/web-console/src/useMobileDrawerSwipe";
import { formatShortcut, shortcutKeyTokens, shortcutModifierForPlatform } from "../apps/web-console/src/shortcut-platform";

describe("mobile drawer gesture", () => {
  it("waits through touch slop and rejects vertical scrolling or the wrong direction", () => {
    expect(drawerGestureDecision("open", 6, 2)).toBe("pending");
    expect(drawerGestureDecision("open", 14, 20)).toBe("reject");
    expect(drawerGestureDecision("open", -14, 1)).toBe("reject");
    expect(drawerGestureDecision("close", 14, 1)).toBe("reject");
  });

  it("engages only a decisive horizontal gesture in the expected direction", () => {
    expect(drawerGestureDecision("open", 24, 4)).toBe("engage");
    expect(drawerGestureDecision("close", -24, 4)).toBe("engage");
  });

  it("uses a flick first and otherwise settles at the halfway point", () => {
    expect(shouldSettleDrawerOpen(0.2, 0.5)).toBe(true);
    expect(shouldSettleDrawerOpen(0.8, -0.5)).toBe(false);
    expect(shouldSettleDrawerOpen(0.51, 0.1)).toBe(true);
    expect(shouldSettleDrawerOpen(0.49, -0.1)).toBe(false);
  });
});

describe("shortcut platform labels", () => {
  it("formats Apple and non-Apple modifiers without relying on a render-time UA branch", () => {
    expect(shortcutModifierForPlatform("MacIntel")).toBe("⌘");
    expect(shortcutModifierForPlatform("iPad")).toBe("⌘");
    expect(shortcutModifierForPlatform("Win32")).toBe("Ctrl");
    expect(formatShortcut("⌘", "K")).toBe("⌘K");
    expect(formatShortcut("Ctrl", "K")).toBe("Ctrl K");
    expect(shortcutKeyTokens("Ctrl", "K")).toEqual(["Ctrl", "K"]);
  });
});
