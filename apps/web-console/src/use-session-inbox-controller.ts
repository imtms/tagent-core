import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, type Message, type SessionInboxItem, type TaskRun } from "./api";

interface SessionInboxControllerOptions {
  sessionId: string;
  activeRun: TaskRun | null;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
  onRunStarted: (run: TaskRun, history: Message[]) => void;
}

interface SessionInboxAuthority {
  sessionId: string;
  generation: number;
}

export function useSessionInboxController({
  sessionId,
  activeRun,
  setError,
  setNotice,
  onRunStarted,
}: SessionInboxControllerOptions) {
  const [items, setItems] = useState<SessionInboxItem[]>([]);
  const [startingId, setStartingId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState("");
  const [draggingId, setDraggingId] = useState("");
  const [reordering, setReordering] = useState(false);
  const [mutatingId, setMutatingId] = useState("");
  const authorityRef = useRef<SessionInboxAuthority>({ sessionId, generation: 0 });
  const onRunStartedRef = useRef(onRunStarted);

  onRunStartedRef.current = onRunStarted;

  useLayoutEffect(() => {
    authorityRef.current = {
      sessionId,
      generation: authorityRef.current.generation + 1,
    };
    setStartingId("");
    setEditingId("");
    setDraft("");
    setSavingId("");
    setDraggingId("");
    setReordering(false);
    setMutatingId("");
  }, [sessionId]);

  const isCurrent = useCallback((authority: SessionInboxAuthority) => {
    const current = authorityRef.current;
    return current.sessionId === authority.sessionId && current.generation === authority.generation;
  }, []);

  const refresh = useCallback(async (authority: SessionInboxAuthority = authorityRef.current) => {
    const next = await api.inbox(authority.sessionId);
    if (isCurrent(authority)) setItems(next);
    return next;
  }, [isCurrent]);

  const startEditing = useCallback((item: SessionInboxItem) => {
    setEditingId(item.id);
    setDraft(item.content);
    setError("");
    setNotice("");
  }, [setError, setNotice]);

  const cancelEditing = useCallback(() => {
    setEditingId("");
    setDraft("");
  }, []);

  const save = useCallback(async (item: SessionInboxItem) => {
    const content = draft.trim();
    const authority = { ...authorityRef.current };
    if (!content || !authority.sessionId || savingId) return;
    setSavingId(item.id);
    setError("");
    setNotice("");
    try {
      await api.updateInbox(authority.sessionId, item.id, content);
      await refresh(authority);
      if (!isCurrent(authority)) return;
      cancelEditing();
      setNotice("Queued prompt updated.");
    } catch (cause) {
      if (isCurrent(authority)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent(authority)) setSavingId("");
    }
  }, [cancelEditing, draft, isCurrent, refresh, savingId, setError, setNotice]);

  const applyOrder = useCallback(async (next: SessionInboxItem[]) => {
    const authority = { ...authorityRef.current };
    if (!authority.sessionId) return;
    setReordering(true);
    setError("");
    setNotice("");
    try {
      const reordered = await api.reorderInbox(authority.sessionId, next.map((item) => item.id));
      if (!isCurrent(authority)) return;
      setItems(reordered);
      setNotice("Queued prompts reordered.");
    } catch (cause) {
      if (!isCurrent(authority)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(authority).catch(() => undefined);
    } finally {
      if (isCurrent(authority)) {
        setReordering(false);
        setDraggingId("");
      }
    }
  }, [isCurrent, refresh, setError, setNotice]);

  const dropOn = useCallback(async (targetId: string) => {
    if (!draggingId || draggingId === targetId || reordering || mutatingId) return;
    const from = items.findIndex((item) => item.id === draggingId);
    const to = items.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await applyOrder(next);
  }, [applyOrder, draggingId, items, mutatingId, reordering]);

  const move = useCallback(async (itemId: string, offset: -1 | 1) => {
    if (reordering || mutatingId) return;
    const from = items.findIndex((item) => item.id === itemId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await applyOrder(next);
  }, [applyOrder, items, mutatingId, reordering]);

  const mutate = useCallback(async (
    itemId: string,
    operation: (targetSessionId: string) => Promise<unknown>,
    noticeText?: string,
  ) => {
    const authority = { ...authorityRef.current };
    if (!authority.sessionId || mutatingId || reordering || startingId || savingId) return;
    setMutatingId(itemId);
    setError("");
    setNotice("");
    try {
      await operation(authority.sessionId);
      await refresh(authority);
      if (noticeText && isCurrent(authority)) setNotice(noticeText);
    } catch (cause) {
      if (isCurrent(authority)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent(authority)) setMutatingId("");
    }
  }, [isCurrent, mutatingId, refresh, reordering, savingId, setError, setNotice, startingId]);

  const toggleDeferred = useCallback((item: SessionInboxItem) => mutate(
    item.id,
    (targetSessionId) => api.decideInbox(targetSessionId, item.id, item.decision === "defer" ? "pending" : "defer"),
  ), [mutate]);

  const mergeIntoFirst = useCallback((item: SessionInboxItem) => {
    const target = items[0];
    if (!target || target.id === item.id) return Promise.resolve();
    return mutate(item.id, (targetSessionId) => api.mergeInbox(targetSessionId, item.id, target.id));
  }, [items, mutate]);

  const remove = useCallback((item: SessionInboxItem) => mutate(
    item.id,
    (targetSessionId) => api.deleteInbox(targetSessionId, item.id),
  ), [mutate]);

  const runNow = useCallback(async (item: SessionInboxItem) => {
    const authority = { ...authorityRef.current };
    if (!authority.sessionId || startingId) return;
    setStartingId(item.id);
    setError("");
    setNotice("");
    try {
      if (activeRun?.status === "running" && item.analysis.relation === "parallel" && item.analysis.targetRunId === activeRun.id) {
        await api.requestParallelStart(authority.sessionId, item.id);
        if (isCurrent(authority)) setNotice("Parallel start sent to the human approval queue. The task remains queued until approval and explicit execution.");
        return;
      }
      const result = await api.startInbox(authority.sessionId, item.id);
      const [nextItems, history] = await Promise.all([api.inbox(authority.sessionId), api.messages(authority.sessionId)]);
      if (!isCurrent(authority)) return;
      setItems(nextItems);
      onRunStartedRef.current(result.run, history);
      setNotice("Queued prompt started.");
    } catch (cause) {
      if (isCurrent(authority)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent(authority)) setStartingId("");
    }
  }, [activeRun, isCurrent, setError, setNotice, startingId]);

  return {
    items,
    setItems,
    startingId,
    editingId,
    draft,
    setDraft,
    savingId,
    draggingId,
    setDraggingId,
    reordering,
    mutatingId,
    startEditing,
    cancelEditing,
    save,
    dropOn,
    move,
    toggleDeferred,
    mergeIntoFirst,
    remove,
    runNow,
  };
}
