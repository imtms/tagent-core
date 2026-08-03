import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../web/src/Markdown";

describe("web markdown rendering", () => {
  it("renders GFM-style tables, nested lists, strikethrough, and soft line breaks", () => {
    const html = renderMarkdown(`## Result\n\n| Name | State |\n| --- | --- |\n| API | **ready** |\n\n- parent\n  - child\n\n~~old~~\nnext line`);
    expect(html).toContain('<div class="markdown-table-wrap"><table>');
    expect(html).toContain("<strong>ready</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("child");
    expect(html).toContain("<s>old</s>");
    expect(html).toContain("next line");
  });

  it("adds highlighted fenced-code chrome and escapes language labels", () => {
    const html = renderMarkdown("```typescript\nconst answer: number = 42;\n```");
    expect(html).toContain('class="code-block"');
    expect(html).toContain("typescript");
    expect(html).toContain('class="code-copy"');
    expect(html).toContain("hljs");
    expect(html).toContain("hljs-keyword");
  });

  it("keeps raw HTML inert and rejects dangerous links while hardening external resources", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[danger](javascript:alert(3))\n\n[site](https://example.com)\n\n![alt](https://example.com/a.png)');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it("does not let CJK punctuation become part of auto-linked URLs", () => {
    const html = renderMarkdown("查看 https://example.com/path，继续阅读");
    expect(html).toContain('href="https://example.com/path"');
    expect(html).not.toContain('href="https://example.com/path%EF%BC%8C');
    expect(html).toContain("，继续阅读");
  });
});
