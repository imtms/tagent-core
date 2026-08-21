import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  toTaskRunContractSnapshot,
  toTaskRunLaunchSpec,
} from "@tagent/admission/composition";
import type {
  TaskRunContract,
} from "@tagent/admission/domain";

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
      .flatMap((entry) => {
        const relativeRoot = path.join(group, entry.name, "src");
        return existsSync(path.join(repoRoot, relativeRoot)) ? sourceFiles(relativeRoot) : [];
      });
  });
  const webSources = existsSync(path.join(repoRoot, "apps/web-console/src")) ? sourceFiles("apps/web-console/src") : [];
  return [...sourceFiles("src"), ...workspaceSources, ...webSources]
    .filter((relativePath) => relativePath !== "src/core/types.ts")
    .sort();
}

describe("Admission workspace package", () => {
  it("publishes only the explicit compiled Admission ABI", () => {
    const root = readJson<{ devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const admission = readJson<PackageManifest>("packages/admission/package.json");

    expect(admission).toMatchObject({ name: "@tagent/admission", version: "0.8.19", private: true });
    expect(root.devDependencies[admission.name]).toBe(admission.version);
    expect(Object.keys(admission.exports).sort()).toEqual(expectedExports);
    expect(admission.dependencies).toEqual({
      "@tagent/execution": "0.8.19",
      "@tagent/governance": "0.8.19",
    });
    for (const [subpath, target] of Object.entries(admission.exports)) {
      expect(subpath).not.toContain("*");
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("packages/admission");
    expect(root.scripts.clean).toContain("@tagent/admission");
  });

  it("depends only on its declared Execution and Governance ABIs", () => {
    const packageRoot = path.join(repoRoot, "packages/admission/src");
    const allowedExternal = new Set([
      "node:crypto",
      "@tagent/execution/domain",
      "@tagent/execution/ports",
      "@tagent/execution/composition",
      "@tagent/governance",
      "@tagent/governance/ports",
    ]);
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/admission/src")) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (!specifier.startsWith(".")) {
          if (!allowedExternal.has(specifier)) violations.push(`${relativePath} imports ${specifier}`);
          continue;
        }
        const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
        if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
          violations.push(`${relativePath} escapes to ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the Admission domain autonomous from Execution projections", () => {
    const violations = sourceFiles("packages/admission/src/domain")
      .flatMap((relativePath) => moduleSpecifiers(relativePath)
        .filter((specifier) => !specifier.startsWith("."))
        .map((specifier) => `${relativePath} imports ${specifier}`));
    expect(violations).toEqual([]);

    const sessionSource = readFileSync(path.join(repoRoot, "packages/admission/src/domain/session.ts"), "utf8");
    expect(sessionSource).toContain("SessionRunStatusView");
    expect(sessionSource).toContain("SessionRunPhaseView");
    expect(sessionSource).not.toMatch(/\b(?:RunStatus|RunPhase)\b/);
  });

  it("keeps Admission domain definitions out of root source", () => {
    const names = new Set([
      "Message",
      "Session",
      "SessionId",
      "SessionInputAnalysis",
      "Submission",
      "TaskRunContract",
    ]);
    const violations: string[] = [];
    for (const relativePath of sourceFiles("src")) {
      for (const statement of parsedSource(relativePath).statements) {
        if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
          && names.has(statement.name.text)) {
          violations.push(`${relativePath} defines ${statement.name.text}`);
        }
      }
    }
    expect(violations).toEqual([]);

    const sessionIdOwners: string[] = [];
    for (const relativePath of productionSourceFiles()) {
      for (const statement of parsedSource(relativePath).statements) {
        if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
          && statement.name.text === "SessionId") {
          sessionIdOwners.push(relativePath);
        }
      }
    }
    expect(sessionIdOwners).toEqual(["packages/admission/src/domain/session.ts"]);
  });

  it("keeps the Admission composition ABI provider-neutral", () => {
    const routerSource = readFileSync(path.join(repoRoot, "packages/admission/src/application/session-input-router.ts"), "utf8");
    expect(routerSource).toContain("SessionInputModelPort");
    expect(routerSource).toContain("SessionInputModelRequest");
    expect(routerSource).toContain("SessionInputModelResponse");
    expect(routerSource).toContain("SessionInputModelUsage");
    expect(routerSource).not.toMatch(/\b(?:SessionInputRouterModel|SessionInputLlmRequest|baseUrl|apiKey|timeoutMs|openai-completions)\b/);
  });

  it("copies a mutable TaskRunContract into an immutable Execution launch snapshot", () => {
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
    const launch = toTaskRunLaunchSpec({ sessionId: "session-1", goal: contract.summary, requestId: "request-1", contract });
    contract.objectives[0].summary = "mutated";
    contract.acceptanceCriteria.push("late");
    contract.sourceInboxIds.push("late");
    expect(snapshot.objectives[0].summary).toBe("Build");
    expect(snapshot.acceptanceCriteria).toEqual(["passes"]);
    expect(snapshot.sourceInboxIds).toEqual(["inbox-1"]);
    expect(launch.contract).toEqual(snapshot);
  });

  it("keeps project references aligned with the acyclic Admission manifest edge", () => {
    const references = readJson<{ references: Array<{ path: string }> }>("packages/admission/tsconfig.json").references;
    const referencedPackages = references.map((reference) => {
      const manifestPath = path.resolve(repoRoot, "packages/admission", reference.path, "package.json");
      return JSON.parse(readFileSync(manifestPath, "utf8")).name as string;
    }).sort();
    expect(referencedPackages).toEqual(["@tagent/execution", "@tagent/governance"]);

    const dependents = readdirSync(path.join(repoRoot, "packages")).flatMap((directory) => {
      const manifestPath = path.join(repoRoot, "packages", directory, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
      return Object.hasOwn(manifest.dependencies, "@tagent/admission") ? [manifest.name] : [];
    });
    expect(dependents).toEqual([]);
  });

  it("resolves every public Admission export through compiled Node ESM", () => {
    const script = `
      const root = await import("@tagent/admission");
      const domain = await import("@tagent/admission/domain");
      const ports = await import("@tagent/admission/ports");
      const composition = await import("@tagent/admission/composition");
      if (root.AdmissionCoordinator !== composition.AdmissionCoordinator) process.exit(1);
      if (!composition.SessionInputRouter || !composition.toTaskRunContractSnapshot || !composition.toTaskRunLaunchSpec) process.exit(1);
      if (Object.keys(domain).length || Object.keys(ports).length) process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
