import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const expectedExports = [".", "./application", "./domain", "./ports"];
const governanceDomainNames = new Set([
  "ApprovalRequest",
  "Artifact",
  "CompletionGate",
  "CriterionCoverage",
  "GateEvaluation",
  "GateFailure",
  "PlanItem",
  "ProgressSnapshot",
  "RunCheck",
  "SupervisorAction",
  "SupervisorDecision",
]);

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  dependencies: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
}

interface Tsconfig {
  references?: Array<{ path: string }>;
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
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

describe("Governance workspace package", () => {
  it("publishes only the explicit zero-dependency Governance ABI", () => {
    const root = readJson<{ devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const governance = readJson<PackageManifest>("packages/governance/package.json");

    expect(governance).toMatchObject({ name: "@tagent/governance", version: "0.4.1", private: true });
    expect(root.devDependencies[governance.name]).toBe(governance.version);
    expect(Object.keys(governance.exports).sort()).toEqual(expectedExports);
    expect(governance.dependencies).toEqual({});
    for (const [subpath, target] of Object.entries(governance.exports)) {
      expect(subpath).not.toContain("*");
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("packages/governance");
    expect(root.scripts.clean).toContain("@tagent/governance");
  });

  it("keeps Governance source independent from Execution, root source, and all packages", () => {
    const packageRoot = path.join(repoRoot, "packages/governance/src");
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/governance/src")) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
          violations.push(`${relativePath} imports ${specifier}`);
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

  it("keeps Governance types and Operation ports uniquely defined outside Execution", () => {
    const violations: string[] = [];
    for (const relativePath of sourceFiles("packages/execution/src")) {
      const source = parsedSource(relativePath);
      for (const statement of source.statements) {
        if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
          && governanceDomainNames.has(statement.name.text)) {
          violations.push(`${relativePath} defines ${statement.name.text}`);
        }
        if (ts.isInterfaceDeclaration(statement)
          && ["OperationRecord", "OperationUpdate", "OperationRepository"].includes(statement.name.text)) {
          violations.push(`${relativePath} defines ${statement.name.text}`);
        }
      }
    }
    expect(existsSync(path.join(repoRoot, "packages/execution/src/ports/operation-repository.ts"))).toBe(false);
    expect(violations).toEqual([]);
  });

  it("locks a manifest-aligned acyclic workspace DAG with only approved Governance dependents", () => {
    const workspaceDirs = readdirSync(path.join(repoRoot, "packages"))
      .filter((entry) => existsSync(path.join(repoRoot, "packages", entry, "package.json")))
      .sort();
    const manifests = new Map(workspaceDirs.map((directory) => [
      directory,
      readJson<PackageManifest>(`packages/${directory}/package.json`),
    ]));
    const names = new Set([...manifests.values()].map((manifest) => manifest.name));
    const graph = new Map<string, string[]>();

    for (const [directory, manifest] of manifests) {
      const dependencies = Object.keys(manifest.dependencies).filter((name) => names.has(name)).sort();
      graph.set(manifest.name, dependencies);
      const references = readJson<Tsconfig>(`packages/${directory}/tsconfig.json`).references ?? [];
      const referencedPackages = references.map((reference) => {
        const target = path.resolve(repoRoot, "packages", directory, reference.path, "package.json");
        return JSON.parse(readFileSync(target, "utf8")).name as string;
      }).sort();
      expect(referencedPackages, `${manifest.name} project references`).toEqual(dependencies);
    }

    expect(graph.get("@tagent/governance")).toEqual([]);
    expect([...graph].filter(([, dependencies]) => dependencies.includes("@tagent/governance")).map(([name]) => name).sort()).toEqual([
      "@tagent/admission",
      "@tagent/execution",
      "@tagent/learning",
    ]);

    const incoming = new Map([...graph.keys()].map((name) => [name, 0]));
    for (const dependencies of graph.values()) {
      for (const dependency of dependencies) incoming.set(dependency, (incoming.get(dependency) ?? 0) + 1);
    }
    const queue = [...incoming].filter(([, count]) => count === 0).map(([name]) => name);
    let visited = 0;
    while (queue.length) {
      const name = queue.shift()!;
      visited += 1;
      for (const dependency of graph.get(name) ?? []) {
        const next = (incoming.get(dependency) ?? 0) - 1;
        incoming.set(dependency, next);
        if (next === 0) queue.push(dependency);
      }
    }
    expect(visited, "workspace graph contains an SCC").toBe(graph.size);
  });

  it("resolves every public Governance export through compiled Node ESM", () => {
    const script = `
      const root = await import("@tagent/governance");
      const domain = await import("@tagent/governance/domain");
      const ports = await import("@tagent/governance/ports");
      if (typeof root.operationDigest !== "function" || root.operationDigest !== domain.operationDigest) process.exit(1);
      if (typeof domain.stableJson !== "function" || typeof domain.canonicalOperationJson !== "function") process.exit(1);
      if (Object.keys(ports).length) process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
