import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MemoryService } from "@tagent/memory";
import { createMemoryRuntime } from "@tagent/memory/composition";

const repoRoot = process.cwd();
const expectedExports = [".", "./composition", "./domain", "./ports"];

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
  return readdirSync(absoluteRoot).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry);
    const absolutePath = path.join(repoRoot, relativePath);
    return statSync(absolutePath).isDirectory()
      ? sourceFiles(relativePath)
      : absolutePath.endsWith(".ts") ? [relativePath] : [];
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
  const source = parsedSource(relativePath);
  const specifiers: string[] = [];
  const add = (node: ts.Expression | undefined) => {
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

describe("Memory workspace package", () => {
  it("publishes only the explicit compiled Memory ABI", () => {
    const root = readJson<{ version: string; devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const memory = readJson<PackageManifest>("packages/memory/package.json");

    expect(memory).toMatchObject({ name: "@tagent/memory", version: root.version, private: true });
    expect(root.devDependencies[memory.name]).toBe(memory.version);
    expect(Object.keys(memory.exports).sort()).toEqual(expectedExports);
    expect(Object.keys(memory.dependencies).sort()).toEqual(["@aws-sdk/client-s3", "pg"]);
    expect(Object.keys(memory.dependencies).some((name) => name.startsWith("@tagent/"))).toBe(false);
    for (const [subpath, target] of Object.entries(memory.exports)) {
      expect(subpath).not.toContain("*");
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("@tagent/memory");
    expect(root.scripts.build).toContain("packages/memory/dist/postgres/schema.sql");
  });

  it("exposes the approved Memory service and composition entry points", () => {
    expect(MemoryService).toBeTypeOf("function");
    expect(createMemoryRuntime).toBeTypeOf("function");
  });

  it("keeps the Memory implementation independent from root and other workspaces", () => {
    const packageRoot = path.join(repoRoot, "packages/memory/src");
    const manifest = readJson<PackageManifest>("packages/memory/package.json");
    const dependencies = new Set(Object.keys(manifest.dependencies));
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/memory/src")) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
          if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
            violations.push(`${relativePath} escapes to ${specifier}`);
          }
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        const owner = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!dependencies.has(owner)) violations.push(`${relativePath} imports undeclared ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("builds the package schema asset", () => {
    const source = readFileSync(path.join(repoRoot, "packages/memory/src/postgres/schema.sql"));
    expect(readFileSync(path.join(repoRoot, "packages/memory/dist/postgres/schema.sql"))).toEqual(source);
    const sql = source.toString("utf8");
    expect(sql).toContain("'tagent-memory/0.8',2");
    expect(sql).toContain("created_at bigint NOT NULL");
    expect(sql).not.toMatch(/ALTER TABLE .* ADD COLUMN/i);
  });

  it("resolves every public export through compiled Node ESM", () => {
    const script = `
      const root = await import("@tagent/memory");
      const domain = await import("@tagent/memory/domain");
      await import("@tagent/memory/ports");
      const composition = await import("@tagent/memory/composition");
      if (!root.MemoryService || !domain.isDurableMemory || !composition.createMemoryRuntime) process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
