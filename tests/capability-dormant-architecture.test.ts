import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const productionRoots = [
  "apps/core-service/src",
  "adapters/http-fastify/src",
  "packages/admission/src",
  "packages/execution/src",
] as const;

const capabilityDefinitionFiles = new Set([
  "packages/execution/src/application.ts",
  "packages/execution/src/application/execute-capability-handler.ts",
  "packages/execution/src/capability-execution-errors.ts",
  "packages/execution/src/ports/capability-execution-port.ts",
]);
const capabilityExportFiles = new Set([
  "packages/execution/src/ports/index.ts",
]);

const forbiddenCapabilitySymbols = new Set([
  "ExecuteCapabilityHandler",
  "CapabilityEffectPort",
  "CapabilityEffectSettlement",
  "CapabilityExecutionFence",
  "CapabilityExecutionPersistencePort",
  "CapabilityExecutionRequest",
  "CapabilityExecutionState",
  "CapabilityGrantUnsupportedError",
  "CapabilityOutcomeUnknownError",
  "SqliteFencedCapabilityAuthorizationRepository",
]);

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry);
    const absolutePath = path.join(repoRoot, relativePath);
    return statSync(absolutePath).isDirectory()
      ? sourceFiles(relativePath)
      : /\.tsx?$/.test(entry) ? [relativePath] : [];
  }).sort();
}

function parseSource(relativePath: string, sourceText = readFileSync(path.join(repoRoot, relativePath), "utf8")) {
  return ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function localModuleTarget(relativePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.normalize(path.join(path.dirname(relativePath), specifier));
  if (/\.(?:c|m)?js$/.test(resolved)) return resolved.replace(/\.(?:c|m)?js$/, ".ts");
  return path.extname(resolved) ? resolved : `${resolved}.ts`;
}

function forbiddenModule(relativePath: string, specifier: string): boolean {
  if (specifier === "@tagent/execution/application"
    || specifier.startsWith("@tagent/execution/application/")) return true;
  const local = localModuleTarget(relativePath, specifier);
  return local !== undefined && capabilityDefinitionFiles.has(local);
}

interface DormantViolation {
  file: string;
  line: number;
  reason: string;
}

function dormantViolations(relativePath: string, sourceText?: string): DormantViolation[] {
  if (capabilityDefinitionFiles.has(relativePath) || capabilityExportFiles.has(relativePath)) return [];
  const source = parseSource(relativePath, sourceText);
  const violations = new Map<string, DormantViolation>();
  const report = (node: ts.Node, reason: string) => {
    const violation = { file: relativePath, line: lineOf(source, node), reason };
    violations.set(`${violation.line}:${reason}`, violation);
  };
  const inspectSpecifier = (node: ts.Node, specifier: string | undefined) => {
    if (specifier !== undefined && forbiddenModule(relativePath, specifier)) {
      report(node, `loads dormant capability module '${specifier}'`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      inspectSpecifier(node, literalText(node.moduleSpecifier));
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      inspectSpecifier(node, literalText(node.argument.literal));
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      inspectSpecifier(node, literalText(node.arguments[0]));
    }
    if (ts.isIdentifier(node) && forbiddenCapabilitySymbols.has(node.text)) {
      report(node, `references dormant capability symbol '${node.text}'`);
    }
    if (ts.isElementAccessExpression(node)) {
      const member = literalText(node.argumentExpression);
      if (member && forbiddenCapabilitySymbols.has(member)) {
        report(node, `references dormant capability symbol '${member}'`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...violations.values()];
}

describe("dormant capability execution architecture", () => {
  it("keeps the capability handler and canonical repository out of every production composition surface", () => {
    for (const root of productionRoots) expect(sourceFiles(root).length, root).toBeGreaterThan(0);
    const files = productionRoots.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((relativePath) => dormantViolations(relativePath))).toEqual([]);
  });

  it("proves the dormant gate turns red for imports, aliases, re-exports, dynamic loads, and construction", () => {
    const handlerProbe = dormantViolations("apps/core-service/src/__dormant_probe__.ts", `
      import { ExecuteCapabilityHandler as Handler } from "@tagent/execution/application";
      const loaded = import("@tagent/execution/application");
      export const value = new Handler(null as never, null as never);
      void loaded;
    `);
    const repositoryProbe = dormantViolations("apps/core-service/src/__repository_probe__.ts", `
      import { SqliteFencedCapabilityAuthorizationRepository as Repository }
        from "@tagent/persistence-sqlite/sqlite";
      export const value = Repository;
    `);
    const reExportProbe = dormantViolations("apps/core-service/src/__reexport_probe__.ts", `
      export { ExecuteCapabilityHandler as WiredHandler } from "@tagent/execution/application";
    `);

    expect(handlerProbe.map((violation) => violation.reason)).toEqual(expect.arrayContaining([
      expect.stringContaining("loads dormant capability module"),
      expect.stringContaining("ExecuteCapabilityHandler"),
    ]));
    expect(repositoryProbe.map((violation) => violation.reason)).toContain(
      "references dormant capability symbol 'SqliteFencedCapabilityAuthorizationRepository'",
    );
    expect(reExportProbe.map((violation) => violation.reason)).toEqual(expect.arrayContaining([
      expect.stringContaining("loads dormant capability module"),
      expect.stringContaining("ExecuteCapabilityHandler"),
    ]));
  });

  it("keeps Run approval commands on the versioned Channel surface", () => {
    const taskRunRoutes = parseSource("adapters/http-fastify/src/v1/task-run-routes.ts");
    const taskRunCommandHandler = parseSource("adapters/http-fastify/src/v1/task-run-command-handler.ts");
    expect(taskRunRoutes.text).toContain('/api/v1/task-runs/:taskRunId/commands');
    expect(taskRunCommandHandler.text).toContain('case "task_run.resolve_approval"');
    expect(taskRunCommandHandler.text).toContain("service.approveRunApproval");
    expect(taskRunCommandHandler.text).toContain("service.rejectRunApproval");
  });

});
