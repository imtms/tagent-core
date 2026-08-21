import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const expectedExports = [".", "./factory", "./provider-errors"];

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  dependencies: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
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

function productionSourceFiles(): string[] {
  const workspaceSources = ["packages", "adapters", "apps"].flatMap((group) => {
    const absoluteGroup = path.join(repoRoot, group);
    if (!existsSync(absoluteGroup)) return [];
    return readdirSync(absoluteGroup, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => sourceFiles(path.join(group, entry.name, "src")));
  });
  return [...sourceFiles("src"), ...workspaceSources].sort();
}

describe("Pi runtime adapter workspace package", () => {
  it("publishes only the minimal compiled concrete-runtime ABI", () => {
    const root = readJson<{ workspaces: string[]; devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const runtime = readJson<PackageManifest>("adapters/runtime-pi/package.json");

    expect(runtime).toMatchObject({ name: "@tagent/runtime-pi", version: "0.8.14", private: true });
    expect(root.workspaces).toContain("adapters/*");
    expect(root.devDependencies[runtime.name]).toBe(runtime.version);
    expect(Object.keys(runtime.exports).sort()).toEqual(expectedExports);
    expect(runtime.exports).not.toHaveProperty("./types");
    expect(runtime.dependencies).toEqual({
      "@earendil-works/pi-agent-core": "0.83.0",
      "@earendil-works/pi-ai": "0.83.0",
      "@tagent/execution": "0.8.14",
    });
    for (const target of Object.values(runtime.exports)) {
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("adapters/runtime-pi");
    expect(root.scripts.clean).toContain("@tagent/runtime-pi");
  });

  it("keeps every runtime contract declaration uniquely owned by Execution", () => {
    const contractNames = new Set([
      "AttemptExecutionToken",
      "AttemptRuntimeFactory",
      "AttemptRuntimePort",
      "AttemptRuntimeSpec",
      "RuntimeCapabilityCatalog",
      "RuntimeEventSink",
      "RuntimeMessage",
      "RuntimeMessagePart",
      "RuntimeModelSpec",
      "RuntimeSkill",
      "RuntimeQueueResult",
      "RuntimeUsage",
      "RuntimeTool",
      "RuntimeToolExecutionMode",
      "RuntimeToolResult",
      "RuntimeToolUpdateCallback",
    ]);
    const owners = new Map<string, string[]>();
    for (const relativePath of productionSourceFiles()) {
      for (const statement of parsedSource(relativePath).statements) {
        if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
          && contractNames.has(statement.name.text)) {
          owners.set(statement.name.text, [...(owners.get(statement.name.text) ?? []), relativePath]);
        }
      }
    }
    expect(Object.fromEntries([...owners].sort())).toEqual(Object.fromEntries(
      [...contractNames].sort().map((name) => [name, [name === "RuntimeModelSpec"
        ? "packages/execution/src/domain/runtime-model.ts"
        : "packages/execution/src/ports/attempt-runtime.ts"]]),
    ));
  });

  it("depends only on Execution and the required Pi SDK packages", () => {
    const packageRoot = path.join(repoRoot, "adapters/runtime-pi/src");
    const allowedExternal = (specifier: string) => specifier.startsWith("node:")
      || specifier === "@tagent/execution/ports"
      || specifier === "@earendil-works/pi-agent-core"
      || specifier === "@earendil-works/pi-ai"
      || specifier.startsWith("@earendil-works/pi-ai/");
    const violations: string[] = [];
    for (const relativePath of sourceFiles("adapters/runtime-pi/src")) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (!specifier.startsWith(".")) {
          if (!allowedExternal(specifier)) violations.push(`${relativePath} imports ${specifier}`);
          continue;
        }
        const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
        if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
          violations.push(`${relativePath} escapes to ${specifier}`);
        }
      }
      const text = readFileSync(path.join(repoRoot, relativePath), "utf8");
      if (/\b(?:Admission|Governance|MemoryFacade|Store|ToolCapabilityApplicationPort)\b|better-sqlite3|fastify|persistence\/sqlite/.test(text)) {
        violations.push(`${relativePath} contains a forbidden concrete dependency`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps production consumers on package or Execution ABI imports", () => {
    const adapterRoot = path.join(repoRoot, "adapters/runtime-pi/src");
    const violations: string[] = [];
    for (const relativePath of productionSourceFiles()) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.includes("/src/")) violations.push(`${relativePath} deep-imports ${specifier}`);
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier).replace(/\.js$/, ".ts");
        const crossesIntoAdapter = resolved.startsWith(`${adapterRoot}${path.sep}`)
          && !relativePath.startsWith("adapters/runtime-pi/src/");
        if (crossesIntoAdapter) {
          violations.push(`${relativePath} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("resolves every public export through compiled Node ESM", () => {
    const script = `
      const root = await import("@tagent/runtime-pi");
      const factory = await import("@tagent/runtime-pi/factory");
      const errors = await import("@tagent/runtime-pi/provider-errors");
      if (Object.keys(root).join(",") !== "PiRuntime,providerRetryDelayMs") process.exit(1);
      if (!factory.createInProcessRuntime || !factory.resolveRuntimeFactory) process.exit(1);
      if (!errors.classifyProviderFailure || !errors.isRetryableProviderFailure) process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
