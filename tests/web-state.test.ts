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
    expect(markdown).not.toContain("dangerouslySetInnerHTML");
    expect(markdown).toContain("target=\"_blank\"");
    expect(markdown).toContain("rel=\"noreferrer\"");
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
});
