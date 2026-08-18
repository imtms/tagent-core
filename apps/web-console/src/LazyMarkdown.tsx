import { lazy, memo, Suspense } from "react";
import { preloadMarkdown } from "./markdown-loader";

const RichMarkdown = lazy(() => preloadMarkdown().then((module) => ({ default: module.Markdown })));

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <Suspense fallback={<div className="markdown markdown-loading" aria-busy="true">{children}</div>}>
    <RichMarkdown>{children}</RichMarkdown>
  </Suspense>;
});
