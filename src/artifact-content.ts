import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".txt", ".log", ".csv", ".tsv",
  ".json", ".jsonl", ".yaml", ".yml", ".xml", ".html", ".htm", ".css",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go",
  ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
  ".bash", ".zsh", ".fish", ".sql", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".diff", ".patch", ".rst",
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const TEXT_KINDS = new Set([
  "text", "markdown", "md", "report", "analysis", "document", "documentation",
  "note", "memory-note", "deployment-report", "sql", "code", "source", "config",
  "configuration", "json", "yaml", "csv", "log",
]);
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function artifactExtension(title: string, uri: string) {
  const uriPath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  return path.extname(uriPath || title).toLowerCase() || path.extname(title).toLowerCase();
}

export function isMarkdownArtifact(kind: string, title: string, uri: string) {
  return kind.toLowerCase() === "markdown" || kind.toLowerCase() === "md" || MARKDOWN_EXTENSIONS.has(artifactExtension(title, uri));
}

export function isTextArtifact(kind: string, title: string, uri: string, content: string) {
  if (content) return !content.includes("\0");
  return TEXT_KINDS.has(kind.toLowerCase()) || TEXT_EXTENSIONS.has(artifactExtension(title, uri));
}

export function artifactFilename(title: string, uri: string) {
  const uriPath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  return path.basename(uriPath || title) || title || "artifact.txt";
}

function localArtifactPath(uri: string, workspaceRoot: string) {
  if (!uri || /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !uri.startsWith("file://")) return null;
  const filename = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  return path.resolve(path.isAbsolute(filename) ? filename : path.join(workspaceRoot, filename));
}

export async function loadArtifactSource(content: string, uri: string, workspaceRoot: string, maxBytes = MAX_PREVIEW_BYTES) {
  if (content) {
    const bytes = Buffer.byteLength(content);
    if (bytes > maxBytes) throw Object.assign(new Error(`artifact exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`), { code: "ARTIFACT_TOO_LARGE" });
    return { content, source: "inline" as const };
  }
  const filename = localArtifactPath(uri, workspaceRoot);
  if (!filename) throw Object.assign(new Error("artifact content is not available from this server"), { code: "ARTIFACT_SOURCE_UNAVAILABLE" });
  const metadata = await stat(filename);
  if (!metadata.isFile()) throw Object.assign(new Error("artifact URI does not identify a file"), { code: "ARTIFACT_SOURCE_UNAVAILABLE" });
  if (metadata.size > maxBytes) throw Object.assign(new Error(`artifact exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`), { code: "ARTIFACT_TOO_LARGE" });
  return { content: await readFile(filename, "utf8"), source: "file" as const };
}

export function loadArtifactDownload(content: string, uri: string, workspaceRoot: string) {
  return loadArtifactSource(content, uri, workspaceRoot, MAX_DOWNLOAD_BYTES);
}
