import { lazy, memo, Suspense } from "react";

type MarkdownModule = typeof import("./Markdown");

let markdownModulePromise: Promise<MarkdownModule> | undefined;

export function preloadMarkdown(): Promise<MarkdownModule> {
  markdownModulePromise ??= import("./Markdown").catch((cause) => {
    markdownModulePromise = undefined;
    throw cause;
  });
  return markdownModulePromise;
}

const RichMarkdown = lazy(() => preloadMarkdown().then((module) => ({ default: module.Markdown })));

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <Suspense fallback={<div className="markdown markdown-loading" aria-busy="true">{children}</div>}>
    <RichMarkdown>{children}</RichMarkdown>
  </Suspense>;
});
