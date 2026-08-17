import { useEffect, useState } from "react";
import type { Session } from "./api";
import {
  storedBoolean,
  storedNumberRecord,
  storedStringArray,
  storedTheme,
  storedWorkspaceEmojis,
  type Theme,
} from "./workspace-preferences";

function persist(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch { /* Browser storage is optional. */ }
}

export function mergeSessionActivityBaseline(
  current: Record<string, number>,
  sessions: readonly Session[],
): Record<string, number> {
  let changed = false;
  const next = { ...current };
  for (const session of sessions) {
    if (next[session.id] !== undefined) continue;
    next[session.id] = session.updatedAt;
    changed = true;
  }
  return changed ? next : current;
}

export function useWorkspacePresentation(sessions: readonly Session[]) {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => storedStringArray("tagent.pinned-workspaces"));
  const [lastSeenBySession, setLastSeenBySession] = useState<Record<string, number>>(() => storedNumberRecord("tagent.workspace-last-seen"));
  const [sessionActivityBaseline, setSessionActivityBaseline] = useState<Record<string, number>>({});
  const [viewingEarlierHistory, setViewingEarlierHistory] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(() => storedBoolean("tagent.left-rail-collapsed"));
  const [rightCollapsed, setRightCollapsed] = useState(() => storedBoolean("tagent.right-panel-collapsed", true));
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [workspaceEmojiById, setWorkspaceEmojiById] = useState<Record<string, string>>(storedWorkspaceEmojis);
  const [sessionMenuId, setSessionMenuId] = useState("");
  const [sessionMenuPosition, setSessionMenuPosition] = useState({ top: 0, left: 0 });

  useEffect(() => persist("tagent.left-rail-collapsed", String(leftCollapsed)), [leftCollapsed]);
  useEffect(() => persist("tagent.right-panel-collapsed", String(rightCollapsed)), [rightCollapsed]);
  useEffect(() => persist("tagent.workspace-emojis", workspaceEmojiById), [workspaceEmojiById]);
  useEffect(() => persist("tagent.pinned-workspaces", pinnedSessionIds), [pinnedSessionIds]);
  useEffect(() => persist("tagent.workspace-last-seen", lastSeenBySession), [lastSeenBySession]);
  useEffect(() => setSessionActivityBaseline((current) => mergeSessionActivityBaseline(current, sessions)), [sessions]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171715" : "#f5f4f2");
    persist("tagent.theme", theme);
  }, [theme]);

  return {
    leftOpen, setLeftOpen,
    rightOpen, setRightOpen,
    workspaceMenuOpen, setWorkspaceMenuOpen,
    workspaceSwitcherOpen, setWorkspaceSwitcherOpen,
    shortcutHelpOpen, setShortcutHelpOpen,
    sessionSearch, setSessionSearch,
    pinnedSessionIds, setPinnedSessionIds,
    lastSeenBySession, setLastSeenBySession,
    sessionActivityBaseline,
    viewingEarlierHistory, setViewingEarlierHistory,
    leftCollapsed, setLeftCollapsed,
    rightCollapsed, setRightCollapsed,
    theme, setTheme,
    workspaceEmojiById, setWorkspaceEmojiById,
    sessionMenuId, setSessionMenuId,
    sessionMenuPosition, setSessionMenuPosition,
  };
}
