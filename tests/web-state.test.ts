import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Web workbench state model", () => {
  it("keeps active execution separate from selected Run history", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [activeRun, setActiveRun]");
    expect(source).toContain("const [selectedRun, setSelectedRun]");
    expect(source).toContain("subscribe(runId, consumerId, cursor.generation");
    expect(source).toContain("setSelectedRun(selected)");
    expect(source).not.toContain("const [run, setRun]");
  });

  it("renders Markdown without raw HTML injection and exposes expandable tool calls", async () => {
    const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../web/src/Markdown.tsx", import.meta.url), "utf8");
    expect(app).toContain("<Markdown>{message.content}</Markdown>");
    expect(app).toContain("<details className={`tool-call");
    expect(app).toContain("api.transcriptView");
    expect(markdown).toContain("html: false");
    expect(markdown).toContain("dangerouslySetInnerHTML");
    expect(markdown).toContain('tokens[index].attrSet("target", "_blank")');
    expect(markdown).toContain('tokens[index].attrSet("rel", "noopener noreferrer")');
  });

  it("refreshes the active Run when structured task state changes", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('event.type === "run.updated"');
    expect(source).toContain("const updated = await api.run(runId)");
  });

  it("restores active streaming and tools from the durable checkpoint", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("active?.checkpoint?.active ? active.checkpoint.assistantPartial");
    expect(source).toContain("active.checkpoint.currentTool");
    expect(source).toContain("activeRun.checkpoint?.active ? activeRun.checkpoint.lastEventSeq");
    expect(source).not.toContain("activeRun?.lastEventSeq, sessionId");
  });
  it("renders persisted current operation state", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('deriveCurrentOperation(run, now)');
    expect(source).toContain('Current operation');
    expect(source).toContain('operation.toolName || "agent"');
    expect(source).not.toContain('operation.progressSummary');
    expect(source).not.toContain('operation.summary');
  });

  it("supports renaming workspaces from the session rail", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("api.renameSession(session.id, title)");
    expect(source).toContain('aria-label="Rename workspace"');
    expect(source).toContain('className="session-title-input"');
  });

  it("cancels rename on Escape and submits Enter only once", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("cancelRenameRef.current = true");
    expect(source).toContain('if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }');
    expect(source).toContain("if (renameSubmittingRef.current) return;");
    expect(source).toContain('if (event.key === "Enter") { event.preventDefault(); void renameSession(session); }');
    expect(source).toContain('if (event.key === "Escape") { event.preventDefault(); cancelRename(); event.currentTarget.blur(); }');
  });
  it("shows submitted messages optimistically and continuously reconciles persisted chat state", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [pendingUserMessage, setPendingUserMessage]");
    expect(source).toContain("setPendingUserMessage(optimistic)");
    expect(source).toContain('aria-label="Sending message"');
    expect(source).toContain("api.messagePage(targetSessionId, undefined, MESSAGE_PAGE_SIZE)");
    expect(source).toContain("sessionIdRef.current !== targetSessionId");
    expect(source).toContain("setDraft(content)");
  });


  it("loads conversation history in cursor pages without replacing the current scroll model", async () => {
    const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    const api = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
    const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(api).toContain("export interface MessagePage");
    expect(api).toContain("paged=1&limit=");
    expect(app).toContain("const MESSAGE_PAGE_SIZE = 40");
    expect(app).toContain("api.messagePage(sessionId, oldestId, MESSAGE_PAGE_SIZE)");
    expect(app).toContain("currentViewport.scrollTop = previousTop + currentViewport.scrollHeight - previousHeight");
    expect(app).toContain("if (viewport.scrollTop < 160) void loadOlderMessages()");
    expect(app).toContain("prependingHistoryRef.current || (!autoScrollRef.current && !forceScrollRef.current)");
    expect(app).toContain("autoScrollRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96");
    expect(app).toContain("forceScrollRef.current = true");
    expect(app).toContain('<div className="message-feed">');
    expect(styles).toContain("overscroll-behavior: contain");
    expect(styles).toContain("scrollbar-gutter: stable");
  });

  it("fences concurrent and stale history page requests and permits retry after failure", async () => {
    const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("olderRequestRef.current) return");
    expect(app).toContain("historyGenerationRef.current += 1; olderRequestRef.current = null");
    expect(app).toContain("historyGenerationRef.current !== generation");
    expect(app).toContain("if (olderRequestRef.current === request) olderRequestRef.current = null");
    expect(app).toContain("setMessages((current) => mergeMessages(current, page.items))");
    expect(app).toContain("setLoadingOlderMessages(false)");
  });

});
