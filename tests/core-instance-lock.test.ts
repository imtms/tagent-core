import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCoreInstanceLock,
  type CoreInstanceLock,
  type CoreInstanceLockOptions,
  type ProcessIdentityProbe,
} from "@tagent/persistence-sqlite/writer";
import {
  WriterAuthorityLostError,
  WriterAuthorityUnavailableError,
} from "@tagent/persistence-sqlite/writer";

const temporaryDirectories: string[] = [];
const locks: CoreInstanceLock[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "tagent-core-instance-lock-"));
  temporaryDirectories.push(directory);
  return {
    databasePath: path.join(directory, "core.sqlite"),
    options: (overrides: CoreInstanceLockOptions = {}): CoreInstanceLockOptions => ({
      instanceId: "instance-a",
      pid: 1_001,
      host: "test-host",
      processStart: "process-start-a",
      clock: () => 10_000,
      filesystemProbe: async () => "local",
      ...overrides,
    }),
  };
}

async function acquire(databasePath: string, options: CoreInstanceLockOptions) {
  const lock = await acquireCoreInstanceLock(databasePath, options);
  locks.push(lock);
  return lock;
}

afterEach(async () => {
  for (const lock of locks.splice(0).reverse()) {
    await lock.release().catch(() => undefined);
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Core instance lock", () => {
  it("accepts a local filesystem and returns a held lock at the database lock path", async () => {
    const { databasePath, options } = await fixture();
    const filesystemProbe = vi.fn(async () => "local" as const);

    const lock = await acquire(databasePath, options({ filesystemProbe }));

    expect(filesystemProbe).toHaveBeenCalledOnce();
    expect(lock.path).toBe(`${databasePath}.core-instance.lock`);
    await expect(lock.assertHeld()).resolves.toBeUndefined();
  });

  it.each(["remote", "shared", "unknown"] as const)(
    "rejects %s filesystem semantics",
    async (classification) => {
      const { databasePath, options } = await fixture();
      const filesystemProbe = vi.fn(async () => classification);

      await expect(acquire(databasePath, options({ filesystemProbe })))
        .rejects.toThrow(`has ${classification} filesystem semantics`);

      expect(filesystemProbe).toHaveBeenCalledOnce();
    },
  );

  it("allows only one acquisition for the same SQLite lock path", async () => {
    const { databasePath, options } = await fixture();
    const first = await acquire(databasePath, options());

    await expect(acquire(databasePath, options({
      processProbe: async () => ({ status: "alive", processStart: "process-start-a" }),
    }))).rejects.toThrow(WriterAuthorityUnavailableError);

    await expect(first.assertHeld()).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject(first.metadata);
  });

  it("takes over same-host metadata after the recorded owner is confirmed dead", async () => {
    const { databasePath, options } = await fixture();
    const stale = await acquire(databasePath, options());
    const processProbe: ProcessIdentityProbe = vi.fn(async (pid) => {
      expect(pid).toBe(stale.metadata.pid);
      return { status: "dead" as const };
    });

    const replacement = await acquire(databasePath, options({
      instanceId: "instance-b",
      pid: 2_002,
      processStart: "process-start-b",
      processProbe,
      clock: () => 20_000,
    }));

    expect(processProbe).toHaveBeenCalledTimes(2);
    expect(replacement.metadata).toMatchObject({
      instanceId: "instance-b",
      pid: 2_002,
      host: "test-host",
      processStart: "process-start-b",
      acquiredAt: 20_000,
    });
    await expect(stale.assertHeld()).rejects.toThrow(WriterAuthorityLostError);
    await expect(stale.release()).rejects.toThrow(WriterAuthorityLostError);
    await expect(replacement.assertHeld()).resolves.toBeUndefined();
  });

  it("takes over after PID reuse when the live process start differs from the recorded owner", async () => {
    const { databasePath, options } = await fixture();
    const stale = await acquire(databasePath, options());
    const processProbe: ProcessIdentityProbe = vi.fn(async () => ({
      status: "alive" as const,
      processStart: "process-start-after-pid-reuse",
    }));

    const replacement = await acquire(databasePath, options({
      instanceId: "instance-b",
      pid: 2_002,
      processStart: "process-start-b",
      processProbe,
    }));

    expect(processProbe).toHaveBeenCalledWith(stale.metadata.pid);
    await expect(stale.assertHeld()).rejects.toThrow(WriterAuthorityLostError);
    await expect(stale.release()).rejects.toThrow(WriterAuthorityLostError);
    await expect(replacement.assertHeld()).resolves.toBeUndefined();
  });

  it("fails closed when lock metadata is replaced while stale-owner probing is in flight", async () => {
    const { databasePath, options } = await fixture();
    const stale = await acquire(databasePath, options());
    const probeEntered = deferred<void>();
    const probeResult = deferred<Awaited<ReturnType<ProcessIdentityProbe>>>();
    const processProbe: ProcessIdentityProbe = vi.fn(async () => {
      probeEntered.resolve(undefined);
      return probeResult.promise;
    });
    const takeover = acquire(databasePath, options({
      instanceId: "recovering-contender",
      pid: 2_002,
      processStart: "process-start-b",
      processProbe,
    }));
    const takeoverFailure = expect(takeover).rejects.toThrow("owner changed during stale recovery");

    await probeEntered.promise;
    const racingContender = {
      instanceId: "racing-contender",
      pid: 3_003,
      host: "test-host",
      processStart: "process-start-c",
      acquiredAt: 30_000,
    };
    await unlink(stale.path);
    await writeFile(stale.path, `${JSON.stringify(racingContender)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    probeResult.resolve({ status: "dead" });

    await takeoverFailure;
    expect(JSON.parse(await readFile(stale.path, "utf8"))).toEqual(racingContender);
    await expect(readFile(`${stale.path}.recovery`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects takeover while the recorded same-host process identity is alive", async () => {
    const { databasePath, options } = await fixture();
    const current = await acquire(databasePath, options());

    await expect(acquire(databasePath, options({
      instanceId: "instance-b",
      pid: 2_002,
      processStart: "process-start-b",
      processProbe: async () => ({ status: "alive", processStart: current.metadata.processStart }),
    }))).rejects.toThrow(`Core instance lock is held by live process ${current.metadata.pid}`);

    await expect(current.assertHeld()).resolves.toBeUndefined();
  });

  it("does not publish a recovery marker for a live contender while the owner is still acquiring", async () => {
    const { databasePath, options } = await fixture();
    const lockPath = `${databasePath}.core-instance.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    const syncEntered = deferred<void>();
    const releaseOwnerSync = deferred<void>();
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const prototypeProbe = await open(path.join(path.dirname(databasePath), "file-handle-prototype"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(prototypeProbe) as { sync(): Promise<void> };
    const originalSync = fileHandlePrototype.sync;
    await prototypeProbe.close();
    let interceptedOwnerSync = false;
    const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (this: unknown) {
      if (!interceptedOwnerSync) {
        interceptedOwnerSync = true;
        syncEntered.resolve(undefined);
        await releaseOwnerSync.promise;
      }
      await originalSync.call(this);
    });

    try {
      const owner = acquireCoreInstanceLock(databasePath, options({ instanceId: "owner" }));
      await syncEntered.promise;
      const contender = acquireCoreInstanceLock(databasePath, options({
        instanceId: "contender",
        pid: 2_002,
        processStart: "process-start-b",
        processProbe: async () => {
          probeEntered.resolve(undefined);
          await releaseProbe.promise;
          return { status: "alive", processStart: "process-start-a" };
        },
      }));
      await probeEntered.promise;

      await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      releaseOwnerSync.resolve(undefined);
      releaseProbe.resolve(undefined);
      const results = await Promise.allSettled([owner, contender]);
      const successes = results.filter((result): result is PromiseFulfilledResult<CoreInstanceLock> => result.status === "fulfilled");
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(successes[0].value.metadata.instanceId).toBe("owner");
      expect(failures).toHaveLength(1);
      expect(String(failures[0].reason)).toContain("held by live process");
      locks.push(successes[0].value);
      await expect(successes[0].value.assertHeld()).resolves.toBeUndefined();
      await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseOwnerSync.resolve(undefined);
      releaseProbe.resolve(undefined);
      syncSpy.mockRestore();
    }
  });

  it("rejects stale recovery for lock metadata from another host", async () => {
    const { databasePath, options } = await fixture();
    const remote = await acquire(databasePath, options({ host: "remote-host" }));
    const processProbe = vi.fn<ProcessIdentityProbe>(async () => ({ status: "dead" }));

    await expect(acquire(databasePath, options({
      instanceId: "instance-b",
      pid: 2_002,
      processStart: "process-start-b",
      processProbe,
    }))).rejects.toThrow("refusing remote stale recovery");

    expect(processProbe).not.toHaveBeenCalled();
    await expect(remote.assertHeld()).resolves.toBeUndefined();
  });

  it("rejects stale recovery when the recorded process status is unknown", async () => {
    const { databasePath, options } = await fixture();
    const current = await acquire(databasePath, options());

    await expect(acquire(databasePath, options({
      instanceId: "instance-b",
      pid: 2_002,
      processStart: "process-start-b",
      processProbe: async () => ({ status: "unknown", reason: "probe denied" }),
    }))).rejects.toThrow(`Core instance lock owner ${current.metadata.pid} cannot be verified: probe denied`);

    await expect(current.assertHeld()).resolves.toBeUndefined();
  });

  it("rejects a path replacement even when it copies the acquired metadata", async () => {
    const { databasePath, options } = await fixture();
    const lock = await acquire(databasePath, options());
    await expect(lock.assertHeld()).resolves.toBeUndefined();

    await unlink(lock.path);
    await writeFile(lock.path, `${JSON.stringify(lock.metadata)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

    await expect(lock.assertHeld()).rejects.toThrow("no longer refers to the acquired file");
  });

  it("releases startup ownership after migration failure so the next startup can acquire it", async () => {
    const { databasePath, options } = await fixture();
    const start = async (instanceId: string, migrate: () => void) => {
      const lock = await acquire(databasePath, options({ instanceId }));
      try {
        migrate();
        return lock;
      } catch (error) {
        await lock.release();
        throw error;
      }
    };

    await expect(start("failed-startup", () => {
      throw new Error("simulated migration failure");
    })).rejects.toThrow("simulated migration failure");

    const restarted = await start("restarted", () => undefined);
    expect(restarted.metadata.instanceId).toBe("restarted");
    await expect(restarted.assertHeld()).resolves.toBeUndefined();
  });
});
