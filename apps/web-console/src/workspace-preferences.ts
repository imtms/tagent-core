import type { GateProfile } from "./api";

export type Theme = "light" | "dark";

function storedJson(key: string, fallback: unknown): unknown {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch { return fallback; }
}

function storedRecord<Value>(key: string, valid: (value: unknown) => value is Value): Record<string, Value> {
  const parsed = storedJson(key, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Value] => valid(entry[1])));
}

export function storedStringRecord(key: string): Record<string, string> {
  return storedRecord(key, (value): value is string => typeof value === "string");
}

export function storeStringRecord(key: string, value: Record<string, string>): void {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* Browser storage is optional. */ }
}

export function storedGateProfiles(): Record<string, GateProfile> {
  const stored = storedStringRecord("tagent.gate-profiles");
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, GateProfile] => ["off", "relaxed", "strict"].includes(entry[1])));
}

export function storedNumberRecord(key: string): Record<string, number> {
  return storedRecord(key, (value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function storedStringLists(key: string): Record<string, string[]> {
  return storedRecord(key, (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"));
}

export function storedStringArray(key: string): string[] {
  const parsed = storedJson(key, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

export function storedTheme(): Theme {
  try {
    const saved = globalThis.localStorage?.getItem("tagent.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Browser storage is optional. */ }
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
