import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, BrainCircuit, ChevronDown, ChevronRight, Keyboard, Menu, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, PanelRightClose, PanelRightOpen, Play, Plus, Search, Send, Settings2, Square, Sun, Target, X } from "lucide-react";
import { api, drainTranscriptView, type Message, type RuntimeStatus, type Session, type TaskRun, type TranscriptItem } from "./api";
import { ICON_SIZE } from "./icon-size";
import { canResumeRun, formatRunStatus } from "./run-state";
import { formatShortcut, useShortcutModifier } from "./shortcut-platform";
import { useDrawerFocus, useMobileDrawerLayout } from "./use-drawer-focus";
import { useMobileDrawerSwipe } from "./use-mobile-drawer-swipe";
import { usePopoverFocus } from "./use-popover-focus";
import { useStickyConversation } from "./use-sticky-conversation";
import { messagePageHasOlderHint, useConversationHistory } from "./use-conversation-history";
import { useMemoryAnnotations } from "./use-memory-annotations";
import { useRunViewState } from "./use-run-view-state";
import { useSessionInboxController } from "./use-session-inbox-controller";
import { useTaskRunOperations } from "./use-task-run-operations";
import { useWorkspaceComposer } from "./use-workspace-composer";
import { useWorkspaceLiveSync, type PendingUserMessage } from "./use-workspace-live-sync";
import { useWorkspacePresentation } from "./use-workspace-presentation";
import { useWorkspaceSessions } from "./use-workspace-sessions";
import { useWorkspaceSubmission } from "./use-workspace-submission";
import { deriveWorkspaceNavigation } from "./workspace-navigation";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { WorkspaceSkillsControl } from "./WorkspaceSkillsControl";
import { GateProfileControl } from "./GateProfileControl";
import { TimeAgo } from "./TimeAgo";
import { localDayKey } from "./time-format";
import { userInputRequestKey } from "./user-input-state";
import { ConversationMessage, PendingConversationMessage } from "./ConversationMessage";
import {
  ApprovalDock,
  ConversationDateDivider,
  ExecutionTimeline,
  QueuePrompt,
  RunActivityStrip,
  RunDetails,
  TAgentMark,
  UserInputCard,
  WorkspaceRunStatus,
} from "./AppPanels";
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

