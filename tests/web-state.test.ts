import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Web workbench state model", () => {
  it("uses a semantic, themeable and responsive console design system", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const entry = await readFile(new URL("../apps/web-console/src/main.tsx", import.meta.url), "utf8");
    const design = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    expect(entry).toContain('import "./design-system.css"');
    expect(app).toContain('type Theme = "light" | "dark"');
    expect(app).toContain('document.documentElement.dataset.theme = theme');
    expect(app).toContain('globalThis.localStorage?.setItem("tagent.theme", theme)');
    expect(app).toContain('aria-label="More workspace actions"');
    expect(app).toContain('aria-label="Open memory center"');
    expect(app).toContain('aria-label="Open learning center"');
    expect(design).toContain(':root[data-theme="dark"]');
    expect(design).toContain('--background:');
    expect(design).toContain('--surface-raised:');
    expect(design).toContain('.workspace-actions-menu');
    expect(design).toMatch(/\.session-emoji\s*\{[\s\S]*?pointer-events: none;/);
    expect(design).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it("keeps chat primary while progressively disclosing navigation and audit detail", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const contextMenu = await readFile(new URL("../apps/web-console/src/WorkspaceContextMenu.tsx", import.meta.url), "utf8");
    const switcher = await readFile(new URL("../apps/web-console/src/WorkspaceSwitcher.tsx", import.meta.url), "utf8");
    const drawerSwipe = await readFile(new URL("../apps/web-console/src/use-mobile-drawer-swipe.ts", import.meta.url), "utf8");
    const modalFocus = await readFile(new URL("../apps/web-console/src/use-modal-focus.ts", import.meta.url), "utf8");
    const shortcutHelp = await readFile(new URL("../apps/web-console/src/KeyboardShortcutsDialog.tsx", import.meta.url), "utf8");
    const design = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    expect(app).toContain('storedBoolean("tagent.right-panel-collapsed", true)');
    expect(app).toContain('className="session-search"');
    expect(app).toContain('<WorkspaceContextMenu session={session}');
    expect(app).toContain('onContextMenu={(event) =>');
    expect(app).toContain("useDrawerFocus(leftOpen, sessionRailRef)");
    expect(app).toContain("useMobileDrawerSwipe({");
    expect(app).toContain("usePopoverFocus(workspaceMenuOpen, workspaceMenuRef");
    expect(app).toContain('role={leftOpen ? "dialog" : undefined} aria-label="Workspaces"');
    expect(contextMenu).toContain('className="session-context-menu"');
    expect(contextMenu).toContain('event.key === "ArrowDown"');
    expect(app).toContain('<WorkspaceSwitcher open={workspaceSwitcherOpen}');
    expect(app).toContain('event.key.toLocaleLowerCase() === "k"');
    expect(switcher).toContain("useModalFocus(open, dialogRef, onClose, inputRef)");
    expect(modalFocus).toContain('appShell.inert = true');
    expect(modalFocus).toContain('previouslyFocused?.focus');
    expect(switcher).toContain('scrollIntoView({ block: "nearest" })');
    expect(switcher).toContain('role="option" tabIndex={-1}');
    expect(drawerSwipe).toContain('document.addEventListener("touchstart"');
    expect(drawerSwipe).toContain("drawerGestureDecision(mode, deltaX, deltaY)");
    expect(drawerSwipe).toContain('matchMedia?.("(prefers-reduced-motion: reduce)")');
    expect(app).toContain('className="collapsed-workspace-tooltip" role="tooltip"');
    expect(app).toContain("workspaceShortcut = formatShortcut(shortcutModifier, \"K\")");
    expect(app).toContain("new IntentPrefetchCache<string, WorkspaceSnapshot>(30_000, 6)");
    expect(app).toContain("onMouseEnter={() => prefetchWorkspace(session.id)}");
    expect(app).toContain("onFocus={() => prefetchWorkspace(session.id)}");
    expect(app).toContain("onPrefetch={prefetchWorkspace}");
    expect(app).toMatch(/if \(cached\) \{[\s\S]*?applyWorkspaceSnapshot\(cached\);[\s\S]*?workspacePrefetchCache\.invalidate\(targetSessionId\);/);
    expect(app).toContain('event.key === "?"');
    expect(app).toContain("setShortcutHelpOpen(false)");
    expect(app).toContain("setWorkspaceSwitcherOpen(false)");
    expect(app).toContain("<KeyboardShortcutsDialog open={shortcutHelpOpen}");
    expect(app).toContain("enterSubmits={enterSubmits}");
    expect(shortcutHelp).toContain('role="dialog" aria-modal="true"');
    expect(shortcutHelp).toContain("shortcutKeyTokens(modifier, \"K\")");
    expect(app).toContain('const auditAvailable = Boolean(activeRun || selectedRun || runs.length)');
    expect(app).toContain('className="starter-prompts"');
    expect(app).toContain("jump-to-latest");
    expect(app).toContain('className="conversation-skeleton"');
    expect(app).toContain('function TAgentMark');
    expect(design).toContain('.run-panel.needs-attention.collapsed');
    expect(design).toContain('.workspace-actions-menu');
    expect(design).toContain('.workspace-switcher-backdrop');
  });

  it("uses a directional, flat conversation rhythm with technical metadata", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const switcher = await readFile(new URL("../apps/web-console/src/WorkspaceSwitcher.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    const design = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    expect(design).toContain("--conversation-measure: 860px");
    expect(styles).toContain(".message.user { width: fit-content; max-width: min(680px, 82%); margin-right: 0; margin-left: auto; }");
    expect(styles).toContain(".message.assistant .message-body { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }");
    expect(design).toContain("font: 500 10px/1.2 var(--font-mono)");
    expect(design).toContain(".message.assistant .markdown > :not(.code-block):not(.markdown-table-wrap)");
    expect(app).toContain('className="workspace-run-status idle"><span className="workspace-status-dot" />No tasks');
    expect(switcher).toContain('className="workspace-switcher-dot"');
  });

  it("adds quiet time orientation to long conversations and workspace recency", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const message = await readFile(new URL("../apps/web-console/src/ConversationMessage.tsx", import.meta.url), "utf8");
    const switcher = await readFile(new URL("../apps/web-console/src/WorkspaceSwitcher.tsx", import.meta.url), "utf8");
    const timeAgo = await readFile(new URL("../apps/web-console/src/TimeAgo.tsx", import.meta.url), "utf8");
    const design = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    expect(app).toContain("function ConversationDateDivider");
    expect(app).toContain("localDayKey(messages[index - 1].createdAt)");
    expect(message).toContain('<MessageFooter createdAt={message.createdAt} content={message.content} />');
    expect(app).toContain("<TimeAgo value={session.updatedAt}");
    expect(switcher).toContain("<TimeAgo value={session.updatedAt}");
    expect(timeAgo).toContain("dateTime={new Date(value).toISOString()}");
    expect(timeAgo).toContain("title={formatExactDateTime(value)}");
    expect(timeAgo).toContain("subscribers = new Set");
    expect(design).toContain(".conversation-date-divider");
  });

  it("follows the live edge without stealing the reader's history position", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const sticky = await readFile(new URL("../apps/web-console/src/use-sticky-conversation.ts", import.meta.url), "utf8");
    const scroll = await readFile(new URL("../apps/web-console/src/conversation-scroll.ts", import.meta.url), "utf8");
    const design = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    expect(app).toContain("useStickyConversation(sessionId, conversationActivityKey, conversationStageRef)");
    expect(app).toContain('ref={messageFeedRef}');
    expect(app).toContain('"New activity. Jump to latest"');
    expect(sticky).toContain("new ResizeObserver");
    expect(sticky).toContain("observer.observe(content)");
    expect(sticky).toContain("observer.observe(viewport)");
    expect(sticky).toContain("if (stage) observer.observe(stage)");
    expect(sticky).toContain("nextConversationPinState");
    expect(sticky).toContain("previousActivityRef.current === activityKey");
    expect(sticky).toContain("activityReadyRef.current && !pinnedRef.current");
    expect(sticky).toContain("contentChanged && activityReadyRef.current");
    expect(scroll).toContain("sample.nextTop < sample.previousTop - 2");
    expect(design).toContain(".conversation-stage");
    expect(design).toMatch(/\.jump-to-latest\s*\{[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\);/);
  });

  it("keeps conversation metadata quiet until it is useful", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const message = await readFile(new URL("../apps/web-console/src/ConversationMessage.tsx", import.meta.url), "utf8");
    const legacy = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    const design = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    expect(app).toContain("<ConversationMessage message={message}");
    expect(message).toContain('aria-label={`Message from ${speaker}`}');
    expect(message).toContain('<MessageFooter createdAt={message.createdAt} content={message.content} />');
    expect(message).toContain('failed ? "Copy unavailable" : "Copy message"');
    expect(message).toContain('failed ? "Unavailable" : "Copy"');
    expect(message).toContain('<BrainCircuit size={11} /><span>{detail}</span>');
    expect(message).toContain('document.execCommand("copy")');
    expect(message).not.toContain('className="message-meta"');
    expect(legacy).toContain(".message:hover .message-copy");
    expect(legacy).toContain("@media (hover: none), (pointer: coarse) { .message-copy { opacity: .72; } }");
    expect(design).toContain(".message-footer");
    expect(design).toContain(".turn-memory { color: var(--foreground-muted); }");
    expect(design).toMatch(/@media \(max-width: 680px\)[\s\S]*?\.message-copy\s*\{[\s\S]*?opacity: \.58;/);
  });

  it("persists per-workspace drafts and provides IME-safe keyboard composition", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain('storedStringRecord("tagent.composer-drafts")');
    expect(app).toContain('storedStringLists("tagent.composer-history")');
    expect(app).toContain('onCompositionStart={() => { composerIsComposingRef.current = true; }}');
    expect(app).toContain('!event.nativeEvent.isComposing');
    expect(app).toContain('event.key === "ArrowUp"');
    expect(app).toContain('event.key === "/"');
  });

  it("renders the persisted user-input form and submits it to resume", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const api = await readFile(new URL("../apps/web-console/src/api.ts", import.meta.url), "utf8");
    expect(app).toContain("Information needed to continue");
    expect(app).toContain("selectedRun?.pendingUserInput");
    expect(app).toContain("api.submitUserInput");
    expect(app).toContain("Submit and resume");
    expect(api).toContain("/api/v1/console/user-input-requests/${requestId}/submit");
  });

  it("puts pending approvals directly above the chat composer instead of in the audit sidebar", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/design-system.css", import.meta.url), "utf8");
    const footerStart = app.indexOf('<footer className="composer-wrap">');
    const footer = app.slice(footerStart, app.indexOf("</footer>", footerStart));
    const runDetails = app.slice(app.indexOf("function RunDetails"), app.indexOf("type RunApproval"));
    expect(app).toContain("function ApprovalDock");
    expect(app).toContain('activeRun?.supervision.approvalRequests.filter((approval) => approval.status === "pending")');
    expect(footer).toMatch(/<ApprovalDock[\s\S]*<div className="composer">/);
    expect(footer).toContain("resolvingId={resolvingApprovalId}");
    expect(footer).toContain("resolvingDecision={resolvingApprovalDecision}");
    expect(app).toContain("await api.approveRunApproval(approval.id)");
    expect(app).toContain("await api.rejectRunApproval(approval.id)");
    expect(app).toContain('resolvingDecision === "rejected" ? "Rejecting…"');
    expect(app).toContain("sourceRun && sourceRun.id !== updated.id");
    expect(app).toContain("await api.run(sourceRun.id)");
    expect(app).toContain("sessionIdRef.current !== targetSessionId");
    expect(app).toContain('decision === "approved" && sourceRun?.id === updated.id');
    expect(app).toContain('return "Approve & execute"');
    expect(app).toContain('return "Approve & start"');
    expect(runDetails).not.toContain("approvalRequests");
    expect(styles).toContain(".approval-card");
    expect(styles).toContain("var(--warning-soft)");
  });

  it("offers a persistent three-level Gate selector before TaskRun creation", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const api = await readFile(new URL("../apps/web-console/src/api.ts", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    const footerStart = app.indexOf('<footer className="composer-wrap">');
    const footer = app.slice(footerStart, app.indexOf("</footer>", footerStart));
    expect(app).toContain('storedStringRecord("tagent.gate-profiles")');
    expect(app).toContain('role="radiogroup" aria-label="Gate acceptance style"');
    expect(app).toContain('{ value: "off", label: "Off", description: "Direct delivery" }');
    expect(app).toContain('{ value: "relaxed", label: "Relaxed", description: "Open research" }');
    expect(app).toContain('{ value: "strict", label: "Strict", description: "Code & closed work" }');
    expect(footer).toMatch(/gate-profile-control[\s\S]*className="composer"/);
    expect(app).toContain('api.send(targetSessionId, content, gateProfile)');
    expect(api).toContain('gateProfile: GateProfile');
    expect(styles).toContain(".gate-profile-options");
  });

  it("opens text and Markdown artifacts in the Web UI without removing downloads", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const api = await readFile(new URL("../apps/web-console/src/api.ts", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    expect(app).toContain("function ArtifactsPanel");
    expect(app).toContain("api.artifactContent(run.id, artifact.id)");
    expect(app).toContain('role="dialog" aria-modal="true"');
    expect(app).toContain('preview.format === "markdown" ? <Markdown>{preview.content}</Markdown> : <pre className="artifact-text-preview">{preview.content}</pre>');
    expect(app).toContain("api.downloadArtifact(run.id, artifact.id, artifact.title)");
    expect(app).toContain("<Download size={14} />");
    expect(api).toContain("/artifacts/${encodeURIComponent(artifactId)}/content");
    expect(api).toContain("/artifacts/${encodeURIComponent(artifactId)}/download");
    expect(styles).toContain(".artifact-preview");
  });

  it("keeps active execution separate from selected Run history", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [activeRun, setActiveRun]");
    expect(source).toContain("const [selectedRun, setSelectedRun]");
    expect(source).toContain("subscribe(runId, consumerId, cursor.generation, cursor.ackedSeq");
    expect(source).toContain("if (event.seq <= checkpointAfter) { scheduleAck(event.seq); return; }");
    expect(source).toContain("setSelectedRun(selected)");
    expect(source).not.toContain("const [run, setRun]");
  });

  it("renders Markdown without raw HTML injection and exposes expandable tool calls", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const message = await readFile(new URL("../apps/web-console/src/ConversationMessage.tsx", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../apps/web-console/src/Markdown.tsx", import.meta.url), "utf8");
    const lazyMarkdown = await readFile(new URL("../apps/web-console/src/LazyMarkdown.tsx", import.meta.url), "utf8");
    expect(message).toContain("<Markdown>{message.content}</Markdown>");
    expect(app).toContain("<details className={`tool-call");
    expect(app).toContain("api.transcriptView");
    expect(markdown).toContain("html: false");
    expect(markdown).toContain("dangerouslySetInnerHTML");
    expect(markdown).toContain('tokens[index].attrSet("target", "_blank")');
    expect(markdown).toContain('tokens[index].attrSet("rel", "noopener noreferrer")');
    expect(lazyMarkdown).toContain('import("./Markdown")');
    expect(lazyMarkdown).toContain('fallback={<div className="markdown markdown-loading" aria-busy="true">');
  });

  it("refreshes the active Run when structured task state changes", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('event.type === "run.updated"');
    expect(source).toContain("const updated = await api.run(runId)");
  });

  it("restores active streaming and tools from the durable checkpoint", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("snapshot.active?.checkpoint?.active ? snapshot.active.checkpoint.assistantPartial");
    expect(source).toContain("snapshot.active.checkpoint.currentTool");
    expect(source).toContain('event.type === "message.started"');
    expect(source).toContain("active.checkpoint.currentTool");
    expect(source).toContain("activeRun.checkpoint?.active ? activeRun.checkpoint.lastEventSeq");
    expect(source).toContain('if (nextSession.id === sessionIdRef.current)');
    expect(source).not.toContain("activeRun?.lastEventSeq, sessionId");
  });
  it("renders persisted current operation state", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('deriveCurrentOperation(run, now)');
    expect(source).toContain('Current operation');
    expect(source).toContain('operation.toolName || "agent"');
    expect(source).not.toContain('operation.progressSummary');
    expect(source).not.toContain('operation.summary');
  });

  it("renders prerequisite-deferred contract review without calling it a failure", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('gate.failures.length ? "failed" : "deferred"');
    expect(source).toContain('gate.failures.length ? `${gate.failures.length} failure(s)` : "deferred"');
  });

  it("supports renaming workspaces from the session rail", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const contextMenu = await readFile(new URL("../apps/web-console/src/WorkspaceContextMenu.tsx", import.meta.url), "utf8");
    expect(source).toContain("api.renameSession(session.id, title)");
    expect(contextMenu).toContain("onRename(); onClose();");
    expect(contextMenu).toContain("<span>Rename workspace</span>");
    expect(source).toContain('className="session-title-input"');
  });

  it("cancels rename on Escape and submits Enter only once", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("cancelRenameRef.current = true");
    expect(source).toContain('if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }');
    expect(source).toContain("if (renameSubmittingRef.current) return;");
    expect(source).toContain('if (event.key === "Enter") { event.preventDefault(); void renameSession(session); }');
    expect(source).toContain('if (event.key === "Escape") { event.preventDefault(); cancelRename(); event.currentTarget.blur(); }');
  });
  it("paginates and isolates expensive rendering in long chats", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const message = await readFile(new URL("../apps/web-console/src/ConversationMessage.tsx", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../apps/web-console/src/Markdown.tsx", import.meta.url), "utf8");
    const liveText = await readFile(new URL("../apps/web-console/src/LiveText.tsx", import.meta.url), "utf8");
    const lazyMarkdown = await readFile(new URL("../apps/web-console/src/LazyMarkdown.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    expect(app).toContain("loadOlderMessages");
    expect(app).toContain("<Fragment key={message.id}");
    expect(app).toContain("<ConversationMessage message={message}");
    expect(app).toContain("<LiveText>{liveOutput}</LiveText>");
    expect(app).toContain("<LiveText>{liveThinking}</LiveText>");
    expect(app).toContain("<ExecutionTimeline runId=");
    expect(app).toContain("items={transcript}");
    expect(app).not.toContain("api.sessions(), api.messages(targetSessionId)");
    expect(markdown).toContain("export const Markdown = memo");
    expect(liveText).toContain("export const LiveText = memo");
    expect(liveText).not.toContain("markdown-it");
    expect(lazyMarkdown).toContain('const RichMarkdown = lazy(() => preloadMarkdown()');
    expect(app).toContain("if (history.some((message) => message.content.trim())) void preloadMarkdown().catch(() => undefined)");
    expect(app).toContain("if (transcriptHasRichText) void preloadMarkdown().catch(() => undefined)");
    expect(app).toMatch(/async function submit\(\)[\s\S]*?void preloadMarkdown\(\)\.catch\(\(\) => undefined\);/);
    expect(message).toContain("<LiveText>{content}</LiveText>");
    expect(styles).toContain("content-visibility: auto");
  });

  it("keeps the visible response until replacement content arrives and reconciles missed terminal events", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('if (event.type === "message.started") { replaceStreamingOnNextDeltaRef.current = true; setLiveThinking(""); }');
    expect(source).toContain('if (event.type === "message.thinking.delta")');
    expect(source).toContain('if (event.type === "transcript.updated")');
    expect(source).toContain("if (replaceStreamingOnNextDeltaRef.current)");
    expect(source).toContain('if (event.type === "message.completed")');
    expect(source).toContain("const [history, ended, view] = await Promise.all");
    expect(source).not.toContain("earlier draft");
    expect(source).not.toContain("setProvisionalDrafts");
  });

  it("keeps the execution trace live while running and collapses it when the final result settles", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    expect(source).toContain("const [expanded, setExpanded] = useState(isRunning)");
    expect(source).toContain("useEffect(() => { setExpanded(isRunning); }, [runId, isRunning])");
    expect(source).toContain("if (!isRunning || !expanded) return;");
    expect(source).toContain("body.scrollTop = body.scrollHeight");
    expect(source).toContain('aria-expanded={expanded}');
    expect(source).toContain('isRunning={activeRun?.status === "running"}');
    expect(styles).toContain(".execution-timeline-body { max-height:");
    expect(styles).toContain("overflow-y: auto");
  });

  it("keeps tool telemetry out of the conversation and exposes auditable Supervisor gates", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("<ToolHistory items={transcriptTools}");
    expect(source).not.toContain("<LiveToolActivity events={activeTools}");
    expect(source).toContain("<ToolActivityPanel transcriptItems={transcriptTools} events={toolEvents}");
    expect(source).toContain("Gate audit");
    expect(source).toContain("Each acceptance criterion must be covered");
    expect(source).toContain("Completion claims require a check, receipt, or artifact");
    expect(source).toContain("criterionCoverage");
    expect(source).toContain("Supervisor & execution");
  });

  it("shows submitted messages optimistically and continuously reconciles persisted chat state", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const message = await readFile(new URL("../apps/web-console/src/ConversationMessage.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [pendingUserMessage, setPendingUserMessage]");
    expect(source).toContain("setPendingUserMessage(optimistic)");
    expect(source).toContain("<PendingConversationMessage content={pendingUserMessage.content}");
    expect(message).toContain('aria-label="Sending message"');
    expect(source).toContain("api.messages(targetSessionId)");
    expect(source).toContain("sessionIdRef.current !== targetSessionId");
    expect(source).toContain("updateComposerDraft(content)");
    expect(source).toContain('globalThis.localStorage?.setItem("tagent.composer-drafts"');
  });

  it("debounces SSE acknowledgements and avoids full Run refreshes for routine tool events", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("scheduleAck(event.seq)");
    expect(source).toContain("setTimeout(() => { ackTimer = undefined; flushAck(); }, 500)");
    expect(source).not.toContain('event.type.startsWith("tool.") || event.type.startsWith("continuation.")');
  });

  it("merges serialized transcript deltas instead of reloading the full transcript for each event", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("const refresh = transcriptRefreshTaskRef.current.catch(() => undefined).then(async () => {");
    expect(source).toContain("const after = transcriptAfterRef.current;");
    expect(source).toContain("if (transcriptRunIdRef.current !== runId) return;");
    expect(source).toContain("const delta = await api.transcriptView(runId, after);");
    expect(source).toContain("setTranscript((current) => mergeTranscriptItems(current, delta));");
    expect(source).toContain("await refreshTranscriptThrough(Number(event.data.transcriptSeq));");
    expect(source).not.toContain("if (event.type === \"transcript.updated\") setTranscript(await api.transcriptView(runId))");
  });

  it("keeps active recoverable Runs subscribed while projecting interrupted Runs to Resume", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const runState = await readFile(new URL("../apps/web-console/src/run-state.ts", import.meta.url), "utf8");
    expect(source).toContain('isActiveRunStatus(activeRun.status)');
    expect(source).toContain('findActiveRun(runHistory)');
    expect(source).toContain('canResumeRun(selectedRun, activeRun)');
    expect(runState).toContain('["running", "waiting_input", "blocked"]');
    expect(runState).not.toContain('"interrupted"]');
    expect(source).toContain('document.addEventListener("visibilitychange", reconnect)');
    expect(source).toContain('window.addEventListener("online", reconnect)');
    expect(source).toContain('const shouldRefreshContent = currentRun.lastEventSeq !== activeRunRef.current?.lastEventSeq');
    expect(source).toContain('refreshSelectedTranscript ? api.transcriptView(active.id) : Promise.resolve(undefined)');
    expect(source).toContain('setStreamGeneration((value) => value + 1)');
  });

});
