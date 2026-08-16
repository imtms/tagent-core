import type { GateProfile } from "./api";

export type Theme = "light" | "dark";

export function storedBoolean(key: string, fallback = false): boolean {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value === null || value === undefined ? fallback : value === "true";
  } catch { return fallback; }
}

export function storedStringRecord(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

export function storedGateProfiles(): Record<string, GateProfile> {
  const stored = storedStringRecord("tagent.gate-profiles");
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, GateProfile] => ["off", "relaxed", "strict"].includes(entry[1])));
}

export function storedNumberRecord(key: string): Record<string, number> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  } catch { return {}; }
}

export function storedStringLists(key: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string")));
  } catch { return {}; }
}

export function storedStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export function storedWorkspaceEmojis(): Record<string, string> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem("tagent.workspace-emojis") ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export function storedTheme(): Theme {
  try {
    const saved = globalThis.localStorage?.getItem("tagent.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Browser storage is optional. */ }
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
