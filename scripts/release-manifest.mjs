#!/usr/bin/env node
/* global console */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const root = path.resolve(process.argv[3] ?? ".");
const manifestPath = path.join(root, "RELEASE_MANIFEST.json");
const requiredRuntime = { node: "24.18.1", abi: "137", platform: "linux", arch: "x64" };
const trackedFiles = [
  "package.json",
  "package-lock.json",
  "dist/server.js",
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
];

function fail(message) {
  console.error(`[release-verify] ${message}`);
  process.exit(1);
}

async function sha256(relativePath) {
  const content = await readFile(path.join(root, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

function assertRuntime(expected = requiredRuntime) {
  const actual = {
    node: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      fail(`incompatible ${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
  }
}

async function verifyNativeModule() {
  const binding = trackedFiles[3];
  if (!existsSync(path.join(root, binding))) fail(`missing native binding: ${binding}`);
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
  for (const file of trackedFiles) {
    if (!existsSync(path.join(root, file))) fail(`required release file is missing: ${file}`);
  }
  await verifyNativeModule();
  const files = Object.fromEntries(await Promise.all(trackedFiles.map(async (file) => [file, await sha256(file)])));
  const manifest = {
    schemaVersion: 1,
    commit,
    runtime: requiredRuntime,
    files,
  };
  await writeFile(path.join(root, "RELEASE_COMMIT"), `${commit}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[release-verify] created manifest for ${commit}`);
}

async function verifyManifest() {
  if (!existsSync(manifestPath)) fail("RELEASE_MANIFEST.json is missing");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`invalid release manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.schemaVersion !== 1) fail(`unsupported manifest schema: ${manifest.schemaVersion}`);
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) fail("manifest commit is invalid");
  assertRuntime(manifest.runtime);
  const commitFile = (await readFile(path.join(root, "RELEASE_COMMIT"), "utf8")).trim();
  if (commitFile !== manifest.commit) fail(`commit marker mismatch: manifest=${manifest.commit}, file=${commitFile}`);
  const expectedFiles = Object.keys(manifest.files ?? {}).sort();
  if (expectedFiles.join("\n") !== [...trackedFiles].sort().join("\n")) fail("manifest file set is incomplete or unexpected");
  for (const file of trackedFiles) {
    if (!existsSync(path.join(root, file))) fail(`required release file is missing: ${file}`);
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
