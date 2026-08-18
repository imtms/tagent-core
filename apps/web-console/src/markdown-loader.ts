type MarkdownModule = typeof import("./Markdown");

let markdownModulePromise: Promise<MarkdownModule> | undefined;

export function preloadMarkdown(): Promise<MarkdownModule> {
  markdownModulePromise ??= import("./Markdown").catch((cause) => {
    markdownModulePromise = undefined;
    throw cause;
  });
  return markdownModulePromise;
}
