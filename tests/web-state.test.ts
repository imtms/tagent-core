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
    expect(app).toContain('aria-label="Open workspace tools"');
    expect(app).toContain('aria-label="Open memory center"');
    expect(app).toContain('aria-label="Open learning center"');
    expect(design).toContain(':root[data-theme="dark"]');
    expect(design).toContain('--background:');
    expect(design).toContain('--surface-raised:');
    expect(design).toContain('.mobile-tools-menu');
    expect(design).toContain('@media (prefers-reduced-motion: reduce)');
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
    expect(source).toContain("subscribe(runId, consumerId, cursor.generation");
    expect(source).toContain("setSelectedRun(selected)");
    expect(source).not.toContain("const [run, setRun]");
  });

  it("renders Markdown without raw HTML injection and exposes expandable tool calls", async () => {
    const app = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../apps/web-console/src/Markdown.tsx", import.meta.url), "utf8");
    expect(app).toContain("<Markdown>{message.content}</Markdown>");
    expect(app).toContain("<details className={`tool-call");
    expect(app).toContain("api.transcriptView");
    expect(markdown).toContain("html: false");
    expect(markdown).toContain("dangerouslySetInnerHTML");
    expect(markdown).toContain('tokens[index].attrSet("target", "_blank")');
    expect(markdown).toContain('tokens[index].attrSet("rel", "noopener noreferrer")');
  });

  it("refreshes the active Run when structured task state changes", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('event.type === "run.updated"');
    expect(source).toContain("const updated = await api.run(runId)");
  });

  it("restores active streaming and tools from the durable checkpoint", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("active?.checkpoint?.active ? active.checkpoint.assistantPartial");
    expect(source).toContain('event.type === "message.started"');
    expect(source).toContain("active.checkpoint.currentTool");
    expect(source).toContain("activeRun.checkpoint?.active ? activeRun.checkpoint.lastEventSeq");
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

  it("supports renaming workspaces from the session rail", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("api.renameSession(session.id, title)");
    expect(source).toContain('aria-label="Rename workspace"');
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
    const markdown = await readFile(new URL("../apps/web-console/src/Markdown.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../apps/web-console/src/styles.css", import.meta.url), "utf8");
    expect(app).toContain("loadOlderMessages");
    expect(app).toContain("<ChatMessage key={message.id}");
    expect(app).toContain("<LiveText>{liveOutput}</LiveText>");
    expect(app).toContain("<LiveText>{liveThinking}</LiveText>");
    expect(app).toContain("<ExecutionTimeline runId=");
    expect(app).toContain("items={transcript}");
    expect(app).not.toContain("api.sessions(), api.messages(targetSessionId)");
    expect(markdown).toContain("export const Markdown = memo");
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
    expect(source).toContain("const [pendingUserMessage, setPendingUserMessage]");
    expect(source).toContain("setPendingUserMessage(optimistic)");
    expect(source).toContain('aria-label="Sending message"');
    expect(source).toContain("api.messages(targetSessionId)");
    expect(source).toContain("sessionIdRef.current !== targetSessionId");
    expect(source).toContain("setDraft(content)");
  });

  it("debounces SSE acknowledgements and avoids full Run refreshes for routine tool events", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("scheduleAck(event.seq)");
    expect(source).toContain("setTimeout(() => { ackTimer = undefined; flushAck(); }, 500)");
    expect(source).not.toContain('event.type.startsWith("tool.") || event.type.startsWith("continuation.")');
  });

  it("keeps recoverable non-running Runs subscribed and refreshes same-Run content", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('["running", "waiting_input", "blocked", "interrupted"].includes(activeRun.status)');
    expect(source).toContain('document.addEventListener("visibilitychange", reconnect)');
    expect(source).toContain('window.addEventListener("online", reconnect)');
    expect(source).toContain('const shouldRefreshContent = currentRun.lastEventSeq !== activeRunRef.current?.lastEventSeq');
    expect(source).toContain('Promise.all([api.transcriptView(active.id), api.messages(targetSessionId)])');
    expect(source).toContain('setStreamGeneration((value) => value + 1)');
  });

});
