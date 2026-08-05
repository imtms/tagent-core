import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const callerBoundaryRoots = [
  "apps/core-service/src",
  "adapters/http-fastify/src",
  "adapters/runtime-pi/src",
  "adapters/workspace-local/src",
  "packages/admission/src",
  "packages/execution/src",
  "packages/governance/src",
  "packages/learning/src",
  "packages/memory/src",
] as const;
const rawSqlAdapterFiles = new Set(["packages/memory/src/postgres/postgres-adapter.ts"]);
const storeCompositionFiles = new Set(["apps/core-service/src/server.ts"]);
const rawSql = /\b(?:SELECT\b|INSERT\s+INTO\b|UPDATE\s+[a-z_][a-z0-9_]*\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|ALTER\s+TABLE\b|DROP\s+TABLE\b|PRAGMA\b)/i;

function sourceFiles(relativePath: string): string[] {
  const filename = path.join(repoRoot, relativePath);
  return statSync(filename).isDirectory()
    ? readdirSync(filename).flatMap((name) => sourceFiles(path.join(relativePath, name)))
    : filename.endsWith(".ts") ? [relativePath] : [];
}

const callerBoundaryFiles = callerBoundaryRoots.flatMap(sourceFiles).sort();

function regexIdentifiers(source: ts.SourceFile): Set<string> {
  const identifiers = new Set<string>();
  const collections = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isRegularExpressionLiteral(node.initializer)) identifiers.add(node.name.text);
      if (ts.isArrayLiteralExpression(node.initializer)
        && node.initializer.elements.length > 0
        && node.initializer.elements.every(ts.isRegularExpressionLiteral)) {
        collections.add(node.name.text);
      }
    }
    if (ts.isForOfStatement(node)
      && ts.isIdentifier(node.expression)
      && collections.has(node.expression.text)
      && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        if (ts.isIdentifier(declaration.name)) identifiers.add(declaration.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return identifiers;
}

function isRegularExpressionExec(node: ts.PropertyAccessExpression, identifiers: Set<string>): boolean {
  if (node.name.text !== "exec") return false;
  const unwrap = (expression: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expression)
    ? unwrap(expression.expression)
    : expression;
  const receiver = unwrap(node.expression);
  return ts.isRegularExpressionLiteral(receiver)
    || ts.isIdentifier(receiver) && identifiers.has(receiver.text);
}

function persistenceViolations(relativePath: string) {
  const filename = path.join(repoRoot, relativePath);
  const sourceText = readFileSync(filename, "utf8");
  const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const regularExpressions = regexIdentifiers(source);
  const violations = new Set<string>();
  const report = (node: ts.Node, rule: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    violations.add(`${relativePath}:${line} ${rule}`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!storeCompositionFiles.has(relativePath)
        && /(?:^|\/)store\/store\.(?:c|m)?js$/.test(node.moduleSpecifier.text)) {
        report(node, "imports the concrete Store module");
      }
      if (node.moduleSpecifier.text === "better-sqlite3") report(node, "imports better-sqlite3");
    }
    if (!storeCompositionFiles.has(relativePath)
      && ts.isIdentifier(node) && node.text === "Store") report(node, "references concrete Store");
    if (ts.isPropertyAccessExpression(node)
      && ["db", "prepare", "exec"].includes(node.name.text)
      && !isRegularExpressionExec(node, regularExpressions)) {
      report(node, `uses .${node.name.text}`);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && rawSql.test(node.getText(source))
      && !rawSqlAdapterFiles.has(relativePath)) {
      report(node, "contains raw SQL");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (/\bReturnType\s*<\s*Store\b/.test(sourceText)) {
    violations.add(`${relativePath} uses ReturnType<Store>`);
  }
  return [...violations].sort();
}

describe("persistence caller boundaries", () => {
  it("keeps application, HTTP, domains, runtime, tools, learning, and memory behind persistence ports", () => {
    expect(callerBoundaryFiles.flatMap(persistenceViolations)).toEqual([]);
  });

  it("limits raw SQL in caller trees to the explicit PostgreSQL memory adapter", () => {
    const observed = callerBoundaryFiles.filter((relativePath) => {
      if (rawSqlAdapterFiles.has(relativePath)) return true;
      return persistenceViolations(relativePath).some((violation) => violation.endsWith("contains raw SQL"));
    });
    expect(observed).toEqual([...rawSqlAdapterFiles]);
  });
});
