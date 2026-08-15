import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, realpath, stat, statfs, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { scrubbedParentEnvironment } from "@tagent/execution/ports";
import { WriterAuthorityLostError, WriterAuthorityUnavailableError } from "../writer-authority.js";

const execFileAsync = promisify(execFile);

export interface CoreInstanceLockMetadata {
  instanceId: string;
  pid: number;
  host: string;
  processStart: string;
  acquiredAt: number;
}

export type ProcessIdentityProbeResult =
  | { status: "alive"; processStart: string }
  | { status: "dead" }
  | { status: "unknown"; reason: string };

export type ProcessIdentityProbe = (pid: number) => Promise<ProcessIdentityProbeResult>;
export type FilesystemClassification = "local" | "remote" | "shared" | "unknown";
export type FilesystemSemanticsProbe = (directory: string) => Promise<FilesystemClassification>;

export interface CoreInstanceLockOptions {
  instanceId?: string;
  pid?: number;
  host?: string;
  processStart?: string;
  clock?: () => number;
  processProbe?: ProcessIdentityProbe;
  filesystemProbe?: FilesystemSemanticsProbe;
  lockPath?: string;
}

function errnoCode(error: unknown): string | number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string | number }).code
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedHost(host: string): string {
  return host.trim().toLowerCase();
}

async function linuxProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  try {
    const [rawStat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const closingParen = rawStat.lastIndexOf(")");
    if (closingParen < 0) return { status: "unknown", reason: "malformed /proc process stat" };
    const fields = rawStat.slice(closingParen + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) {
      return { status: "unknown", reason: "missing /proc process start time" };
    }
    return { status: "alive", processStart: `linux:${bootId.trim()}:${startTicks}` };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { status: "dead" };
    return { status: "unknown", reason: message(error) };
  }
}

async function posixProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  try {
    const result = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...scrubbedParentEnvironment(), LC_ALL: "C" },
    });
    const processStart = result.stdout.trim().replace(/\s+/g, " ");
    return processStart ? { status: "alive", processStart: `posix:${processStart}` } : { status: "dead" };
  } catch (error) {
    if (errnoCode(error) === 1) return { status: "dead" };
    return { status: "unknown", reason: message(error) };
  }
}

async function windowsProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`;
  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", env: scrubbedParentEnvironment(),
    });
    const processStart = result.stdout.trim();
    return processStart ? { status: "alive", processStart: `windows:${processStart}` } : { status: "dead" };
  } catch (error) {
    return { status: "unknown", reason: message(error) };
  }
}

export async function defaultProcessIdentityProbe(pid: number): Promise<ProcessIdentityProbeResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unknown", reason: "invalid pid" };
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return posixProcessIdentity(pid);
  }
  if (process.platform === "win32") return windowsProcessIdentity(pid);
  return { status: "unknown", reason: `unsupported process identity platform ${process.platform}` };
}

async function windowsFilesystemClassification(directory: string): Promise<FilesystemClassification> {
  const root = path.parse(directory).root;
  if (!root || root.startsWith("\\\\")) return "remote";
  const drive = root.slice(0, 2).replace(/'/g, "''");
  const script = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").DriveType`;
  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", env: scrubbedParentEnvironment(),
    });
    const driveType = Number(result.stdout.trim());
    if (driveType === 3) return "local";
    if (driveType === 4) return "remote";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function defaultFilesystemSemanticsProbe(directory: string): Promise<FilesystemClassification> {
  if (process.platform === "win32") return windowsFilesystemClassification(directory);
  try {
    const filesystem = await statfs(directory);
    const type = Number(filesystem.type) >>> 0;
    const remoteTypes = new Set([
      0x00006969, // NFS
      0xff534d42, // CIFS/SMB
      0x0000517b, // SMBFS
      0x65735546, // FUSE: semantics cannot be established here
      0x01021997, // 9P
      0x5346414f, // AFS
    ]);
    if (remoteTypes.has(type)) return "remote";
    const localTypes = process.platform === "darwin"
      // APFS reports 0x1a on current Darwin kernels; retain 0x19 for older
      // Darwin variants and 0x4244 for HFS volumes.
      ? new Set([0x0000001a, 0x00000019, 0x00004244])
      : new Set([
        0x0000ef53, // ext2/3/4
        0x58465342, // XFS
        0x9123683e, // Btrfs
        0x01021994, // tmpfs
        0x794c7630, // overlayfs
        0x2fc12fc1, // ZFS
      ]);
    return localTypes.has(type) ? "local" : "unknown";
  } catch {
    return "unknown";
  }
}

