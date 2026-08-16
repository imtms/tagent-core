#!/usr/bin/env node
/* global console */
import { createHash } from "node:crypto";
import { readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const root = path.resolve(process.argv[3] ?? ".");
const manifestPath = path.join(root, "RELEASE_MANIFEST.json");
const requiredRuntime = { node: "24.18.1", abi: "137", platform: "linux", arch: "x64" };
const generatedFiles = new Set(["RELEASE_COMMIT", "RELEASE_MANIFEST.json"]);
const nativeBinding = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";
const workspaceHelper = "node_modules/@tagent/workspace-local/dist/workspace-fd-helper.py";
const coreRequiredReleaseFiles = [
  "package.json",
  "package-lock.json",
  "dist/host.js",
  "node_modules/@tagent/core-service/dist/host.js",
  "node_modules/@tagent/core-service/dist/generation-entry.js",
  nativeBinding,
  workspaceHelper,
  "node_modules/@tagent/memory/dist/postgres/schema.sql",
  "dist/memory/postgres/schema.sql",
  "scripts/release-manifest.mjs",
  "scripts/deploy-release.sh",
  "scripts/gateway-readiness-probe.mjs",
];
const webRequiredReleaseFiles = [
  "package.json",
  "dist/index.html",
  "scripts/release-manifest.mjs",
];
const coreContract = Object.freeze({
  hostProtocolVersion: 1,
  stateProtocol: "tagent-core/state-0.8-r2",
  generationEntry: "node_modules/@tagent/core-service/dist/generation-entry.js",
});

function fail(message) {
  console.error(`[release-verify] ${message}`);
  process.exit(1);
}

function releaseArtifact(value) {
  const artifact = value || "core";
  if (artifact !== "core" && artifact !== "web-console") fail(`unsupported release artifact: ${artifact}`);
  return artifact;
}

function assertArtifactBoundary(files, artifact) {
  if (files.some((file) => file === ".omx" || file.startsWith(".omx/"))) {
    fail("Release artifacts must not contain OMX runtime state");
  }
  if (artifact === "core") {
    if (files.some((file) => file.startsWith("dist/web/") || file.startsWith("node_modules/@tagent/web-console/"))) {
      fail("Core release must not contain the Web Console");
    }
    return;
  }
  const webReleaseRoots = new Set(["package.json", "scripts/release-manifest.mjs"]);
  const unexpected = files.find((file) => !webReleaseRoots.has(file) && !file.startsWith("dist/"));
  if (unexpected) {
    fail(`Web Console release contains a non-whitelisted file: ${unexpected}`);
  }
}

async function sha256(relativePath) {
  const content = await readFile(path.join(root, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

function assertRuntime(expected = requiredRuntime) {
  const actual = { node: process.versions.node, abi: process.versions.modules, platform: process.platform, arch: process.arch };
  for (const key of Object.keys(expected)) if (actual[key] !== expected[key]) fail(`incompatible ${key}: expected ${expected[key]}, got ${actual[key]}`);
}

async function listReleaseFiles(directory = root, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolute);
      fail(`symbolic links are forbidden in releases: ${relative} -> ${target}`);
    }
    if (prefix === "" && generatedFiles.has(relative)) {
      if (!entry.isFile()) fail(`unsupported release entry: ${relative}`);
      continue;
    }
    if (entry.isDirectory()) files.push(...await listReleaseFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else fail(`unsupported release entry: ${relative}`);
  }
  return files.sort();
}

async function assertMaterializedInternalPackages() {
  const rootManifestPath = path.join(root, "package.json");
  let rootManifest;
  try { rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8")); }
  catch (error) { fail(`invalid root package.json: ${error instanceof Error ? error.message : String(error)}`); }

  const rootDependencies = Object.keys(rootManifest.dependencies ?? {}).filter((name) => name.startsWith("@tagent/")).sort();
  const scopePath = path.join(root, "node_modules", "@tagent");
  if (!existsSync(scopePath)) {
    if (rootDependencies.length > 0) fail("missing materialized internal package scope: node_modules/@tagent");
    return;
  }

  const entries = await readdir(scopePath, { withFileTypes: true });
  const materializedPackages = new Map(entries.map((entry) => [`@tagent/${entry.name}`, entry]));
  for (const entry of entries) {
    const relativeRoot = path.posix.join("node_modules", "@tagent", entry.name);
    if (!entry.isDirectory()) fail(`internal package is not a regular directory: ${relativeRoot}`);
  }

  const pending = [...rootDependencies];
  const requiredPackages = new Set();
  while (pending.length > 0) {
    const packageName = pending.pop();
    if (requiredPackages.has(packageName)) continue;
    const entry = materializedPackages.get(packageName);
    if (!entry) fail(`missing materialized internal package: node_modules/${packageName}`);
    requiredPackages.add(packageName);
    const relativeRoot = path.posix.join("node_modules", "@tagent", entry.name);
    const packageManifestPath = path.join(scopePath, entry.name, "package.json");
    const distPath = path.join(scopePath, entry.name, "dist");
    if (!existsSync(packageManifestPath)) fail(`materialized workspace package.json is missing: ${relativeRoot}/package.json`);
    if (!existsSync(distPath)) fail(`materialized workspace dist is missing: ${relativeRoot}/dist`);
    let packageManifest;
    try { packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8")); }
    catch (error) { fail(`invalid materialized workspace package.json: ${relativeRoot}/package.json: ${error instanceof Error ? error.message : String(error)}`); }
    if (packageManifest.name !== packageName) {
      fail(`materialized workspace name mismatch: expected ${packageName}, got ${String(packageManifest.name)}`);
    }
    pending.push(...Object.keys(packageManifest.dependencies ?? {}).filter((name) => name.startsWith("@tagent/")));
    let compiledFiles;
    try { compiledFiles = await readdir(distPath); }
    catch (error) { fail(`invalid materialized workspace dist: ${relativeRoot}/dist: ${error instanceof Error ? error.message : String(error)}`); }
    if (compiledFiles.length === 0) fail(`materialized workspace dist is empty: ${relativeRoot}/dist`);
  }
  for (const packageName of materializedPackages.keys()) {
    if (!requiredPackages.has(packageName)) fail(`non-production internal package is materialized: node_modules/${packageName}`);
  }
}

async function assertWorkspaceHelper() {
  const absolute = path.join(root, workspaceHelper);
  let metadata;
  try { metadata = await stat(absolute); }
  catch { fail(`missing workspace helper: ${workspaceHelper}`); }
  if (!metadata.isFile()) fail(`workspace helper is not a regular file: ${workspaceHelper}`);
  if ((metadata.mode & 0o111) === 0) fail(`workspace helper is not executable: ${workspaceHelper}`);
  const source = await readFile(absolute, "utf8");
  if (!source.startsWith("#!/usr/bin/env python3\n")) fail(`workspace helper has an invalid executable protocol: ${workspaceHelper}`);
}

async function verifyNativeModule() {
  if (!existsSync(path.join(root, nativeBinding))) fail(`missing native binding: ${nativeBinding}`);
  try {
    const require = createRequire(path.join(root, "package.json"));
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.exec("SELECT 1");
    database.close();
  } catch (error) {
    fail(`better-sqlite3 smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createManifest() {
  const artifact = releaseArtifact(process.env.RELEASE_ARTIFACT);
  if (artifact === "core") assertRuntime();
  const commit = process.env.RELEASE_COMMIT?.trim();
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) fail("RELEASE_COMMIT must be a full 40-character Git commit");
  const releaseFiles = await listReleaseFiles();
  assertArtifactBoundary(releaseFiles, artifact);
  if (artifact === "core") await assertMaterializedInternalPackages();
  const requiredReleaseFiles = artifact === "core" ? coreRequiredReleaseFiles : webRequiredReleaseFiles;
  for (const required of requiredReleaseFiles) {
    if (!releaseFiles.includes(required)) fail(`required release file is missing: ${required}`);
  }
  if (artifact === "core") {
    await assertWorkspaceHelper();
    await verifyNativeModule();
  }
  const files = Object.fromEntries(await Promise.all(releaseFiles.map(async (file) => [file, await sha256(file)])));
  await writeFile(path.join(root, "RELEASE_COMMIT"), `${commit}\n`, "utf8");
  const manifest = artifact === "core"
    ? { schemaVersion: 2, artifact, commit, runtime: requiredRuntime, core: coreContract, files }
    : { schemaVersion: 2, artifact, commit, files };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[release-verify] created ${artifact} manifest for ${commit}`);
}

async function verifyManifest() {
  const actualFiles = await listReleaseFiles();
  if (!existsSync(manifestPath)) fail("RELEASE_MANIFEST.json is missing");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { fail(`invalid release manifest: ${error instanceof Error ? error.message : String(error)}`); }
  if (manifest.schemaVersion !== 2) fail(`unsupported manifest schema: ${manifest.schemaVersion}`);
  const artifact = releaseArtifact(manifest.artifact);
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) fail("manifest commit is invalid");
  if (artifact === "core") {
    assertRuntime(manifest.runtime);
    if (JSON.stringify(manifest.core) !== JSON.stringify(coreContract)) {
      fail("Core Host/state protocol contract is missing or incompatible");
    }
  }
  const commitFile = (await readFile(path.join(root, "RELEASE_COMMIT"), "utf8")).trim();
  if (commitFile !== manifest.commit) fail(`commit marker mismatch: manifest=${manifest.commit}, file=${commitFile}`);
  assertArtifactBoundary(actualFiles, artifact);
  if (artifact === "core") await assertMaterializedInternalPackages();
  const requiredReleaseFiles = artifact === "core" ? coreRequiredReleaseFiles : webRequiredReleaseFiles;
  for (const required of requiredReleaseFiles) {
    if (!actualFiles.includes(required)) fail(`required release file is missing: ${required}`);
  }
  if (artifact === "core") await assertWorkspaceHelper();
  const expectedFiles = Object.keys(manifest.files ?? {}).sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) fail("manifest file set does not match the release contents");
  for (const file of actualFiles) {
    const actual = await sha256(file);
    if (actual !== manifest.files[file]) fail(`checksum mismatch for ${file}: expected ${manifest.files[file]}, got ${actual}`);
  }
  if (artifact === "core") await verifyNativeModule();
  console.log(`[release-verify] ${artifact} release ${manifest.commit} is compatible and internally consistent`);
}

const command = process.argv[2];
if (command === "create") await createManifest();
else if (command === "verify") await verifyManifest();
else fail("usage: release-manifest.mjs <create|verify> [release-directory]");
