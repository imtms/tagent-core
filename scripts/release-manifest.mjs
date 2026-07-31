#!/usr/bin/env node
/* global console */
import { createHash } from "node:crypto";
import { readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const root = path.resolve(process.argv[3] ?? ".");
const manifestPath = path.join(root, "RELEASE_MANIFEST.json");
const requiredRuntime = { node: "24.18.1", abi: "137", platform: "linux", arch: "x64" };
const generatedFiles = new Set(["RELEASE_COMMIT", "RELEASE_MANIFEST.json"]);
const nativeBinding = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";

function fail(message) {
  console.error(`[release-verify] ${message}`);
  process.exit(1);
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
    if (prefix === "" && generatedFiles.has(relative)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = path.resolve(path.dirname(absolute), target);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail(`symlink escapes release root: ${relative} -> ${target}`);
      fail(`release symlinks are not supported: ${relative}`);
    }
    if (entry.isDirectory()) files.push(...await listReleaseFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else fail(`unsupported release entry: ${relative}`);
  }
  return files.sort();
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
  assertRuntime();
  const commit = process.env.RELEASE_COMMIT?.trim();
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) fail("RELEASE_COMMIT must be a full 40-character Git commit");
  const releaseFiles = await listReleaseFiles();
  for (const required of ["package.json", "package-lock.json", "dist/server.js", nativeBinding, "scripts/release-manifest.mjs", "scripts/deploy-release.sh"]) {
    if (!releaseFiles.includes(required)) fail(`required release file is missing: ${required}`);
  }
  await verifyNativeModule();
  const files = Object.fromEntries(await Promise.all(releaseFiles.map(async (file) => [file, await sha256(file)])));
  await writeFile(path.join(root, "RELEASE_COMMIT"), `${commit}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 2, commit, runtime: requiredRuntime, files }, null, 2)}\n`, "utf8");
  console.log(`[release-verify] created manifest for ${commit}`);
}

async function verifyManifest() {
  if (!existsSync(manifestPath)) fail("RELEASE_MANIFEST.json is missing");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { fail(`invalid release manifest: ${error instanceof Error ? error.message : String(error)}`); }
  if (manifest.schemaVersion !== 2) fail(`unsupported manifest schema: ${manifest.schemaVersion}`);
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) fail("manifest commit is invalid");
  assertRuntime(manifest.runtime);
  const commitFile = (await readFile(path.join(root, "RELEASE_COMMIT"), "utf8")).trim();
  if (commitFile !== manifest.commit) fail(`commit marker mismatch: manifest=${manifest.commit}, file=${commitFile}`);
  const actualFiles = await listReleaseFiles();
  const expectedFiles = Object.keys(manifest.files ?? {}).sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) fail("manifest file set does not match the release contents");
  for (const file of actualFiles) {
    const actual = await sha256(file);
    if (actual !== manifest.files[file]) fail(`checksum mismatch for ${file}: expected ${manifest.files[file]}, got ${actual}`);
  }
  await verifyNativeModule();
  console.log(`[release-verify] release ${manifest.commit} is compatible and internally consistent`);
}

const command = process.argv[2];
if (command === "create") await createManifest();
else if (command === "verify") await verifyManifest();
else fail("usage: release-manifest.mjs <create|verify> [release-directory]");
