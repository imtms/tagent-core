import { useState } from "react";

export type ShortcutModifier = "⌘" | "Ctrl";

export function shortcutModifierForPlatform(platform: string, maxTouchPoints = 0): ShortcutModifier {
  const normalized = platform.toLocaleLowerCase();
  const isApplePlatform = /mac|iphone|ipad|ipod/.test(normalized) || (normalized === "macintel" && maxTouchPoints > 1);
  return isApplePlatform ? "⌘" : "Ctrl";
}

function detectShortcutModifier(): ShortcutModifier {
  const navigatorValue = globalThis.navigator;
  if (!navigatorValue) return "Ctrl";
  const userAgentData = navigatorValue as Navigator & { userAgentData?: { platform?: string } };
  return shortcutModifierForPlatform(userAgentData.userAgentData?.platform || navigatorValue.platform || navigatorValue.userAgent, navigatorValue.maxTouchPoints);
}

export function useShortcutModifier(): ShortcutModifier {
  const [modifier] = useState(detectShortcutModifier);
  return modifier;
}

export function formatShortcut(modifier: ShortcutModifier, key: string): string {
  return modifier === "⌘" ? `${modifier}${key}` : `${modifier} ${key}`;
}

export function shortcutKeyTokens(modifier: ShortcutModifier, key: string): string[] {
  return [modifier, key];
}
