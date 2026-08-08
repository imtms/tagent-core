import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  WorkspacePathError,
  createTools,
  listWorkspaceDirectory,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@tagent/workspace-local";
import { createTools as ToolsCreateTools } from "@tagent/workspace-local/tools";
import {
  WorkspacePathError as PathWorkspacePathError,
  listWorkspaceDirectory as PathListWorkspaceDirectory,
  readWorkspaceFile as PathReadWorkspaceFile,
  writeWorkspaceFile as PathWriteWorkspaceFile,
} from "@tagent/workspace-local/workspace-path";

const repoRoot = process.cwd();
const packageRoot = "adapters/workspace-local";
const sourceRoot = `${packageRoot}/src`;
const helperSource = `${sourceRoot}/workspace-fd-helper.py`;
const helperAsset = `${packageRoot}/dist/workspace-fd-helper.py`;

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  dependencies: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
  scripts: Record<string, string>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  return readdirSync(absoluteRoot).flatMap((entry) => {
    if (entry === "dist" || entry === "node_modules") return [];
    const relativePath = path.join(relativeRoot, entry);
    const absolutePath = path.join(repoRoot, relativePath);
    return statSync(absolutePath).isDirectory()
      ? sourceFiles(relativePath)
      : /\.tsx?$/.test(absolutePath) ? [relativePath] : [];
  }).sort();
}

