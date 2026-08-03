import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const deployScript = path.resolve("scripts/deploy-release.sh");
const buildScript = path.resolve("scripts/build-release.sh");
const manifestScript = path.resolve("scripts/release-manifest.mjs");

async function executable(file: string, content: string) {
  await writeFile(file, content, { mode: 0o755 });
}

async function deploymentFixture(options: { health?: "ok" | "fail"; restart?: "ok" | "fail" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tagent-deploy-test-"));
  const bin = path.join(root, "bin");
  const releaseRoot = path.join(root, "opt");
  const oldRelease = path.join(releaseRoot, "releases", "old");
  await mkdir(bin, { recursive: true });
  await mkdir(oldRelease, { recursive: true });
  await symlink("releases/old", path.join(releaseRoot, "current"));
  const log = path.join(root, "calls.log");
  const realNode = process.execPath;
  await executable(path.join(bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(realNode)} "$@"\n`);
  await executable(path.join(bin, "systemctl"), `#!/bin/sh\necho systemctl:$* >> ${JSON.stringify(log)}\n${options.restart === "fail" ? "exit 1" : "exit 0"}\n`);
  await executable(path.join(bin, "curl"), `#!/bin/sh\necho curl:$* >> ${JSON.stringify(log)}\n${options.health === "fail" ? "exit 22" : "exit 0"}\n`);
  for (const name of ["tar", "python3", "realpath", "mkdir", "mktemp", "rm", "tr", "chmod", "readlink", "ln", "mv", "sleep"]) {
    const resolved = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    await symlink(resolved, path.join(bin, name));
  }
  return { root, bin, releaseRoot, log };
}

async function artifact(root: string, commit: string, corrupt: "native" | "manifest" | "syntax" | null = null) {
  const directory = path.join(root, `tagent-core-${commit}`);
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(directory, "package-lock.json"), "{}\n");
  await writeFile(path.join(directory, "dist", "server.js"), corrupt === "syntax" ? "const = ;\n" : "console.log('ok');\n");
  await writeFile(path.join(directory, "scripts", "deploy-release.sh"), "deploy\n");
  await writeFile(path.join(directory, "scripts", "release-manifest.mjs"), await readFile(manifestScript));
  const bindingSource = path.resolve("node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  await writeFile(path.join(directory, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), await readFile(bindingSource));
  await writeFile(path.join(directory, "node_modules", "better-sqlite3", "package.json"), JSON.stringify({ main: "lib/index.js" }));
  await mkdir(path.join(directory, "node_modules", "better-sqlite3", "lib"), { recursive: true });
  await writeFile(path.join(directory, "node_modules", "better-sqlite3", "lib", "index.js"), "module.exports = require(" + JSON.stringify(path.resolve("node_modules/better-sqlite3")) + ");\n");
  const files: Record<string, string> = {};
  async function add(relative: string) { files[relative] = createHash("sha256").update(await readFile(path.join(directory, relative))).digest("hex"); }
  for (const relative of ["package.json", "package-lock.json", "dist/server.js", "scripts/deploy-release.sh", "scripts/release-manifest.mjs", "node_modules/better-sqlite3/build/Release/better_sqlite3.node", "node_modules/better-sqlite3/package.json", "node_modules/better-sqlite3/lib/index.js"]) await add(relative);
  if (corrupt === "manifest") files["dist/server.js"] = "0".repeat(64);
  if (corrupt === "native") files["node_modules/better-sqlite3/build/Release/better_sqlite3.node"] = "0".repeat(64);
  await writeFile(path.join(directory, "RELEASE_COMMIT"), `${commit}\n`);
  await writeFile(path.join(directory, "RELEASE_MANIFEST.json"), JSON.stringify({ schemaVersion: 2, commit, runtime: { node: "24.18.1", abi: "137", platform: "linux", arch: "x64" }, files }));
  const tarball = path.join(root, `${commit}.tar.gz`);
  const tar = spawnSync("tar", ["-C", root, "-czf", tarball, path.basename(directory)], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  return tarball;
}

function deploy(fixture: Awaited<ReturnType<typeof deploymentFixture>>, tarball: string) {
  return spawnSync("bash", [deployScript, tarball, fixture.releaseRoot, "tagent-test.service"], {
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, TAGENT_HEALTH_ATTEMPTS: "1", TAGENT_HEALTH_URL: "http://test/api/health" }, encoding: "utf8",
  });
}

const commit = "1".repeat(40);

describe("production release deployment", () => {
  it("removes npm .bin symlinks before creating an archive that the deployer can accept", async () => {
    const source = await readFile(buildScript, "utf8");
    expect(source).toContain('find "$release/node_modules" -type d -name .bin -prune -exec rm -rf {} +');
    expect(source.indexOf('find "$release/node_modules" -type d -name .bin')).toBeLessThan(source.indexOf('tar -C "$work" -czf'));
  });

  it.each(["native", "manifest", "syntax"] as const)("does not switch or restart when %s preflight fails", async (kind) => {
    const fixture = await deploymentFixture();
    const result = deploy(fixture, await artifact(fixture.root, commit, kind));
    expect(result.status).not.toBe(0);
    expect(await readlink(path.join(fixture.releaseRoot, "current"))).toBe("releases/old");
    expect(await readFile(fixture.log, "utf8").catch(() => "")).not.toContain("systemctl");
  });

  it("rolls current back and restarts the old service after health failure", async () => {
    const fixture = await deploymentFixture({ health: "fail" });
    const result = deploy(fixture, await artifact(fixture.root, commit));
    expect(result.status).not.toBe(0);
    expect(await readlink(path.join(fixture.releaseRoot, "current"))).toBe("releases/old");
    expect((await readFile(fixture.log, "utf8")).match(/systemctl:restart/g)).toHaveLength(2);
  });

  it("rejects archive path traversal before extraction", async () => {
    const fixture = await deploymentFixture();
    const tarball = path.join(fixture.root, "unsafe.tar.gz");
    const python = spawnSync("python3", ["-c", "import io,tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('../escape'); b=b'x'; i.size=1; t.addfile(i,io.BytesIO(b)); t.close()", tarball]);
    expect(python.status).toBe(0);
    const result = deploy(fixture, tarball);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe archive path");
  });
});
