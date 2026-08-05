import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const mutationAuthorities = new Set([
  "activateWorkflow",
  "setWorkflowStatus",
  "forgetWorkflow",
  "restoreWorkflow",
  "applyProposalRevision",
  "startCanary",
  "settleCanary",
  "completeApprovalExecution",
  "executeExternalApproval",
  "executeApproval",
  "saveLearningSettings",
  "transitionRuntime",
  "transitionSystem",
]);
const forbiddenMutationSymbols = new Set([
  "TaskRunTransitionPort",
  "FencedRuntimeMutationPort",
  "ExecuteCapabilityHandler",
  "CapabilityEffectPort",
  "CapabilityEffectSettlement",
  "CapabilityEffectBeginResult",
  "CapabilityExecutionPersistencePort",
  "ToolCapabilityApplicationPort",
]);
const forbiddenNames = new Set([...mutationAuthorities, ...forbiddenMutationSymbols]);
const activeRevisionMutationNames = new Set([
  "activeRevision",
  "activeRevisionId",
  "setActiveRevision",
]);

interface Violation {
  file: string;
  line: number;
  reason: string;
}

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  if (!statSync(absoluteRoot).isDirectory()) return absoluteRoot.endsWith(".ts") ? [relativeRoot] : [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry);
    return statSync(path.join(repoRoot, relativePath)).isDirectory()
      ? sourceFiles(relativePath)
      : /\.tsx?$/.test(entry) ? [relativePath] : [];
  }).sort();
}

function productionFiles(): string[] {
  return sourceFiles("packages/learning/src");
}

function parseSource(relativePath: string, sourceText = readFileSync(path.join(repoRoot, relativePath), "utf8")) {
  return ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function mutationModule(specifier: string): boolean {
  return /(?:^|\/)(?:workflow-(?:repository|service)|task-run-transition-port|attempt-repository|capability-execution-port|execute-capability-handler|tool-capability-application-port)(?:\.[cm]?[jt]s)?$/.test(specifier);
}

function expressionAuthorityName(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  if (ts.isIdentifier(expression) && forbiddenNames.has(expression.text)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && forbiddenNames.has(expression.name.text)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const name = literalText(expression.argumentExpression);
    return name && forbiddenNames.has(name) ? name : undefined;
  }
  return undefined;
}

function visitBindings(
  pattern: ts.ObjectBindingPattern,
  report: (node: ts.Node, reason: string) => void,
): void {
  for (const element of pattern.elements) {
    const name = propertyName(element.propertyName ?? element.name);
    if (name && forbiddenNames.has(name)) report(element, `destructures mutation authority '${name}'`);
    if (ts.isObjectBindingPattern(element.name)) visitBindings(element.name, report);
  }
}

function governanceViolations(relativePath: string, sourceText?: string): Violation[] {
  const source = parseSource(relativePath, sourceText);
  const violations = new Map<string, Violation>();
  const report = (node: ts.Node, reason: string) => {
    const violation = { file: relativePath, line: lineOf(source, node), reason };
    violations.set(`${violation.line}:${reason}`, violation);
  };
  const inspectModule = (node: ts.Node, kind: "imports" | "re-exports" | "dynamically loads") => {
    const specifier = ts.isCallExpression(node)
      ? literalText(node.arguments[0])
      : "moduleSpecifier" in node ? literalText(node.moduleSpecifier as ts.Node) : undefined;
    if (specifier && mutationModule(specifier)) {
      report(node, `${kind} mutation-authority module '${specifier}'`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) inspectModule(node, "imports");
    if (ts.isExportDeclaration(node)) {
      inspectModule(node, "re-exports");
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const name = element.propertyName?.text ?? element.name.text;
          if (forbiddenNames.has(name)) report(element, `re-exports mutation authority '${name}'`);
        }
      }
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      inspectModule(node, "dynamically loads");
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literalText(node.argument.literal);
      if (specifier && mutationModule(specifier)) {
        report(node, `imports mutation-authority type module '${specifier}'`);
      }
    }
    if (ts.isImportSpecifier(node)) {
      const name = node.propertyName?.text ?? node.name.text;
      if (forbiddenNames.has(name)) report(node, `imports mutation authority '${name}'`);
    }
    if (ts.isPropertyAccessExpression(node) && forbiddenNames.has(node.name.text)) {
      report(node, `directly accesses mutation authority '${node.name.text}'`);
    }
    if (ts.isElementAccessExpression(node)) {
      const name = literalText(node.argumentExpression);
      if (name && forbiddenNames.has(name)) report(node, `computed access to mutation authority '${name}'`);
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) visitBindings(node.name, report);
      if (ts.isIdentifier(node.name)) {
        const authority = expressionAuthorityName(node.initializer);
        if (authority) report(node, `aliases mutation authority '${authority}' as '${node.name.text}'`);
      }
    }
    if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
      || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      && forbiddenNames.has(propertyName(node.name) ?? "")) {
      report(node, `declares mutation authority method '${propertyName(node.name)}'`);
    }
    if (ts.isIdentifier(node) && forbiddenMutationSymbols.has(node.text)) {
      report(node, `references forbidden mutation symbol '${node.text}'`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...violations.values()];
}