export function App() {
  const [conversationLoading, setConversationLoading] = useState(true);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const runView = useRunViewState();
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
    setExpandedRunId,
    setStreaming,
    startRun: startRunView,
    openRun: openRunView,
  } = runView;
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const {
    workspaces,
    setWorkspaces,
    workspacesLoading,
    workspaceId,
    selectedWorkspace,
    creatingWorkspace,
    createWorkspace,
    selectWorkspace,
    renamingWorkspaceId,
    workspaceTitleDraft,
    setWorkspaceTitleDraft,
    beginRenameWorkspace,
    cancelRenameWorkspace,
    commitRenameWorkspace,
    savingExecutionProfile,
    updateExecutionProfile,
  } = useWorkspaceSessions({
    hasActiveRun: Boolean(activeRun),
    setError,
    setNotice,
  });
  const {
    leftOpen, setLeftOpen, rightOpen, setRightOpen,
    workspaceMenuOpen, setWorkspaceMenuOpen, workspaceSwitcherOpen, setWorkspaceSwitcherOpen,
    shortcutHelpOpen, setShortcutHelpOpen, workspaceSearch, setWorkspaceSearch,
    pinnedWorkspaceIds, setPinnedWorkspaceIds, lastSeenByWorkspace, setLastSeenByWorkspace,
    workspaceActivityBaseline, viewingEarlierHistory, setViewingEarlierHistory,
    leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed,
    theme, setTheme, workspaceEmojiById, setWorkspaceEmojiById,
    workspaceContextMenuId, setWorkspaceContextMenuId, workspaceContextMenuPosition, setWorkspaceContextMenuPosition,
  } = useWorkspacePresentation(workspaces);
  const messageScrollRef = useRef<HTMLElement>(null);
  const messageFeedRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    setMessages,
    hasOlderMessages,
    setHasOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,
  } = useConversationHistory({
    workspaceId,
    viewportRef: messageScrollRef,
    onEarlierHistory: () => setViewingEarlierHistory(true),
    onError: setError,
  });
  const {
    draft,
    hasSavedDraft,
    historyCursor,
    isComposingRef: composerIsComposingRef,
    textareaRef: composerTextareaRef,
    selectedGateProfile,
    gateProfileNote,
    updateDraft: updateComposerDraft,
    navigateHistory: navigateComposerHistory,
    recordSubmission,
    selectGateProfile,
  } = useWorkspaceComposer(workspaceId);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const { loaded: memoryJobsLoaded, byMessageId: memoryJobByMessageId } = useMemoryAnnotations(runtimeStatus, workspaceId);
  const workspaceRailRef = useRef<HTMLElement>(null);
  const conversationStageRef = useRef<HTMLDivElement>(null);
  const auditPanelRef = useRef<HTMLElement>(null);
  const mobileBackdropRef = useRef<HTMLButtonElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const handleInboxRunStarted = useCallback((nextRun: TaskRun, history: Message[]) => {
    setMessages(history);
    setHasOlderMessages(messagePageHasOlderHint(history));
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
    sessionId: workspaceId,
    activeRun,
    setError,
    setNotice,
    onRunStarted: handleInboxRunStarted,
  });
  const {
    currentWorkspaceIdRef,
    prefetchWorkspace,
    prepareWorkspaceSelection,
  } = useWorkspaceLiveSync({
    workspaceId,
    runView,
    setWorkspaces,
    setMessages,
    setHasOlderMessages,
    setConversationLoading,
    setPendingUserMessage,
    setInbox,
    setError,
  });
  const shortcutModifier = useShortcutModifier();
  const workspaceShortcut = formatShortcut(shortcutModifier, "K");
  const mobileDrawerLayout = useMobileDrawerLayout();
  const leftDrawerOpen = mobileDrawerLayout && leftOpen;
  const rightDrawerOpen = mobileDrawerLayout && rightOpen;
  const conversationActivityKey = `${messages.at(-1)?.id ?? 0}:${pendingUserMessage?.workspaceId === workspaceId ? pendingUserMessage.createdAt : 0}:${transcript.at(-1)?.seq ?? 0}:${events.at(-1)?.seq ?? 0}:${streaming.length}:${liveThinking.length}`;
  const { pinnedToLatest, hasNewActivity, handleScroll: handleMessageScroll, jumpToLatest: scrollToLatest, pinToLatest } = useStickyConversation(workspaceId, conversationActivityKey, conversationStageRef, messageScrollRef, messageFeedRef);
  const {
    submittingUserInputId,
    submitRequestedInput,
    resolvingApprovalId,
    resolvingApprovalDecision,
    resolveRunApproval,
    retryingRunId,
    retryLaunch,
  } = useTaskRunOperations({
    workspaceId,
    currentWorkspaceIdRef,
    runView,
    pinToLatest,
    setError,
    setNotice,
  });
  const { submitting, submit } = useWorkspaceSubmission({
    workspaceId,
    draft,
    gateProfile: selectedGateProfile,
    recordSubmission,
    restoreDraft: updateComposerDraft,
    pinToLatest,
    setInbox,
    setMessages,
    setHasOlderMessages,
    setPendingUserMessage,
    startRun: startRunView,
    setError,
    setNotice,
  });

  useDrawerFocus(leftDrawerOpen, workspaceRailRef);
  useDrawerFocus(rightDrawerOpen, auditPanelRef);
  useEffect(() => {
    if (mobileDrawerLayout) return;
    setLeftOpen(false);
    setRightOpen(false);
  }, [mobileDrawerLayout, setLeftOpen, setRightOpen]);
  useMobileDrawerSwipe({
    open: leftDrawerOpen,
    enabled: mobileDrawerLayout && !rightDrawerOpen && !workspaceSwitcherOpen && !shortcutHelpOpen && !workspaceMenuOpen && !memoryOpen && !goalsOpen,
    drawerRef: workspaceRailRef,
    backdropRef: mobileBackdropRef,
    onOpenChange: setLeftOpen,
  });
  usePopoverFocus(workspaceMenuOpen, workspaceMenuRef, useCallback(() => setWorkspaceMenuOpen(false), []));

  function openWorkspaceContextMenu(workspace: Session, anchor: DOMRect | { top: number; bottom: number; left: number }, x?: number, y?: number) {
    const menuWidth = 208;
    const menuHeight = 198;
    const left = x === undefined ? anchor.left : x;
    const top = y === undefined ? anchor.bottom + 4 : y;
    setWorkspaceContextMenuPosition({
      top: Math.max(8, Math.min(top, globalThis.innerHeight - menuHeight - 8)),
      left: Math.max(8, Math.min(left, globalThis.innerWidth - menuWidth - 8)),
    });
    setWorkspaceContextMenuId(workspace.id);
  }

  useEffect(() => {
    setViewingEarlierHistory(false);
  }, [workspaceId]);
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuOpen(false); setSkillMenuOpen(false); setWorkspaceSwitcherOpen(false); setShortcutHelpOpen(false); setWorkspaceContextMenuId(""); setLeftOpen(false); setRightOpen(false);
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
    let closed = false;
    void api.status().then((status) => { if (!closed) setRuntimeStatus(status); }).catch((cause) => {
      if (!closed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { closed = true; };
  }, []);
  const jumpToLatest = useCallback(() => {
    scrollToLatest("smooth");
    setViewingEarlierHistory(false);
  }, [scrollToLatest]);

  const activeTools = useMemo(() => events.filter((event) => event.type.startsWith("tool.")).slice(-20), [events]);
  const transcriptTools = useMemo(() => transcript.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool"), [transcript]);
  const pendingApprovals = useMemo(() => activeRun?.supervision.approvalRequests.filter((approval) => approval.status === "pending") ?? [], [activeRun]);

  async function handleWorkspaceCreate() {
    const workspace = await createWorkspace(prepareWorkspaceSelection);
    if (!workspace) return;
    setLeftOpen(false);
    setSkillMenuOpen(false);
  }

  function handleWorkspaceSelect(nextWorkspace: Session) {
    setLastSeenByWorkspace((current) => ({ ...current, [nextWorkspace.id]: nextWorkspace.updatedAt }));
    const changed = selectWorkspace(nextWorkspace, prepareWorkspaceSelection);
    setLeftOpen(false);
    setWorkspaceContextMenuId("");
    setWorkspaceSwitcherOpen(false);
    if (changed) setSkillMenuOpen(false);
  }

  function togglePinnedWorkspace(targetWorkspaceId: string) {
    setPinnedWorkspaceIds((current) => current.includes(targetWorkspaceId)
      ? current.filter((id) => id !== targetWorkspaceId)
      : [targetWorkspaceId, ...current]);
  }

  useEffect(() => {
    if (!selectedWorkspace || lastSeenByWorkspace[selectedWorkspace.id] === selectedWorkspace.updatedAt) return;
    setLastSeenByWorkspace((current) => ({ ...current, [selectedWorkspace.id]: selectedWorkspace.updatedAt }));
  }, [selectedWorkspace?.id, selectedWorkspace?.updatedAt]);
  const selectableModels = [...new Set([runtimeStatus?.modelId ?? "gpt-5.6-sol", ...(runtimeStatus?.fallbackModelIds ?? [])])];
  const { groups: workspaceGroups, emptyState: workspaceNavigationEmptyState } = deriveWorkspaceNavigation(workspaces, pinnedWorkspaceIds, workspaceSearch);
  const selectedRunStatus = activeRun?.status ?? selectedRun?.status;
  const auditNeedsAttention = pendingApprovals.length > 0 || selectedRunStatus === "waiting_input" || selectedRunStatus === "failed" || selectedRunStatus === "blocked";
  const auditAvailable = runs.length > 0;
  const enterSubmits = !globalThis.matchMedia?.("(pointer: coarse)").matches;
  const workspaceMeta = activeRun
    ? `${activeRun.modelId || runtimeStatus?.modelId || "Default model"} · ${activeRun.reasoningEffort}`
    : selectedWorkspace
      ? `${selectedWorkspace.modelId || runtimeStatus?.modelId || "Default model"} · ${selectedWorkspace.reasoningEffort}`
      : runtimeStatus ? `${runtimeStatus.modelId} · ready` : "Ready for a new task";

  return <div className={`app-shell ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""} ${auditNeedsAttention ? "audit-needs-attention" : ""} ${auditAvailable ? "" : "audit-unavailable"}`}>
    <WorkspaceSwitcher open={workspaceSwitcherOpen} workspaces={workspaces} selectedWorkspaceId={workspaceId} pinnedWorkspaceIds={pinnedWorkspaceIds} workspaceEmojiById={workspaceEmojiById} creating={creatingWorkspace} onClose={() => setWorkspaceSwitcherOpen(false)} onSelect={handleWorkspaceSelect} onCreate={handleWorkspaceCreate} onPrefetch={prefetchWorkspace} />
    <KeyboardShortcutsDialog open={shortcutHelpOpen} modifier={shortcutModifier} enterSubmits={enterSubmits} onClose={() => setShortcutHelpOpen(false)} />
    <aside ref={workspaceRailRef} className={`workspace-rail ${leftDrawerOpen ? "mobile-open" : ""} ${leftCollapsed ? "collapsed" : ""}`} role={leftDrawerOpen ? "dialog" : undefined} aria-label="Workspaces" aria-modal={leftDrawerOpen ? "true" : undefined}>
      <div className="brand"><div className="brand-mark"><TAgentMark /></div><div className="brand-copy"><strong>TAgent</strong><span>Core runtime</span></div><button className="icon-button desktop-only rail-collapse" onClick={() => setLeftCollapsed((current) => !current)} aria-label={leftCollapsed ? "Expand workspace sidebar" : "Collapse workspace sidebar"} title={leftCollapsed ? "Expand workspace sidebar" : "Collapse workspace sidebar"}>{leftCollapsed ? <PanelLeftOpen size={ICON_SIZE.lg} /> : <PanelLeftClose size={ICON_SIZE.lg} />}</button><button className="icon-button mobile-only" data-drawer-close onClick={() => setLeftOpen(false)} aria-label="Close workspace sidebar"><X size={ICON_SIZE.lg} /></button></div>
      <button className="new-workspace" onClick={handleWorkspaceCreate} disabled={creatingWorkspace} aria-busy={creatingWorkspace} title="New workspace">{creatingWorkspace ? <Activity className="spin" size={ICON_SIZE.md} /> : <Plus size={ICON_SIZE.md} />}<span>{creatingWorkspace ? "Creating…" : "New workspace"}</span></button>
      {(workspacesLoading || workspaces.length > 0) && <label className="workspace-search"><Search size={ICON_SIZE.sm} /><input type="search" value={workspaceSearch} onChange={(event) => setWorkspaceSearch(event.target.value)} placeholder="Filter workspaces" aria-label="Filter workspaces" />{workspaceSearch ? <button type="button" onClick={() => setWorkspaceSearch("")} aria-label="Clear workspace filter"><X size={ICON_SIZE.sm} /></button> : <kbd aria-label={`${workspaceShortcut} shortcut`}>{workspaceShortcut}</kbd>}</label>}
      <div className="workspace-list" onScroll={() => { if (workspaceContextMenuId) setWorkspaceContextMenuId(""); }}>
        {workspacesLoading ? <div className="workspace-skeletons" aria-label="Loading workspaces"><i /><i /><i /></div> : workspaceGroups.map((group) => <section className="workspace-group" key={group.label}><div className="workspace-group-label"><span>{group.label}</span><small>{group.workspaces.length}</small></div>{group.workspaces.map((workspace) => {
          const pinned = pinnedWorkspaceIds.includes(workspace.id);
          const unread = workspace.id !== workspaceId && workspace.updatedAt > (lastSeenByWorkspace[workspace.id] ?? workspaceActivityBaseline[workspace.id] ?? workspace.updatedAt);
          const runStatus = workspace.latestRunStatus;
          const customWorkspaceEmoji = workspaceEmojiById[workspace.id];
          return <div key={workspace.id} className={`workspace-item ${workspace.id === workspaceId ? "active" : ""} ${unread ? "unread" : ""}`} onContextMenu={(event) => {
            if (renamingWorkspaceId === workspace.id) return;
            event.preventDefault();
            openWorkspaceContextMenu(workspace, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
          }}>
          <span className={`workspace-avatar ${customWorkspaceEmoji ? "custom" : "monogram"}`} aria-hidden="true">{(customWorkspaceEmoji ?? workspace.title.trim().slice(0, 1).toLocaleUpperCase()) || "T"}</span>
          {renamingWorkspaceId === workspace.id ? <div className="workspace-select workspace-editor">
            <span><input className="workspace-title-input" value={workspaceTitleDraft} autoFocus onChange={(event) => setWorkspaceTitleDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void commitRenameWorkspace(workspace); }
              if (event.key === "Escape") { event.preventDefault(); cancelRenameWorkspace(); event.currentTarget.blur(); }
            }} onBlur={() => void commitRenameWorkspace(workspace)} aria-label="Workspace name" /><span className="workspace-meta"><TimeAgo value={workspace.updatedAt} /><WorkspaceRunStatus workspace={workspace} /></span></span>
          </div> : <>
            <button className="workspace-select" onMouseEnter={() => prefetchWorkspace(workspace.id)} onFocus={() => prefetchWorkspace(workspace.id)} onClick={() => handleWorkspaceSelect(workspace)} title={leftCollapsed ? undefined : workspace.title} aria-label={`Open workspace ${workspace.title}${unread ? ". Unread activity" : ""}`} aria-describedby={leftCollapsed ? `workspace-tooltip-${workspace.id}` : undefined}><span><strong>{workspace.title}{unread && <i className="unread-dot" aria-label="Unread activity" />}</strong><span className="workspace-meta"><TimeAgo value={workspace.updatedAt} /><WorkspaceRunStatus workspace={workspace} /></span></span></button>
            <button className="workspace-more" type="button" onClick={(event) => {
              if (workspaceContextMenuId === workspace.id) { setWorkspaceContextMenuId(""); return; }
              const item = event.currentTarget.closest(".workspace-item")?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
              openWorkspaceContextMenu(workspace, item);
            }} aria-haspopup="menu" aria-expanded={workspaceContextMenuId === workspace.id} aria-label={`More actions for ${workspace.title}`}><MoreHorizontal size={ICON_SIZE.sm} /></button>
            <span id={`workspace-tooltip-${workspace.id}`} className="collapsed-workspace-tooltip" role="tooltip"><strong>{workspace.title}</strong>{(runStatus || unread) && <small>{runStatus && <><i className={`workspace-tooltip-status ${runStatus}`} />{formatRunStatus(runStatus)}</>}{unread && <>{runStatus ? " · " : ""}Unread</>}</small>}</span>
            {workspaceContextMenuId === workspace.id && <WorkspaceContextMenu workspace={workspace} pinned={pinned} currentEmoji={workspaceEmojiById[workspace.id] ?? ""} emojis={workspaceEmojis} position={workspaceContextMenuPosition} onClose={() => setWorkspaceContextMenuId("")} onTogglePinned={() => togglePinnedWorkspace(workspace.id)} onRename={() => beginRenameWorkspace(workspace)} onChooseEmoji={(emoji) => setWorkspaceEmojiById((current) => ({ ...current, [workspace.id]: emoji }))} />}
          </>}
        </div>})}</section>)}
        {!workspacesLoading && workspaceNavigationEmptyState && <div className={`workspace-navigation-empty ${workspaceNavigationEmptyState.kind}`}>{workspaceNavigationEmptyState.kind === "no-workspaces" ? <Plus size={ICON_SIZE.md} /> : <Search size={ICON_SIZE.md} />}<strong>{workspaceNavigationEmptyState.title}</strong><small>{workspaceNavigationEmptyState.detail}</small>{workspaceNavigationEmptyState.kind === "no-matches" && <button type="button" onClick={() => setWorkspaceSearch("")}>Clear filter</button>}</div>}
      </div>
    </aside>

    <main className="conversation">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setLeftOpen(true)} aria-label="Open workspace sidebar"><Menu size={ICON_SIZE.xl} /></button>
        <div className="workspace-heading"><span className="workspace-kicker">Workspace</span><h1><button type="button" onClick={() => setWorkspaceSwitcherOpen(true)} title={`Switch workspace (${workspaceShortcut})`}>{selectedWorkspace?.title ?? "TAgent Core"}<ChevronDown size={ICON_SIZE.sm} /></button></h1><p>{workspaceMeta}</p></div>
        <div className="top-actions">
          {auditAvailable && selectedRunStatus && <button className={`run-status-control ${selectedRunStatus}`} onClick={() => { setWorkspaceMenuOpen(false); setRightCollapsed(false); setRightOpen(true); }} aria-label={`Open audit panel. Task status: ${formatRunStatus(selectedRunStatus)}`}><span /><strong>{formatRunStatus(selectedRunStatus)}</strong></button>}
          {canResumeRun(selectedRun, activeRun) && <button className="resume-button desktop-only" onClick={async () => { setError(""); try { const resumed = await api.resume(selectedRun.id); setActiveRun(resumed); setSelectedRun(resumed); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={ICON_SIZE.md} />Resume</button>}
          {activeRun?.status === "running" && <button className="icon-button danger desktop-only" onClick={() => void api.cancel(activeRun.id)} title="Stop run" aria-label="Stop run"><Square size={ICON_SIZE.lg} /></button>}
          {workspaceId && <WorkspaceSkillsControl workspaceId={workspaceId} open={skillMenuOpen} onOpenChange={setSkillMenuOpen} onBeforeOpen={() => setWorkspaceMenuOpen(false)} onError={setError} onNotice={setNotice} />}
          <button className={`workspace-menu-toggle ${workspaceMenuOpen ? "active" : ""}`} type="button" title="Workspace settings" aria-label="More workspace actions" aria-haspopup="dialog" aria-expanded={workspaceMenuOpen} onClick={() => { setSkillMenuOpen(false); setWorkspaceMenuOpen((current) => !current); }}><Settings2 size={ICON_SIZE.md} /><span className="desktop-only">Workspace</span><ChevronDown className="desktop-only" size={ICON_SIZE.xs} /></button>
          {workspaceMenuOpen && <><button className="workspace-menu-scrim" type="button" aria-label="Close workspace actions" onClick={() => setWorkspaceMenuOpen(false)} /><div ref={workspaceMenuRef} className="workspace-actions-menu" role="dialog" aria-label="Workspace settings">
            <div className="workspace-actions-heading"><span>Workspace settings</span><small>{selectedWorkspace?.title ?? "TAgent Core"}</small></div>
            {auditAvailable && <button onClick={() => { setRightCollapsed(false); setRightOpen(true); setWorkspaceMenuOpen(false); }}><PanelRight size={ICON_SIZE.md} /><span>Supervisor & execution</span>{selectedRunStatus && <small>{formatRunStatus(selectedRunStatus)}</small>}</button>}
            {selectedWorkspace && <div className="workspace-profile-settings"><label><span>Model</span><select value={selectedWorkspace.modelId || runtimeStatus?.modelId || "gpt-5.6-sol"} disabled={savingExecutionProfile} onChange={(event) => void updateExecutionProfile({ modelId: event.target.value })}>{selectableModels.map((modelId) => <option value={modelId} key={modelId}>{modelId}</option>)}</select></label><label><span>Reasoning</span><select value={selectedWorkspace.reasoningEffort} disabled={savingExecutionProfile} onChange={(event) => void updateExecutionProfile({ reasoningEffort: event.target.value as Session["reasoningEffort"] })}>{reasoningEfforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}</select></label></div>}
            {canResumeRun(selectedRun, activeRun) && <button onClick={async () => { setWorkspaceMenuOpen(false); setError(""); try { const resumed = await api.resume(selectedRun.id); setActiveRun(resumed); setSelectedRun(resumed); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={ICON_SIZE.md} /><span>Resume TaskRun</span></button>}
            {selectedRun?.status === "failed" && selectedRun.launchRetryable && !activeRun && <button onClick={() => { setWorkspaceMenuOpen(false); void retryLaunch(selectedRun); }} disabled={Boolean(retryingRunId)}><Play size={ICON_SIZE.md} /><span>{retryingRunId === selectedRun.id ? "Retrying launch…" : "Retry launch"}</span></button>}
            {activeRun?.status === "running" && <button className="workspace-stop-run" onClick={() => { setWorkspaceMenuOpen(false); void api.cancel(activeRun.id); }}><Square size={ICON_SIZE.md} /><span>Stop TaskRun</span></button>}
            <div className="workspace-actions-separator" />
            <button onClick={() => { setShortcutHelpOpen(true); setWorkspaceMenuOpen(false); }}><Keyboard size={ICON_SIZE.md} /><span>Keyboard shortcuts</span><small>?</small></button>
            <button onClick={() => { setTheme((current) => current === "dark" ? "light" : "dark"); setWorkspaceMenuOpen(false); }}>{theme === "dark" ? <Sun size={ICON_SIZE.md} /> : <Moon size={ICON_SIZE.md} />}<span>{theme === "dark" ? "Light theme" : "Dark theme"}</span></button>
            {workspaceId && <button onClick={() => { setGoalsOpen(true); setWorkspaceMenuOpen(false); }}><Target size={ICON_SIZE.md} /><span>Workspace Goals</span></button>}
            {runtimeStatus?.memoryEnabled && <button aria-label="Open memory center" onClick={() => { setMemoryOpen(true); setWorkspaceMenuOpen(false); }}><BrainCircuit size={ICON_SIZE.md} /><span>Memory center</span></button>}
          </div></>}
        </div>
      </header>
      <div className="conversation-stage" ref={conversationStageRef}>
        <section className="message-scroll" ref={messageScrollRef} onScroll={handleMessageScroll}>
          <div className="message-feed" ref={messageFeedRef}>
        {conversationLoading && !messages.length ? <div className="conversation-skeleton" aria-label="Loading conversation"><span /><span /><span /></div> : !messages.length && !streaming && pendingUserMessage?.workspaceId !== workspaceId && <div className="empty-state"><div className="empty-icon"><TAgentMark size={ICON_SIZE.hero} /></div><h2>What should we accomplish?</h2><p>Describe the outcome. TAgent will preserve context and verify the work.</p><div className="starter-prompts" aria-label="Starter prompts">{starterPrompts.map((starter) => <button type="button" key={starter.label} onClick={() => { updateComposerDraft(starter.prompt); requestAnimationFrame(() => composerTextareaRef.current?.focus()); }}><span><strong>{starter.label}</strong><small>{starter.detail}</small></span><ChevronRight size={ICON_SIZE.sm} /></button>)}</div></div>}
        {hasOlderMessages && <button className="load-older" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages}>{loadingOlderMessages ? "Loading…" : "Load earlier messages"}</button>}
        {viewingEarlierHistory && <div className="history-context"><span>Viewing earlier history</span><button type="button" onClick={jumpToLatest}>Return to latest</button></div>}
        {messages.map((message, index) => <Fragment key={message.id}>{(index === 0 || localDayKey(messages[index - 1].createdAt) !== localDayKey(message.createdAt)) && <ConversationDateDivider value={message.createdAt} />}<ConversationMessage message={message} memoryJob={message.role === "user" && runtimeStatus?.memoryEnabled ? (memoryJobsLoaded ? memoryJobByMessageId.get(message.id) ?? null : undefined) : undefined} /></Fragment>)}
        {pendingUserMessage?.workspaceId === workspaceId && !messages.some((message) => message.role === "user" && message.content === pendingUserMessage.content && message.createdAt >= pendingUserMessage.createdAt - 5_000) && <>{(!messages.length || localDayKey(messages[messages.length - 1].createdAt) !== localDayKey(pendingUserMessage.createdAt)) && <ConversationDateDivider value={pendingUserMessage.createdAt} />}<PendingConversationMessage content={pendingUserMessage.content} /></>}
        {activeRun && <RunActivityStrip run={activeRun} />}
        {selectedRun?.pendingUserInput && <UserInputCard key={userInputRequestKey(selectedRun.pendingUserInput)} request={selectedRun.pendingUserInput} submitting={submittingUserInputId === selectedRun.pendingUserInput.id} onSubmit={(values) => submitRequestedInput(selectedRun.pendingUserInput!, values)} />}
        {(activeRun || selectedRun) && transcript.length + events.length + Number(Boolean(liveThinking || streaming)) > 0 && <ExecutionTimeline runId={(activeRun ?? selectedRun)!.id} isRunning={activeRun?.status === "running"} items={transcript} events={activeRun ? events : []} liveThinking={activeRun ? liveThinking : ""} liveOutput={activeRun ? streaming : ""} />}
          </div>
        </section>
        {!pinnedToLatest && <button className={`jump-to-latest ${hasNewActivity ? "has-new-activity" : ""}`} type="button" onClick={jumpToLatest} aria-label={hasNewActivity ? "New activity. Jump to latest" : "Jump to latest"}><ArrowDown size={ICON_SIZE.sm} /><span>{hasNewActivity ? "New activity" : "Latest"}</span>{hasNewActivity && <i aria-hidden="true" />}</button>}
      </div>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="success-banner">{notice}</div>}
        {activeRun && pendingApprovals.length > 0 && <ApprovalDock run={activeRun} approvals={pendingApprovals} resolvingId={resolvingApprovalId} resolvingDecision={resolvingApprovalDecision} onResolve={resolveRunApproval} />}
        <div className="composer-toolbar">
          <div className="composer-mode"><span><Activity size={ICON_SIZE.xs} />{activeRun ? formatRunStatus(activeRun.status) : "Ready"}</span>{activeRun && <span>Steer or queue</span>}</div>
          <GateProfileControl profile={selectedGateProfile} note={gateProfileNote} appliesToNextRun={Boolean(activeRun)} onChange={selectGateProfile} />
        </div>
        <div className="composer"><textarea ref={composerTextareaRef} value={draft} onChange={(event) => updateComposerDraft(event.target.value)} onCompositionStart={() => { composerIsComposingRef.current = true; }} onCompositionEnd={() => { composerIsComposingRef.current = false; }} onKeyDown={(event) => {
          if (event.key === "Enter" && enterSubmits && !event.shiftKey && !composerIsComposingRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && !submitting) void submit(); return; }
          const caretAtStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
          const caretAtEnd = event.currentTarget.selectionStart === draft.length && event.currentTarget.selectionEnd === draft.length;
          if (event.key === "ArrowUp" && (historyCursor !== null || caretAtStart)) { event.preventDefault(); navigateComposerHistory(-1); }
          if (event.key === "ArrowDown" && historyCursor !== null && caretAtEnd) { event.preventDefault(); navigateComposerHistory(1); }
        }} placeholder="Describe an outcome, correction, constraint, or follow-up…" rows={1} aria-label={enterSubmits ? "Message. Press Enter to send and Shift Enter for a new line." : "Message. Use the send button to submit."} /><button type="button" onClick={() => void submit()} disabled={!draft.trim() || submitting} aria-label="Add to Supervisor queue">{submitting ? <Activity className="spin" size={ICON_SIZE.lg} /> : <Send size={ICON_SIZE.lg} />}</button></div>
        {hasSavedDraft && <div className="composer-hint"><span>Draft saved</span></div>}
        {inbox.length > 0 && <section className="supervisor-inbox"><div className="inbox-heading"><span>Up next</span><small>{inbox.length} queued</small></div>{inbox.map((item, index) => <QueuePrompt key={item.id} item={item} index={index} editing={editingInboxId === item.id} draft={editingInboxId === item.id ? inboxDraft : item.content} busy={Boolean(startingInboxId || savingInboxId || reorderingInbox || mutatingInboxId)} starting={startingInboxId === item.id} dragging={draggingInboxId === item.id} canMoveUp={index > 0} canMoveDown={index < inbox.length - 1} onEdit={() => startEditingInbox(item)} onDraftChange={setInboxDraft} onSave={() => void saveInbox(item)} onCancelEdit={cancelEditingInbox} onStart={() => void runInboxNow(item)} onToggleDefer={() => void toggleDeferredInbox(item)} onMergeFirst={() => void mergeInboxIntoFirst(item)} onDelete={() => void deleteInboxItem(item)} onMoveUp={() => void moveInbox(item.id, -1)} onMoveDown={() => void moveInbox(item.id, 1)} onDragStart={(event) => { setDraggingInboxId(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }} onDragEnd={() => setDraggingInboxId("")} onDrop={(event) => { event.preventDefault(); void reorderInbox(item.id); }} />)}</section>}
      </footer>
    </main>

    {auditAvailable && <aside ref={auditPanelRef} className={`audit-panel ${rightDrawerOpen ? "mobile-open" : ""} ${rightCollapsed ? "collapsed" : ""} ${auditNeedsAttention ? "needs-attention" : ""}`} role={rightDrawerOpen ? "dialog" : undefined} aria-label="Supervisor and execution" aria-modal={rightDrawerOpen ? "true" : undefined}>
      <div className="audit-panel-heading"><div><h2>Supervisor & execution</h2></div><button className={`icon-button desktop-only audit-panel-collapse ${auditNeedsAttention ? "attention" : ""}`} onClick={() => setRightCollapsed((current) => !current)} aria-label={rightCollapsed ? "Expand audit sidebar" : "Collapse audit sidebar"} title={rightCollapsed ? "Expand audit details" : "Collapse audit details"}>{rightCollapsed ? <><PanelRightOpen size={ICON_SIZE.lg} />{selectedRunStatus && <span className={`collapsed-audit-dot ${selectedRunStatus}`} />}</> : <PanelRightClose size={ICON_SIZE.lg} />}</button><button className="icon-button mobile-only" data-drawer-close onClick={() => setRightOpen(false)} aria-label="Close audit panel"><X size={ICON_SIZE.lg} /></button></div>
      <div className="run-history">{runs.map((item, index) => {
        const expanded = item.id === expandedRunId;
        return <section className={`run-history-item ${expanded ? "expanded" : ""}`} key={item.id}>
          <button className="run-history-toggle" onClick={async () => {
            if (expanded) { setExpandedRunId(""); return; }
            const selected = await api.run(item.id); const view = await drainTranscriptView(item.id, selected.transcriptCount); openRunView(selected, view.items, view.after);
          }} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={ICON_SIZE.md} /> : <ChevronRight size={ICON_SIZE.md} />}
            <span className={`history-status ${item.status}`} />
            <span className="history-copy"><strong>{item.goal}</strong><small>{formatRunStatus(item.status)}{item.attempt > 1 ? ` · attempt ${item.attempt}` : ""}</small></span>
            {index === 0 && item.status === "running" ? <time>current</time> : <TimeAgo value={item.updatedAt ?? item.createdAt} />}
          </button>
          {expanded && selectedRun?.id === item.id && <RunDetails run={selectedRun} toolEvents={activeRun?.id === item.id ? activeTools : []} transcriptTools={transcriptTools} />}
        </section>;
      })}</div>
    </aside>}
    {runtimeStatus?.memoryEnabled && memoryOpen && <Suspense fallback={null}><MemoryPanel runtime={runtimeStatus} onClose={() => setMemoryOpen(false)} /></Suspense>}
    {goalsOpen && workspaceId && <Suspense fallback={null}><GoalsPanel workspaceId={workspaceId} onClose={() => setGoalsOpen(false)} onOpenRun={(runId) => { void api.run(runId).then(async (run) => { const view = await drainTranscriptView(run.id, run.transcriptCount); openRunView(run, view.items, view.after); setGoalsOpen(false); setRightOpen(true); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} /></Suspense>}
    <button ref={mobileBackdropRef} className={`backdrop mobile-only ${leftDrawerOpen || rightDrawerOpen ? "visible" : ""}`} onClick={() => { setLeftOpen(false); setRightOpen(false); }} aria-label="Close panel" aria-hidden={leftDrawerOpen || rightDrawerOpen ? undefined : "true"} tabIndex={leftDrawerOpen || rightDrawerOpen ? 0 : -1} />
  </div>;
}
