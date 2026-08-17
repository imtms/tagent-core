import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowDown, BrainCircuit, Check, ChevronDown, ChevronRight, Keyboard, Menu, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, PanelRightClose, PanelRightOpen, Pencil, Play, Plus, Search, Send, Settings2, ShieldCheck, Square, Sun, Target, Trash2, Upload, WandSparkles, X } from "lucide-react";
import { api, drainTranscriptView, subscribe, type CaptureJob, type GateProfile, type Message, type RuntimeStatus, type Session, type SkillRevision, type SkillSummary, type TaskRun, type TranscriptItem, type UserInputRequest } from "./api";
import { preloadMarkdown } from "./LazyMarkdown";
import { createRequestId, getOrCreateEventConsumerId } from "./id";
import { IntentPrefetchCache } from "./intent-prefetch-cache";
import { canResumeRun, findActiveRun, isActiveRunStatus } from "./run-state";
import { formatShortcut, useShortcutModifier } from "./shortcut-platform";
import { useDrawerFocus } from "./use-drawer-focus";
import { useMobileDrawerSwipe } from "./use-mobile-drawer-swipe";
import { useModalFocus } from "./use-modal-focus";
import { usePopoverFocus } from "./use-popover-focus";
import { useStickyConversation } from "./use-sticky-conversation";
import { useRunViewState } from "./use-run-view-state";
import { useSessionInboxController } from "./use-session-inbox-controller";
import { useWorkspacePresentation } from "./use-workspace-presentation";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { TimeAgo } from "./TimeAgo";
import { localDayKey } from "./time-format";
import { ConversationMessage, PendingConversationMessage } from "./ConversationMessage";
import {
  ApprovalDock,
  ConversationDateDivider,
  ExecutionTimeline,
  QueuePrompt,
  RunDetails,
  TAgentMark,
  UserInputCard,
  WorkspaceRunStatus,
  approvalResolutionNotice,
  type RunApproval,
} from "./AppPanels";
import { mergeTranscriptItems } from "./transcript-projection";
import { createEventAcknowledger, type EventAcknowledger } from "./event-acknowledger";
import { loadWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-controller";
import { WorkspaceLiveSyncCoordinator } from "./workspace-live-sync";
import {
  storedGateProfiles,
  storedStringLists,
  storedStringRecord,
} from "./workspace-preferences";
const MemoryPanel = lazy(() => import("./MemoryPanel").then((module) => ({ default: module.MemoryPanel })));
const GoalsPanel = lazy(() => import("./GoalsPanel").then((module) => ({ default: module.GoalsPanel })));

const workspaceEmojis = ["💬", "🧠", "🛠️", "🚀", "📚", "🔬", "🎨", "📦", "🧭", "⚙️"] as const;
const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const starterPrompts = [
  { label: "Analyze this repository", detail: "Prioritize improvements with evidence", prompt: "Analyze this repository and identify the highest-impact improvements, with evidence and a prioritized plan." },
  { label: "Fix failing tests", detail: "Diagnose causes and verify the suite", prompt: "Find the failing tests, diagnose their root causes, implement the fixes, and verify the full relevant test suite." },
  { label: "Review recent changes", detail: "Check regressions and coverage", prompt: "Review the recent changes for correctness, regressions, maintainability, and missing verification." },
  { label: "Improve the documentation", detail: "Refresh guidance and verify commands", prompt: "Audit the project documentation, fix stale or unclear guidance, and verify the documented commands." },
] as const;
const initialWorkspaceRequestId = createRequestId();

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(true);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [retryingRunId, setRetryingRunId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<{ sessionId: string; content: string; createdAt: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittingUserInputId, setSubmittingUserInputId] = useState("");
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [resolvingApprovalDecision, setResolvingApprovalDecision] = useState<"approved" | "rejected" | "">("");
  const {
    activeRun,
    selectedRun,
    runs,
    expandedRunId,
    events,
    transcript,
    streaming,
    liveThinking,
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
    startRun: startRunView,
    openRun: openRunView,
  } = useRunViewState();
  const [draft, setDraft] = useState("");
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>(() => storedStringRecord("tagent.composer-drafts"));
  const [gateProfileBySession, setGateProfileBySession] = useState<Record<string, GateProfile>>(storedGateProfiles);
  const [inputHistoryBySession, setInputHistoryBySession] = useState<Record<string, string[]>>(() => storedStringLists("tagent.composer-history"));
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const {
    leftOpen, setLeftOpen, rightOpen, setRightOpen,
    workspaceMenuOpen, setWorkspaceMenuOpen, workspaceSwitcherOpen, setWorkspaceSwitcherOpen,
    shortcutHelpOpen, setShortcutHelpOpen, sessionSearch, setSessionSearch,
    pinnedSessionIds, setPinnedSessionIds, lastSeenBySession, setLastSeenBySession,
    sessionActivityBaseline, viewingEarlierHistory, setViewingEarlierHistory,
    leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed,
    theme, setTheme, workspaceEmojiById, setWorkspaceEmojiById,
    sessionMenuId, setSessionMenuId, sessionMenuPosition, setSessionMenuPosition,
  } = useWorkspacePresentation(sessions);
  const [savingExecutionProfile, setSavingExecutionProfile] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [workspaceSkills, setWorkspaceSkills] = useState<SkillRevision[]>([]);
  const [skillEditor, setSkillEditor] = useState<SkillRevision | null>(null);
  const [skillEditorDraft, setSkillEditorDraft] = useState({ name: "", description: "", content: "", disableModelInvocation: false });
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillUploading, setSkillUploading] = useState(false);
  const [skillDragActive, setSkillDragActive] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [memoryJobs, setMemoryJobs] = useState<CaptureJob[]>([]);
  const [memoryJobsLoaded, setMemoryJobsLoaded] = useState(false);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const sessionRailRef = useRef<HTMLElement>(null);
  const conversationStageRef = useRef<HTMLDivElement>(null);
  const runPanelRef = useRef<HTMLElement>(null);
  const mobileBackdropRef = useRef<HTMLButtonElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const skillEditorRef = useRef<HTMLElement>(null);
  const skillEditorNameRef = useRef<HTMLInputElement>(null);
  const skillFileRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const renameSubmittingRef = useRef(false);
  const sessionIdRef = useRef("");
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const composerIsComposingRef = useRef(false);
  const historySeedRef = useRef("");
  const workspaceLiveSyncRef = useRef(new WorkspaceLiveSyncCoordinator());
  const [workspacePrefetchCache] = useState(() => new IntentPrefetchCache<string, WorkspaceSnapshot>(30_000, 6));
  const handleInboxRunStarted = useCallback((nextRun: TaskRun, history: Message[]) => {
    setMessages(history);
    setHasOlderMessages(history.length === 80);
    startRunView(nextRun);
  }, [startRunView]);
  const {
    items: inbox,
    setItems: setInbox,
    startingId: startingInboxId,
    editingId: editingInboxId,
    draft: inboxDraft,
    setDraft: setInboxDraft,
    savingId: savingInboxId,
    draggingId: draggingInboxId,
    setDraggingId: setDraggingInboxId,
    reordering: reorderingInbox,
    mutatingId: mutatingInboxId,
    startEditing: startEditingInbox,
    cancelEditing: cancelEditingInbox,
    save: saveInbox,
    dropOn: reorderInbox,
    move: moveInbox,
    toggleDeferred: toggleDeferredInbox,
    mergeIntoFirst: mergeInboxIntoFirst,
    remove: deleteInboxItem,
    runNow: runInboxNow,
  } = useSessionInboxController({
    sessionId,
    activeRun,
    setError,
    setNotice,
    onRunStarted: handleInboxRunStarted,
  });
  const shortcutModifier = useShortcutModifier();
  const workspaceShortcut = formatShortcut(shortcutModifier, "K");
  const conversationActivityKey = `${messages.at(-1)?.id ?? 0}:${pendingUserMessage?.sessionId === sessionId ? pendingUserMessage.createdAt : 0}:${transcript.at(-1)?.seq ?? 0}:${events.at(-1)?.seq ?? 0}:${streaming.length}:${liveThinking.length}`;
  const { viewportRef: messageScrollRef, contentRef: messageFeedRef, pinnedToLatest, hasNewActivity, handleScroll: handleMessageScroll, jumpToLatest: scrollToLatest, pinToLatest } = useStickyConversation(sessionId, conversationActivityKey, conversationStageRef);

  const applyWorkspaceSnapshot = useCallback((snapshot: WorkspaceSnapshot) => {
    setMessages(snapshot.history);
    setHasOlderMessages(snapshot.history.length === 80);
    setInbox(snapshot.queued);
    applyRunWorkspaceSnapshot(snapshot);
  }, [applyRunWorkspaceSnapshot, setInbox]);

  const prefetchWorkspace = useCallback((targetSessionId: string) => {
    if (!targetSessionId || targetSessionId === sessionIdRef.current) return;
    void workspacePrefetchCache.load(targetSessionId, () => loadWorkspaceSnapshot(targetSessionId)).catch(() => undefined);
  }, [workspacePrefetchCache]);

  useDrawerFocus(leftOpen, sessionRailRef);
  useDrawerFocus(rightOpen, runPanelRef);
  useMobileDrawerSwipe({
    open: leftOpen,
    enabled: !rightOpen && !workspaceSwitcherOpen && !shortcutHelpOpen && !workspaceMenuOpen && !memoryOpen && !goalsOpen,
    drawerRef: sessionRailRef,
    backdropRef: mobileBackdropRef,
    onOpenChange: setLeftOpen,
  });
  usePopoverFocus(workspaceMenuOpen, workspaceMenuRef, useCallback(() => setWorkspaceMenuOpen(false), []));
  usePopoverFocus(skillMenuOpen, skillMenuRef, useCallback(() => setSkillMenuOpen(false), []));
  const closeSkillEditor = useCallback(() => setSkillEditor(null), []);
  useModalFocus(Boolean(skillEditor), skillEditorRef, closeSkillEditor, skillEditorNameRef);

  function openSessionMenu(session: Session, anchor: DOMRect | { top: number; bottom: number; left: number }, x?: number, y?: number) {
    const menuWidth = 208;
    const menuHeight = 198;
    const left = x === undefined ? anchor.left : x;
    const top = y === undefined ? anchor.bottom + 4 : y;
    setSessionMenuPosition({
      top: Math.max(8, Math.min(top, globalThis.innerHeight - menuHeight - 8)),
      left: Math.max(8, Math.min(left, globalThis.innerWidth - menuWidth - 8)),
    });
    setSessionMenuId(session.id);
  }

  useEffect(() => {
    sessionIdRef.current = sessionId;
    workspaceLiveSyncRef.current.enterWorkspace(sessionId);
    setViewingEarlierHistory(false);
  }, [sessionId]);
  useEffect(() => {
    setDraft(draftBySession[sessionId] ?? "");
    setHistoryCursor(null);
    historySeedRef.current = "";
  }, [sessionId]);
  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "36px";
    const height = Math.min(Math.max(textarea.scrollHeight, 36), 140);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 140 ? "auto" : "hidden";
  }, [draft]);
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuOpen(false); setSkillMenuOpen(false); setWorkspaceSwitcherOpen(false); setShortcutHelpOpen(false); setSessionMenuId(""); setLeftOpen(false); setRightOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (event.key.toLocaleLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setWorkspaceMenuOpen(false);
        setShortcutHelpOpen(false);
        setWorkspaceSwitcherOpen(true);
        return;
      }
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey && !target?.closest("input, textarea, select, [contenteditable='true']")) {
        event.preventDefault();
        setWorkspaceMenuOpen(false);
        setWorkspaceSwitcherOpen(false);
        setShortcutHelpOpen(true);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !target?.closest("input, textarea, select, [contenteditable='true']")) {
        event.preventDefault();
        composerTextareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    try { globalThis.localStorage?.setItem("tagent.composer-drafts", JSON.stringify(draftBySession)); } catch { /* Browser storage is optional. */ }
  }, [draftBySession]);
  useEffect(() => {
    try { globalThis.localStorage?.setItem("tagent.gate-profiles", JSON.stringify(gateProfileBySession)); } catch { /* Browser storage is optional. */ }
  }, [gateProfileBySession]);
  useEffect(() => {
    try { globalThis.localStorage?.setItem("tagent.composer-history", JSON.stringify(inputHistoryBySession)); } catch { /* Browser storage is optional. */ }
  }, [inputHistoryBySession]);
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      let items = await api.sessions();
      if (!items.length) items = [await api.createSession("First workspace", initialWorkspaceRequestId)];
      setSessions(items);
      setSessionId((current) => current || items[0].id);
    } finally { setSessionsLoading(false); }
  }, []);

  useEffect(() => { void loadSessions(); void api.status().then(setRuntimeStatus); }, [loadSessions]);
  useEffect(() => {
    if (!sessionId) { setWorkspaceSkills([]); return; }
    let closed = false;
    void Promise.all([api.skills(), api.workspaceSkills(sessionId)]).then(([catalog, selected]) => {
      if (!closed) { setSkills(catalog); setWorkspaceSkills(selected); }
    }).catch((cause) => { if (!closed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { closed = true; };
  }, [sessionId]);

  const uploadSkill = async (file: File) => {
    if (skillUploading) return;
    setSkillUploading(true); setError(""); setNotice("");
    try {
      const uploaded = await api.uploadSkill(file);
      setSkills(await api.skills());
      setNotice(`Skill ${uploaded.name} v${uploaded.revision} added to the shared center.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSkillUploading(false); setSkillDragActive(false); if (skillFileRef.current) skillFileRef.current.value = ""; }
  };

  const toggleWorkspaceSkill = async (skillId: string) => {
    if (!sessionId || skillUploading) return;
    setSkillUploading(true); setError("");
    const selectedIds = new Set(workspaceSkills.map((skill) => skill.skillId));
    if (selectedIds.has(skillId)) selectedIds.delete(skillId); else selectedIds.add(skillId);
    try { const selected = await api.replaceWorkspaceSkills(sessionId, [...selectedIds]); setWorkspaceSkills(selected); setSkills(await api.skills()); setNotice(`${selected.length} Skill${selected.length === 1 ? "" : "s"} referenced by this workspace.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSkillUploading(false); }
  };

  const editSkill = async (skillId: string) => {
    if (skillUploading) return;
    setSkillUploading(true); setError("");
    try { const revision = await api.skill(skillId); setSkillEditor(revision); setSkillEditorDraft({ name: revision.name, description: revision.description, content: revision.content, disableModelInvocation: revision.disableModelInvocation }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSkillUploading(false); }
  };
  const saveSkill = async () => {
    if (!skillEditor || skillUploading) return;
    setSkillUploading(true); setError("");
    try { const revision = await api.updateSkill(skillEditor.skillId, skillEditorDraft); setSkillEditor(null); setSkills(await api.skills()); if (sessionId) setWorkspaceSkills(await api.workspaceSkills(sessionId)); setNotice(`Skill ${revision.name} saved as revision ${revision.revision}.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSkillUploading(false); }
  };
  const removeSkill = async (skill: SkillSummary) => {
    if (skillUploading || !globalThis.confirm(`Delete ${skill.name} from the shared Skills center? Existing TaskRuns keep their frozen revision.`)) return;
    setSkillUploading(true); setError("");
    try { await api.deleteSkill(skill.id); setSkills(await api.skills()); if (sessionId) setWorkspaceSkills(await api.workspaceSkills(sessionId)); setNotice(`Skill ${skill.name} deleted from the shared center.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSkillUploading(false); }
  };
  const openSkillPicker = () => {
    setSkillDragActive(false);
    skillFileRef.current?.click();
  };
  const dropSkill = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void uploadSkill(file);
    else setSkillDragActive(false);
  };
  useEffect(() => {
    if (!runtimeStatus?.memoryEnabled || !sessionId) { setMemoryJobs([]); setMemoryJobsLoaded(false); return; }
    setMemoryJobsLoaded(false);
    let closed = false;
    let polling = false;
    const scope = { type: "workspace" as const, id: runtimeStatus.memoryWorkspaceScopeId ?? "default" };
    const refresh = async () => {
      if (closed || polling) return;
      polling = true;
      try { const jobs = await api.memoryJobs(scope); if (!closed) { setMemoryJobs(jobs); setMemoryJobsLoaded(true); } }
      catch { if (!closed) setMemoryJobsLoaded(true); }
      finally { polling = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => { closed = true; clearInterval(timer); };
  }, [runtimeStatus?.memoryEnabled, runtimeStatus?.memoryWorkspaceScopeId, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    const targetSessionId = sessionId;
    const workspaceToken = workspaceLiveSyncRef.current.captureWorkspace(targetSessionId);
    if (!workspaceToken) return;
    let closed = false;
    let polling = false;
    const isCurrent = () => !closed && workspaceLiveSyncRef.current.isWorkspaceCurrent(workspaceToken);
    const refresh = async () => {
      if (!isCurrent() || polling || document.visibilityState !== "visible") return;
      polling = true;
      const snapshotGuard = workspaceLiveSyncRef.current.snapshotGuard(workspaceToken);
      try {
        const [queued, runHistory, sessionItems] = await Promise.all([
          api.inbox(targetSessionId), api.runs(targetSessionId), api.sessions(),
        ]);
        if (!isCurrent() || !workspaceLiveSyncRef.current.canCommitSnapshot(snapshotGuard)) return;
        setInbox(queued);
        setRuns(runHistory);
        setSessions(sessionItems);
        const active = findActiveRun(runHistory);
        const currentActiveRunId = activeRunIdRef.current;
        if (active?.id === currentActiveRunId && workspaceLiveSyncRef.current.hasFreshStream(workspaceToken, active.id)) return;
        if (!active && currentActiveRunId && workspaceLiveSyncRef.current.hasFreshStream(workspaceToken, currentActiveRunId)) return;
        if (active?.id && active.id !== activeRunIdRef.current) {
          const [hydrated, history] = await Promise.all([api.run(active.id), api.messages(targetSessionId)]);
          const view = await drainTranscriptView(active.id, hydrated.transcriptCount);
          if (!isCurrent() || !workspaceLiveSyncRef.current.commitSnapshot(snapshotGuard)) return;
          replaceStreamingOnNextDeltaRef.current = false;
          setMessages(history); setHasOlderMessages(history.length === 80);
          setActiveRun(hydrated); setSelectedRun(hydrated); setExpandedRunId(hydrated.id);
          transcriptRunIdRef.current = hydrated.id;
          transcriptAfterRef.current = view.after;
          setTranscript(view.items); setStreaming(hydrated.checkpoint?.active ? hydrated.checkpoint.assistantPartial : ""); setLiveThinking("");
          setEvents(hydrated.checkpoint?.active && hydrated.checkpoint.currentTool ? [{ runId: hydrated.id, seq: hydrated.checkpoint.lastEventSeq, type: "tool.started", data: hydrated.checkpoint.currentTool, createdAt: hydrated.checkpoint.updatedAt }] : []);
          setError("");
        } else if (!active && activeRunIdRef.current) {
          const endedRunId = activeRunIdRef.current;
          const [history, ended] = await Promise.all([api.messages(targetSessionId), api.run(endedRunId)]);
          const view = await drainTranscriptView(endedRunId, ended.transcriptCount);
          if (!isCurrent() || activeRunIdRef.current !== endedRunId || !workspaceLiveSyncRef.current.commitSnapshot(snapshotGuard)) return;
          replaceStreamingOnNextDeltaRef.current = false;
          transcriptRunIdRef.current = ended.id;
          transcriptAfterRef.current = view.after;
          setMessages(history); setHasOlderMessages(history.length === 80); setSelectedRun(ended); setTranscript(view.items);
          setActiveRun(null); setStreaming(""); setLiveThinking(""); setEvents([]);
        } else if (active) {
          const currentRun = await api.run(active.id);
          const shouldRefreshContent = currentRun.lastEventSeq !== activeRunRef.current?.lastEventSeq;
          if (shouldRefreshContent) {
            const refreshSelectedTranscript = transcriptRunIdRef.current === active.id;
            const [view, history] = await Promise.all([
              refreshSelectedTranscript ? drainTranscriptView(active.id, currentRun.transcriptCount) : Promise.resolve(undefined),
              api.messages(targetSessionId),
            ]);
            if (!isCurrent() || !workspaceLiveSyncRef.current.commitSnapshot(snapshotGuard)) return;
            if (view && refreshSelectedTranscript && transcriptRunIdRef.current === active.id) {
              transcriptAfterRef.current = view.after;
              setTranscript(view.items);
            }
            setMessages(history); setHasOlderMessages(history.length === 80);
          }
          else if (!workspaceLiveSyncRef.current.commitSnapshot(snapshotGuard)) return;
          setActiveRun(currentRun);
          setSelectedRun((current) => current?.id === currentRun.id ? currentRun : current);
        }
      } catch {
        // SSE remains authoritative while polling provides eventual UI recovery.
      } finally { polling = false; }
    };
    if (workspaceLiveSyncRef.current.consumeRecoveryRequest(workspaceToken)) void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [sessionId, streamGeneration]);
  useEffect(() => {
    if (!sessionId) return;
    const targetSessionId = sessionId;
    const workspaceToken = workspaceLiveSyncRef.current.captureWorkspace(targetSessionId);
    if (!workspaceToken) return;
    const snapshotGuard = workspaceLiveSyncRef.current.snapshotGuard(workspaceToken);
    let closed = false;
    const cached = workspacePrefetchCache.peek(targetSessionId);
    if (cached) {
      applyWorkspaceSnapshot(cached);
      setConversationLoading(false);
      workspacePrefetchCache.invalidate(targetSessionId);
    }
    else {
      setMessages([]); setHasOlderMessages(false); setInbox([]); resetRunWorkspace(); setConversationLoading(true);
    }
    setError(""); setPendingUserMessage(null);
    void workspacePrefetchCache.load(targetSessionId, () => loadWorkspaceSnapshot(targetSessionId)).then((snapshot) => {
      if (closed || !workspaceLiveSyncRef.current.commitSnapshot(snapshotGuard)) return;
      applyWorkspaceSnapshot(snapshot);
    }).catch((cause) => { if (!closed && workspaceLiveSyncRef.current.isWorkspaceCurrent(workspaceToken)) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { workspacePrefetchCache.invalidate(targetSessionId); if (!closed && workspaceLiveSyncRef.current.isWorkspaceCurrent(workspaceToken)) setConversationLoading(false); });
    return () => { closed = true; };
  }, [applyWorkspaceSnapshot, sessionId, workspacePrefetchCache]);

  useEffect(() => {
    const reconnect = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      workspaceLiveSyncRef.current.invalidateStream(sessionIdRef.current);
      setStreamGeneration((value) => value + 1);
    };
    document.addEventListener("visibilitychange", reconnect);
    window.addEventListener("online", reconnect);
    return () => { document.removeEventListener("visibilitychange", reconnect); window.removeEventListener("online", reconnect); };
  }, []);
  useEffect(() => {
    if (!activeRun?.id || !isActiveRunStatus(activeRun.status)) return;
    const targetSessionId = sessionId;
    const workspaceToken = workspaceLiveSyncRef.current.captureWorkspace(targetSessionId);
    if (!workspaceToken) return;
    const streamToken = workspaceLiveSyncRef.current.beginStream(workspaceToken, activeRun.id);
    if (!streamToken) return;
    let closed = false;
    let unsubscribe: () => void = () => {};
    const consumerId = getOrCreateEventConsumerId();
    const runId = activeRun.id;
    let acknowledger: EventAcknowledger | undefined;
    const isCurrent = () => !closed && workspaceLiveSyncRef.current.isStreamCurrent(streamToken);
    const checkpointAfter = activeRun.checkpoint?.active ? activeRun.checkpoint.lastEventSeq : activeRun.lastEventSeq ?? 0;
    const refreshTranscriptThrough = (throughSeq: number) => {
      const refresh = transcriptRefreshTaskRef.current.catch(() => undefined).then(async () => {
        if (transcriptRunIdRef.current !== runId) return;
        const after = transcriptAfterRef.current;
        if (!Number.isSafeInteger(throughSeq) || throughSeq <= after) return;
        const delta = await drainTranscriptView(runId, throughSeq, after);
        if (!isCurrent() || activeRunIdRef.current !== runId || transcriptRunIdRef.current !== runId) return;
        transcriptAfterRef.current = delta.after;
        setTranscript((current) => mergeTranscriptItems(current, delta.items));
        setStreaming(""); setLiveThinking("");
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
      // The durable server cursor is authoritative. Events already represented by the
      // hydrated checkpoint are replayed and acknowledged, but need not be applied twice.
      unsubscribe = subscribe(runId, consumerId, cursor.generation, cursor.ackedSeq, async (event) => {
        if (!isCurrent()) return;
        workspaceLiveSyncRef.current.noteStreamActivity(streamToken);
        if (event.seq <= checkpointAfter) { acknowledger?.schedule(event.seq); return; }
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
        if (content.trim()) { replaceStreamingOnNextDeltaRef.current = false; setStreaming(content); }
      }
      if (event.type === "transcript.updated") {
        await refreshTranscriptThrough(Number(event.data.transcriptSeq));
        if (!isCurrent()) return;
        streamingDeltaBatcher.discard();
      }
      if (["run.completed", "run.blocked", "run.failed", "run.cancelled", "run.interrupted", "run.waiting_for_input"].includes(event.type)) {
        streamingDeltaBatcher.flush();
        const updatedTask = api.run(runId);
        const [updated, runHistory, history, queued, view, sessionItems] = await Promise.all([
          updatedTask, api.runs(targetSessionId), api.messages(targetSessionId), api.inbox(targetSessionId), updatedTask.then((run) => drainTranscriptView(runId, run.transcriptCount)), api.sessions(),
        ]);
        if (!isCurrent()) return;
        const nextActiveSummary = findActiveRun(runHistory);
        const nextActive = nextActiveSummary
          ? nextActiveSummary.id === updated.id ? updated : await api.run(nextActiveSummary.id)
          : null;
        if (!isCurrent()) return;
        setStreaming((current) => {
          const response = String(event.data.response ?? "").trim();
          const persisted = !current.trim() || history.some((message) => message.role === "assistant" && (message.content === current || (response && message.content === response)));
          return persisted ? "" : current;
        });
        replaceStreamingOnNextDeltaRef.current = false; setActiveRun(nextActive);
        setSelectedRun(updated);
        setRuns(runHistory); setMessages((current) => {
          const older = current.filter((message) => !history.some((latest) => latest.id === message.id) && message.id < (history[0]?.id ?? Number.MAX_SAFE_INTEGER));
          return [...older, ...history];
        }); setInbox(queued); transcriptRunIdRef.current = updated.id; transcriptAfterRef.current = view.after; setTranscript(view.items); setSessions(sessionItems);
      } else if (event.type === "run.updated" || event.type.startsWith("continuation.") || event.type.startsWith("supervisor.")) {
        const updated = await api.run(runId);
        if (!isCurrent()) return;
        setActiveRun(updated);
        setSelectedRun((current) => current?.id === updated.id ? updated : current);
        setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
      if (isCurrent()) acknowledger?.schedule(event.seq);
      }, () => {
        if (!isCurrent()) return;
        workspaceLiveSyncRef.current.closeStream(streamToken, true);
        unsubscribe();
        window.setTimeout(() => { if (!closed && document.visibilityState === "visible" && navigator.onLine) setStreamGeneration((value) => value + 1); }, 1_000);
      });
      workspaceLiveSyncRef.current.markStreamHealthy(streamToken);
    }).catch((cause) => {
      if (!isCurrent()) return;
      workspaceLiveSyncRef.current.closeStream(streamToken, true);
      setError(cause instanceof Error ? cause.message : String(cause));
      window.setTimeout(() => { if (!closed && document.visibilityState === "visible" && navigator.onLine) setStreamGeneration((value) => value + 1); }, 1_000);
    });
    return () => {
      acknowledger?.close();
      workspaceLiveSyncRef.current.closeStream(streamToken, false);
      closed = true;
      streamingDeltaBatcher.discard();
      unsubscribe();
    };
  }, [activeRun?.id, activeRun?.status, sessionId, loadSessions, streamGeneration]);

  const jumpToLatest = useCallback(() => {
    scrollToLatest("smooth");
    setViewingEarlierHistory(false);
  }, [scrollToLatest]);

  const activeTools = useMemo(() => events.filter((event) => event.type.startsWith("tool.")).slice(-20), [events]);
  const transcriptTools = useMemo(() => transcript.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool"), [transcript]);
  const pendingApprovals = useMemo(() => activeRun?.supervision.approvalRequests.filter((approval) => approval.status === "pending") ?? [], [activeRun]);
  const memoryJobByMessageId = useMemo(() => {
    const jobs = new Map<number, CaptureJob>();
    for (const job of memoryJobs) {
      if (job.request.captureSource?.kind && job.request.captureSource.kind !== "user_message") continue;
      for (const source of job.request.sourceRefs) {
        if (source.sourceType !== "message") continue;
        const messageId = Number(source.sourceId);
        if (Number.isFinite(messageId) && (!jobs.has(messageId) || job.updatedAt > (jobs.get(messageId)?.updatedAt ?? 0))) jobs.set(messageId, job);
      }
    }
    return jobs;
  }, [memoryJobs]);

  async function loadOlderMessages() {
    if (!sessionId || loadingOlderMessages || !messages.length) return;
    const viewport = messageScrollRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    setLoadingOlderMessages(true);
    try {
      const older = await api.messages(sessionId, 80, messages[0].id);
      setMessages((current) => [...older.filter((item) => !current.some((existing) => existing.id === item.id)), ...current]);
      setHasOlderMessages(older.length === 80);
      if (older.length) setViewingEarlierHistory(true);
      requestAnimationFrame(() => { if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingOlderMessages(false); }
  }

  async function createSession() {
    const session = await api.createSession(`Workspace ${sessions.length + 1}`);
    setSessions((current) => [session, ...current]); setSessionId(session.id); setLeftOpen(false);
  }

  function selectSession(nextSession: Session) {
    setLastSeenBySession((current) => ({ ...current, [nextSession.id]: nextSession.updatedAt }));
    if (nextSession.id === sessionIdRef.current) { setLeftOpen(false); setSessionMenuId(""); setWorkspaceSwitcherOpen(false); return; }
    const cached = workspacePrefetchCache.peek(nextSession.id);
    sessionIdRef.current = nextSession.id;
    if (cached) { applyWorkspaceSnapshot(cached); setConversationLoading(false); }
    else setConversationLoading(true);
    setSessionId(nextSession.id); setLeftOpen(false); setSessionMenuId(""); setWorkspaceSwitcherOpen(false);
  }

  function togglePinnedSession(targetSessionId: string) {
    setPinnedSessionIds((current) => current.includes(targetSessionId)
      ? current.filter((id) => id !== targetSessionId)
      : [targetSessionId, ...current]);
  }

  function updateComposerDraft(value: string, resetHistory = true) {
    setDraft(value);
    if (sessionId) setDraftBySession((current) => ({ ...current, [sessionId]: value }));
    if (resetHistory) { setHistoryCursor(null); historySeedRef.current = value; }
  }

  function navigateComposerHistory(direction: -1 | 1) {
    const history = inputHistoryBySession[sessionId] ?? [];
    if (!history.length) return;
    if (historyCursor === null) historySeedRef.current = draft;
    const nextCursor = historyCursor === null
      ? (direction === -1 ? history.length - 1 : null)
      : historyCursor + direction;
    if (nextCursor === null || nextCursor >= history.length) {
      setHistoryCursor(null); updateComposerDraft(historySeedRef.current, false); return;
    }
    const bounded = Math.max(0, nextCursor);
    const nextDraft = history[bounded] ?? "";
    setHistoryCursor(bounded); updateComposerDraft(nextDraft, false);
    requestAnimationFrame(() => composerTextareaRef.current?.setSelectionRange(nextDraft.length, nextDraft.length));
  }

  function cancelRename() {
    cancelRenameRef.current = true;
    setRenamingSessionId(""); setSessionTitleDraft("");
  }

  async function renameSession(session: Session) {
    if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }
    if (renameSubmittingRef.current) return;
    const title = sessionTitleDraft.trim();
    if (!title) { setError("Workspace name is required."); return; }
    if (title === session.title) { setRenamingSessionId(""); setSessionTitleDraft(""); return; }
    renameSubmittingRef.current = true;
    setError("");
    try {
      const updated = await api.renameSession(session.id, title);
      setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRenamingSessionId(""); setSessionTitleDraft("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { renameSubmittingRef.current = false; }
  }

  async function updateExecutionProfile(settings: { modelId?: string; reasoningEffort?: Session["reasoningEffort"] }) {
    if (!sessionId || savingExecutionProfile) return;
    setSavingExecutionProfile(true); setError(""); setNotice("");
    try {
      const updated = await api.updateSession(sessionId, settings);
      setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(activeRun ? "Execution preference saved for the next TaskRun; the active TaskRun keeps its original profile." : "Workspace execution preference saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingExecutionProfile(false); }
  }

  async function submit() {
    const content = draft.trim();
    const targetSessionId = sessionId;
    const gateProfile = gateProfileBySession[targetSessionId] ?? "relaxed";
    if (!content || !targetSessionId || submitting) return;
    void preloadMarkdown().catch(() => undefined);
    const optimistic = { sessionId: targetSessionId, content, createdAt: Date.now() };
    setSubmitting(true); updateComposerDraft(""); setError(""); setNotice(""); pinToLatest();
    setInputHistoryBySession((current) => {
      const history = current[targetSessionId] ?? [];
      const deduplicated = history.filter((item) => item !== content);
      return { ...current, [targetSessionId]: [...deduplicated, content].slice(-50) };
    });
    try {
      const admission = await api.send(targetSessionId, content, gateProfile);
      if (sessionIdRef.current !== targetSessionId) return;
      if (admission.run) setPendingUserMessage(optimistic);
      const [queued, history] = await Promise.all([api.inbox(targetSessionId), api.messages(targetSessionId)]);
      if (sessionIdRef.current !== targetSessionId) return;
      const persisted = history.some((message) => message.role === "user" && message.content === content && message.createdAt >= optimistic.createdAt - 5_000);
      setInbox(queued); setMessages(history); setHasOlderMessages(history.length === 80); setPendingUserMessage(persisted ? null : admission.run ? optimistic : null);
      if (admission.run) {
        const nextRun = admission.run;
        startRunView(nextRun);
      }
    } catch (cause) {
      if (sessionIdRef.current === targetSessionId) { setPendingUserMessage(null); updateComposerDraft(content); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally { setSubmitting(false); }
  }

  async function submitRequestedInput(request: UserInputRequest, values: Record<string, string>) {
    if (submittingUserInputId) return;
    setSubmittingUserInputId(request.id); setError(""); setNotice("");
    try {
      if (!selectedRun) throw new Error("TaskRun is not selected");
      const resumed = await api.submitUserInput(selectedRun.id, request.id, values);
      setActiveRun(resumed); setSelectedRun(resumed); setRuns((current) => current.map((item) => item.id === resumed.id ? resumed : item));
      setEvents([]); setStreaming(""); setLiveThinking(""); setNotice("Information submitted. TaskRun resumed."); pinToLatest();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmittingUserInputId(""); }
  }

  async function resolveRunApproval(approval: RunApproval, decision: "approved" | "rejected") {
    if (resolvingApprovalId) return;
    const sourceRun = activeRun;
    const targetSessionId = sessionId;
    setResolvingApprovalId(approval.id); setResolvingApprovalDecision(decision); setError(""); setNotice("");
    try {
      if (!sourceRun) throw new Error("TaskRun is not active");
      const updated = await api.resolveRunApproval(sourceRun.id, approval.id, decision);
      if (sessionIdRef.current !== targetSessionId) return;
      const refreshedSource = sourceRun && sourceRun.id !== updated.id
        ? await api.run(sourceRun.id)
        : updated;
      if (sessionIdRef.current !== targetSessionId) return;
      const resolvedRuns = refreshedSource.id === updated.id ? [updated] : [updated, refreshedSource];
      setActiveRun((current) => resolvedRuns.find((run) => run.id === current?.id) ?? current);
      setSelectedRun((current) => resolvedRuns.find((run) => run.id === current?.id) ?? current);
      setRuns((current) => {
        const replacements = new Map(resolvedRuns.map((run) => [run.id, run]));
        const knownIds = new Set(current.map((run) => run.id));
        return [...resolvedRuns.filter((run) => !knownIds.has(run.id)), ...current.map((run) => replacements.get(run.id) ?? run)];
      });
      if (decision === "approved" && sourceRun?.id === updated.id) { setEvents([]); setStreaming(""); setLiveThinking(""); }
      setNotice(approvalResolutionNotice(approval.actionType, decision));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setResolvingApprovalId(""); setResolvingApprovalDecision(""); }
  }

  async function retryLaunch(run: TaskRun) {
    if (retryingRunId) return;
    setRetryingRunId(run.id); setError(""); setNotice("");
    try {
      const result = await api.retryLaunch(run.id);
      const nextRun = result.run;
      startRunView(nextRun);
      setNotice("TaskRun launch retry started.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRetryingRunId(""); }
  }

  const selectedSession = sessions.find((session) => session.id === sessionId);
  useEffect(() => {
    if (!selectedSession || lastSeenBySession[selectedSession.id] === selectedSession.updatedAt) return;
    setLastSeenBySession((current) => ({ ...current, [selectedSession.id]: selectedSession.updatedAt }));
  }, [selectedSession?.id, selectedSession?.updatedAt]);
  const selectableModels = [...new Set([runtimeStatus?.modelId ?? "gpt-5.6-sol", ...(runtimeStatus?.fallbackModelIds ?? [])])];
  const normalizedSessionSearch = sessionSearch.trim().toLocaleLowerCase();
  const filteredSessions = sessions.filter((session) => !normalizedSessionSearch || session.title.toLocaleLowerCase().includes(normalizedSessionSearch));
  const pinnedSessions = filteredSessions.filter((session) => pinnedSessionIds.includes(session.id));
  const recentSessions = filteredSessions.filter((session) => !pinnedSessionIds.includes(session.id));
  const sessionGroups = [
    ...(pinnedSessions.length ? [{ label: "Pinned", sessions: pinnedSessions }] : []),
    ...((recentSessions.length || !pinnedSessions.length) ? [{ label: normalizedSessionSearch ? "Matches" : "Recent", sessions: recentSessions }] : []),
  ];
  const selectedRunStatus = activeRun?.status ?? selectedRun?.status;
  const auditNeedsAttention = pendingApprovals.length > 0 || selectedRunStatus === "waiting_input" || selectedRunStatus === "failed" || selectedRunStatus === "blocked";
  const auditAvailable = Boolean(activeRun || selectedRun || runs.length);
  const enterSubmits = !globalThis.matchMedia?.("(pointer: coarse)").matches;

  return <div className={`app-shell ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""} ${auditNeedsAttention ? "audit-needs-attention" : ""} ${auditAvailable ? "" : "audit-unavailable"}`}>
    <WorkspaceSwitcher open={workspaceSwitcherOpen} sessions={sessions} selectedSessionId={sessionId} pinnedSessionIds={pinnedSessionIds} workspaceEmojiById={workspaceEmojiById} onClose={() => setWorkspaceSwitcherOpen(false)} onSelect={selectSession} onCreate={createSession} onPrefetch={prefetchWorkspace} />
    <KeyboardShortcutsDialog open={shortcutHelpOpen} modifier={shortcutModifier} enterSubmits={enterSubmits} onClose={() => setShortcutHelpOpen(false)} />
    <aside ref={sessionRailRef} className={`session-rail ${leftOpen ? "mobile-open" : ""} ${leftCollapsed ? "collapsed" : ""}`} role={leftOpen ? "dialog" : undefined} aria-label="Workspaces" aria-modal={leftOpen ? "true" : undefined}>
      <div className="brand"><div className="brand-mark"><TAgentMark /></div><div className="brand-copy"><strong>TAgent</strong><span>Core runtime</span></div><button className="icon-button desktop-only rail-collapse" onClick={() => setLeftCollapsed((current) => !current)} aria-label={leftCollapsed ? "Expand workspace sidebar" : "Collapse workspace sidebar"} title={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{leftCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button><button className="icon-button mobile-only" data-drawer-close onClick={() => setLeftOpen(false)} aria-label="Close sessions"><X size={18} /></button></div>
      <button className="new-session" onClick={createSession} title="New workspace"><Plus size={16} /><span>New workspace</span></button>
      <label className="session-search"><Search size={14} /><input type="search" value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} placeholder="Filter workspaces" aria-label="Filter workspaces" />{sessionSearch ? <button type="button" onClick={() => setSessionSearch("")} aria-label="Clear workspace filter"><X size={13} /></button> : <kbd aria-label={`${workspaceShortcut} shortcut`}>{workspaceShortcut}</kbd>}</label>
      <div className="session-list" onScroll={() => { if (sessionMenuId) setSessionMenuId(""); }}>
        {sessionsLoading ? <div className="session-skeletons" aria-label="Loading workspaces"><i /><i /><i /></div> : sessionGroups.map((group) => <section className="session-group" key={group.label}><div className="session-group-label"><span>{group.label}</span><small>{group.sessions.length}</small></div>{group.sessions.map((session) => {
          const pinned = pinnedSessionIds.includes(session.id);
          const unread = session.id !== sessionId && session.updatedAt > (lastSeenBySession[session.id] ?? sessionActivityBaseline[session.id] ?? session.updatedAt);
          return <div key={session.id} className={`session-item ${session.id === sessionId ? "active" : ""} ${unread ? "unread" : ""}`} onContextMenu={(event) => {
            if (renamingSessionId === session.id) return;
            event.preventDefault();
            openSessionMenu(session, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
          }}>
          <span className="session-emoji" aria-hidden="true">{workspaceEmojiById[session.id] ?? "💬"}</span>
          {renamingSessionId === session.id ? <div className="session-select session-editor">
            <span><input className="session-title-input" value={sessionTitleDraft} autoFocus onChange={(event) => setSessionTitleDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void renameSession(session); }
              if (event.key === "Escape") { event.preventDefault(); cancelRename(); event.currentTarget.blur(); }
            }} onBlur={() => void renameSession(session)} aria-label="Workspace name" /><span className="session-meta"><TimeAgo value={session.updatedAt} /><WorkspaceRunStatus session={session} /></span></span>
          </div> : <>
            <button className="session-select" onMouseEnter={() => prefetchWorkspace(session.id)} onFocus={() => prefetchWorkspace(session.id)} onClick={() => selectSession(session)} aria-label={`Open workspace ${session.title}${unread ? ". Unread activity" : ""}`} aria-describedby={leftCollapsed ? `workspace-tooltip-${session.id}` : undefined}><span><strong>{session.title}{unread && <i className="unread-dot" aria-label="Unread activity" />}</strong><span className="session-meta"><TimeAgo value={session.updatedAt} /><WorkspaceRunStatus session={session} /></span></span></button>
            <button className="session-more" type="button" onClick={(event) => {
              if (sessionMenuId === session.id) { setSessionMenuId(""); return; }
              const item = event.currentTarget.closest(".session-item")?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
              openSessionMenu(session, item);
            }} aria-haspopup="menu" aria-expanded={sessionMenuId === session.id} aria-label={`More actions for ${session.title}`}><MoreHorizontal size={14} /></button>
            <span id={`workspace-tooltip-${session.id}`} className="collapsed-workspace-tooltip" role="tooltip"><strong>{session.title}</strong><small><i className={`workspace-tooltip-status ${session.latestRunStatus ?? "idle"}`} />{session.latestRunStatus ? session.latestRunStatus.replaceAll("_", " ") : "No tasks"}{unread ? " · Unread" : ""}</small></span>
            {sessionMenuId === session.id && <WorkspaceContextMenu session={session} pinned={pinned} currentEmoji={workspaceEmojiById[session.id] ?? "💬"} emojis={workspaceEmojis} position={sessionMenuPosition} onClose={() => setSessionMenuId("")} onTogglePinned={() => togglePinnedSession(session.id)} onRename={() => { setRenamingSessionId(session.id); setSessionTitleDraft(session.title); }} onChooseEmoji={(emoji) => setWorkspaceEmojiById((current) => ({ ...current, [session.id]: emoji }))} />}
          </>}
        </div>})}</section>)}
        {!sessionsLoading && filteredSessions.length === 0 && <div className="session-search-empty"><Search size={16} /><span>No matching workspaces</span><button type="button" onClick={() => setSessionSearch("")}>Clear search</button></div>}
      </div>
      <div className="rail-footer"><span className="status-dot" />Local control plane{runtimeStatus?.schemaVersion ? ` · db v${runtimeStatus.schemaVersion}` : ""}</div>
    </aside>

    <main className="conversation">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setLeftOpen(true)} aria-label="Open sessions"><Menu size={19} /></button>
        <div className="workspace-heading"><span className="workspace-kicker">Workspace</span><h1><button type="button" onClick={() => setWorkspaceSwitcherOpen(true)} title={`Switch workspace (${workspaceShortcut})`}>{selectedSession?.title ?? "TAgent Core"}<ChevronDown size={13} /></button></h1><p>{activeRun ? `${activeRun.phase} · ${activeRun.status} · ${activeRun.modelId || runtimeStatus?.modelId || "default model"} · ${activeRun.reasoningEffort}` : runtimeStatus ? `${runtimeStatus.runtime} · ready` : "Ready for a new task"}</p></div>
        <div className="top-actions">
          {auditAvailable && selectedRunStatus && <button className={`run-status-control ${selectedRunStatus}`} onClick={() => { setWorkspaceMenuOpen(false); setRightCollapsed(false); setRightOpen(true); }} aria-label={`Open audit panel. Task status: ${selectedRunStatus}`}><span /><strong>{selectedRunStatus === "waiting_input" ? "Needs input" : selectedRunStatus.replaceAll("_", " ")}</strong></button>}
          {canResumeRun(selectedRun, activeRun) && <button className="resume-button desktop-only" onClick={async () => { setError(""); try { const resumed = await api.resume(selectedRun.id); setActiveRun(resumed); setSelectedRun(resumed); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={15} />Resume</button>}
          {activeRun?.status === "running" && <button className="icon-button danger desktop-only" onClick={() => void api.cancel(activeRun.id)} title="Stop run" aria-label="Stop run"><Square size={17} /></button>}
          {sessionId && <div className="skill-control">
            <input ref={skillFileRef} type="file" accept=".md,.zip,text/markdown,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadSkill(file); }} />
            <button className={`skill-menu-toggle ${workspaceSkills.length ? "active" : ""} ${skillDragActive ? "drag-active" : ""}`} type="button" title="Workspace skills" aria-label={`${workspaceSkills.length} ${workspaceSkills.length === 1 ? "Skill" : "Skills"} referenced by this workspace`} aria-haspopup="dialog" aria-controls="workspace-skill-menu" aria-expanded={skillMenuOpen} onClick={() => { setWorkspaceMenuOpen(false); setSkillMenuOpen((current) => !current); }} onDragEnter={(event) => { event.preventDefault(); setSkillDragActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={() => setSkillDragActive(false)} onDrop={dropSkill}><WandSparkles size={15} /><span className="desktop-only">{skillUploading ? "Saving…" : "Skills"}</span>{workspaceSkills.length > 0 && <span className="skill-revision-badge">{workspaceSkills.length}</span>}<ChevronDown className="desktop-only" size={12} /></button>
            {skillMenuOpen && <><button className="workspace-menu-scrim" type="button" aria-label="Close Skill loader" onClick={() => setSkillMenuOpen(false)} /><div id="workspace-skill-menu" ref={skillMenuRef} className={`skill-loader-menu ${skillDragActive ? "drag-active" : ""}`} role="dialog" aria-modal="false" aria-labelledby="workspace-skill-heading" onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSkillDragActive(false); }} onDrop={dropSkill}>
              <div className="skill-loader-heading"><span className="skill-heading-icon"><WandSparkles size={15} /></span><span><strong id="workspace-skill-heading">Skills center</strong><small>Shared library · choose references for this workspace</small></span><em>{skills.length}</em></div>
              <button className="skill-drop-target" type="button" disabled={skillUploading} onClick={openSkillPicker} onDragEnter={(event) => { event.preventDefault(); setSkillDragActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}><span className="skill-upload-icon">{skillUploading ? <Activity className="spin" size={18} /> : <Upload size={18} />}</span><span><strong>{skillUploading ? "Validating Skill…" : "Upload or drop a Skill"}</strong><small>SKILL.md or ZIP · available to every workspace</small></span></button>
              {skills.length > 0 ? <div className="skill-catalog"><span>Shared Skills</span>{skills.map((skill) => { const selected = workspaceSkills.some((item) => item.skillId === skill.id); return <div className={`skill-catalog-row ${selected ? "selected" : ""}`} key={skill.id}><button type="button" className="skill-reference-toggle" aria-pressed={selected} disabled={skillUploading} onClick={() => void toggleWorkspaceSkill(skill.id)}><span className="skill-select-box">{selected && <Check size={12} />}</span><span><strong>{skill.name}</strong><small>{skill.description}</small></span><em>v{skill.latestRevision}</em></button><div className="skill-row-actions"><button type="button" title="Edit Skill" aria-label={`Edit ${skill.name}`} onClick={() => void editSkill(skill.id)}><Pencil size={13} /></button><button type="button" title="Delete Skill" aria-label={`Delete ${skill.name}`} onClick={() => void removeSkill(skill)}><Trash2 size={13} /></button></div></div>; })}</div> : <div className="skill-empty"><WandSparkles size={14} /><span><strong>No Skills in the center</strong><small>Upload once, then reference it from any workspace.</small></span></div>}
              <p className="skill-snapshot-note"><ShieldCheck size={13} /><span>TaskRuns freeze every referenced revision. Later edits or deletions never change running work.</span></p>
            </div></>}
          </div>}
          <button className={`workspace-menu-toggle ${workspaceMenuOpen ? "active" : ""}`} type="button" title="Workspace settings" aria-label="More workspace actions" aria-haspopup="dialog" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((current) => !current)}><Settings2 size={16} /><span className="desktop-only">Workspace</span><ChevronDown className="desktop-only" size={12} /></button>
          {workspaceMenuOpen && <><button className="workspace-menu-scrim" type="button" aria-label="Close workspace actions" onClick={() => setWorkspaceMenuOpen(false)} /><div ref={workspaceMenuRef} className="workspace-actions-menu" role="dialog" aria-label="Workspace settings">
            <div className="workspace-actions-heading"><span>Workspace settings</span><small>{selectedSession?.title ?? "TAgent Core"}</small></div>
            {auditAvailable && <button onClick={() => { setRightCollapsed(false); setRightOpen(true); setWorkspaceMenuOpen(false); }}><PanelRight size={15} /><span>Supervisor & execution</span>{selectedRunStatus && <small>{selectedRunStatus.replaceAll("_", " ")}</small>}</button>}
            {selectedSession && <div className="workspace-profile-settings"><label><span>Model</span><select value={selectedSession.modelId || runtimeStatus?.modelId || "gpt-5.6-sol"} disabled={savingExecutionProfile} onChange={(event) => void updateExecutionProfile({ modelId: event.target.value })}>{selectableModels.map((modelId) => <option value={modelId} key={modelId}>{modelId}</option>)}</select></label><label><span>Reasoning</span><select value={selectedSession.reasoningEffort} disabled={savingExecutionProfile} onChange={(event) => void updateExecutionProfile({ reasoningEffort: event.target.value as Session["reasoningEffort"] })}>{reasoningEfforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}</select></label></div>}
            {canResumeRun(selectedRun, activeRun) && <button onClick={async () => { setWorkspaceMenuOpen(false); setError(""); try { const resumed = await api.resume(selectedRun.id); setActiveRun(resumed); setSelectedRun(resumed); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={15} /><span>Resume TaskRun</span></button>}
            {selectedRun?.status === "failed" && selectedRun.launchRetryable && !activeRun && <button onClick={() => { setWorkspaceMenuOpen(false); void retryLaunch(selectedRun); }} disabled={Boolean(retryingRunId)}><Play size={15} /><span>{retryingRunId === selectedRun.id ? "Retrying launch…" : "Retry launch"}</span></button>}
            {activeRun?.status === "running" && <button className="workspace-stop-run" onClick={() => { setWorkspaceMenuOpen(false); void api.cancel(activeRun.id); }}><Square size={15} /><span>Stop TaskRun</span></button>}
            <div className="workspace-actions-separator" />
            <button onClick={() => { setShortcutHelpOpen(true); setWorkspaceMenuOpen(false); }}><Keyboard size={15} /><span>Keyboard shortcuts</span><small>?</small></button>
            <button onClick={() => { setTheme((current) => current === "dark" ? "light" : "dark"); setWorkspaceMenuOpen(false); }}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}<span>{theme === "dark" ? "Light theme" : "Dark theme"}</span></button>
            {sessionId && <button onClick={() => { setGoalsOpen(true); setWorkspaceMenuOpen(false); }}><Target size={15} /><span>Workspace Goals</span></button>}
            {runtimeStatus?.memoryEnabled && <button aria-label="Open memory center" onClick={() => { setMemoryOpen(true); setWorkspaceMenuOpen(false); }}><BrainCircuit size={15} /><span>Memory center</span></button>}
          </div></>}
        </div>
      </header>
      {skillEditor && createPortal(<div className="skill-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSkillEditor(); }}><section ref={skillEditorRef} className="skill-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-editor-title" aria-describedby="skill-editor-note"><header><span><small>Shared Skill</small><h2 id="skill-editor-title">Edit {skillEditor.name}</h2></span><button type="button" aria-label="Close Skill editor" onClick={closeSkillEditor}><X size={17} /></button></header><div className="skill-editor-grid"><label><span>Name</span><input ref={skillEditorNameRef} type="text" autoComplete="off" value={skillEditorDraft.name} onChange={(event) => setSkillEditorDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Description</span><input type="text" autoComplete="off" value={skillEditorDraft.description} onChange={(event) => setSkillEditorDraft((current) => ({ ...current, description: event.target.value }))} /></label><label className="skill-editor-content"><span>Instructions</span><textarea value={skillEditorDraft.content} onChange={(event) => setSkillEditorDraft((current) => ({ ...current, content: event.target.value }))} /></label><label className="skill-editor-option"><input type="checkbox" checked={skillEditorDraft.disableModelInvocation} onChange={(event) => setSkillEditorDraft((current) => ({ ...current, disableModelInvocation: event.target.checked }))} /><span><strong>Manual invocation only</strong><small>Hide this Skill from Pi's available Skills list.</small></span></label></div><footer><span id="skill-editor-note">Saving creates a new immutable revision.</span><div><button type="button" onClick={closeSkillEditor}>Cancel</button><button className="primary" type="button" disabled={skillUploading} onClick={() => void saveSkill()}>{skillUploading ? "Saving…" : "Save revision"}</button></div></footer></section></div>, document.body)}

      <div className="conversation-stage" ref={conversationStageRef}>
        <section className="message-scroll" ref={messageScrollRef} onScroll={handleMessageScroll}>
          <div className="message-feed" ref={messageFeedRef}>
        {conversationLoading && !messages.length ? <div className="conversation-skeleton" aria-label="Loading conversation"><span /><span /><span /></div> : !messages.length && !streaming && pendingUserMessage?.sessionId !== sessionId && <div className="empty-state"><div className="empty-icon"><TAgentMark size={23} /></div><span className="empty-kicker">Durable agent workspace</span><h2>What should we accomplish?</h2><p>Start with an outcome. TAgent will plan the work, preserve progress, and verify the result.</p><div className="starter-prompts" aria-label="Starter prompts">{starterPrompts.map((starter) => <button type="button" key={starter.label} onClick={() => { updateComposerDraft(starter.prompt); requestAnimationFrame(() => composerTextareaRef.current?.focus()); }}><span><strong>{starter.label}</strong><small>{starter.detail}</small></span><ChevronRight size={13} /></button>)}</div><div className="empty-capabilities" aria-label="TAgent workflow"><span>Plan</span><i /><span>Execute</span><i /><span>Verify</span></div></div>}
        {hasOlderMessages && <button className="load-older" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages}>{loadingOlderMessages ? "Loading…" : "Load earlier messages"}</button>}
        {viewingEarlierHistory && <div className="history-context"><span>Viewing earlier history</span><button type="button" onClick={jumpToLatest}>Return to latest</button></div>}
        {messages.map((message, index) => <Fragment key={message.id}>{(index === 0 || localDayKey(messages[index - 1].createdAt) !== localDayKey(message.createdAt)) && <ConversationDateDivider value={message.createdAt} />}<ConversationMessage message={message} memoryEnabled={Boolean(runtimeStatus?.memoryEnabled)} memoryJob={message.role === "user" ? (memoryJobsLoaded ? memoryJobByMessageId.get(message.id) ?? null : undefined) : undefined} /></Fragment>)}
        {pendingUserMessage?.sessionId === sessionId && !messages.some((message) => message.role === "user" && message.content === pendingUserMessage.content && message.createdAt >= pendingUserMessage.createdAt - 5_000) && <>{(!messages.length || localDayKey(messages[messages.length - 1].createdAt) !== localDayKey(pendingUserMessage.createdAt)) && <ConversationDateDivider value={pendingUserMessage.createdAt} />}<PendingConversationMessage content={pendingUserMessage.content} memoryEnabled={Boolean(runtimeStatus?.memoryEnabled)} /></>}
        {activeRun && <div className="active-run-strip"><Activity size={14} /><span>Attempt {activeRun.attempt}</span><strong>{activeRun.phase}</strong><small>{activeRun.usage.totalTokens.toLocaleString()} tokens</small></div>}
        {selectedRun?.pendingUserInput && <UserInputCard request={selectedRun.pendingUserInput} submitting={submittingUserInputId === selectedRun.pendingUserInput.id} onSubmit={(values) => submitRequestedInput(selectedRun.pendingUserInput!, values)} />}
        {(activeRun || selectedRun) && transcript.length + events.length + Number(Boolean(liveThinking || streaming)) > 0 && <ExecutionTimeline runId={(activeRun ?? selectedRun)!.id} isRunning={activeRun?.status === "running"} items={transcript} events={activeRun ? events : []} liveThinking={activeRun ? liveThinking : ""} liveOutput={activeRun ? streaming : ""} />}
          </div>
        </section>
        {!pinnedToLatest && <button className={`jump-to-latest ${hasNewActivity ? "has-new-activity" : ""}`} type="button" onClick={jumpToLatest} aria-label={hasNewActivity ? "New activity. Jump to latest" : "Jump to latest"}><ArrowDown size={14} /><span>{hasNewActivity ? "New activity" : "Latest"}</span>{hasNewActivity && <i aria-hidden="true" />}</button>}
      </div>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="success-banner">{notice}</div>}
        {activeRun && pendingApprovals.length > 0 && <ApprovalDock run={activeRun} approvals={pendingApprovals} resolvingId={resolvingApprovalId} resolvingDecision={resolvingApprovalDecision} onResolve={resolveRunApproval} />}
        <div className="composer-mode"><span><Activity size={13} />{activeRun ? "Steer or queue" : "Supervisor inbox"}</span><span>{activeRun ? "New input is classified as steer, context, follow-up, parallel work, or a new TaskRun" : "Supervisor summarizes, prioritizes, and starts the next eligible contract"}</span><kbd>/</kbd></div>
        <div className="gate-profile-control">
          <div className="gate-profile-heading"><span><ShieldCheck size={13} />Gate acceptance</span><small>{activeRun ? "Applies only if this input creates a new TaskRun" : "Choose before this TaskRun starts"}</small></div>
          <div className="gate-profile-options" role="radiogroup" aria-label="Gate acceptance style">
            {([
              { value: "off", label: "Off", description: "Direct delivery" },
              { value: "relaxed", label: "Relaxed", description: "Open research" },
              { value: "strict", label: "Strict", description: "Code & closed work" },
            ] as const).map((option) => {
              const selected = (gateProfileBySession[sessionId] ?? "relaxed") === option.value;
              return <button key={option.value} type="button" role="radio" aria-checked={selected} className={selected ? "selected" : ""} onClick={() => setGateProfileBySession((current) => ({ ...current, [sessionId]: option.value }))}>
                <span>{option.label}</span><small>{option.description}</small>
              </button>;
            })}
          </div>
          <p>{(gateProfileBySession[sessionId] ?? "relaxed") === "off" ? "No completion review. External-action approvals and safety policies remain active." : (gateProfileBySession[sessionId] ?? "relaxed") === "relaxed" ? "One result-oriented review; missing core outcomes still block, secondary uncertainty does not." : "Requires plan, current trusted checks, and criterion-level coverage."}</p>
        </div>
        <div className="composer"><textarea ref={composerTextareaRef} value={draft} onChange={(event) => updateComposerDraft(event.target.value)} onCompositionStart={() => { composerIsComposingRef.current = true; }} onCompositionEnd={() => { composerIsComposingRef.current = false; }} onKeyDown={(event) => {
          if (event.key === "Enter" && enterSubmits && !event.shiftKey && !composerIsComposingRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && !submitting) void submit(); return; }
          const caretAtStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
          const caretAtEnd = event.currentTarget.selectionStart === draft.length && event.currentTarget.selectionEnd === draft.length;
          if (event.key === "ArrowUp" && (historyCursor !== null || caretAtStart)) { event.preventDefault(); navigateComposerHistory(-1); }
          if (event.key === "ArrowDown" && historyCursor !== null && caretAtEnd) { event.preventDefault(); navigateComposerHistory(1); }
        }} placeholder="Describe an outcome, correction, constraint, or follow-up…" rows={1} aria-label={enterSubmits ? "Message. Press Enter to send and Shift Enter for a new line." : "Message. Use the send button to submit."} /><button type="button" onClick={() => void submit()} disabled={!draft.trim() || submitting} aria-label="Add to Supervisor queue">{submitting ? <Activity className="spin" size={18} /> : <Send size={18} />}</button></div>
        <div className="composer-hint"><span>{enterSubmits ? "Enter to send · Shift+Enter for a new line" : "Use the arrow to send"}</span>{draftBySession[sessionId]?.trim() && <span>Draft saved</span>}</div>
        {inbox.length > 0 && <section className="supervisor-inbox"><div className="inbox-heading"><span>Up next</span><small>{inbox.length} queued</small></div>{inbox.map((item, index) => <QueuePrompt key={item.id} item={item} index={index} editing={editingInboxId === item.id} draft={editingInboxId === item.id ? inboxDraft : item.content} busy={Boolean(startingInboxId || savingInboxId || reorderingInbox || mutatingInboxId)} starting={startingInboxId === item.id} dragging={draggingInboxId === item.id} canMoveUp={index > 0} canMoveDown={index < inbox.length - 1} onEdit={() => startEditingInbox(item)} onDraftChange={setInboxDraft} onSave={() => void saveInbox(item)} onCancelEdit={cancelEditingInbox} onStart={() => void runInboxNow(item)} onToggleDefer={() => void toggleDeferredInbox(item)} onMergeFirst={() => void mergeInboxIntoFirst(item)} onDelete={() => void deleteInboxItem(item)} onMoveUp={() => void moveInbox(item.id, -1)} onMoveDown={() => void moveInbox(item.id, 1)} onDragStart={(event) => { setDraggingInboxId(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }} onDragEnd={() => setDraggingInboxId("")} onDrop={(event) => { event.preventDefault(); void reorderInbox(item.id); }} />)}</section>}
      </footer>
    </main>

    {auditAvailable && <aside ref={runPanelRef} className={`run-panel ${rightOpen ? "mobile-open" : ""} ${rightCollapsed ? "collapsed" : ""} ${auditNeedsAttention ? "needs-attention" : ""}`} role={rightOpen ? "dialog" : undefined} aria-label="Supervisor and execution" aria-modal={rightOpen ? "true" : undefined}>
      <div className="panel-heading"><div><span className="eyebrow">On demand</span><h2>Supervisor & execution</h2></div><button className={`icon-button desktop-only panel-collapse ${auditNeedsAttention ? "attention" : ""}`} onClick={() => setRightCollapsed((current) => !current)} aria-label={rightCollapsed ? "Expand audit sidebar" : "Collapse audit sidebar"} title={rightCollapsed ? "Expand audit details" : "Collapse audit details"}>{rightCollapsed ? <><PanelRightOpen size={17} />{selectedRunStatus && <span className={`collapsed-audit-dot ${selectedRunStatus}`} />}</> : <PanelRightClose size={17} />}</button><button className="icon-button mobile-only" data-drawer-close onClick={() => setRightOpen(false)} aria-label="Close task panel"><X size={18} /></button></div>
      {!runs.length ? <div className="panel-empty"><Play size={20} /><p>No TaskRuns</p></div> : <div className="run-history">{runs.map((item, index) => {
        const expanded = item.id === expandedRunId;
        return <section className={`run-history-item ${expanded ? "expanded" : ""}`} key={item.id}>
          <button className="run-history-toggle" onClick={async () => {
            if (expanded) { setExpandedRunId(""); return; }
            const selected = await api.run(item.id); const view = await drainTranscriptView(item.id, selected.transcriptCount); openRunView(selected, view.items, view.after);
          }} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span className={`history-status ${item.status}`} />
            <span className="history-copy"><strong>{item.goal}</strong><small>{item.status} · attempt {item.attempt}</small></span>
            {index === 0 && item.status === "running" ? <time>current</time> : <TimeAgo value={item.updatedAt ?? item.createdAt} />}
          </button>
          {expanded && selectedRun?.id === item.id && <RunDetails run={selectedRun} toolEvents={activeRun?.id === item.id ? activeTools : []} transcriptTools={transcriptTools} />}
        </section>;
      })}</div>}
    </aside>}
    {runtimeStatus?.memoryEnabled && memoryOpen && <Suspense fallback={null}><MemoryPanel runtime={runtimeStatus} onClose={() => setMemoryOpen(false)} /></Suspense>}
    {goalsOpen && sessionId && <Suspense fallback={null}><GoalsPanel workspaceId={sessionId} onClose={() => setGoalsOpen(false)} onOpenRun={(runId) => { void api.run(runId).then(async (run) => { const view = await drainTranscriptView(run.id, run.transcriptCount); openRunView(run, view.items, view.after); setGoalsOpen(false); setRightOpen(true); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} /></Suspense>}
    <button ref={mobileBackdropRef} className={`backdrop mobile-only ${leftOpen || rightOpen ? "visible" : ""}`} onClick={() => { setLeftOpen(false); setRightOpen(false); }} aria-label="Close panel" aria-hidden={leftOpen || rightOpen ? undefined : "true"} tabIndex={leftOpen || rightOpen ? 0 : -1} />
  </div>;
}
