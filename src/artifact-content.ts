import path from "node:path";
import { readWorkspaceFile, WorkspacePathError } from "./security/workspace-path.js";

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

function safeRelativeUri(uri: string) {
  const value = uri.trim();
  if (!value) return "";
  if (path.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw Object.assign(new Error("artifact URI must be a workspace-relative path"), { code: "ARTIFACT_PATH_REJECTED" });
  }
  return value;
}

function artifactExtension(title: string, uri: string) {
  let uriPath = "";
  try { uriPath = safeRelativeUri(uri); } catch { /* untrusted URI is not needed for type display */ }
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
  let uriPath = "";
  try { uriPath = safeRelativeUri(uri); } catch { /* fall back to trusted display title */ }
  return path.basename(uriPath || title) || "artifact.bin";
}

async function loadArtifactBytes(content: string, uri: string, workspaceRoot: string, maxBytes: number) {
  if (content) {
    const buffer = Buffer.from(content, "utf8");
    if (buffer.length > maxBytes) throw Object.assign(new Error(`artifact exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`), { code: "ARTIFACT_TOO_LARGE" });
    return { buffer, source: "inline" as const };
  }
  const relative = safeRelativeUri(uri);
  if (!relative) throw Object.assign(new Error("artifact content is not available from this server"), { code: "ARTIFACT_SOURCE_UNAVAILABLE" });
  try {
    // Boundary validation and O_NOFOLLOW happen again for every content/download read.
    const source = await readWorkspaceFile(workspaceRoot, relative);
    if (source.metadata.size > maxBytes) throw Object.assign(new Error(`artifact exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`), { code: "ARTIFACT_TOO_LARGE" });
    return { buffer: source.buffer, source: "file" as const };
  } catch (error) {
    if (error instanceof WorkspacePathError) throw Object.assign(new Error(error.message), { code: "ARTIFACT_PATH_REJECTED" });
    throw error;
  }
}

export async function loadArtifactSource(content: string, uri: string, workspaceRoot: string, maxBytes = MAX_PREVIEW_BYTES) {
  const source = await loadArtifactBytes(content, uri, workspaceRoot, maxBytes);
  return { content: source.buffer.toString("utf8"), source: source.source };
}

export function loadArtifactDownload(content: string, uri: string, workspaceRoot: string) {
  return loadArtifactBytes(content, uri, workspaceRoot, MAX_DOWNLOAD_BYTES);
}
