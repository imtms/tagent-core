import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubprocessHandle } from "@tagent/execution/ports";
import { createLocalSubprocessPort } from "./local-subprocess.js";

export class WorkspacePathError extends Error {
  readonly code: string;
  constructor(message: string, code = "WORKSPACE_PATH_REJECTED") { super(message); this.name = "WorkspacePathError"; this.code = code; }
}

const helper = fileURLToPath(new URL("./workspace-fd-helper.py", import.meta.url));

function validateTarget(target: string) {
  if (target.includes("\0")) throw new WorkspacePathError("Path contains a NUL byte");
  if (path.isAbsolute(target)) throw new WorkspacePathError("Absolute paths are not allowed");
  const normalized = path.posix.normalize(target.replaceAll("\\", "/") || ".");
  if (normalized === ".." || normalized.startsWith("../")) throw new WorkspacePathError("Path escapes the workspace");
  return normalized;
}

type HelperOptions = { signal: AbortSignal; input?: string | Buffer; env?: NodeJS.ProcessEnv };

async function runHelper(operation: "read" | "write" | "list" | "commit-batch", root: string, target: string, options: HelperOptions) {
  options.signal.throwIfAborted();
  const normalized = validateTarget(target);
  const subprocess = createLocalSubprocessPort();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maxOutput = operation === "list" ? 8 * 1024 * 1024 : 50 * 1024 * 1024;
  let outputBytes = 0;
  let overflow = false;
  let handle: SubprocessHandle | undefined;
  const capture = (target: Buffer[], bytes: Uint8Array) => {
    const chunk = Buffer.from(bytes);
    outputBytes += chunk.length;
    if (outputBytes > maxOutput) {
      overflow = true;
      handle?.terminate();
      return;
    }
    target.push(chunk);
  };
  try {
    handle = subprocess.spawn({
      argv: ["python3", helper, operation, root, normalized],
      cwd: root,
      env: options.env,
      stdin: options.input,
      signal: options.signal,
      terminationGraceMs: 100,
      onStdout: (chunk) => capture(stdout, chunk),
      onStderr: (chunk) => capture(stderr, chunk),
    });
    const outcome = await handle.done;
    options.signal.throwIfAborted();
    if (overflow) throw new WorkspacePathError("Workspace operation output is too large", "WORKSPACE_OUTPUT_TOO_LARGE");
    if (outcome.exitCode === 0) return Buffer.concat(stdout);
    const message = Buffer.concat(stderr).toString("utf8").trim();
    try {
      const result = JSON.parse(message) as { error?: string; code?: string };
      throw new WorkspacePathError(result.error ?? "Workspace operation failed", result.code);
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      throw new WorkspacePathError(message || `Workspace helper exited with status ${outcome.exitCode}`, "WORKSPACE_IO_ERROR");
    }
  } finally {
    await subprocess.dispose?.();
  }
}

/** Existing-path compatibility result; actual I/O must use the descriptor-relative helpers below. */
export async function resolveWorkspaceExisting(root: string, target: string, signal: AbortSignal) {
  const normalized = validateTarget(target);
  // Listing through the pinned directory descriptor proves the complete path is an existing,
  // non-symlink directory. Callers must not use the returned display path for subsequent I/O.
  await runHelper("list", root, normalized, { signal });
  return { root: path.resolve(root), path: path.resolve(root, normalized), relative: normalized };
}

export async function listWorkspaceDirectory(root: string, target: string, signal: AbortSignal, env?: NodeJS.ProcessEnv) {
  const buffer = await runHelper("list", root, target, { signal, env });
  return JSON.parse(buffer.toString("utf8")) as Array<{ name: string; directory: boolean; symlink: boolean }>;
}

export async function readWorkspaceFile(root: string, target: string, signal: AbortSignal, env?: NodeJS.ProcessEnv) {
  const normalized = validateTarget(target);
  const buffer = await runHelper("read", root, normalized, { signal, env });
  return { root: path.resolve(root), path: path.resolve(root, normalized), relative: normalized, metadata: { size: buffer.length, isFile: () => true }, buffer };
}

/**
 * The helper pins the canonical workspace and each parent directory as file descriptors, creates
 * the temporary file relative to the pinned parent, and uses renameat on that same descriptor.
 * Concurrent directory-to-symlink replacement therefore cannot redirect the write outside.
 */
export async function writeWorkspaceFile(root: string, target: string, content: string | Buffer, signal: AbortSignal, env?: NodeJS.ProcessEnv) {
  const normalized = validateTarget(target);
  await runHelper("write", root, normalized, { signal, input: content, env });
  return { root: path.resolve(root), parent: path.dirname(path.resolve(root, normalized)), path: path.resolve(root, normalized), relative: normalized };
}


/** Commits a fully preflighted set of existing regular files through descriptor-relative renames. */
export async function commitWorkspaceFiles(root: string, entries: Array<{ path: string; content: string | Buffer; expectedHash: string }>, signal: AbortSignal, env?: NodeJS.ProcessEnv) {
  if (!entries.length) throw new WorkspacePathError("Batch commit requires at least one entry", "WORKSPACE_BATCH_INVALID");
  const paths = entries.map((entry) => validateTarget(entry.path));
  if (new Set(paths).size !== paths.length) throw new WorkspacePathError("Batch commit contains duplicate paths", "WORKSPACE_BATCH_INVALID");
  const payload = JSON.stringify({ entries: entries.map((entry, index) => ({ path: paths[index], expectedHash: entry.expectedHash, contentBase64: (Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8")).toString("base64") })) });
  await runHelper("commit-batch", root, ".", { signal, input: payload, env });
}
