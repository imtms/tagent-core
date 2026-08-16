import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const forbiddenDirectMutations = new Set([
  "transitionRun",
  "finalizeRun",
  "blockRun",
  "markInterrupted",
  "resumeRun",
  "completeWithGate",
]);
const storeCompositionAllowlist = new Set(["apps/core-service/src/server.ts"]);

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  if (!statSync(absoluteRoot).isDirectory()) return absoluteRoot.endsWith(".ts") ? [relativeRoot] : [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry);
    const absolutePath = path.join(repoRoot, relativePath);
    return statSync(absolutePath).isDirectory()
      ? sourceFiles(relativePath)
      : /\.tsx?$/.test(entry) ? [relativePath] : [];
  }).sort();
}

function workspaceProductionFiles(): string[] {
  return ["packages", "apps", "adapters"].flatMap((group) => {
    const root = path.join(repoRoot, group);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !(group === "adapters" && entry.name === "persistence-sqlite"))
      .flatMap((entry) => sourceFiles(path.join(group, entry.name, "src")));
  }).concat(sourceFiles("src"));
}

function parseSource(relativePath: string, text = readFileSync(path.join(repoRoot, relativePath), "utf8")) {
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

function visitTaskRunBindings(
  pattern: ts.ObjectBindingPattern,
  report: (node: ts.Node, reason: string) => void,
  insideTaskRuns: boolean,
): void {
  for (const element of pattern.elements) {
    const name = propertyName(element.propertyName ?? element.name);
    const taskRunScope = insideTaskRuns || name === "taskRuns";
    if (taskRunScope && name && forbiddenDirectMutations.has(name)) {
      report(element, `destructures direct TaskRun mutation '${name}'`);
    }
    if (ts.isObjectBindingPattern(element.name)) {
      visitTaskRunBindings(element.name, report, taskRunScope);
    }
  }
}

interface ProductionViolation {
  file: string;
  line: number;
  reason: string;
}

function productionViolations(relativePath: string, text?: string): ProductionViolation[] {
  const source = parseSource(relativePath, text);
  const violations: ProductionViolation[] = [];
  const report = (node: ts.Node, reason: string) => {
    violations.push({ file: relativePath, line: lineOf(source, node), reason });
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && forbiddenDirectMutations.has(node.name.text)) {
      report(node, `accesses direct TaskRun mutation '${node.name.text}'`);
    }
    if (ts.isElementAccessExpression(node)) {
      const name = literalText(node.argumentExpression);
      if (name && forbiddenDirectMutations.has(name)) {
        report(node, `accesses computed direct TaskRun mutation '${name}'`);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const fromTaskRuns = node.initializer !== undefined
        && (ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === "taskRuns"
          || ts.isElementAccessExpression(node.initializer)
            && literalText(node.initializer.argumentExpression) === "taskRuns");
      visitTaskRunBindings(node.name, report, fromTaskRuns);
    }
    if (!storeCompositionAllowlist.has(relativePath) && ts.isImportDeclaration(node)) {
      const module = literalText(node.moduleSpecifier) ?? "";
      const bindings = node.importClause?.namedBindings;
      const importsStore = node.importClause?.name?.text === "Store"
        || bindings && ts.isNamedImports(bindings)
          && bindings.elements.some((element) =>
            (element.propertyName?.text ?? element.name.text) === "Store");
      if (importsStore || /(?:^|\/)store(?:\/|\.|$)/.test(module)) {
        report(node, `imports Store outside the composition root via '${module}'`);
      }
    }
    if (!storeCompositionAllowlist.has(relativePath) && ts.isNewExpression(node)
      && ts.isIdentifier(node.expression) && node.expression.text === "Store") {
      report(node, "constructs Store outside the composition root");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function interfaceMethods(relativePath: string, interfaceName: string): string[] {
  const source = parseSource(relativePath);
  const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName);
  return declaration?.members
    .map((member) => propertyName(member.name))
    .filter((name): name is string => name !== undefined) ?? [];
}

function frozenTaskRunProperties(): string[] {
  const relativePath = "adapters/persistence-sqlite/src/sqlite/sqlite-persistence.ts";
  const source = parseSource(relativePath);
  let properties: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
      && node.left.name.text === "taskRuns"
      && ts.isCallExpression(node.right)
      && ts.isPropertyAccessExpression(node.right.expression)
      && node.right.expression.expression.getText(source) === "Object"
      && node.right.expression.name.text === "freeze"
      && ts.isObjectLiteralExpression(node.right.arguments[0])) {
      properties = node.right.arguments[0].properties
        .map((property) => propertyName(property.name))
        .filter((name): name is string => name !== undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return properties;
}

function transitionCalls(relativePath: string): { runtime: number; system: number } {
  const source = parseSource(relativePath);
  const result = { runtime: 0, system: 0 };
  const runtimeMethods = new Set([
    "failRuntimeTaskRun",
    "settleRuntimeInitializationFailure",
  ]);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      if (name && runtimeMethods.has(name)) result.runtime += 1;
      if (name === "transitionSystem") result.system += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function directPortCalls(relativePath: string, method: "transitionRuntime" | "transitionSystem"): number {
  const source = parseSource(relativePath);
  let calls = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === method) calls += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

describe("production TaskRun transition authority", () => {
  it("turns red for direct taskRuns mutations and Store use outside the composition root", () => {
    expect(productionViolations("packages/execution/src/application/__direct_mutation_probe__.ts", `
      import { Store } from "@tagent/persistence-sqlite";
      declare const persistence: { taskRuns: { transitionRun(): void } };
      persistence.taskRuns.transitionRun();
      persistence.taskRuns["blockRun"]();
      const aliased = persistence.taskRuns.resumeRun;
      const { transitionRun } = persistence.taskRuns;
      const { taskRuns: { finalizeRun: finalize } } = persistence;
      transitionRun();
      aliased();
      finalize();
      export const store = new Store(":memory:");
    `).map((violation) => violation.reason)).toEqual(expect.arrayContaining([
      "accesses direct TaskRun mutation 'transitionRun'",
      "accesses computed direct TaskRun mutation 'blockRun'",
      "accesses direct TaskRun mutation 'resumeRun'",
      "destructures direct TaskRun mutation 'transitionRun'",
      "destructures direct TaskRun mutation 'finalizeRun'",
      expect.stringContaining("imports Store outside the composition root"),
      "constructs Store outside the composition root",
    ]));
  });

  it("has no direct TaskRun mutation bypass in production workspaces", () => {
    const files = workspaceProductionFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((relativePath) => productionViolations(relativePath))).toEqual([]);
    expect(productionViolations("apps/core-service/src/server.ts")).toEqual([]);
  });

  it("removes all six mutations from production TaskRunRepository and SqlitePersistence taskRuns", () => {
    const taskRunRepository = interfaceMethods(
      "packages/execution/src/ports/task-run-repository.ts",
      "TaskRunRepository",
    );
    const persistedTaskRuns = frozenTaskRunProperties();
    for (const method of forbiddenDirectMutations) {
      expect(taskRunRepository, `TaskRunRepository.${method}`).not.toContain(method);
      expect(persistedTaskRuns, `SqlitePersistence.taskRuns.${method}`).not.toContain(method);
    }
    const store = interfaceMethods("adapters/persistence-sqlite/src/store.ts", "Store");
    void store; // Store is a class and intentionally remains the internal persistence surface.
  });

  it("routes the known production callers through the bounded transition port", () => {
    expect(transitionCalls("packages/execution/src/application/attempt-executor.ts"))
      .toEqual({ runtime: 2, system: 0 });
    expect(transitionCalls("packages/execution/src/application/attempt-settlement-service.ts"))
      .toEqual({ runtime: 0, system: 0 });
    expect(transitionCalls("packages/execution/src/application/runtime-initialization-failure.ts"))
      .toEqual({ runtime: 1, system: 0 });
    expect(transitionCalls("packages/admission/src/application/admission-coordinator.ts"))
      .toEqual({ runtime: 0, system: 3 });
    expect(transitionCalls("packages/execution/src/application/execution-lifecycle-service.ts"))
      .toEqual({ runtime: 0, system: 1 });
    expect(transitionCalls("packages/execution/src/application/runtime-registry.ts"))
      .toEqual({ runtime: 0, system: 1 });
    expect(transitionCalls("packages/execution/src/application/run-context-service.ts"))
      .toEqual({ runtime: 0, system: 1 });
    expect(sourceFiles("packages/execution/src/application")
      .map((file) => ({ file, calls: directPortCalls(file, "transitionRuntime") }))
      .filter(({ calls }) => calls > 0))
      .toEqual([{
        file: "packages/execution/src/application/task-run-transition-helpers.ts",
        calls: 1,
      }]);
  });
});
