import { memo, useCallback, useMemo, useRef } from "react";
import { renderMarkdown } from "./markdown-renderer";

export const Markdown = memo(function Markdown({ children }: { children: string }) {
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
});
