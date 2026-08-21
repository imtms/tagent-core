import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@tagent/core-service/config";

const repoRoot = process.cwd();
const packageRoot = "apps/core-service";
const sourceRoot = `${packageRoot}/src`;
const expectedExports = [".", "./application", "./composition", "./config", "./host"];
const expectedDependencies = {
  "@tagent/admission": "0.8.21",
  "@tagent/execution": "0.8.21",
  "@tagent/governance": "0.8.21",
  "@tagent/http-fastify": "0.8.21",
  "@tagent/memory": "0.8.21",
  "@tagent/persistence-sqlite": "0.8.21",
  "@tagent/runtime-pi": "0.8.21",
  "@tagent/workspace-local": "0.8.21",
  "fflate": "^0.8.2",
  "yaml": "^2.9.0",
};

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  dependencies: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
  bin?: Record<string, string>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    if (entry === "dist" || entry === "node_modules") return [];
    const relativePath = path.join(relativeRoot, entry);
    const absolutePath = path.join(repoRoot, relativePath);
    return statSync(absolutePath).isDirectory()
      ? sourceFiles(relativePath)
      : /\.tsx?$/.test(entry) ? [relativePath] : [];
  }).sort();
}

function parsedSource(relativePath: string) {
  return ts.createSourceFile(
    relativePath,
    readFileSync(path.join(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function moduleSpecifiers(relativePath: string): string[] {
  const source = parsedSource(relativePath);
  const specifiers: string[] = [];
  const add = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.push(node.text);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function workspaceManifests(): Array<[string, PackageManifest]> {
  return ["packages", "adapters", "apps"].flatMap((group) => {
    const absoluteGroup = path.join(repoRoot, group);
    if (!existsSync(absoluteGroup)) return [];
    return readdirSync(absoluteGroup, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const relativePath = path.join(group, entry.name, "package.json");
        return existsSync(path.join(repoRoot, relativePath))
          ? [[relativePath, readJson<PackageManifest>(relativePath)] as [string, PackageManifest]]
          : [];
      });
  });
}

describe("Core service application workspace package", () => {
  it("requires service authentication before binding Core beyond loopback", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
      expect(loadConfig({ HOST: host })).toMatchObject({ host, serviceCredentials: [] });
    }
    for (const host of ["0.0.0.0", "::", "192.0.2.10", "core.internal"]) {
      expect(() => loadConfig({ HOST: host })).toThrow(
        "TAGENT_SERVICE_CREDENTIALS is required when HOST is not loopback",
      );
    }

    const serviceCredentials = JSON.stringify([{
      token: "release-review-service-token",
      scopes: ["sessions:read"],
    }]);
    expect(loadConfig({ HOST: "0.0.0.0", TAGENT_SERVICE_CREDENTIALS: serviceCredentials }))
      .toMatchObject({
        host: "0.0.0.0",
        serviceCredentials: [{
          token: "release-review-service-token",
          scopes: ["sessions:read"],
        }],
      });
  });

  it("publishes the private process App and Host through five explicit compiled ABI entries", () => {
    const root = readJson<{ workspaces: string[]; dependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    expect(manifest).toMatchObject({ name: "@tagent/core-service", version: "0.8.21", private: true });
    expect(root.workspaces).toContain("apps/*");
    expect(root.dependencies[manifest.name]).toBe(manifest.version);
    expect(root.dependencies).toEqual({
      "@tagent/core-service": "0.8.21",
      "better-sqlite3": "12.4.1",
    });
    expect(Object.keys(manifest.exports).sort()).toEqual(expectedExports);
    expect(manifest.dependencies).toEqual(expectedDependencies);
    expect(manifest.bin).toEqual({ "tagent-core-service": "./dist/cli.js" });
    for (const target of Object.values(manifest.exports)) {
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("@tagent/core-service");
    expect(root.scripts.clean).toContain("@tagent/core-service");
    expect(root.scripts["dev:server"]).toBe("TAGENT_RELEASE_ROOT=. tsx watch apps/core-service/src/cli.ts");
    expect(root.scripts.start).toBe("node dist/host.js");
    expect(readFileSync(path.join(repoRoot, packageRoot, "dist", "cli.js"), "utf8"))
      .toMatch(/^#!\/usr\/bin\/env node/);
  });

  it("exposes only the Host as a system entrypoint", () => {
    const hostPath = "src/host.ts";
    const hostText = readFileSync(path.join(repoRoot, hostPath), "utf8");
    expect(moduleSpecifiers(hostPath).sort()).toEqual([
      "@tagent/core-service/host",
      "node:path",
      "node:url",
    ]);
    expect(hostText).toContain("runCoreHostFromCli");
    expect(hostText).not.toMatch(/\b(?:Store|CoreLifecycle|createApp|bootstrapCore)\b/);

    const server = readFileSync(path.join(repoRoot, sourceRoot, "server.ts"), "utf8");
    const cli = readFileSync(path.join(repoRoot, sourceRoot, "cli.ts"), "utf8");
    const generationEntry = readFileSync(path.join(repoRoot, sourceRoot, "generation-entry.ts"), "utf8");
    const generationCli = readFileSync(path.join(repoRoot, sourceRoot, "generation-cli.ts"), "utf8");
    const publicIndex = readFileSync(path.join(repoRoot, sourceRoot, "index.ts"), "utf8");
    expect(server).not.toContain("process.argv[1]");
    expect(server).not.toContain("import.meta.url");
    expect(cli).toContain("runCoreHostFromCli");
    expect(cli).not.toContain("runCoreServiceFromCli");
    expect((generationEntry.match(/runCoreServiceFromCli\(\)/g) ?? [])).toHaveLength(1);
    expect(generationEntry).toContain('process.env.TAGENT_HOST_MANAGED !== "1"');
    expect(generationEntry).toContain('typeof process.send !== "function"');
    expect(generationEntry).toContain("process.exit(1)");
    expect(generationCli).toContain("process.exit(0)");
    expect(publicIndex).not.toContain("runCoreServiceFromCli");

    const directGeneration = spawnSync(
      process.execPath,
      [path.join(repoRoot, packageRoot, "dist", "generation-entry.js")],
      { encoding: "utf8", env: { ...process.env, TAGENT_HOST_MANAGED: "1" } },
    );
    expect(directGeneration.status).toBe(1);
    expect(directGeneration.stderr).toContain("must be started by the Core Host");
  });

  it("keeps Host supervision independent from Generation composition and persistence", () => {
    const hostImports = moduleSpecifiers(`${sourceRoot}/host.ts`);
    expect([...new Set(hostImports.filter((specifier) => !specifier.startsWith("node:")))])
      .toEqual([
        "./generation-protocol.js",
        "./host-generation-session.js",
        "./host-state-store.js",
        "./host-release-registry.js",
      ]);
    expect(moduleSpecifiers(`${sourceRoot}/generation-protocol.ts`)).toEqual([]);
    expect(moduleSpecifiers(`${sourceRoot}/host-generation-session.ts`).filter((specifier) => !specifier.startsWith("node:")))
      .toEqual(["./generation-protocol.js", "./host-release-registry.js"]);
    expect(moduleSpecifiers(`${sourceRoot}/host-state-store.ts`).filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
    expect(moduleSpecifiers(`${sourceRoot}/host-release-registry.ts`).filter((specifier) => !specifier.startsWith("node:")))
      .toEqual(["./generation-protocol.js"]);
    for (const filename of ["host.ts", "host-generation-session.ts", "host-state-store.ts", "host-release-registry.ts"]) {
      expect(readFileSync(path.join(repoRoot, sourceRoot, filename), "utf8"))
        .not.toMatch(/@tagent\/|\.\/composition|\.\/server|sqlite|\bStore\b|bootstrapCore/);
    }
    expect(readFileSync(path.join(repoRoot, sourceRoot, "composition", "generation-host-bridge.ts"), "utf8"))
      .not.toContain("../host.js");
    expect(readFileSync(path.join(repoRoot, sourceRoot, "server.ts"), "utf8"))
      .not.toMatch(/GenerationHostBridge|ManagedGenerationAdapter|generation-protocol|\.\/host\.js/);
  });

  it("uses only declared public workspace ABIs and has no reverse package or adapter dependency", () => {
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    const declared = new Set(Object.keys(manifest.dependencies));
    const appRoot = path.resolve(repoRoot, sourceRoot);
    const violations: string[] = [];
    for (const relativePath of sourceFiles(sourceRoot)) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(repoRoot, path.dirname(relativePath), specifier);
          if (resolved !== appRoot && !resolved.startsWith(`${appRoot}${path.sep}`)) {
            violations.push(`${relativePath} escapes to ${specifier}`);
          }
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        if (specifier.includes("/src/")) violations.push(`${relativePath} deep-imports ${specifier}`);
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!declared.has(packageName)) violations.push(`${relativePath} imports undeclared ${specifier}`);
      }
    }
    for (const [manifestPath, candidate] of workspaceManifests()) {
      if (candidate.name === "@tagent/core-service") continue;
      if (candidate.dependencies?.["@tagent/core-service"]) {
        violations.push(`${manifestPath} depends on @tagent/core-service`);
      }
      const candidateRoot = path.join(path.dirname(manifestPath), "src");
      for (const relativePath of sourceFiles(candidateRoot)) {
        if (moduleSpecifiers(relativePath).some((specifier) => specifier === "@tagent/core-service" || specifier.startsWith("@tagent/core-service/"))) {
          violations.push(`${relativePath} imports @tagent/core-service`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("owns each authoritative process resource exactly once in the composition root", () => {
    const files = sourceFiles(sourceRoot);
    const sourceByFile = new Map(files.map((relativePath) => [relativePath, readFileSync(path.join(repoRoot, relativePath), "utf8")]));
    const owner = `${sourceRoot}/server.ts`;
    const operations = [
      /\bacquireCoreInstanceLock\(/g,
      /\bnew Store\(/g,
      /\bclaimCoreWriterConnectionWithRetry\(/g,
      /\bcreateGuardedSqlitePersistence\(/g,
      /\bresolveRuntimeFactory\(/g,
      /\bcreateMemoryRuntime\(/g,
      /\bservice\s*=\s*createCoreApplication\(/g,
      /\bcreateApp\(/g,
    ];
    for (const operation of operations) {
      const owners = [...sourceByFile].flatMap(([relativePath, text]) => text.match(operation) ? [relativePath] : []);
      expect(owners).toEqual([owner]);
      expect(sourceByFile.get(owner)?.match(operation)).toHaveLength(1);
    }
    for (const [relativePath, text] of sourceByFile) {
      if (relativePath === owner) continue;
      expect(text).not.toMatch(/\b(?:CoreInstanceLock|CoreWriterConnection|SqlitePersistence)\b/);
    }
  });

  it("wires one guarded persistence graph through Memory, Core, and HTTP", () => {
    const server = readFileSync(path.join(repoRoot, sourceRoot, "server.ts"), "utf8");
    for (const sentinel of [
      "writerConnection.writerGuard.installConnectionGuard()",
      "const persistence = createGuardedSqlitePersistence(store, writerConnection.writerGuard)",
      "const corePersistence = assembleCoreApplicationPersistence(persistence)",
      "const httpPersistence = assembleHttpPersistence(persistence)",
      "memoryRuntime = await createMemoryRuntime({",
      "resolveEmbeddingApiKey: embeddingCredentialReference",
      "resolveExtractorApiKey: extractorCredentialReference",
      "service = createCoreApplication({\n      persistence: corePersistence",
      "persistence: httpPersistence",
      "memory: memoryRuntime?.service ? assembleHttpMemory(memoryRuntime.service) : undefined",
      "artifacts: httpArtifactContent",
      "writerReadiness: lifecycle",
    ]) expect(server).toContain(sentinel);
    expect(server).not.toMatch(/createApp\(\{[\s\S]*?\bstore\s*:/);

    const milestones = [
      "instanceLock = await acquireCoreInstanceLock",
      "store = new Store",
      "writerConnection = await claimCoreWriterConnectionWithRetry",
      "writerConnection.writerGuard.installConnectionGuard()",
      "await lifecycle.start()",
      "store.runStartupRecovery",
      "service = createCoreApplication",
      "app = createApp",
      "await app.listen",
      "lifecycle.markReady()",
    ].map((sentinel) => server.indexOf(sentinel));
    expect(milestones.every((offset) => offset >= 0)).toBe(true);
    expect(milestones).toEqual([...milestones].sort((left, right) => left - right));
  });

  it("keeps dynamic release materialization and the core-service deploy fixture complete", () => {
    const build = readFileSync(path.join(repoRoot, "scripts/build-release.sh"), "utf8");
    const fixture = readFileSync(path.join(repoRoot, "tests/release-deploy.test.ts"), "utf8");
    expect(build).toContain("npm query .workspace --json");
    expect(build).toContain('cp -a "$source/package.json" "$source/dist" "$target/"');
    expect(build).not.toMatch(/for workspace in .*core-service/);
    expect(fixture).toContain('"@tagent/core-service": "0.8.21"');
    expect(fixture).toContain('"@tagent", "core-service", "dist"');
    expect(fixture).toContain("node_modules/@tagent/core-service/dist/index.js");
  });

  it("resolves all five public entries through compiled Node ESM without starting the service", () => {
    const script = `
      const root = await import("@tagent/core-service");
      const application = await import("@tagent/core-service/application");
      const composition = await import("@tagent/core-service/composition");
      const config = await import("@tagent/core-service/config");
      const host = await import("@tagent/core-service/host");
      if (typeof root.bootstrapCore !== "function" || root.runCoreServiceFromCli !== undefined) process.exit(1);
      if (typeof application.createCoreApplication !== "function" || typeof application.createCoreApplicationCoordinator !== "function" || application.CoreApplicationCoordinator !== undefined) process.exit(1);
      if (typeof composition.CoreLifecycle !== "function" || typeof composition.TaskRunSupervisor !== "function") process.exit(1);
      if (typeof config.loadConfig !== "function" || typeof config.publicRuntimeConfig !== "function") process.exit(1);
      if (typeof host.runCoreHostFromCli !== "function" || typeof host.CoreHost !== "function") process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 5_000,
    })).not.toThrow();
  });
});