function parseMetadata(source: string, lockPath: string): CoreInstanceLockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new WriterAuthorityUnavailableError(`Core instance lock metadata is invalid at ${lockPath}`);
  }
  const candidate = value as Partial<CoreInstanceLockMetadata> | null;
  if (!candidate || typeof candidate.instanceId !== "string" || !candidate.instanceId
    || !Number.isSafeInteger(candidate.pid) || candidate.pid! <= 0
    || typeof candidate.host !== "string" || !candidate.host
    || typeof candidate.processStart !== "string" || !candidate.processStart
    || !Number.isSafeInteger(candidate.acquiredAt) || candidate.acquiredAt! < 0) {
    throw new WriterAuthorityUnavailableError(`Core instance lock metadata is unverifiable at ${lockPath}`);
  }
  return candidate as CoreInstanceLockMetadata;
}

async function readMetadata(lockPath: string): Promise<CoreInstanceLockMetadata> {
  return parseMetadata(await readFile(lockPath, "utf8"), lockPath);
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function writeLockFile(lockPath: string, metadata: CoreInstanceLockMetadata): Promise<FileHandle> {
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

async function assertStale(
  existing: CoreInstanceLockMetadata,
  currentHost: string,
  processProbe: ProcessIdentityProbe,
  lockPath: string,
): Promise<void> {
  if (normalizedHost(existing.host) !== currentHost) {
    throw new WriterAuthorityUnavailableError(`Core instance lock at ${lockPath} belongs to host ${existing.host}; refusing remote stale recovery`);
  }
  const identity = await processProbe(existing.pid);
  if (identity.status === "unknown") {
    throw new WriterAuthorityUnavailableError(`Core instance lock owner ${existing.pid} cannot be verified: ${identity.reason}`);
  }
  if (identity.status === "alive" && identity.processStart === existing.processStart) {
    throw new WriterAuthorityUnavailableError(`Core instance lock is held by live process ${existing.pid} on ${existing.host}`);
  }
}

async function recoverStaleLock(
  lockPath: string,
  recoveryPath: string,
  recoveryMetadata: CoreInstanceLockMetadata,
  currentHost: string,
  processProbe: ProcessIdentityProbe,
): Promise<void> {
  let observed: CoreInstanceLockMetadata;
  try {
    observed = await readMetadata(lockPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  // A normal live-owner collision must remain side-effect free. In particular,
  // it must never publish a recovery marker that can invalidate the owner that
  // is still completing its own acquisition.
  await assertStale(observed, currentHost, processProbe, lockPath);

  let recoveryHandle: FileHandle;
  try {
    recoveryHandle = await writeLockFile(recoveryPath, recoveryMetadata);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new WriterAuthorityUnavailableError(`Core instance lock recovery is already in progress at ${recoveryPath}`);
    }
    throw error;
  }
  try {
    let confirmed: CoreInstanceLockMetadata;
    try {
      confirmed = await readMetadata(lockPath);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return;
      throw error;
    }
    await assertStale(confirmed, currentHost, processProbe, lockPath);
    if (confirmed.instanceId !== observed.instanceId) {
      throw new WriterAuthorityUnavailableError(`Core instance lock owner changed during stale recovery at ${lockPath}`);
    }
    await unlink(lockPath);
  } finally {
    await recoveryHandle.close().catch(() => undefined);
    await unlink(recoveryPath).catch(() => undefined);
  }
}

export class CoreInstanceLock {
  readonly metadata: Readonly<CoreInstanceLockMetadata>;
  private released = false;

  constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    metadata: CoreInstanceLockMetadata,
  ) {
    this.metadata = Object.freeze({ ...metadata });
  }

  async assertHeld(): Promise<void> {
    if (this.released) throw new WriterAuthorityLostError(`Core instance lock ${this.path} has been released`);
    let current: CoreInstanceLockMetadata;
    try {
      current = await readMetadata(this.path);
    } catch (error) {
      throw new WriterAuthorityLostError(`Core instance lock ${this.path} is unavailable: ${message(error)}`);
    }
    if (current.instanceId !== this.metadata.instanceId) {
      throw new WriterAuthorityLostError(`Core instance lock ${this.path} was replaced by another owner`);
    }
    try {
      const [handleStat, pathStat] = await Promise.all([this.handle.stat(), stat(this.path)]);
      if (handleStat.dev !== pathStat.dev || handleStat.ino && pathStat.ino && handleStat.ino !== pathStat.ino) {
        throw new WriterAuthorityLostError(`Core instance lock ${this.path} no longer refers to the acquired file`);
      }
    } catch (error) {
      if (error instanceof WriterAuthorityLostError) throw error;
      throw new WriterAuthorityLostError(`Core instance lock ${this.path} cannot be verified: ${message(error)}`);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    try {
      let current: CoreInstanceLockMetadata;
      try {
        current = await readMetadata(this.path);
      } catch (error) {
        throw new WriterAuthorityLostError(`Core instance lock ${this.path} cannot be released: ${message(error)}`);
      }
      if (current.instanceId !== this.metadata.instanceId) {
        throw new WriterAuthorityLostError(`Core instance lock ${this.path} cannot be released by a stale owner`);
      }
      await unlink(this.path);
    } finally {
      this.released = true;
      await this.handle.close().catch(() => undefined);
    }
  }
}

export async function acquireCoreInstanceLock(
  databasePath: string,
  options: CoreInstanceLockOptions = {},
): Promise<CoreInstanceLock> {
  if (!databasePath || databasePath === ":memory:" || databasePath.startsWith("file:")) {
    throw new WriterAuthorityUnavailableError(`Core instance lock requires a filesystem SQLite path, received ${databasePath || "<empty>"}`);
  }
  const databaseAbsolutePath = path.resolve(databasePath);
  const directory = path.dirname(databaseAbsolutePath);
  const filesystemDirectory = await realpath(directory);
  const filesystemProbe = options.filesystemProbe ?? defaultFilesystemSemanticsProbe;
  const classification = await filesystemProbe(filesystemDirectory);
  if (classification !== "local") {
    throw new WriterAuthorityUnavailableError(`SQLite directory ${filesystemDirectory} has ${classification} filesystem semantics; local atomic locking is required`);
  }
  const lockPath = options.lockPath ? path.resolve(options.lockPath) : `${databaseAbsolutePath}.core-instance.lock`;
  if (path.dirname(lockPath) !== directory) {
    throw new WriterAuthorityUnavailableError("Core instance lock must reside in the SQLite database directory");
  }
  const recoveryPath = `${lockPath}.recovery`;
  const processProbe = options.processProbe ?? defaultProcessIdentityProbe;
  const pid = options.pid ?? process.pid;
  const host = normalizedHost(options.host ?? os.hostname());
  const identity = options.processStart
    ? { status: "alive" as const, processStart: options.processStart }
    : await processProbe(pid);
  if (identity.status !== "alive") {
    const reason = identity.status === "unknown" ? identity.reason : "current pid was not found";
    throw new WriterAuthorityUnavailableError(`Current process start identity cannot be verified: ${reason}`);
  }
  const metadata: CoreInstanceLockMetadata = {
    instanceId: options.instanceId ?? randomUUID(),
    pid,
    host,
    processStart: identity.processStart,
    acquiredAt: (options.clock ?? Date.now)(),
  };
  if (!metadata.instanceId || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0
    || !metadata.host || !metadata.processStart || !Number.isSafeInteger(metadata.acquiredAt) || metadata.acquiredAt < 0) {
    throw new TypeError("Core instance lock identity is invalid");
  }

  if (await pathExists(recoveryPath)) {
    throw new WriterAuthorityUnavailableError(`Core instance lock recovery is already in progress at ${recoveryPath}`);
  }

  let handle: FileHandle;
  try {
    handle = await writeLockFile(lockPath, metadata);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    await recoverStaleLock(lockPath, recoveryPath, metadata, host, processProbe);
    try {
      handle = await writeLockFile(lockPath, metadata);
    } catch (retryError) {
      if (errnoCode(retryError) === "EEXIST") {
        throw new WriterAuthorityUnavailableError(`Core instance lock was acquired by another contender at ${lockPath}`);
      }
      throw retryError;
    }
  }
  const lock = new CoreInstanceLock(lockPath, handle, metadata);
  try {
    if (await pathExists(recoveryPath)) {
      throw new WriterAuthorityUnavailableError(`Core instance lock recovery is in progress at ${recoveryPath}`);
    }
    await lock.assertHeld();
    return lock;
  } catch (error) {
    await handle.close().catch(() => undefined);
    const current = await readMetadata(lockPath).catch(() => null);
    if (current?.instanceId === metadata.instanceId) await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}
