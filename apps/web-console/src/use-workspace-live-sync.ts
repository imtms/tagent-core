import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  api,
  drainTranscriptView,
  subscribe,
  type Message,
  type Session,
  type SessionInboxItem,
  type TaskRun,
  type TranscriptItem,
} from "./api";
import { createEventAcknowledger, type EventAcknowledger } from "./event-acknowledger";
import { getOrCreateEventConsumerId } from "./id";
import { IntentPrefetchCache } from "./intent-prefetch-cache";
import { findActiveRun, isActiveRunStatus } from "./run-state";
import { mergeTranscriptItems } from "./transcript-projection";
import type { useRunViewState } from "./use-run-view-state";
import { loadWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-controller";
import { WorkspaceLiveSyncCoordinator, WorkspaceReconnectBackoff } from "./workspace-live-sync";

export interface PendingUserMessage {
  workspaceId: string;
  content: string;
  createdAt: number;
}

interface WorkspaceLiveSyncOptions {
  workspaceId: string;
  runView: ReturnType<typeof useRunViewState>;
  setWorkspaces: Dispatch<SetStateAction<Session[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>;
  setConversationLoading: Dispatch<SetStateAction<boolean>>;
  setPendingUserMessage: Dispatch<SetStateAction<PendingUserMessage | null>>;
  setInbox: Dispatch<SetStateAction<SessionInboxItem[]>>;
  setError: Dispatch<SetStateAction<string>>;
}

const terminalRunEvents = new Set([
  "run.completed",
  "run.blocked",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "run.waiting_for_input",
]);

export function mergeRefreshedMessages(current: Message[], latest: Message[]): Message[] {
  const latestIds = new Set(latest.map((message) => message.id));
  const firstLatestId = latest[0]?.id ?? Number.MAX_SAFE_INTEGER;
  const older = current.filter((message) => !latestIds.has(message.id) && message.id < firstLatestId);
  return [...older, ...latest];
}

export function shouldStreamWorkspaceRun(run: TaskRun | null, workspaceId: string): run is TaskRun {
  return Boolean(run?.id && run.sessionId === workspaceId && isActiveRunStatus(run.status));
}

export function terminalStreamingAfterRefresh(
  current: string,
  transcript: TranscriptItem[],
  terminalResponse: unknown,
): string {
  if (!current) return "";
  const hasAuthoritativeOutput = String(terminalResponse ?? "").trim().length > 0
    || transcript.some((item) => item.kind === "assistant" && item.text.trim().length > 0);
  return hasAuthoritativeOutput ? "" : current;
}

export function useWorkspaceLiveSync({
  workspaceId,
  runView,
  setWorkspaces,
  setMessages,
  setHasOlderMessages,
  setConversationLoading,
  setPendingUserMessage,
  setInbox,
  setError,
}: WorkspaceLiveSyncOptions) {
  const {
    activeRun,
    setActiveRun,
    setSelectedRun,
    setRuns,
    setExpandedRunId,
    setEvents,
    setTranscript,
    setStreaming,
    setLiveThinking,
    streamingDeltaBatcher,
    activeRunIdRef,
    activeRunRef,
    replaceStreamingOnNextDeltaRef,
    transcriptRunIdRef,
    transcriptAfterRef,
    transcriptRefreshTaskRef,
    applyWorkspaceSnapshot: applyRunWorkspaceSnapshot,
    resetWorkspace: resetRunWorkspace,
  } = runView;
  const coordinatorRef = useRef(new WorkspaceLiveSyncCoordinator());
  const reconnectBackoffRef = useRef(new WorkspaceReconnectBackoff());
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectRunIdRef = useRef("");
  const currentWorkspaceIdRef = useRef(workspaceId);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [prefetchCache] = useState(() => new IntentPrefetchCache<string, WorkspaceSnapshot>(30_000, 6));

  useLayoutEffect(() => {
    currentWorkspaceIdRef.current = workspaceId;
    if (!coordinatorRef.current.captureWorkspace(workspaceId)) coordinatorRef.current.enterWorkspace(workspaceId);
  }, [workspaceId]);

  const applyWorkspaceSnapshot = useCallback((snapshot: WorkspaceSnapshot) => {
    setMessages(snapshot.history);
    setHasOlderMessages(snapshot.history.length === 80);
    setInbox(snapshot.queued);
    applyRunWorkspaceSnapshot(snapshot);
  }, [applyRunWorkspaceSnapshot, setHasOlderMessages, setInbox, setMessages]);

  const prefetchWorkspace = useCallback((targetWorkspaceId: string) => {
    if (!targetWorkspaceId || targetWorkspaceId === currentWorkspaceIdRef.current) return;
    void prefetchCache.load(targetWorkspaceId, () => loadWorkspaceSnapshot(targetWorkspaceId)).catch(() => undefined);
  }, [prefetchCache]);

  const prepareWorkspaceSelection = useCallback((targetWorkspaceId: string) => {
    currentWorkspaceIdRef.current = targetWorkspaceId;
    coordinatorRef.current.enterWorkspace(targetWorkspaceId);
    const cached = prefetchCache.peek(targetWorkspaceId);
    if (cached) {
      applyWorkspaceSnapshot(cached);
      setConversationLoading(false);
    } else {
      setConversationLoading(true);
    }
  }, [applyWorkspaceSnapshot, prefetchCache, setConversationLoading]);

  useEffect(() => {
    if (!workspaceId) return;
    const targetWorkspaceId = workspaceId;
    const workspaceToken = coordinatorRef.current.captureWorkspace(targetWorkspaceId);
    if (!workspaceToken) return;
    let closed = false;
    let polling = false;
    const isCurrent = () => !closed && coordinatorRef.current.isWorkspaceCurrent(workspaceToken);
    const refresh = async () => {
      if (!isCurrent() || polling || document.visibilityState !== "visible") return;
      polling = true;
      const snapshotGuard = coordinatorRef.current.snapshotGuard(workspaceToken);
      try {
        const [queued, runHistory, sessionItems] = await Promise.all([
          api.inbox(targetWorkspaceId),
          api.runs(targetWorkspaceId),
          api.sessions(),
        ]);
        if (!isCurrent() || !coordinatorRef.current.canCommitSnapshot(snapshotGuard)) return;
        setInbox(queued);
        setRuns(runHistory);
        setWorkspaces(sessionItems);
        const active = findActiveRun(runHistory);
        const currentActiveRunId = activeRunIdRef.current;
        if (active?.id === currentActiveRunId && coordinatorRef.current.hasFreshStream(workspaceToken, active.id)) return;
        if (!active && currentActiveRunId && coordinatorRef.current.hasFreshStream(workspaceToken, currentActiveRunId)) return;
        if (active?.id && active.id !== currentActiveRunId) {
          const [hydrated, history] = await Promise.all([
            api.run(active.id),
            api.messages(targetWorkspaceId),
          ]);
          const view = await drainTranscriptView(active.id, hydrated.transcriptCount);
          if (!isCurrent() || !coordinatorRef.current.commitSnapshot(snapshotGuard)) return;
          replaceStreamingOnNextDeltaRef.current = false;
          setMessages(history);
          setHasOlderMessages(history.length === 80);
          setActiveRun(hydrated);
          setSelectedRun(hydrated);
          setExpandedRunId(hydrated.id);
          transcriptRunIdRef.current = hydrated.id;
          transcriptAfterRef.current = view.after;
          setTranscript(view.items);
          setStreaming(hydrated.checkpoint?.active ? hydrated.checkpoint.assistantPartial : "");
          setLiveThinking("");
          setEvents(hydrated.checkpoint?.active && hydrated.checkpoint.currentTool ? [{
            runId: hydrated.id,
            seq: hydrated.checkpoint.lastEventSeq,
            type: "tool.started",
            data: hydrated.checkpoint.currentTool,
            createdAt: hydrated.checkpoint.updatedAt,
          }] : []);
          setError("");
        } else if (!active && currentActiveRunId) {
          const [history, ended] = await Promise.all([
            api.messages(targetWorkspaceId),
            api.run(currentActiveRunId),
          ]);
          const view = await drainTranscriptView(currentActiveRunId, ended.transcriptCount);
          if (!isCurrent()
            || activeRunIdRef.current !== currentActiveRunId
            || !coordinatorRef.current.commitSnapshot(snapshotGuard)) return;
          replaceStreamingOnNextDeltaRef.current = false;
          transcriptRunIdRef.current = ended.id;
          transcriptAfterRef.current = view.after;
          setMessages(history);
          setHasOlderMessages(history.length === 80);
          setSelectedRun(ended);
          setTranscript(view.items);
          setActiveRun(null);
          setStreaming("");
          setLiveThinking("");
          setEvents([]);
        } else if (active) {
          const currentRun = await api.run(active.id);
          const shouldRefreshContent = currentRun.lastEventSeq !== activeRunRef.current?.lastEventSeq;
          if (shouldRefreshContent) {
            const refreshSelectedTranscript = transcriptRunIdRef.current === active.id;
            const [view, history] = await Promise.all([
              refreshSelectedTranscript
                ? drainTranscriptView(active.id, currentRun.transcriptCount)
                : Promise.resolve(undefined),
              api.messages(targetWorkspaceId),
            ]);
            if (!isCurrent() || !coordinatorRef.current.commitSnapshot(snapshotGuard)) return;
            if (view && refreshSelectedTranscript && transcriptRunIdRef.current === active.id) {
              transcriptAfterRef.current = view.after;
              setTranscript(view.items);
            }
            setMessages(history);
            setHasOlderMessages(history.length === 80);
          } else if (!coordinatorRef.current.commitSnapshot(snapshotGuard)) {
            return;
          }
          setActiveRun(currentRun);
          setSelectedRun((current) => current?.id === currentRun.id ? currentRun : current);
        }
      } catch {
        // SSE remains authoritative while polling provides eventual UI recovery.
      } finally {
        polling = false;
      }
    };
    if (coordinatorRef.current.consumeRecoveryRequest(workspaceToken)) void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [workspaceId, streamGeneration]);

  useEffect(() => {
    if (!workspaceId) return;
    const targetWorkspaceId = workspaceId;
    const workspaceToken = coordinatorRef.current.captureWorkspace(targetWorkspaceId);
    if (!workspaceToken) return;
    const snapshotGuard = coordinatorRef.current.snapshotGuard(workspaceToken);
    let closed = false;
    const cached = prefetchCache.peek(targetWorkspaceId);
    if (cached) {
      applyWorkspaceSnapshot(cached);
      setConversationLoading(false);
      prefetchCache.invalidate(targetWorkspaceId);
    } else {
      setMessages([]);
      setHasOlderMessages(false);
      setInbox([]);
      resetRunWorkspace();
      setConversationLoading(true);
    }
    setError("");
    setPendingUserMessage(null);
    void prefetchCache.load(targetWorkspaceId, () => loadWorkspaceSnapshot(targetWorkspaceId)).then((snapshot) => {
      if (closed || !coordinatorRef.current.commitSnapshot(snapshotGuard)) return;
      applyWorkspaceSnapshot(snapshot);
    }).catch((cause) => {
      if (!closed && coordinatorRef.current.isWorkspaceCurrent(workspaceToken)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => {
      prefetchCache.invalidate(targetWorkspaceId);
      if (!closed && coordinatorRef.current.isWorkspaceCurrent(workspaceToken)) setConversationLoading(false);
    });
    return () => { closed = true; };
  }, [applyWorkspaceSnapshot, prefetchCache, resetRunWorkspace, workspaceId, setConversationLoading, setError, setHasOlderMessages, setInbox, setMessages, setPendingUserMessage]);

  useEffect(() => {
    const reconnect = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectBackoffRef.current.cancel();
      coordinatorRef.current.invalidateStream(currentWorkspaceIdRef.current);
      setStreamGeneration((value) => value + 1);
    };
    document.addEventListener("visibilitychange", reconnect);
    window.addEventListener("online", reconnect);
    return () => {
      document.removeEventListener("visibilitychange", reconnect);
      window.removeEventListener("online", reconnect);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectBackoffRef.current.cancel();
    };
  }, []);

  useEffect(() => {
    if (!shouldStreamWorkspaceRun(activeRun, workspaceId)) {
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectBackoffRef.current.reset();
      reconnectRunIdRef.current = "";
      return;
    }
    if (reconnectRunIdRef.current !== activeRun.id) {
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectBackoffRef.current.reset();
      reconnectRunIdRef.current = activeRun.id;
    }
    const targetWorkspaceId = workspaceId;
    const workspaceToken = coordinatorRef.current.captureWorkspace(targetWorkspaceId);
    if (!workspaceToken) return;
    const streamToken = coordinatorRef.current.beginStream(workspaceToken, activeRun.id);
    if (!streamToken) return;
    let closed = false;
    let unsubscribe: () => void = () => {};
    const consumerId = getOrCreateEventConsumerId();
    const runId = activeRun.id;
    let acknowledger: EventAcknowledger | undefined;
    const isCurrent = () => !closed && coordinatorRef.current.isStreamCurrent(streamToken);
    const checkpointAfter = activeRun.checkpoint?.active
      ? activeRun.checkpoint.lastEventSeq
      : activeRun.lastEventSeq ?? 0;
    const scheduleReconnect = () => {
      const delay = reconnectBackoffRef.current.nextDelay();
      if (delay === null) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectBackoffRef.current.fired();
        if (!closed && document.visibilityState === "visible" && navigator.onLine) {
          setStreamGeneration((value) => value + 1);
        }
      }, delay);
    };
    const refreshTranscriptThrough = (throughSeq: number) => {
      const refresh = transcriptRefreshTaskRef.current.catch(() => undefined).then(async () => {
        if (transcriptRunIdRef.current !== runId) return;
        const after = transcriptAfterRef.current;
        if (!Number.isSafeInteger(throughSeq) || throughSeq <= after) return;
        const delta = await drainTranscriptView(runId, throughSeq, after);
        if (!isCurrent()
          || activeRunIdRef.current !== runId
          || transcriptRunIdRef.current !== runId) return;
        transcriptAfterRef.current = delta.after;
        setTranscript((current) => mergeTranscriptItems(current, delta.items));
        setStreaming("");
        setLiveThinking("");
      });
      transcriptRefreshTaskRef.current = refresh.catch(() => undefined);
      return refresh;
    };

    void api.claimConsumer(runId, consumerId).then((cursor) => {
      if (!isCurrent()) return;
      acknowledger = createEventAcknowledger((sequence) => {
        void api.ackConsumer(runId, consumerId, cursor.generation, sequence).catch(() => undefined);
      });
      setError("");
      // The durable server cursor is authoritative. Events represented by the hydrated
      // checkpoint are replayed and acknowledged, but need not be applied twice.
      unsubscribe = subscribe(runId, consumerId, cursor.generation, cursor.ackedSeq, async (event) => {
        if (!isCurrent()) return;
        coordinatorRef.current.noteStreamActivity(streamToken);
        if (event.seq <= checkpointAfter) {
          acknowledger?.schedule(event.seq);
          return;
        }
        setEvents((current) => [...current.slice(-39), event]);
        if (event.type === "message.started") {
          streamingDeltaBatcher.flush();
          replaceStreamingOnNextDeltaRef.current = true;
          setLiveThinking("");
        }
        if (event.type === "message.thinking.delta") {
          streamingDeltaBatcher.appendThinking(String(event.data.delta ?? ""));
        }
        if (event.type === "message.delta") {
          const delta = String(event.data.delta ?? "");
          if (replaceStreamingOnNextDeltaRef.current) {
            streamingDeltaBatcher.flush();
            replaceStreamingOnNextDeltaRef.current = false;
            setStreaming(delta);
          } else {
            streamingDeltaBatcher.appendOutput(delta);
          }
        }
        if (event.type === "message.completed") {
          streamingDeltaBatcher.flush();
          const content = String(event.data.content ?? "");
          if (content.trim()) {
            replaceStreamingOnNextDeltaRef.current = false;
            setStreaming(content);
          }
        }
        if (event.type === "transcript.updated") {
          await refreshTranscriptThrough(Number(event.data.transcriptSeq));
          if (!isCurrent()) return;
          streamingDeltaBatcher.discard();
        }
        if (terminalRunEvents.has(event.type)) {
          streamingDeltaBatcher.flush();
          const updatedTask = api.run(runId);
          const [updated, runHistory, history, queued, view, sessionItems] = await Promise.all([
            updatedTask,
            api.runs(targetWorkspaceId),
            api.messages(targetWorkspaceId),
            api.inbox(targetWorkspaceId),
            updatedTask.then((run) => drainTranscriptView(runId, run.transcriptCount)),
            api.sessions(),
          ]);
          if (!isCurrent()) return;
          const nextActiveSummary = findActiveRun(runHistory);
          const nextActive = nextActiveSummary
            ? nextActiveSummary.id === updated.id ? updated : await api.run(nextActiveSummary.id)
            : null;
          if (!isCurrent()) return;
          setStreaming((current) => terminalStreamingAfterRefresh(current, view.items, event.data.response));
          replaceStreamingOnNextDeltaRef.current = false;
          setActiveRun(nextActive);
          setSelectedRun(updated);
          setRuns(runHistory);
          setMessages((current) => mergeRefreshedMessages(current, history));
          setInbox(queued);
          transcriptRunIdRef.current = updated.id;
          transcriptAfterRef.current = view.after;
          setTranscript(view.items);
          setWorkspaces(sessionItems);
        } else if (event.type === "run.updated"
          || event.type.startsWith("continuation.")
          || event.type.startsWith("supervisor.")) {
          const updated = await api.run(runId);
          if (!isCurrent()) return;
          setActiveRun(updated);
          setSelectedRun((current) => current?.id === updated.id ? updated : current);
          setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
        }
        if (isCurrent()) acknowledger?.schedule(event.seq);
      }, () => {
        if (!isCurrent()) return;
        coordinatorRef.current.closeStream(streamToken, true);
        unsubscribe();
        scheduleReconnect();
      });
      coordinatorRef.current.markStreamHealthy(streamToken);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectBackoffRef.current.reset();
    }).catch((cause) => {
      if (!isCurrent()) return;
      coordinatorRef.current.closeStream(streamToken, true);
      setError(cause instanceof Error ? cause.message : String(cause));
      scheduleReconnect();
    });
    return () => {
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectBackoffRef.current.cancel();
      acknowledger?.close();
      coordinatorRef.current.closeStream(streamToken, false);
      closed = true;
      streamingDeltaBatcher.discard();
      unsubscribe();
    };
  }, [activeRun?.id, activeRun?.status, workspaceId, streamGeneration]);

  return {
    currentWorkspaceIdRef,
    prefetchWorkspace,
    prepareWorkspaceSelection,
  };
}
