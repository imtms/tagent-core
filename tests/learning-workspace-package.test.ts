import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  DistillationWorker,
  LearningFeatureControl,
  LearningService,
  SemanticJudge,
  WorkflowService,
} from "@tagent/learning";
import { LearningApplication } from "@tagent/learning/application";
import type { WorkflowSpec } from "@tagent/learning/domain";
import type { SemanticJudgeModelPort } from "@tagent/learning/ports";

const repoRoot = process.cwd();
const expectedExports = [".", "./application", "./domain", "./ports"];
const expectedDependencies = [
  "@tagent/admission",
  "@tagent/execution",
  "@tagent/governance",
  "@tagent/memory",
];

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
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(relativePath));
  return specifiers;
}

describe("Learning workspace package", () => {
  it("publishes only the explicit private Learning ABI and exact domain dependencies", () => {
    const root = readJson<{ version: string; devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const learning = readJson<PackageManifest>("packages/learning/package.json");

    expect(learning).toMatchObject({ name: "@tagent/learning", version: root.version, private: true });
    expect(root.devDependencies[learning.name]).toBe(learning.version);
    expect(Object.keys(learning.exports).sort()).toEqual(expectedExports);
    expect(Object.keys(learning.dependencies).sort()).toEqual(expectedDependencies);
    expect(Object.values(learning.dependencies)).toEqual(expectedDependencies.map(() => root.version));
    for (const [subpath, target] of Object.entries(learning.exports)) {
      expect(subpath).not.toContain("*");
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("packages/learning");
    expect(root.scripts.clean).toContain("@tagent/learning");
  });

  it("exposes the approved runtime and compile-time surface", () => {
    expect(DistillationWorker).toBeTypeOf("function");
    expect(LearningFeatureControl).toBeTypeOf("function");
    expect(LearningService).toBeTypeOf("function");
    expect(SemanticJudge).toBeTypeOf("function");
    expect(WorkflowService).toBeTypeOf("function");
    expect(LearningApplication).toBeTypeOf("function");
    const workflow: WorkflowSpec | undefined = undefined;
    const modelPort: SemanticJudgeModelPort | undefined = undefined;
    expect(workflow).toBeUndefined();
    expect(modelPort).toBeUndefined();
  });

  it("keeps Learning independent from Core and concrete adapters", () => {
    const packageRoot = path.join(repoRoot, "packages/learning/src");
    const dependencies = new Set(expectedDependencies);
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/learning/src")) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
          if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
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

    const packageSource = sourceFiles("packages/learning/src")
      .map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8"))
      .join("\n");
    expect(packageSource).not.toMatch(/better-sqlite3|Fastify|runtime-pi|pi-(?:ai|agent|coding)|\/core\/|\/store\//);
    // Learning must remain persistence-port-only: no direct Store/db/raw SQL escape hatch.
    expect(packageSource).not.toMatch(/\b(?:Store|Database)\b|\bdb\s*\.\s*(?:prepare|exec|transaction)\s*\(|\.prepare\s*\(/);
  });

  it("keeps SemanticJudge policy provider-neutral", () => {
    const semanticSource = readFileSync(path.join(repoRoot, "packages/learning/src/semantic-judge.ts"), "utf8");
    expect(semanticSource).not.toMatch(/baseUrl|apiKey|timeoutMs|maxRetries|\bfetch\s*\(/);
    expect(semanticSource).toContain("SemanticJudgeModelPort");
    expect(readFileSync(path.join(repoRoot, "apps/core-service/src/composition/semantic-judge-model-adapter.ts"), "utf8"))
      .toMatch(/baseUrl[\s\S]*apiKey[\s\S]*timeoutMs[\s\S]*maxAttempts/);
  });

  it("keeps SQLite implementations outside Learning and pointed at its ports", () => {
    for (const relativePath of [
      "adapters/persistence-sqlite/src/sqlite/legacy-learning-ledger-repository.ts",
      "adapters/persistence-sqlite/src/sqlite/legacy-workflow-repository.ts",
      "adapters/persistence-sqlite/src/sqlite/legacy-store-adapter.ts",
    ]) {
      expect(readFileSync(path.join(repoRoot, relativePath), "utf8")).toContain("@tagent/learning/");
    }
    expect(existsSync(path.join(repoRoot, "packages/learning/src/persistence"))).toBe(false);
  });

  it("resolves every compiled Learning export under Node ESM", () => {
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'await import("@tagent/learning");',
        'await import("@tagent/learning/domain");',
        'await import("@tagent/learning/ports");',
        'await import("@tagent/learning/application");',
      ].join("\n"),
    ], { cwd: repoRoot, stdio: "pipe" });
  });
});
