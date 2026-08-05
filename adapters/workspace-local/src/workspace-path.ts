import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

type HelperOptions = { input?: string | Buffer; env?: NodeJS.ProcessEnv };

async function runHelper(operation: "read" | "write" | "list", root: string, target: string, options: HelperOptions = {}) {
  const normalized = validateTarget(target);
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("python3", [helper, operation, root, normalized], { stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutput = operation === "list" ? 8 * 1024 * 1024 : 50 * 1024 * 1024;
    let outputBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) { overflow = true; child.kill("SIGKILL"); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      if (overflow) return reject(new WorkspacePathError("Workspace operation output is too large", "WORKSPACE_OUTPUT_TOO_LARGE"));
      if (status === 0) return resolve(Buffer.concat(stdout));
      const message = Buffer.concat(stderr).toString("utf8").trim();
      try {
        const result = JSON.parse(message) as { error?: string; code?: string };
        reject(new WorkspacePathError(result.error ?? "Workspace operation failed", result.code));
      } catch {
        reject(new WorkspacePathError(message || `Workspace helper exited with status ${status}`, "WORKSPACE_IO_ERROR"));
      }
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

/** Existing-path compatibility result; actual I/O must use the descriptor-relative helpers below. */
export async function resolveWorkspaceExisting(root: string, target: string) {
  const normalized = validateTarget(target);
  // Listing through the pinned directory descriptor proves the complete path is an existing,
  // non-symlink directory. Callers must not use the returned display path for subsequent I/O.
  await runHelper("list", root, normalized);
  return { root: path.resolve(root), path: path.resolve(root, normalized), relative: normalized };
}

export async function listWorkspaceDirectory(root: string, target: string, env?: NodeJS.ProcessEnv) {
  const buffer = await runHelper("list", root, target, { env });
  return JSON.parse(buffer.toString("utf8")) as Array<{ name: string; directory: boolean; symlink: boolean }>;
}

export async function readWorkspaceFile(root: string, target: string, env?: NodeJS.ProcessEnv) {
  const normalized = validateTarget(target);
  const buffer = await runHelper("read", root, normalized, { env });
  return { root: path.resolve(root), path: path.resolve(root, normalized), relative: normalized, metadata: { size: buffer.length, isFile: () => true }, buffer };
}

/**
 * The helper pins the canonical workspace and each parent directory as file descriptors, creates
 * the temporary file relative to the pinned parent, and uses renameat on that same descriptor.
 * Concurrent directory-to-symlink replacement therefore cannot redirect the write outside.
 */
export async function writeWorkspaceFile(root: string, target: string, content: string | Buffer, env?: NodeJS.ProcessEnv) {
  const normalized = validateTarget(target);
  await runHelper("write", root, normalized, { input: content, env });
  return { root: path.resolve(root), parent: path.dirname(path.resolve(root, normalized)), path: path.resolve(root, normalized), relative: normalized };
}