function activeProjectionReachabilityViolations(): Violation[] {
  const violations: Violation[] = [];
  let roots = 0;
  for (const relativePath of sourceFiles("packages/learning/src")) {
    const source = parseSource(relativePath);
    const visitClass = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        const methods = new Map<string, ts.MethodDeclaration>();
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const name = propertyName(member.name);
          if (name) methods.set(name, member);
        }
        if (methods.has("applyActiveProjection")) {
          roots += 1;
          const queue: Array<{ method: string; path: string[] }> = [
            { method: "applyActiveProjection", path: [] },
          ];
          const visited = new Set<string>();
          while (queue.length) {
            const current = queue.shift()!;
            if (visited.has(current.method)) continue;
            visited.add(current.method);
            const declaration = methods.get(current.method);
            if (!declaration) continue;
            const callPath = [...current.path, current.method];
            const visitMethod = (methodNode: ts.Node) => {
              if (ts.isCallExpression(methodNode) && ts.isPropertyAccessExpression(methodNode.expression)
                && methodNode.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
                const called = methodNode.expression.name.text;
                if (methods.has(called)) queue.push({ method: called, path: callPath });
              }
              if ((ts.isPropertyAccessExpression(methodNode) && methodNode.name.text === "settleCanary")
                || ts.isElementAccessExpression(methodNode)
                  && literalText(methodNode.argumentExpression) === "settleCanary") {
                violations.push({
                  file: relativePath,
                  line: lineOf(source, methodNode),
                  reason: `${callPath.join(" -> ")} reaches active Canary settlement`,
                });
              }
              if ((ts.isPropertyAssignment(methodNode) || ts.isShorthandPropertyAssignment(methodNode))
                && activeRevisionMutationNames.has(propertyName(methodNode.name) ?? "")) {
                violations.push({
                  file: relativePath,
                  line: lineOf(source, methodNode),
                  reason: `${callPath.join(" -> ")} writes '${propertyName(methodNode.name)}'`,
                });
              }
              ts.forEachChild(methodNode, visitMethod);
            };
            visitMethod(declaration);
          }
        }
      }
      ts.forEachChild(node, visitClass);
    };
    visitClass(source);
  }
  if (roots === 0) {
    violations.push({
      file: "packages/learning/src",
      line: 1,
      reason: "does not declare an applyActiveProjection class root",
    });
  }
  return violations;
}

function formatViolation(violation: Violation): string {
  return `${violation.file}:${violation.line} ${violation.reason}`;
}

describe("Learning Governance no-bypass architecture", () => {
  it("turns red for dot, bracket, destructuring, alias, method, re-export, and dynamic-import bypasses", () => {
    const probe = governanceViolations("packages/learning/src/__governance_bypass_probe__.ts", `
      import type { TaskRunTransitionPort, CapabilityEffectPort } from "@tagent/execution/ports";
      declare const workflow: Record<string, (...args: never[]) => unknown>;
      workflow.activateWorkflow();
      workflow["forgetWorkflow"]();
      const { restoreWorkflow: restore } = workflow;
      const apply = workflow.applyProposalRevision;
      class UnsafeExecutor {
        startCanary() {}
        executeExternalApproval() {}
        executeApproval() {}
        saveLearningSettings() {}
      }
      void import("./ports/workflow-repository.js");
      export { settleCanary as settle } from "./ports/workflow-repository.js";
      type Forbidden = TaskRunTransitionPort | CapabilityEffectPort;
      void restore; void apply; void UnsafeExecutor; void (null as unknown as Forbidden);
    `).map((violation) => violation.reason);

    expect(probe).toEqual(expect.arrayContaining([
      "directly accesses mutation authority 'activateWorkflow'",
      "computed access to mutation authority 'forgetWorkflow'",
      "destructures mutation authority 'restoreWorkflow'",
      "aliases mutation authority 'applyProposalRevision' as 'apply'",
      "declares mutation authority method 'startCanary'",
      "declares mutation authority method 'executeExternalApproval'",
      "declares mutation authority method 'executeApproval'",
      "declares mutation authority method 'saveLearningSettings'",
      expect.stringContaining("dynamically loads mutation-authority module"),
      "re-exports mutation authority 'settleCanary'",
      "references forbidden mutation symbol 'TaskRunTransitionPort'",
      "references forbidden mutation symbol 'CapabilityEffectPort'",
    ]));
  });

  it("keeps the Learning workspace free of mutation-authority bypasses", () => {
    const files = productionFiles();
    expect(files.length).toBeGreaterThan(30);
    expect(files.flatMap((file) => governanceViolations(file)).map(formatViolation)).toEqual([]);
  });

  it("keeps the active projection call graph away from Canary settlement and active revision writes", () => {
    expect(activeProjectionReachabilityViolations().map(formatViolation)).toEqual([]);
  });
});
