import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { CORE_HOST_PROTOCOL_VERSION, CORE_STATE_PROTOCOL } from "./generation-protocol.js";

const RELEASE_ID = /^[0-9a-f]{40}$/;

export interface CoreReleaseIdentity {
  readonly id: string;
  readonly directory: string;
  readonly generationEntry: string;
  readonly managed: boolean;
}

interface CoreReleaseManifest {
  schemaVersion: number;
  artifact: string;
  commit: string;
  core?: {
    hostProtocolVersion?: number;
    stateProtocol?: string;
    generationEntry?: string;
  };
}

export interface CoreReleaseRegistryOptions {
  releaseRoot: string;
  directReleaseDirectory: string;
  directGenerationEntry?: string;
  verifyRelease?: (release: CoreReleaseIdentity) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

/** Resolves, verifies, and atomically commits immutable releases for the Host. */
export class CoreReleaseRegistry {
  readonly currentPath: string;
  private trustedVerifierPath?: string;

  constructor(private readonly options: CoreReleaseRegistryOptions) {
    this.currentPath = path.join(path.resolve(options.releaseRoot), "current");
  }

  async initialize(): Promise<void> {
    this.trustedVerifierPath = path.join(
      await realpath(this.options.directReleaseDirectory),
      "scripts",
      "release-manifest.mjs",
    );
  }

  async resolveCommitted(): Promise<CoreReleaseIdentity> {
    try {
      const target = await readlink(this.currentPath);
      const match = /^releases\/([0-9a-f]{40})$/.exec(target.replaceAll("\\", "/"));
      if (!match) throw new Error(`Core current link has unsafe target ${target}`);
      return this.resolve(match[1]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const directory = path.resolve(this.options.directReleaseDirectory);
      const entry = path.resolve(directory, this.options.directGenerationEntry ?? "dist/generation-entry.js");
      const configuredId = (this.options.environment ?? process.env).TAGENT_RELEASE_ID?.trim() ?? "";
      const id = RELEASE_ID.test(configuredId) ? configuredId : "development";
      return { id, directory, generationEntry: entry, managed: false };
    }
  }

  async resolveTarget(target: string, current: CoreReleaseIdentity): Promise<CoreReleaseIdentity> {
    if (target === "current") return current;
    if (!RELEASE_ID.test(target)) throw new Error("Target release must be current or a full lowercase Git commit");
    return this.resolve(target);
  }

  async verify(release: CoreReleaseIdentity): Promise<void> {
    if (!release.managed) return;
    if (this.options.verifyRelease) return this.options.verifyRelease(release);
    if (!this.trustedVerifierPath) throw new Error("Core Host trusted release verifier is unavailable");
    const verify = promisify(execFile);
    await verify(process.execPath, [this.trustedVerifierPath, "verify", release.directory], {
      cwd: release.directory,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  async commit(releaseId: string): Promise<void> {
    if (!RELEASE_ID.test(releaseId)) throw new Error(`Invalid release identity ${releaseId}`);
    const root = path.resolve(this.options.releaseRoot);
    const temporary = path.join(root, `.current.${releaseId}.${randomUUID()}`);
    await symlink(`releases/${releaseId}`, temporary);
    try {
      await rename(temporary, this.currentPath);
      const directory = await open(root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async resolve(id: string): Promise<CoreReleaseIdentity> {
    if (!RELEASE_ID.test(id)) throw new Error(`Invalid release identity ${id}`);
    const root = path.resolve(this.options.releaseRoot);
    const directory = path.join(root, "releases", id);
    const resolved = await realpath(directory);
    const expected = await realpath(path.join(root, "releases")) + path.sep;
    if (!resolved.startsWith(expected)) throw new Error(`Release ${id} escapes the release root`);
    const manifest = JSON.parse(await readFile(path.join(resolved, "RELEASE_MANIFEST.json"), "utf8")) as CoreReleaseManifest;
    if (manifest.schemaVersion !== 2) throw new Error(`Release ${id} manifest schema is unsupported`);
    if (manifest.artifact !== "core" || manifest.commit !== id) throw new Error(`Release ${id} manifest identity is invalid`);
    if (manifest.core?.hostProtocolVersion !== CORE_HOST_PROTOCOL_VERSION) throw new Error(`Release ${id} Host protocol is incompatible`);
    if (manifest.core.stateProtocol !== CORE_STATE_PROTOCOL) throw new Error(`Release ${id} state protocol is incompatible`);
    const relativeEntry = manifest.core.generationEntry;
    if (!relativeEntry) throw new Error(`Release ${id} Generation entry is missing`);
    if (path.isAbsolute(relativeEntry) || relativeEntry.split(/[\\/]+/).includes("..")) {
      throw new Error(`Release ${id} generation entry is unsafe`);
    }
    return { id, directory: resolved, generationEntry: path.join(resolved, relativeEntry), managed: true };
  }
}
