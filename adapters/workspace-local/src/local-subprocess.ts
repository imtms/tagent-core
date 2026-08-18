import { spawn, spawnSync } from "node:child_process";
import {
  scrubbedParentEnvironment,
  type SubprocessHandle,
  type SubprocessPort,
  type SubprocessSpawnSpec,
} from "@tagent/execution/ports";

/** Explicit environment overrides win using the target platform's key semantics. */
export function childEnvironment(
  explicit: Readonly<NodeJS.ProcessEnv> = {},
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const scrubbed = scrubbedParentEnvironment(inherited);
  let entries = Object.entries(scrubbed);
  for (const [name, value] of Object.entries(explicit)) {
    if (!name || name.includes("=") || name.includes("\0") || value?.includes("\0")) {
      throw new Error("Subprocess environment entries require non-empty NUL-free names without = and NUL-free values");
    }
    entries = entries.filter(([candidate]) => process.platform === "win32"
      ? candidate.toUpperCase() !== name.toUpperCase()
      : candidate !== name);
    if (value !== undefined) entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function terminateWindowsTree(pid: number) {
  if (pid > 0) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

function signalTree(pid: number, signal: NodeJS.Signals, child: ReturnType<typeof spawn>) {
  if (pid <= 0) return;
  if (process.platform === "win32") return terminateWindowsTree(pid);
  try { process.kill(-pid, signal); } catch { try { child.kill(signal); } catch { /* exit race */ } }
}

function posixTreeAlive(pid: number) {
  if (pid <= 0 || process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class SubprocessTreeCleanupTimeoutError extends Error {
  readonly code = "SUBPROCESS_TREE_CLEANUP_TIMEOUT";
  constructor(readonly pid: number, readonly timeoutMs: number) {
    super(`Subprocess tree ${pid} remained alive after ${timeoutMs}ms of cleanup`);
    this.name = "SubprocessTreeCleanupTimeoutError";
  }
}

export function subprocessTreeCleanupDeadlineMs(terminationGraceMs: number) {
  return Math.min(MAX_TIMER_DELAY_MS, Math.ceil(terminationGraceMs) + 1_000);
}

export async function waitForTreeExit(
  pid: number,
  timeoutMs: number,
  treeAlive: (candidatePid: number) => boolean = posixTreeAlive,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Subprocess tree cleanup timeout must be positive");
  const deadline = Date.now() + timeoutMs;
  while (treeAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SubprocessTreeCleanupTimeoutError(pid, timeoutMs);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
}

/** Local managed-process implementation with scrubbed environment and tree-scoped termination. */
export class LocalSubprocessPort implements SubprocessPort {
  private readonly active = new Set<SubprocessHandle>();

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (!spec.argv[0]) throw new Error("Subprocess argv requires a program");
    if (!Number.isFinite(spec.terminationGraceMs) || spec.terminationGraceMs <= 0) {
      throw new Error("Subprocess terminationGraceMs must be positive");
    }
    if (spec.signal?.aborted) throw new Error("Subprocess aborted before spawn");
    const [program, ...args] = spec.argv;
    const child = spawn(program, args, {
      cwd: spec.cwd,
      env: childEnvironment(spec.env),
      detached: process.platform !== "win32",
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const pid = child.pid ?? -1;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      signalTree(pid, "SIGTERM", child);
      escalation = setTimeout(() => signalTree(pid, "SIGKILL", child), spec.terminationGraceMs);
      escalation.unref?.();
    };
    spec.signal?.addEventListener("abort", terminate, { once: true });
    if (child.stdin) {
      child.stdin.on("error", () => { /* Child exit may race a finite stdin write. */ });
      child.stdin.end(spec.stdin);
    }
    child.stdout?.on("data", (chunk: Buffer) => spec.onStdout?.(chunk));
    child.stderr?.on("data", (chunk: Buffer) => spec.onStderr?.(chunk));
    let handle: SubprocessHandle;
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (escalation) clearTimeout(escalation);
        spec.signal?.removeEventListener("abort", terminate);
        this.active.delete(handle);
      };
      child.once("error", (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        if (posixTreeAlive(pid)) terminate();
        void waitForTreeExit(pid, subprocessTreeCleanupDeadlineMs(spec.terminationGraceMs)).then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ exitCode, signal });
        }, (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
    });
    handle = Object.freeze({ pid, done, terminate });
    this.active.add(handle);
    return handle;
  }

  async dispose() {
    const handles = [...this.active];
    for (const handle of handles) handle.terminate();
    await Promise.allSettled(handles.map((handle) => handle.done));
  }
}

export function createLocalSubprocessPort(): SubprocessPort {
  return new LocalSubprocessPort();
}
