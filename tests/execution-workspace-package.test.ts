import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ExecutionCoordinator } from "@tagent/execution";
import { ExecuteCapabilityHandler } from "@tagent/execution/application";
import type { ExecutionSessionRef, TaskRun } from "@tagent/execution/domain";
import { AttemptExecutor } from "@tagent/execution/composition";

const repoRoot = process.cwd();
const expectedExports = [".", "./application", "./composition", "./domain", "./ports"];

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

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;

describe("Execution workspace package", () => {
  it("publishes only the explicit compiled Execution ABI", () => {
    const root = readJson<{ devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const execution = readJson<PackageManifest>("packages/execution/package.json");

    expect(execution).toMatchObject({ name: "@tagent/execution", version: "0.2.1", private: true });
    expect(root.devDependencies[execution.name]).toBe(execution.version);
    expect(Object.keys(execution.exports).sort()).toEqual(expectedExports);
    expect(execution.dependencies).toEqual({ "@tagent/governance": "0.2.1" });
    for (const [subpath, target] of Object.entries(execution.exports)) {
      expect(subpath).not.toContain("*");
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("packages/execution");
    expect(root.scripts.clean).toContain("@tagent/execution");
  });

  it("keeps the explicit implementations in the Execution package", () => {
    const implementationFiles = [
      ...sourceFiles("packages/execution/src/application"),
      ...sourceFiles("packages/execution/src/domain"),
      ...sourceFiles("packages/execution/src/ports"),
    ];
    expect(implementationFiles).toHaveLength(40);
    expect(implementationFiles).toEqual(expect.arrayContaining([
      "packages/execution/src/application/runtime-initialization-failure.ts",
      "packages/execution/src/application/task-run-transition-helpers.ts",
      "packages/execution/src/ports/task-run-transition-port.ts",
    ]));
  });

  it("keeps package source dependent only on Governance, node:crypto, and package-internal modules", () => {
    const packageRoot = path.join(repoRoot, "packages/execution/src");
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/execution/src")) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
          if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
            violations.push(`${relativePath} escapes to ${specifier}`);
          }
          continue;
        }
        if (specifier !== "node:crypto"
          && specifier !== "@tagent/governance/domain"
          && specifier !== "@tagent/governance/ports") {
          violations.push(`${relativePath} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("owns an Execution session reference without redeclaring Admission SessionId", () => {
    const sessionIdDeclarations: string[] = [];
    for (const relativePath of sourceFiles("packages/execution/src")) {
      for (const statement of parsedSource(relativePath).statements) {
        if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
          && statement.name.text === "SessionId") {
          sessionIdDeclarations.push(relativePath);
        }
      }
    }
    expect(sessionIdDeclarations).toEqual([]);

    const referenceCompatibility: Equal<TaskRun["sessionId"], ExecutionSessionRef> = true;
    expect(referenceCompatibility).toBe(true);
  });

  it("keeps application internals off the root export while exposing reviewed subpaths explicitly", async () => {
    const root = await import("@tagent/execution");
    const application = await import("@tagent/execution/application");
    expect(Object.keys(root)).toEqual(["ExecutionCoordinator"]);
    expect(root.ExecutionCoordinator).toBe(ExecutionCoordinator);
    expect(root).not.toHaveProperty("AttemptExecutor");
    expect(root).not.toHaveProperty("ExecuteCapabilityHandler");
    expect(AttemptExecutor).toBeTypeOf("function");
    expect(ExecuteCapabilityHandler).toBeTypeOf("function");
    expect(Object.keys(application).sort()).toEqual([
      "CapabilityGrantUnsupportedError",
      "CapabilityOutcomeUnknownError",
      "ExecuteCapabilityHandler",
    ]);
  });

  it("resolves every public export through compiled Node ESM", () => {
    const script = `
      const root = await import("@tagent/execution");
      const application = await import("@tagent/execution/application");
      const domain = await import("@tagent/execution/domain");
      await import("@tagent/execution/ports");
      const composition = await import("@tagent/execution/composition");
      if (!root.ExecutionCoordinator || !application.ExecuteCapabilityHandler || !domain.attemptIdFor || !composition.AttemptExecutor || !composition.createOneShotPort) process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
