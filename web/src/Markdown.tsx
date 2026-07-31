import { useCallback, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c++", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const greedyLinkCut = /[*\u3000-\u303f\uff00-\uffef]/;
const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const defaultRenderRule: RenderRule = (tokens, index, options, _env, self) => self.renderToken(tokens, index, options);

function createMarkdownRenderer() {
  const renderer: MarkdownIt = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
    highlight(code: string, language: string): string {
      if (language && hljs.getLanguage(language)) {
        try {
          return hljs.highlight(code, { language }).value;
        } catch {
          // Fall through to auto detection.
        }
      }
      try {
        return hljs.highlightAuto(code).value;
      } catch {
        return escapeHtml(code);
      }
    },
  });

  // Linkify can consume emphasis markers or CJK punctuation immediately after
  // a URL. Split that suffix back into plain text, matching TAgent's behavior.
  renderer.core.ruler.after("linkify", "fix_greedy_linkify", (state: StateCore) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const children = block.children;
      for (let index = 0; index < children.length; index += 1) {
        const open = children[index];
        const text = children[index + 1];
        const close = children[index + 2];
        if (open.type !== "link_open" || open.markup !== "linkify" || text?.type !== "text" || close?.type !== "link_close") continue;
        const cutAt = text.content.search(greedyLinkCut);
        if (cutAt < 0) continue;
        const suffix = text.content.slice(cutAt);
        text.content = text.content.slice(0, cutAt);
        open.attrSet("href", text.content);
        const suffixToken = new state.Token("text", "", 0);
        suffixToken.content = suffix;
        children.splice(index + 3, 0, suffixToken);
      }
    }
  });

  const defaultLinkOpen = renderer.renderer.rules.link_open ?? defaultRenderRule;
  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const href = tokens[index].attrGet("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };

  const defaultImage = renderer.renderer.rules.image ?? defaultRenderRule;
  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    tokens[index].attrSet("loading", "lazy");
    tokens[index].attrSet("decoding", "async");
    tokens[index].attrSet("referrerpolicy", "no-referrer");
    return defaultImage(tokens, index, options, env, self);
  };

  const defaultFence = renderer.renderer.rules.fence ?? defaultRenderRule;
  renderer.renderer.rules.fence = (tokens, index, options, env, self) => {
    const language = tokens[index].info.trim().split(/\s+/)[0] || "text";
    let rendered = defaultFence(tokens, index, options, env, self);
    rendered = rendered.includes('<code class="')
      ? rendered.replace('<code class="', '<code class="hljs ')
      : rendered.replace("<code>", '<code class="hljs">');
    return `<div class="code-block"><div class="code-block-header"><span>${renderer.utils.escapeHtml(language)}</span><button type="button" class="code-copy" aria-label="Copy code">Copy</button></div>${rendered}</div>`;
  };

  renderer.renderer.rules.table_open = () => '<div class="markdown-table-wrap"><table>\n';
  renderer.renderer.rules.table_close = () => "</table></div>\n";

  return renderer;
}

const markdownRenderer = createMarkdownRenderer();

export function renderMarkdown(content: string) {
  return markdownRenderer.render(content || "");
}

export function Markdown({ children }: { children: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(children), [children]);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard?.writeText(code).then(() => {
      button.textContent = "Copied";
      button.classList.add("copied");
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = "Copy";
        button.classList.remove("copied");
      }, 1400);
    }).catch(() => {
      button.textContent = "Copy failed";
      window.setTimeout(() => { if (button.isConnected) button.textContent = "Copy"; }, 1400);
    });
  }, []);

  return <div ref={rootRef} className="markdown" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
