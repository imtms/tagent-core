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
    expect(source).toContain('event.type === "message.started"');
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
  it("paginates and isolates expensive rendering in long chats", async () => {
    const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../web/src/Markdown.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(app).toContain("loadOlderMessages");
    expect(app).toContain("<ChatMessage key={message.id}");
    expect(app).toContain("<LiveText>{streaming}</LiveText>");
    expect(app).not.toContain("api.sessions(), api.messages(targetSessionId)");
    expect(markdown).toContain("export const Markdown = memo");
    expect(styles).toContain("content-visibility: auto");
  });

  it("keeps the visible response until replacement content arrives and reconciles missed terminal events", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('if (event.type === "message.started") replaceStreamingOnNextDeltaRef.current = true');
    expect(source).toContain("if (replaceStreamingOnNextDeltaRef.current)");
    expect(source).toContain('if (event.type === "message.completed")');
    expect(source).toContain("const [history, ended, view] = await Promise.all");
    expect(source).not.toContain("earlier draft");
    expect(source).not.toContain("setProvisionalDrafts");
  });

  it("keeps tool telemetry out of the conversation and exposes auditable Supervisor gates", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
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
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [pendingUserMessage, setPendingUserMessage]");
    expect(source).toContain("setPendingUserMessage(optimistic)");
    expect(source).toContain('aria-label="Sending message"');
    expect(source).toContain("api.messages(targetSessionId)");
    expect(source).toContain("sessionIdRef.current !== targetSessionId");
    expect(source).toContain("setDraft(content)");
  });

});
