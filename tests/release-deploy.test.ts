import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const deployScript = path.resolve("scripts/deploy-release.sh");
const buildScript = path.resolve("scripts/build-release.sh");
const manifestScript = path.resolve("scripts/release-manifest.mjs");
const ciWorkflow = path.resolve(".github/workflows/ci.yml");
const releaseWorkflow = path.resolve(".github/workflows/release.yml");

async function executable(file: string, content: string) {
  await writeFile(file, content, { mode: 0o755 });
}

async function deploymentFixture(options: { health?: "ok" | "fail"; restart?: "ok" | "fail"; existingRelease?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tagent-deploy-test-"));
  const bin = path.join(root, "bin");
  const releaseRoot = path.join(root, "opt");
  const oldRelease = path.join(releaseRoot, "releases", "old");
  await mkdir(bin, { recursive: true });
  await mkdir(releaseRoot, { recursive: true });
  if (options.existingRelease !== false) {
    await mkdir(oldRelease, { recursive: true });
    await symlink("releases/old", path.join(releaseRoot, "current"));
  }
  const log = path.join(root, "calls.log");
  const realNode = process.execPath;
  const runtimeShim = path.join(root, "production-runtime.cjs");
  await writeFile(runtimeShim, [
    'Object.defineProperty(process.versions, "node", { value: "24.18.1" });',
    'Object.defineProperty(process.versions, "modules", { value: "137" });',
    'Object.defineProperty(process, "platform", { value: "linux" });',
    'Object.defineProperty(process, "arch", { value: "x64" });',
  ].join("\n"));
  await executable(path.join(bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(realNode)} --require ${JSON.stringify(runtimeShim)} "$@"\n`);
  const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
  await executable(path.join(bin, "mv"), `#!/bin/sh\nif [ "$1" = "-Tf" ]; then\n  shift\n  exec python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$@"\nfi\nexec ${JSON.stringify(realMv)} "$@"\n`);
  await executable(path.join(bin, "systemctl"), `#!/bin/sh\necho systemctl:$* >> ${JSON.stringify(log)}\n${options.restart === "fail" ? 'if [ "$1" = "restart" ]; then exit 1; fi' : ""}\nexit 0\n`);
  await executable(path.join(bin, "curl"), `#!/bin/sh\necho curl:$* >> ${JSON.stringify(log)}\n${options.health === "fail" ? "exit 22" : "exit 0"}\n`);
  for (const name of ["tar", "python3", "realpath", "mkdir", "mktemp", "rm", "tr", "chmod", "readlink", "ln", "sleep"]) {
    const resolved = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    await symlink(resolved, path.join(bin, name));
  }
  return { root, bin, releaseRoot, log, runtimeShim };
}

async function releaseDirectory(root: string, commit: string, corrupt: "native" | "manifest" | "syntax" | null = null) {
  const directory = path.join(root, `tagent-core-${commit}`);
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await mkdir(path.join(directory, "dist", "memory", "postgres"), { recursive: true });
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "admission", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "abi", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "core-service", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "governance", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "http-fastify", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "execution", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "learning", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "memory", "dist", "postgres"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "persistence-sqlite", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "runtime-pi", "dist"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "@tagent", "workspace-local", "dist"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    type: "module",
    dependencies: {
      "@tagent/core-service": "0.6.5",
      "better-sqlite3": "12.4.1",
    },
  }));
  await writeFile(path.join(directory, "package-lock.json"), "{}\n");
  await writeFile(path.join(directory, "dist", "server.js"), corrupt === "syntax" ? "const = ;\n" : "console.log('ok');\n");
  await writeFile(path.join(directory, "scripts", "deploy-release.sh"), "deploy\n");
  await writeFile(path.join(directory, "scripts", "release-manifest.mjs"), await readFile(manifestScript));
  await writeFile(
    path.join(directory, "scripts", "gateway-readiness-probe.mjs"),
    await readFile(path.resolve("scripts/gateway-readiness-probe.mjs")),
  );
  const require = createRequire(import.meta.url);
  const packageRoot = path.resolve(path.dirname(require.resolve("better-sqlite3")), "..");
  const bindingSource = path.join(packageRoot, "build", "Release", "better_sqlite3.node");
  await writeFile(path.join(directory, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), await readFile(bindingSource));
  await writeFile(path.join(directory, "node_modules", "better-sqlite3", "package.json"), JSON.stringify({ main: "lib/index.js" }));
  await mkdir(path.join(directory, "node_modules", "better-sqlite3", "lib"), { recursive: true });
  await writeFile(path.join(directory, "node_modules", "better-sqlite3", "lib", "index.js"), "module.exports = require(" + JSON.stringify(packageRoot) + ");\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "admission", "package.json"), JSON.stringify({ name: "@tagent/admission", type: "module", dependencies: { "@tagent/execution": "0.6.5", "@tagent/governance": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "admission", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "abi", "package.json"), JSON.stringify({ name: "@tagent/abi", type: "module" }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "abi", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "core-service", "package.json"), JSON.stringify({ name: "@tagent/core-service", type: "module", dependencies: { "@tagent/admission": "0.6.5", "@tagent/execution": "0.6.5", "@tagent/governance": "0.6.5", "@tagent/http-fastify": "0.6.5", "@tagent/learning": "0.6.5", "@tagent/memory": "0.6.5", "@tagent/persistence-sqlite": "0.6.5", "@tagent/runtime-pi": "0.6.5", "@tagent/workspace-local": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "core-service", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "governance", "package.json"), JSON.stringify({ name: "@tagent/governance", type: "module" }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "governance", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "http-fastify", "package.json"), JSON.stringify({ name: "@tagent/http-fastify", type: "module", dependencies: { "@tagent/abi": "0.6.5", "@tagent/admission": "0.6.5", "@tagent/execution": "0.6.5", "@tagent/governance": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "http-fastify", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "execution", "package.json"), JSON.stringify({ name: "@tagent/execution", type: "module", dependencies: { "@tagent/governance": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "execution", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "learning", "package.json"), JSON.stringify({ name: "@tagent/learning", type: "module", dependencies: { "@tagent/admission": "0.6.5", "@tagent/execution": "0.6.5", "@tagent/governance": "0.6.5", "@tagent/memory": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "learning", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "memory", "package.json"), JSON.stringify({ name: "@tagent/memory", type: "module" }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "memory", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "memory", "dist", "postgres", "schema.sql"), "SELECT 1;\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "persistence-sqlite", "package.json"), JSON.stringify({ name: "@tagent/persistence-sqlite", type: "module", dependencies: { "@tagent/admission": "0.6.5", "@tagent/execution": "0.6.5", "@tagent/governance": "0.6.5", "@tagent/learning": "0.6.5", "@tagent/memory": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "persistence-sqlite", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "runtime-pi", "package.json"), JSON.stringify({ name: "@tagent/runtime-pi", type: "module", dependencies: { "@tagent/execution": "0.6.5" } }));
  await writeFile(path.join(directory, "node_modules", "@tagent", "runtime-pi", "dist", "index.js"), "export {};\n");
  await writeFile(path.join(directory, "node_modules", "@tagent", "workspace-local", "package.json"), JSON.stringify({ name: "@tagent/workspace-local", type: "module", dependencies: { "@tagent/execution": "0.6.5" } }));
  await writeFile(
    path.join(directory, "node_modules", "@tagent", "workspace-local", "dist", "workspace-fd-helper.py"),
    "#!/usr/bin/env python3\n",
    { mode: 0o755 },
  );
  await writeFile(path.join(directory, "dist", "memory", "postgres", "schema.sql"), "SELECT 1;\n");
  const files: Record<string, string> = {};
  async function add(relative: string) { files[relative] = createHash("sha256").update(await readFile(path.join(directory, relative))).digest("hex"); }
  for (const relative of ["package.json", "package-lock.json", "dist/server.js", "dist/memory/postgres/schema.sql", "scripts/deploy-release.sh", "scripts/release-manifest.mjs", "scripts/gateway-readiness-probe.mjs", "node_modules/better-sqlite3/build/Release/better_sqlite3.node", "node_modules/better-sqlite3/package.json", "node_modules/better-sqlite3/lib/index.js", "node_modules/@tagent/admission/package.json", "node_modules/@tagent/admission/dist/index.js", "node_modules/@tagent/abi/package.json", "node_modules/@tagent/abi/dist/index.js", "node_modules/@tagent/core-service/package.json", "node_modules/@tagent/core-service/dist/index.js", "node_modules/@tagent/governance/package.json", "node_modules/@tagent/governance/dist/index.js", "node_modules/@tagent/http-fastify/package.json", "node_modules/@tagent/http-fastify/dist/index.js", "node_modules/@tagent/execution/package.json", "node_modules/@tagent/execution/dist/index.js", "node_modules/@tagent/learning/package.json", "node_modules/@tagent/learning/dist/index.js", "node_modules/@tagent/memory/package.json", "node_modules/@tagent/memory/dist/index.js", "node_modules/@tagent/memory/dist/postgres/schema.sql", "node_modules/@tagent/persistence-sqlite/package.json", "node_modules/@tagent/persistence-sqlite/dist/index.js", "node_modules/@tagent/runtime-pi/package.json", "node_modules/@tagent/runtime-pi/dist/index.js", "node_modules/@tagent/workspace-local/package.json", "node_modules/@tagent/workspace-local/dist/workspace-fd-helper.py"]) await add(relative);
  if (corrupt === "manifest") files["dist/server.js"] = "0".repeat(64);
  if (corrupt === "native") files["node_modules/better-sqlite3/build/Release/better_sqlite3.node"] = "0".repeat(64);
  await writeFile(path.join(directory, "RELEASE_COMMIT"), `${commit}\n`);
  await writeFile(path.join(directory, "RELEASE_MANIFEST.json"), JSON.stringify({ schemaVersion: 2, commit, runtime: { node: "24.18.1", abi: "137", platform: "linux", arch: "x64" }, files }));
  return directory;
}

