import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GateProfile } from "./api";
import { storedGateProfiles, storedStringLists, storedStringRecord } from "./workspace-preferences";

const COMPOSER_HISTORY_LIMIT = 50;

export interface ComposerHistoryView {
  cursor: number | null;
  draft: string;
  seed: string;
}

export function nextComposerHistoryView(
  history: readonly string[],
  direction: -1 | 1,
  current: ComposerHistoryView,
): ComposerHistoryView {
  if (!history.length) return current;
  const seed = current.cursor === null ? current.draft : current.seed;
  const nextCursor = current.cursor === null
    ? direction === -1 ? history.length - 1 : null
    : current.cursor + direction;
  if (nextCursor === null || nextCursor >= history.length) return { cursor: null, draft: seed, seed };
  const cursor = Math.max(0, nextCursor);
  return { cursor, draft: history[cursor] ?? "", seed };
}

export function clampComposerHeight(scrollHeight: number, minHeight: number, maxHeight: number): number {
  return Math.min(Math.max(scrollHeight, minHeight), maxHeight);
}

function persist(key: string, value: unknown): void {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* Browser storage is optional. */ }
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  const style = getComputedStyle(textarea);
  const minHeight = Number.parseFloat(style.minHeight);
  const parsedMaxHeight = Number.parseFloat(style.maxHeight);
  const maxHeight = Number.isFinite(parsedMaxHeight) ? parsedMaxHeight : textarea.scrollHeight;
  textarea.style.height = style.minHeight;
  const height = clampComposerHeight(textarea.scrollHeight, minHeight, maxHeight);
  textarea.style.height = `${height}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function useWorkspaceComposer(workspaceId: string) {
  const [draft, setDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>(() => storedStringRecord("tagent.composer-drafts"));
  const [gateProfiles, setGateProfiles] = useState<Record<string, GateProfile>>(storedGateProfiles);
  const [histories, setHistories] = useState<Record<string, string[]>>(() => storedStringLists("tagent.composer-history"));
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const historySeedRef = useRef("");

  useEffect(() => {
    setDraft(drafts[workspaceId] ?? "");
    setHistoryCursor(null);
    historySeedRef.current = "";
  }, [workspaceId]);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => persist("tagent.composer-drafts", drafts), [drafts]);
  useEffect(() => persist("tagent.gate-profiles", gateProfiles), [gateProfiles]);
  useEffect(() => persist("tagent.composer-history", histories), [histories]);

  const updateDraft = useCallback((value: string, resetHistory = true) => {
    setDraft(value);
    if (workspaceId) setDrafts((current) => ({ ...current, [workspaceId]: value }));
    if (resetHistory) {
      setHistoryCursor(null);
      historySeedRef.current = value;
    }
  }, [workspaceId]);

  const navigateHistory = useCallback((direction: -1 | 1) => {
    const next = nextComposerHistoryView(histories[workspaceId] ?? [], direction, {
      cursor: historyCursor,
      draft,
      seed: historySeedRef.current,
    });
    if (next.cursor === historyCursor && next.draft === draft && next.seed === historySeedRef.current) return;
    historySeedRef.current = next.seed;
    setHistoryCursor(next.cursor);
    updateDraft(next.draft, false);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.draft.length, next.draft.length));
  }, [draft, histories, historyCursor, updateDraft, workspaceId]);

  const recordSubmission = useCallback((content: string) => {
    updateDraft("");
    if (!workspaceId) return;
    setHistories((current) => {
      const history = current[workspaceId] ?? [];
      return {
        ...current,
        [workspaceId]: [...history.filter((item) => item !== content), content].slice(-COMPOSER_HISTORY_LIMIT),
      };
    });
  }, [updateDraft, workspaceId]);

  const selectGateProfile = useCallback((profile: GateProfile) => {
    if (workspaceId) setGateProfiles((current) => ({ ...current, [workspaceId]: profile }));
  }, [workspaceId]);

  const selectedGateProfile = gateProfiles[workspaceId] ?? "relaxed";
  return {
    draft,
    hasSavedDraft: Boolean(drafts[workspaceId]?.trim()),
    historyCursor,
    isComposingRef,
    textareaRef,
    selectedGateProfile,
    updateDraft,
    navigateHistory,
    recordSubmission,
    selectGateProfile,
  };
}
