import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createOneShotPort, type ExecutionStateView } from "@tagent/execution/composition";
import { toTaskRunContractSnapshot } from "@tagent/admission/composition";
import type { TaskRunContract } from "@tagent/admission/domain";

function assertNarrowPersistenceCapability(state: ExecutionStateView<"persistence", "taskRuns">) {
  void state.persistence.taskRuns;
  // @ts-expect-error compile-time boundary: an undeclared repository cannot escape the service view.
  void state.persistence.sessions;
}
void assertNarrowPersistenceCapability;

const repoRoot = process.cwd();

function sourceText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function sourceFile(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    sourceText(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  if (!statSync(absoluteRoot).isDirectory()) return absoluteRoot.endsWith(".ts") ? [relativeRoot] : [];
  return readdirSync(absoluteRoot)
    .flatMap((entry) => sourceFiles(path.join(relativeRoot, entry)))
    .sort();
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    names.push(clause.namedBindings.name.text);
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      names.push(element.propertyName?.text ?? element.name.text, element.name.text);
    }
  }
  return names;
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function stringLiteralTypes(node: ts.TypeNode): string[] {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(stringLiteralTypes);
  if (ts.isParenthesizedTypeNode(node)) return stringLiteralTypes(node.type);
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [];
}

describe("execution architecture boundaries", () => {
  it("keeps Execution application modules cohesive and prevents a renamed giant service", () => {
    const requiredModules = [
      "attempt-executor.ts",
      "attempt-settlement-service.ts",
      "continuation-scheduler.ts",
      "control-inbox-dispatcher.ts",
      "recovery-coordinator.ts",
      "run-event-hub.ts",
      "runtime-registry.ts",
      "run-context-service.ts",
    ];
    const applicationFiles = sourceFiles("packages/execution/src/application");
    const fileNames = new Set(applicationFiles.map((relativePath) => path.basename(relativePath)));
    const violations = applicationFiles.flatMap((relativePath) => {
      const lines = sourceText(relativePath).split(/\r?\n/).length;
      return lines > 300 ? [`${relativePath} has ${lines} physical lines`] : [];
    });
    const compositionViolations: string[] = [];
    for (const relativePath of applicationFiles) {
      const source = sourceFile(relativePath);
      const visit = (node: ts.Node) => {
        if (ts.isIndexSignatureDeclaration(node)
          && node.type?.kind === ts.SyntaxKind.AnyKeyword) {
          compositionViolations.push(`${relativePath}:${lineOf(source, node)} declares an any index signature`);
        }
        if (ts.isClassDeclaration(node)
          && node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
          compositionViolations.push(`${relativePath}:${lineOf(source, node)} uses inheritance instead of composition`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(requiredModules.filter((module) => !fileNames.has(module))).toEqual([]);
    for (const module of requiredModules) {
      expect(sourceText(`packages/execution/src/application/${module}`).trim().length, `${module} is empty`).toBeGreaterThan(0);
    }
    expect(violations).toEqual([]);
    expect(compositionViolations).toEqual([]);
    const coordinator = sourceText("packages/execution/src/application/execution-coordinator.ts");
    expect(coordinator).toContain("constructor(private readonly services: ExecutionServices)");
    expect(coordinator).not.toContain("AdmissionCoordinator");
    expect(sourceText("apps/core-service/src/application/core-application-coordinator.ts")).toContain("CoreApplicationServices");
  });

  it("gives each Execution service a compile-time narrowed state capability view", () => {
    const statefulServices = [
      "attempt-executor.ts",
      "attempt-settlement-service.ts",
      "continuation-scheduler.ts",
      "control-inbox-dispatcher.ts",
      "execution-lifecycle-service.ts",
      "recovery-coordinator.ts",
      "run-context-service.ts",
      "run-event-hub.ts",
      "runtime-registry.ts",
    ];
    for (const filename of statefulServices) {
      const source = sourceText(`packages/execution/src/application/${filename}`);
      expect(source, `${filename} must declare a narrowed ExecutionStateView`).toContain("ExecutionStateView<");
      expect(source, `${filename} must not receive the full ExecutionState bag`)
        .not.toMatch(/private readonly state:\s*ExecutionState[,)]/);
    }
  });

  it("declares every service repository capability explicitly and prevents a full persistence-port escape", () => {
    const statefulServices = sourceFiles("packages/execution/src/application")
      .filter((relativePath) => /(?:coordinator|dispatcher|executor|hub|registry|scheduler|service)\.ts$/.test(relativePath))
      .filter((relativePath) => sourceText(relativePath).includes("state.persistence."));
    const violations: string[] = [];
    for (const relativePath of statefulServices) {
      const source = sourceFile(relativePath);
      const declared = new Set<string>();
      const used = new Set<string>();
      const visit = (node: ts.Node) => {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
          && node.typeName.text === "ExecutionStateView") {
          const persistenceKeys = node.typeArguments?.[1];
          if (persistenceKeys) for (const key of stringLiteralTypes(persistenceKeys)) declared.add(key);
        }
        if (ts.isPropertyAccessExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "persistence") {
          used.add(node.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (declared.size === 0) violations.push(`${relativePath} has no explicit persistence key set`);
      for (const key of used) {
        if (!declared.has(key)) violations.push(`${relativePath} uses undeclared persistence.${key}`);
      }
      if (declared.size > 9) violations.push(`${relativePath} exposes ${declared.size} repositories`);
      if (sourceText(relativePath).includes("CoreApplicationPersistencePort")) {
        violations.push(`${relativePath} imports or names the full CoreApplicationPersistencePort`);
      }
    }
    const runtimeHost = sourceText("apps/core-service/src/composition/runtime-host-adapter.ts");
    expect(runtimeHost).toMatch(/persistence:\s*Pick<\s*CoreApplicationPersistencePort,/s);
    expect(runtimeHost).not.toMatch(/persistence:\s*CoreApplicationPersistencePort/);
    expect(violations).toEqual([]);
  });

  it("keeps Runtime free of Store, persistence ports, MemoryFacade, and storage-shaped options", () => {
    const runtimeFiles = sourceFiles("adapters/runtime-pi/src");
    const violations: string[] = [];
    const forbiddenOptionFields = new Set(["store", "db", "repository", "persistence"]);

    for (const relativePath of runtimeFiles) {
      const source = sourceFile(relativePath);
      const report = (node: ts.Node, message: string) => {
        violations.push(`${relativePath}:${lineOf(source, node)} ${message}`);
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          const names = importedNames(node);
          if (names.includes("Store") || /(?:^|\/)store(?:\/|$)/.test(specifier)) {
            report(node, "imports Store");
          }
          if (names.includes("MemoryFacade")) report(node, "imports MemoryFacade");
          if (/(?:^|\/)persistence(?:\/|$)/.test(specifier)) report(node, "imports src/persistence");
          if (/(?:^|\/)execution\/ports(?:\/|$)/.test(specifier)
            && specifier !== "@tagent/execution/ports"
            && !specifier.endsWith("/execution/ports/attempt-runtime.js")) {
            report(node, "imports an Execution port other than the runtime contract");
          }
        }
        if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
          && forbiddenOptionFields.has(propertyName(node.name) ?? "")) {
          report(node, `declares storage-shaped option field '${propertyName(node.name)}'`);
        }
        if (ts.isPropertyAccessExpression(node)
          && forbiddenOptionFields.has(node.name.text)
          && (ts.isIdentifier(node.expression) && node.expression.text === "options"
            || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "options")) {
          report(node, `reads storage-shaped options.${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(runtimeFiles.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("keeps Admission and Execution application layers independent of transport, adapters, UI, and Pi SDKs", () => {
    const applicationRoots = ["packages/admission/src/application", "packages/execution/src/application"];
    const forbiddenImports = [
      { label: "Fastify", pattern: /^(?:fastify|@fastify\/)/ },
      { label: "SQLite", pattern: /(?:^|\/)(?:better-sqlite3|persistence\/sqlite)(?:\/|$)/ },
      { label: "React", pattern: /^(?:react|react-dom)(?:\/|$)/ },
      { label: "Pi SDK", pattern: /^@earendil-works\/pi-/ },
      { label: "Store", pattern: /(?:^|\/)store\/store\.(?:c|m)?js$/ },
    ];
    const violations: string[] = [];

    for (const root of applicationRoots) {
      const files = sourceFiles(root);
      if (files.length === 0) {
        violations.push(`${root} has no application modules`);
        continue;
      }
      for (const relativePath of files) {
        const source = sourceFile(relativePath);
        for (const statement of source.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
          const specifier = statement.moduleSpecifier.text;
          for (const forbidden of forbiddenImports) {
            if (forbidden.pattern.test(specifier)) {
              violations.push(`${relativePath}:${lineOf(source, statement)} imports ${forbidden.label} via '${specifier}'`);
            }
          }
          if (importedNames(statement).includes("Store")) {
            violations.push(`${relativePath}:${lineOf(source, statement)} imports Store`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the Execution package dependent only on its declared Governance ABI", () => {
    const executionRoot = path.join(repoRoot, "packages", "execution", "src");
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/execution/src")) {
      const source = sourceFile(relativePath);
      for (const statement of source.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
          || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")
          && specifier !== "@tagent/governance/domain"
          && specifier !== "@tagent/governance/ports") {
          violations.push(`${relativePath}:${lineOf(source, statement)} imports external '${specifier}'`);
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier)
          .replace(/\.(?:c|m)?js$/, ".ts");
        if (resolved !== executionRoot && !resolved.startsWith(`${executionRoot}${path.sep}`)) {
          violations.push(`${relativePath}:${lineOf(source, statement)} crosses Execution boundary via '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);

  });

  it("fails closed until every cyclic collaboration port is bound exactly once", () => {
    const reference = createOneShotPort<{ execute(value: string): string }>("TestPort");
    expect(() => reference.port.execute("before-bind")).toThrow(/not bound/);
    expect(() => reference.assertBound()).toThrow(/not bound/);
    reference.bind({ execute: (value) => `bound:${value}` });
    expect(reference.port.execute("ok")).toBe("bound:ok");
    expect(() => reference.bind({ execute: (value) => value })).toThrow(/already bound/);
    expect(() => reference.assertBound()).not.toThrow();
  });

  it("copies Admission decisions into an Execution-owned immutable launch snapshot", () => {
    const contract: TaskRunContract = {
      sourceInput: "ship it",
      summary: "Ship a verified result",
      objectives: [{ id: "o1", summary: "Build", timing: "current", kind: "change" }],
      acceptanceCriteria: ["passes"],
      scope: "repo",
      nonGoals: ["deploy"],
      sourceInboxIds: ["inbox-1"],
      parentRunId: null,
      relation: "independent",
      intent: "new_task",
      decisionReason: "new work",
      routerVersion: "test",
    };
    const snapshot = toTaskRunContractSnapshot(contract);
    contract.objectives[0].summary = "mutated";
    contract.acceptanceCriteria.push("late");
    contract.sourceInboxIds.push("late");
    expect(snapshot.objectives[0].summary).toBe("Build");
    expect(snapshot.acceptanceCriteria).toEqual(["passes"]);
    expect(snapshot.sourceInboxIds).toEqual(["inbox-1"]);
  });

  it("keeps composition and global facades outside Execution implementation", () => {
    expect(sourceText("packages/execution/src/application/execution-services.ts")).not.toMatch(/Admission|ServiceDependencies/);
    const composition = sourceText("apps/core-service/src/composition/execution-composition.ts");
    expect(composition).not.toMatch(/mutableServices|as\s+ExecutionServices/);
    expect(composition.match(/createOneShotPort</g)?.length).toBe(6);
    for (const forbidden of ["SessionInputRouter", "TaskRunSupervisor", "MemoryFacade", "@earendil-works/pi-"]) {
      expect(sourceText("packages/execution/src/application/execution-state.ts")).not.toContain(forbidden);
    }
  });
});