async function artifact(root: string, commit: string, corrupt: "native" | "manifest" | "syntax" | null = null) {
  const directory = await releaseDirectory(root, commit, corrupt);
  const tarball = path.join(root, `${commit}.tar.gz`);
  const tar = spawnSync("tar", ["-C", root, "-czf", tarball, path.basename(directory)], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  return tarball;
}

function runManifest(
  fixture: Awaited<ReturnType<typeof deploymentFixture>>,
  command: "create" | "verify",
  directory: string,
) {
  return spawnSync(process.execPath, ["--require", fixture.runtimeShim, manifestScript, command, directory], {
    env: { ...process.env, RELEASE_COMMIT: commit },
    encoding: "utf8",
  });
}

function deploy(fixture: Awaited<ReturnType<typeof deploymentFixture>>, tarball: string) {
  return spawnSync("bash", [deployScript, tarball, fixture.releaseRoot, "tagent-test.service"], {
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, TAGENT_HEALTH_ATTEMPTS: "1", TAGENT_HEALTH_URL: "http://test/api/health" }, encoding: "utf8",
  });
}

const commit = "1".repeat(40);

describe("production release deployment", () => {
  it("publishes both verified artifacts from the tag release workflow", async () => {
    const source = await readFile(releaseWorkflow, "utf8");
    expect(source).toContain("tagent-core-${RELEASE_TAG}-linux-x64-node24-abi137.tar.gz");
    expect(source).toContain("tagent-web-console-${RELEASE_TAG}.tar.gz");
    expect(source).toContain("--verify-tag");
    expect(source).not.toContain("RELEASE_COMMIT: ${{ github.sha }}");
    await expect(readFile(path.resolve(".github/workflows/production-artifact.yml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds the Memory workspace before standalone PostgreSQL integration gates", async () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const source = await readFile(workflow, "utf8");
      const build = source.indexOf("npm run build -w @tagent/memory");
      const integration = source.indexOf("npx vitest run tests/postgres-memory.test.ts");
      expect(build, workflow).toBeGreaterThanOrEqual(0);
      expect(integration, workflow).toBeGreaterThan(build);
    }
  });

  it("binds release provenance to the checked-out Git HEAD", async () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const mismatchedCommit = `${head.startsWith("0") ? "1" : "0"}${head.slice(1)}`;
    const result = spawnSync("bash", [buildScript], {
      env: { ...process.env, RELEASE_COMMIT: mismatchedCommit },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`RELEASE_COMMIT must equal checked-out HEAD ${head}`);
  });

  it("uses the canonical v1 health endpoint by default", async () => {
    expect(await readFile(deployScript, "utf8")).toContain("http://127.0.0.1:3100/api/v1/health");
  });

  it("discovers, validates, and materializes only the Core production workspace closure", async () => {
    const source = await readFile(buildScript, "utf8");
    expect(source).toContain("npm query .workspace --json");
    expect(source).toContain("Object.keys(root.dependencies ?? {})");
    expect(source).toContain("workspace.dependencies ?? {}");
    expect(source).toContain('rm -rf "$core_release/node_modules/@tagent"');
    expect(source).not.toContain("for workspace in abi core-client execution memory");
    expect(source).toContain('[[ -f "$source/package.json" ]]');
    expect(source).toContain('[[ -d "$source/dist" ]]');
    expect(source).toContain('[[ -L "$PWD/node_modules/$package_name" ]]');
    expect(source).toContain('cp -a "$source/package.json" "$source/dist" "$target/"');
    expect(source).toContain('install_root="$work/production-install"');
    expect(source).toContain('cd "$install_root"');
    expect(source).toContain("npm ci --omit=dev --workspace @tagent/core-service --include-workspace-root");
    expect(source).not.toContain("npm prune");
    expect(source).toContain('find "$core_release/node_modules" -type d -name .bin -prune -exec rm -rf {} +');
    expect(source).toContain('find "$core_release" -type l -print > "$release_links"');
    expect(source.indexOf('cp -a "$source/package.json"')).toBeLessThan(source.indexOf('find "$core_release/node_modules" -type d -name .bin'));
    expect(source.indexOf('find "$core_release/node_modules" -type d -name .bin')).toBeLessThan(source.indexOf('find "$core_release" -type l'));
    expect(source.indexOf('find "$core_release" -type l')).toBeLessThan(source.indexOf('RELEASE_COMMIT="$commit"'));
    expect(source.indexOf('find "$core_release" -type l')).toBeLessThan(source.indexOf('tar -C "$work" -czf'));
  });

  it("accepts a materialized release made only of regular files and directories", async () => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    const result = runManifest(fixture, "verify", directory);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["create", "verify"] as const)("rejects an arbitrary non-.bin symlink during manifest %s and reports its release path", async (command) => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    await symlink("server.js", path.join(directory, "dist", "server-alias.js"));
    const result = runManifest(fixture, command, directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symbolic links are forbidden in releases: dist/server-alias.js -> server.js");
  });

  it.each([
    ["RELEASE_COMMIT", "create"],
    ["RELEASE_COMMIT", "verify"],
    ["RELEASE_MANIFEST.json", "create"],
    ["RELEASE_MANIFEST.json", "verify"],
  ] as const)("rejects generated root symlink %s during manifest %s", async (generatedName, command) => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    await rm(path.join(directory, generatedName));
    await symlink("package.json", path.join(directory, generatedName));
    const result = runManifest(fixture, command, directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`symbolic links are forbidden in releases: ${generatedName} -> package.json`);
  });

  it.each(["create", "verify"] as const)("rejects OMX runtime state during manifest %s", async (command) => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    await mkdir(path.join(directory, ".omx"), { recursive: true });
    await writeFile(path.join(directory, ".omx", "state.json"), "{}\n");
    const result = runManifest(fixture, command, directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Release artifacts must not contain OMX runtime state");
  });

  it.each(["create", "verify"] as const)("rejects a non-production internal package during manifest %s", async (command) => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    const target = path.join(directory, "node_modules", "@tagent", "core-client");
    await mkdir(path.join(target, "dist"), { recursive: true });
    await writeFile(path.join(target, "package.json"), JSON.stringify({ name: "@tagent/core-client" }));
    await writeFile(path.join(target, "dist", "index.js"), "export {};\n");
    const result = runManifest(fixture, command, directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-production internal package is materialized: node_modules/@tagent/core-client");
  });

  it("rejects a residual workspace symlink before package or checksum verification", async () => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    const execution = path.join(directory, "node_modules", "@tagent", "execution");
    await rm(execution, { recursive: true });
    await symlink("abi", execution);
    const result = runManifest(fixture, "verify", directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symbolic links are forbidden in releases: node_modules/@tagent/execution -> abi");
  });

  it("rejects a missing internal workspace materialization", async () => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    await rm(path.join(directory, "node_modules", "@tagent", "execution"), { recursive: true });
    const result = runManifest(fixture, "verify", directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing materialized internal package: node_modules/@tagent/execution");
  });

  it("rejects a materialized workspace without compiled dist", async () => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    await rm(path.join(directory, "node_modules", "@tagent", "execution", "dist"), { recursive: true });
    const result = runManifest(fixture, "verify", directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("materialized workspace dist is missing: node_modules/@tagent/execution/dist");
  });

  it("requires the materialized workspace-local helper asset", async () => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    const helper = path.join(directory, "node_modules", "@tagent", "workspace-local", "dist", "workspace-fd-helper.py");
    await rm(helper);
    await writeFile(path.join(path.dirname(helper), "index.js"), "export {};\n");
    const result = runManifest(fixture, "verify", directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required release file is missing: node_modules/@tagent/workspace-local/dist/workspace-fd-helper.py");
  });

  it("rejects a symlinked workspace-local helper asset", async () => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    const helper = path.join(directory, "node_modules", "@tagent", "workspace-local", "dist", "workspace-fd-helper.py");
    await rm(helper);
    await symlink("../package.json", helper);
    const result = runManifest(fixture, "verify", directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symbolic links are forbidden in releases: node_modules/@tagent/workspace-local/dist/workspace-fd-helper.py");
  });

  it.each([
    ["non-executable", async (helper: string) => chmod(helper, 0o644), "workspace helper is not executable"],
    ["invalid-protocol", async (helper: string) => writeFile(helper, "print('invalid')\n"), "workspace helper has an invalid executable protocol"],
  ] as const)("rejects a %s workspace-local helper asset", async (_kind, mutate, message) => {
    const fixture = await deploymentFixture();
    const directory = await releaseDirectory(fixture.root, commit);
    const helper = path.join(directory, "node_modules", "@tagent", "workspace-local", "dist", "workspace-fd-helper.py");
    await mutate(helper);
    const result = runManifest(fixture, "verify", directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
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
    await expect(readFile(path.join(fixture.releaseRoot, "releases", commit, "RELEASE_COMMIT"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["restart", { restart: "fail" as const }],
    ["health", { health: "fail" as const }],
  ])("clears current, stops Core, and permits retry after a first-install %s failure", async (_kind, failure) => {
    const fixture = await deploymentFixture({ ...failure, existingRelease: false });
    const result = deploy(fixture, await artifact(fixture.root, commit));
    expect(result.status).not.toBe(0);
    await expect(readlink(path.join(fixture.releaseRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(fixture.releaseRoot, "releases", commit, "RELEASE_COMMIT"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.log, "utf8")).toContain("systemctl:stop");
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
