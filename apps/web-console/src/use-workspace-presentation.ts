import { useEffect, useState } from "react";
import type { Session } from "./api";
import {
  storedNumberRecord,
  storedStringArray,
  storedStringRecord,
  storedTheme,
  type Theme,
} from "./workspace-preferences";

function persist(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch { /* Browser storage is optional. */ }
}

function applyThemeColor(theme: Theme): void {
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const nextThemeColor = theme === "dark" ? themeColor?.dataset.dark : themeColor?.dataset.light;
  if (nextThemeColor) themeColor?.setAttribute("content", nextThemeColor);
}

export function mergeWorkspaceActivityBaseline(
  current: Record<string, number>,
  workspaces: readonly Session[],
): Record<string, number> {
  let changed = false;
  const next = { ...current };
  for (const workspace of workspaces) {
    if (next[workspace.id] !== undefined) continue;
    next[workspace.id] = workspace.updatedAt;
    changed = true;
  }
  return changed ? next : current;
}

export function useWorkspacePresentation(workspaces: readonly Session[]) {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [pinnedWorkspaceIds, setPinnedWorkspaceIds] = useState<string[]>(() => storedStringArray("tagent.pinned-workspaces"));
  const [lastSeenByWorkspace, setLastSeenByWorkspace] = useState<Record<string, number>>(() => storedNumberRecord("tagent.workspace-last-seen"));
  const [workspaceActivityBaseline, setWorkspaceActivityBaseline] = useState<Record<string, number>>({});
  const [viewingEarlierHistory, setViewingEarlierHistory] = useState(false);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [workspaceEmojiById, setWorkspaceEmojiById] = useState<Record<string, string>>(() => storedStringRecord("tagent.workspace-emojis"));
  const [workspaceContextMenuId, setWorkspaceContextMenuId] = useState("");
  const [workspaceContextMenuPosition, setWorkspaceContextMenuPosition] = useState({ top: 0, left: 0 });

  useEffect(() => persist("tagent.workspace-emojis", workspaceEmojiById), [workspaceEmojiById]);
  useEffect(() => persist("tagent.pinned-workspaces", pinnedWorkspaceIds), [pinnedWorkspaceIds]);
  useEffect(() => persist("tagent.workspace-last-seen", lastSeenByWorkspace), [lastSeenByWorkspace]);
  useEffect(() => setWorkspaceActivityBaseline((current) => mergeWorkspaceActivityBaseline(current, workspaces)), [workspaces]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    applyThemeColor(theme);
    persist("tagent.theme", theme);
  }, [theme]);

  return {
    leftOpen, setLeftOpen,
    rightOpen, setRightOpen,
    workspaceMenuOpen, setWorkspaceMenuOpen,
    workspaceSwitcherOpen, setWorkspaceSwitcherOpen,
    shortcutHelpOpen, setShortcutHelpOpen,
    pinnedWorkspaceIds, setPinnedWorkspaceIds,
    lastSeenByWorkspace, setLastSeenByWorkspace,
    workspaceActivityBaseline,
    viewingEarlierHistory, setViewingEarlierHistory,
    theme, setTheme,
    workspaceEmojiById, setWorkspaceEmojiById,
    workspaceContextMenuId, setWorkspaceContextMenuId,
    workspaceContextMenuPosition, setWorkspaceContextMenuPosition,
  };
}
