#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(repositoryRoot, process.argv[2] ?? "dist/sdk");
const stagingDirectory = mkdtempSync(path.join(tmpdir(), "tagent-sdk-release-"));

const packages = [
  { directory: "packages/abi", name: "@tagent/abi", archiveStem: "tagent-abi" },
  { directory: "packages/core-client", name: "@tagent/core-client", archiveStem: "tagent-core-client" },
];

function fail(message) {
  throw new Error(`[build-sdk-release] ${message}`);
}

function manifestAt(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const absolute = path.join(directory, name);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function validateCompiledPackage(packageDirectory) {
  const dist = path.join(repositoryRoot, packageDirectory, "dist");
  if (!existsSync(dist)) fail(`${packageDirectory}/dist is missing`);
  const relativeFiles = filesUnder(dist).map((file) => path.relative(dist, file).split(path.sep).join("/"));
  const javascript = relativeFiles.filter((file) => file.endsWith(".js"));
  const declarations = relativeFiles.filter((file) => file.endsWith(".d.ts"));
  if (javascript.length === 0 || declarations.length === 0) {
    fail(`${packageDirectory} must contain JavaScript and TypeScript declarations`);
  }
  for (const file of javascript) {
    if (!relativeFiles.includes(`${file}.map`)) fail(`${packageDirectory}/dist/${file}.map is missing`);
  }
  for (const file of declarations) {
    if (!relativeFiles.includes(`${file}.map`)) fail(`${packageDirectory}/dist/${file}.map is missing`);
  }
}

function verifyArchive(archive, packageName, version) {
  const entries = run("tar", ["-tzf", archive]).trim().split("\n").filter(Boolean);
  for (const required of ["package/package.json", "package/dist/index.js", "package/dist/index.js.map", "package/dist/index.d.ts", "package/dist/index.d.ts.map"]) {
    if (!entries.includes(required)) fail(`${path.basename(archive)} is missing ${required}`);
  }
  if (entries.some((entry) => entry.endsWith(".tsbuildinfo"))) {
    fail(`${path.basename(archive)} contains a TypeScript build cache`);
  }
  const packedManifest = JSON.parse(run("tar", ["-xOzf", archive, "package/package.json"]));
  if (packedManifest.name !== packageName || packedManifest.version !== version) {
    fail(`${path.basename(archive)} manifest identity does not match ${packageName}@${version}`);
  }
}

function writeChecksum(archive) {
  const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`, "utf8");
}

function smokeTest(archives) {
  const smoke = path.join(stagingDirectory, "smoke");
  mkdirSync(smoke);
  writeFileSync(path.join(smoke, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    ...archives,
  ], { cwd: smoke, timeout: 120_000 });
  writeFileSync(path.join(smoke, "smoke.mjs"), `
    import { CoreClient } from "@tagent/core-client";
    import { CapabilityProfileRegistryResponseSchema } from "@tagent/abi/profiles/v1";
    import { operatorSkillFixture } from "@tagent/abi/operator/skills-v1";
    import { adminMemoryStatusFixture } from "@tagent/abi/admin/profiles-v1";
    if (typeof CoreClient !== "function" || !CapabilityProfileRegistryResponseSchema || !operatorSkillFixture || !adminMemoryStatusFixture) {
      throw new Error("SDK runtime exports are incomplete");
    }
    new CoreClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 100 });
  `, "utf8");
  run(process.execPath, [path.join(smoke, "smoke.mjs")], { cwd: smoke });
  writeFileSync(path.join(smoke, "smoke.ts"), `
    import { CoreClient, type CoreCallOptions } from "@tagent/core-client";
    import type { CapabilityProfileRegistryResponse } from "@tagent/abi/profiles/v1";
    const options: CoreCallOptions = { timeoutMs: 100 };
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:1" });
    const document: CapabilityProfileRegistryResponse | undefined = undefined;
    void [client, options, document];
  `, "utf8");
  writeFileSync(path.join(smoke, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: false,
      strict: true,
      target: "ES2022",
    },
    files: ["smoke.ts"],
  }), "utf8");
  run(process.execPath, [path.join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(smoke, "tsconfig.json")], {
    cwd: smoke,
    timeout: 120_000,
  });
}

try {
  const rootVersion = manifestAt("package.json").version;
  for (const item of packages) {
    const manifest = manifestAt(`${item.directory}/package.json`);
    if (manifest.name !== item.name) fail(`${item.directory} has unexpected package name ${manifest.name}`);
    if (manifest.version !== rootVersion) {
      fail(`${item.name} version ${manifest.version} does not match Core ${rootVersion}`);
    }
  }

  run("npm", ["run", "build", "-w", "@tagent/abi"]);
  run("npm", ["run", "build", "-w", "@tagent/core-client"]);
  mkdirSync(outputDirectory, { recursive: true });

  const archives = [];
  for (const item of packages) {
    validateCompiledPackage(item.directory);
    const packResult = JSON.parse(run("npm", ["pack", path.join(repositoryRoot, item.directory), "--json", "--pack-destination", stagingDirectory]));
    const packed = Array.isArray(packResult) ? packResult[0] : packResult[item.name];
    const generated = path.join(stagingDirectory, packed?.filename ?? "");
    if (!existsSync(generated)) fail(`npm pack did not create an archive for ${item.name}`);
    const archive = path.join(outputDirectory, `${item.archiveStem}-${rootVersion}.tgz`);
    const stagedArchive = path.join(stagingDirectory, `${item.archiveStem}-${rootVersion}.tgz`);
    if (generated !== stagedArchive) renameSync(generated, stagedArchive);
    verifyArchive(stagedArchive, item.name, rootVersion);
    copyFileSync(stagedArchive, archive);
    writeChecksum(archive);
    archives.push(archive);
  }
  smokeTest(archives);
  for (const archive of archives) process.stdout.write(`${archive}\n${archive}.sha256\n`);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}