function parsedSource(relativePath: string) {
  return ts.createSourceFile(
    relativePath,
    readFileSync(path.join(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function moduleSpecifiers(relativePath: string): string[] {
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
  visit(parsedSource(relativePath));
  return specifiers;
}

describe("Local workspace adapter package", () => {
  it("publishes a private minimal ABI with exact approved dependencies", () => {
    const root = readJson<{ devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    expect(manifest).toMatchObject({ name: "@tagent/workspace-local", version: "0.4.0", private: true });
    expect(root.devDependencies[manifest.name]).toBe(manifest.version);
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".", "./artifact-file-sink", "./project-context", "./snapshot-edit", "./tools", "./workspace-path",
    ]);
    expect(manifest.dependencies).toEqual({
      "@earendil-works/pi-agent-core": "0.83.0",
      "@tagent/execution": "0.4.0",
      typebox: "^1.1.24",
    });
    for (const target of Object.values(manifest.exports)) {
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(manifest.scripts.build).toContain("cp src/workspace-fd-helper.py dist/workspace-fd-helper.py");
    expect(manifest.scripts.build).toContain("chmod 755 dist/workspace-fd-helper.py");
    expect(root.scripts["build:packages"]).toContain("@tagent/workspace-local");
    expect(root.scripts.clean).toContain("@tagent/workspace-local");
  });

  it("keeps ToolCapabilityApplicationPort uniquely owned and exported by Execution", () => {
    const productionFiles = [...sourceFiles("src"), ...sourceFiles("packages"), ...sourceFiles("adapters"), ...sourceFiles("apps")];
    const declarations = productionFiles.filter((relativePath) =>
      /(?:interface|type)\s+ToolCapabilityApplicationPort\b/.test(readFileSync(path.join(repoRoot, relativePath), "utf8")));
    expect(declarations).toEqual(["packages/execution/src/ports/tool-capability-application-port.ts"]);
    const executionPorts = readFileSync(path.join(repoRoot, "packages/execution/src/ports/index.ts"), "utf8");
    expect(executionPorts).toContain('from "./tool-capability-application-port.js"');
    expect(readFileSync(path.join(repoRoot, `${sourceRoot}/tools.ts`), "utf8"))
      .toContain('from "@tagent/execution/ports"');
  });

  it("preserves identity across the adapter's explicit public subpaths", () => {
    expect(ToolsCreateTools).toBe(createTools);
    expect(PathWorkspacePathError).toBe(WorkspacePathError);
    expect(PathListWorkspaceDirectory).toBe(listWorkspaceDirectory);
    expect(PathReadWorkspaceFile).toBe(readWorkspaceFile);
    expect(PathWriteWorkspaceFile).toBe(writeWorkspaceFile);
  });

  it("keeps the adapter independent from stores, persistence, memory, HTTP, runtime-pi, and Core aggregates", () => {
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    const dependencies = new Set(Object.keys(manifest.dependencies));
    const violations: string[] = [];
    for (const relativePath of sourceFiles(sourceRoot)) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
          const absoluteSourceRoot = path.join(repoRoot, sourceRoot);
          if (target !== absoluteSourceRoot && !target.startsWith(`${absoluteSourceRoot}${path.sep}`)) {
            violations.push(`${relativePath} escapes to ${specifier}`);
          }
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        const owner = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!dependencies.has(owner)) violations.push(`${relativePath} imports undeclared ${specifier}`);
        if (specifier.includes("/src")) violations.push(`${relativePath} deep-imports ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
    const packageSource = sourceFiles(sourceRoot)
      .map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8"))
      .join("\n");
    expect(packageSource).not.toMatch(/\b(?:Store|MemoryFacade|Fastify)\b|@tagent\/(?:persistence-sqlite|runtime-pi)|\/core\/|\/apps?\//);
    expect(packageSource).not.toMatch(/\b(?:taskRuns|runtimeMutations|appendEvent|updateRun|createRun)\b/);
  });

  it("owns the only helper implementation and builds a regular executable protocol asset", () => {
    const helpers = readdirSync(path.join(repoRoot, "adapters"), { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith("workspace-fd-helper.py") && !entry.includes("/dist/"));
    expect(helpers).toEqual(["workspace-local/src/workspace-fd-helper.py"]);
    expect(existsSync(path.join(repoRoot, "src/security/workspace-fd-helper.py"))).toBe(false);
    const metadata = lstatSync(path.join(repoRoot, helperAsset));
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode & 0o111).not.toBe(0);
    const source = readFileSync(path.join(repoRoot, helperSource), "utf8");
    const built = readFileSync(path.join(repoRoot, helperAsset), "utf8");
    expect(built).toBe(source);
    expect(source.startsWith("#!/usr/bin/env python3\n")).toBe(true);
    expect(source).toContain('O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)');
    expect(source).toContain("stat.S_ISREG");
    expect(source).toContain("src_dir_fd=parent, dst_dir_fd=parent");
    expect(source).toContain("os.fsync(parent)");
    const protocol = spawnSync("python3", [path.join(repoRoot, helperAsset)], { encoding: "utf8" });
    expect(protocol.status).toBe(2);
    expect(JSON.parse(protocol.stderr)).toMatchObject({ ok: false, code: "WORKSPACE_IO_ERROR" });
    const pathSource = readFileSync(path.join(repoRoot, `${sourceRoot}/workspace-path.ts`), "utf8");
    expect(pathSource).toContain('new URL("./workspace-fd-helper.py", import.meta.url)');
    expect(pathSource).toContain('operation === "list" ? 8 * 1024 * 1024 : 50 * 1024 * 1024');
  });

  it("keeps production consumers on package ABIs and Pi concrete ownership on two adapters", () => {
    const productionFiles = [...sourceFiles("src"), ...sourceFiles("packages"), ...sourceFiles("adapters")];
    const forbiddenConsumers = productionFiles.filter((relativePath) =>
      moduleSpecifiers(relativePath).some((specifier) =>
        /(?:tools\/tools|tools\/capability-port|security\/workspace-path)/.test(specifier)
          && !specifier.startsWith("@tagent/")));
    expect(forbiddenConsumers).toEqual([]);
    expect(moduleSpecifiers("apps/core-service/src/composition/runtime-host-adapter.ts")).toContain("@tagent/workspace-local/tools");
    expect(moduleSpecifiers("apps/core-service/src/composition/runtime-host-adapter.ts")).toContain("@tagent/execution/ports");
    expect(moduleSpecifiers("apps/core-service/src/composition/artifact-content.ts")).toContain("@tagent/workspace-local/workspace-path");
    const piAgentCoreImporters = productionFiles.filter((relativePath) =>
      moduleSpecifiers(relativePath).includes("@earendil-works/pi-agent-core"));
    expect(piAgentCoreImporters).toEqual([
      "adapters/runtime-pi/src/pi-runtime.ts",
      "adapters/workspace-local/src/tools.ts",
    ]);
  });

  it("preserves operation receipts, phases, stale checks, and durable tool result semantics", () => {
    const source = readFileSync(path.join(repoRoot, `${sourceRoot}/tools.ts`), "utf8");
    expect(source).toContain("`${runId}:${attempt}:${toolCallId}`");
    expect(source).toContain('capabilities.advanceRunPhase("implement")');
    expect(source).toContain("options.invalidatesChecks === false ? 0 : capabilities.markChecksStale()");
    expect(source).toContain('status: "succeeded"');
    expect(source).toContain('stage: "completed"');
    expect(source).toContain('status: "failed", stage: "execution_failed"');
    expect(source).toContain('name: "task_run"');
    expect(source).toContain('Type.Literal("request_user_input")');
    expect(source).toContain('capabilities.publish("run.updated"');
  });

  it("resolves every compiled export through Node ESM", () => {
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'await import("@tagent/workspace-local");',
        'await import("@tagent/workspace-local/tools");',
        'await import("@tagent/workspace-local/workspace-path");',
      ].join("\n"),
    ], { cwd: repoRoot, stdio: "pipe" });
  });
});
