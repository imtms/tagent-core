import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const workspaceGroups = ["packages", "adapters", "apps"] as const;
const internalVersion = "0.5.0";
const expectedInternalGraph = {
  "@tagent/abi": [],
  "@tagent/core-client": ["@tagent/abi"],
  "@tagent/governance": [],
  "@tagent/execution": ["@tagent/governance"],
  "@tagent/admission": ["@tagent/execution", "@tagent/governance"],
  "@tagent/memory": [],
  "@tagent/learning": ["@tagent/admission", "@tagent/execution", "@tagent/governance", "@tagent/memory"],
  "@tagent/runtime-pi": ["@tagent/execution"],
  "@tagent/persistence-sqlite": ["@tagent/admission", "@tagent/execution", "@tagent/governance", "@tagent/learning", "@tagent/memory"],
  "@tagent/workspace-local": ["@tagent/execution"],
  "@tagent/http-fastify": ["@tagent/abi", "@tagent/admission", "@tagent/execution", "@tagent/governance"],
  "@tagent/core-service": [
    "@tagent/admission",
    "@tagent/execution",
    "@tagent/governance",
    "@tagent/http-fastify",
    "@tagent/learning",
    "@tagent/memory",
    "@tagent/persistence-sqlite",
    "@tagent/runtime-pi",
    "@tagent/workspace-local",
  ],
  "@tagent/web-console": ["@tagent/abi", "@tagent/core-client"],
} as const satisfies Record<string, readonly string[]>;

interface ExportTarget {
  types: string;
  import: string;
}

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports: Record<string, ExportTarget>;
}

interface Workspace {
  group: typeof workspaceGroups[number];
  root: string;
  absoluteRoot: string;
  manifest: PackageManifest;
  sourceFiles: string[];
}

interface ModuleReferences {
  specifiers: string[];
  unresolvedRuntimeLoads: string[];
}

function relative(filename: string): string {
  return path.relative(repoRoot, filename).split(path.sep).join("/");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function filesBelow(absoluteRoot: string, predicate: (filename: string) => boolean): string[] {
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    if (entry === "dist" || entry === "node_modules" || entry === ".git" || entry === ".omx") return [];
    const filename = path.join(absoluteRoot, entry);
    return statSync(filename).isDirectory()
      ? filesBelow(filename, predicate)
      : predicate(filename) ? [filename] : [];
  }).sort();
}

function sourceFiles(absoluteRoot: string): string[] {
  return filesBelow(absoluteRoot, (filename) => /\.[cm]?tsx?$/.test(filename));
}

function discoverWorkspaces(): Workspace[] {
  return workspaceGroups.flatMap((group) => {
    const absoluteGroup = path.join(repoRoot, group);
    if (!existsSync(absoluteGroup)) return [];
    return readdirSync(absoluteGroup, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const root = `${group}/${entry.name}`;
        const absoluteRoot = path.join(repoRoot, root);
        const manifestPath = path.join(absoluteRoot, "package.json");
        if (!existsSync(manifestPath)) throw new Error(`${root} is not a workspace: package.json is missing`);
        return {
          group,
          root,
          absoluteRoot,
          manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest,
          sourceFiles: sourceFiles(path.join(absoluteRoot, "src")),
        };
      });
  }).sort((left, right) => left.root.localeCompare(right.root));
}

function parsedSource(filename: string, sourceText = readFileSync(filename, "utf8")): ts.SourceFile {
  return ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function moduleReferencesFromSource(filename: string, sourceText: string): ModuleReferences {
  const source = parsedSource(filename, sourceText);
  const specifiers: string[] = [];
  const unresolvedRuntimeLoads: string[] = [];
  const add = (node: ts.Node | undefined) => {
    const specifier = literalText(node);
    if (specifier !== undefined) specifiers.push(specifier);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === undefined) {
        unresolvedRuntimeLoads.push(`${relative(filename)}:${node.expression.getText(source)}`);
      } else {
        specifiers.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, unresolvedRuntimeLoads };
}

function moduleReferences(filename: string): ModuleReferences {
  return moduleReferencesFromSource(filename, readFileSync(filename, "utf8"));
}

function packageName(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function isWithin(candidate: string, root: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === "" || relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation);
}

function relativeImportEscapesRoot(filename: string, specifier: string, root: string): boolean {
  return specifier.startsWith(".") && !isWithin(path.resolve(path.dirname(filename), specifier), root);
}

function isWorkspaceDeepImport(specifier: string): boolean {
  return specifier.startsWith("@tagent/") && /\/src(?:\/|$)/.test(specifier);
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (name: string) => {
    indices.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);
    for (const dependency of graph.get(name) ?? []) {
      if (!indices.has(dependency)) {
        connect(dependency);
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indices.get(dependency)!));
      }
    }
    if (lowLinks.get(name) !== indices.get(name)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== name);
    components.push(component.sort());
  };
  for (const name of graph.keys()) if (!indices.has(name)) connect(name);
  return components;
}

function topologicalOrder(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const dependencyCounts = new Map([...graph].map(([name, dependencies]) => [name, dependencies.length]));
  const dependents = new Map<string, string[]>();
  for (const [name, dependencies] of graph) {
    for (const dependency of dependencies) {
      const entries = dependents.get(dependency) ?? [];
      entries.push(name);
      dependents.set(dependency, entries);
    }
  }
  const ready = [...dependencyCounts].filter(([, count]) => count === 0).map(([name]) => name).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift()!;
    order.push(name);
    for (const dependent of dependents.get(name) ?? []) {
      const remaining = dependencyCounts.get(dependent)! - 1;
      dependencyCounts.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return order;
}

function referenceNames(
  configPath: string,
  workspaceByRoot: ReadonlyMap<string, Workspace>,
): { workspaces: string[]; other: string[] } {
  const config = readJson<{ references?: Array<{ path: string }> }>(configPath);
  const configRoot = path.dirname(path.join(repoRoot, configPath));
  const workspaces: string[] = [];
  const other: string[] = [];
  for (const reference of config.references ?? []) {
    const target = path.resolve(configRoot, reference.path);
    const workspace = workspaceByRoot.get(target);
    if (workspace) workspaces.push(workspace.manifest.name);
    else other.push(relative(target));
  }
  return { workspaces: workspaces.sort(), other: other.sort() };
}

function buildWorkspaceOrder(script: string, workspaces: readonly Workspace[]): string[] {
  const nameByRoot = new Map(workspaces.map((workspace) => [workspace.root, workspace.manifest.name]));
  const knownNames = new Set(workspaces.map((workspace) => workspace.manifest.name));
  return script.match(/(?:packages|adapters|apps)\/[a-z0-9-]+|@tagent\/[a-z0-9-]+/g)?.flatMap((token) => {
    const name = token.startsWith("@tagent/") ? token : nameByRoot.get(token);
    return name && knownNames.has(name) ? [name] : [];
  }) ?? [];
}

function regularExpressionIdentifiers(source: ts.SourceFile): Set<string> {
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

function usesEmbeddedDatabaseApi(filename: string): boolean {
  const source = parsedSource(filename);
  const regularExpressions = regularExpressionIdentifiers(source);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && ["db", "prepare", "exec"].includes(node.name.text)) {
      let receiver: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
      const regularExpressionExec = node.name.text === "exec"
        && (ts.isRegularExpressionLiteral(receiver)
          || ts.isIdentifier(receiver) && regularExpressions.has(receiver.text));
      if (!regularExpressionExec) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function classDeclarations(filename: string, className: string): number {
  const source = parsedSource(filename);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

const workspaces = discoverWorkspaces();
const workspaceByName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
const workspaceByRoot = new Map(workspaces.map((workspace) => [workspace.absoluteRoot, workspace]));
const internalGraph = new Map(workspaces.map((workspace) => [
  workspace.manifest.name,
  Object.keys(workspace.manifest.dependencies ?? {}).filter((name) => workspaceByName.has(name)).sort(),
]));
const allWorkspaceSourceFiles = workspaces.flatMap((workspace) => workspace.sourceFiles);

describe("workspace architecture", () => {
  it("discovers the reviewed modular-monolith topology and locks its internal dependency graph", () => {
    const root = readJson<{ workspaces: string[] }>("package.json");
    expect(root.workspaces).toEqual(["packages/*", "adapters/*", "apps/*"]);
    expect([...workspaceByName.keys()].sort()).toEqual(Object.keys(expectedInternalGraph).sort());
    expect(workspaces.map((workspace) => workspace.root).sort()).toEqual([
      "adapters/http-fastify",
      "adapters/persistence-sqlite",
      "adapters/runtime-pi",
      "adapters/workspace-local",
      "apps/core-service",
      "apps/web-console",
      "packages/abi",
      "packages/admission",
      "packages/core-client",
      "packages/execution",
      "packages/governance",
      "packages/learning",
      "packages/memory",
    ]);
    for (const workspace of workspaces) {
      expect(workspace.manifest).toMatchObject({ version: internalVersion, private: true });
      expect(internalGraph.get(workspace.manifest.name)).toEqual(
        [...expectedInternalGraph[workspace.manifest.name as keyof typeof expectedInternalGraph]].sort(),
      );
      for (const dependency of internalGraph.get(workspace.manifest.name) ?? []) {
        expect(workspace.manifest.dependencies?.[dependency]).toBe(internalVersion);
      }
      if (workspace.group !== "apps") {
        expect(internalGraph.get(workspace.manifest.name)).not.toContain("@tagent/core-service");
      }
    }
    expect(stronglyConnectedComponents(internalGraph).every((component) => component.length === 1)).toBe(true);
    expect([...internalGraph].every(([name, dependencies]) => !dependencies.includes(name))).toBe(true);
    expect(topologicalOrder(internalGraph)).toHaveLength(internalGraph.size);
  });

  it("aligns TypeScript references and the root build pipeline with the manifest graph", () => {
    for (const workspace of workspaces) {
      const references = referenceNames(`${workspace.root}/tsconfig.json`, workspaceByRoot);
      expect(references.other, `${workspace.root}/tsconfig.json has a non-workspace reference`).toEqual([]);
      expect(references.workspaces).toEqual(internalGraph.get(workspace.manifest.name));
    }
    const expectedNames = [...workspaceByName.keys()].sort();
    const serverWorkspaceNames = expectedNames.filter((name) => name !== "@tagent/web-console");
    expect(referenceNames("tsconfig.json", workspaceByRoot)).toEqual({
      workspaces: serverWorkspaceNames,
      other: ["tsconfig.server.json", "tsconfig.test.json", "tsconfig.web.json"],
    });
    expect(referenceNames("tsconfig.server.json", workspaceByRoot)).toEqual({
      workspaces: serverWorkspaceNames,
      other: [],
    });
    expect(referenceNames("tsconfig.web.json", workspaceByRoot)).toEqual({
      workspaces: ["@tagent/abi", "@tagent/core-client"],
      other: [],
    });

    const root = readJson<{ scripts: Record<string, string> }>("package.json");
    const order = buildWorkspaceOrder(root.scripts["build:packages"], workspaces);
    expect(order).toHaveLength(serverWorkspaceNames.length);
    expect(new Set(order).size).toBe(serverWorkspaceNames.length);
    const positions = new Map(order.map((name, index) => [name, index]));
    for (const [name, dependencies] of internalGraph) {
      if (name === "@tagent/web-console") continue;
      for (const dependency of dependencies) {
        expect(positions.get(dependency), `${dependency} must build before ${name}`).toBeLessThan(positions.get(name)!);
      }
    }
    expect(root.scripts.build).toContain("npm run build -w @tagent/web-console");
  });

  it("publishes only explicit compiled ESM ABI entries and resolves every public entry", () => {
    const publicEntries: string[] = [];
    for (const workspace of workspaces) {
      const keys = Object.keys(workspace.manifest.exports);
      expect(keys.some((key) => key.includes("*"))).toBe(false);
      for (const [key, target] of Object.entries(workspace.manifest.exports)) {
        expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
        expect(existsSync(path.resolve(workspace.absoluteRoot, target.types))).toBe(true);
        expect(existsSync(path.resolve(workspace.absoluteRoot, target.import))).toBe(true);
        publicEntries.push(`${workspace.manifest.name}${key === "." ? "" : key.slice(1)}`);
      }
    }
    const script = `
      const entries = ${JSON.stringify(publicEntries)};
      for (const entry of entries) await import(entry);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 15_000,
    })).not.toThrow();
  });

  it("enforces public-package imports, declared dependencies, and one-way workspace boundaries", () => {
    const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
    const violations: string[] = [];
    for (const workspace of workspaces) {
      const declared = new Set([
        ...Object.keys(workspace.manifest.dependencies ?? {}),
        ...Object.keys(workspace.manifest.devDependencies ?? {}),
        ...Object.keys(workspace.manifest.peerDependencies ?? {}),
        ...Object.keys(workspace.manifest.optionalDependencies ?? {}),
      ]);
      for (const filename of workspace.sourceFiles) {
        const references = moduleReferences(filename);
        violations.push(...references.unresolvedRuntimeLoads.map((load) => `${load} is not statically resolvable`));
        for (const specifier of references.specifiers) {
          if (specifier.startsWith(".")) {
            if (relativeImportEscapesRoot(filename, specifier, workspace.absoluteRoot)) {
              violations.push(`${relative(filename)} escapes ${workspace.root} through ${specifier}`);
            }
            continue;
          }
          if (builtins.has(specifier)) continue;
          const importedPackage = packageName(specifier);
          if (isWorkspaceDeepImport(specifier)) violations.push(`${relative(filename)} deep-imports ${specifier}`);
          if (!declared.has(importedPackage)) violations.push(`${relative(filename)} imports undeclared ${specifier}`);
          if (workspace.group !== "apps" && importedPackage === "@tagent/core-service") {
            violations.push(`${relative(filename)} reverses into the core-service App`);
          }
        }
      }
    }

    for (const filename of sourceFiles(path.join(repoRoot, "src"))) {
      for (const specifier of moduleReferences(filename).specifiers.filter((entry) => entry.startsWith("."))) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        if (workspaces.some((workspace) => isWithin(resolved, workspace.absoluteRoot))) {
          violations.push(`${relative(filename)} reaches workspace source through ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps concrete framework, runtime, and database implementations in reviewed adapters", () => {
    const concreteOwners = new Map<string, Set<string>>([
      ["fastify", new Set(["adapters/http-fastify"])],
      ["better-sqlite3", new Set(["adapters/persistence-sqlite"])],
      ["@earendil-works/pi-agent-core", new Set(["adapters/runtime-pi"])],
      ["@earendil-works/pi-ai", new Set(["adapters/runtime-pi"])],
    ]);
    const violations: string[] = [];
    for (const workspace of workspaces) {
      for (const filename of workspace.sourceFiles) {
        for (const specifier of moduleReferences(filename).specifiers) {
          const importedPackage = packageName(specifier);
          const allowed = concreteOwners.get(importedPackage);
          if (allowed && !allowed.has(workspace.root)) {
            violations.push(`${relative(filename)} imports concrete dependency ${specifier}`);
          }
        }
        if (workspace.root !== "adapters/persistence-sqlite" && usesEmbeddedDatabaseApi(filename)) {
          violations.push(`${relative(filename)} uses an embedded database API`);
        }
      }
    }
    const storeDeclarations = allWorkspaceSourceFiles.flatMap((filename) =>
      classDeclarations(filename, "Store") > 0 ? [relative(filename)] : []
    );
    expect(storeDeclarations).toEqual(["adapters/persistence-sqlite/src/store.ts"]);
    expect(violations).toEqual([]);
  });

  it("keeps only the documented root CLI wrapper", () => {
    expect(sourceFiles(path.join(repoRoot, "src")).map(relative)).toEqual(["src/server.ts"]);
    const serverPath = path.join(repoRoot, "src/server.ts");
    const server = parsedSource(serverPath);
    expect(server.statements.every((statement) =>
      ts.isImportDeclaration(statement)
      || ts.isExportDeclaration(statement)
      || ts.isVariableStatement(statement)
      || ts.isIfStatement(statement)
    )).toBe(true);
    expect(moduleReferences(serverPath).specifiers.sort()).toEqual([
      "@tagent/core-service",
      "@tagent/core-service",
      "node:path",
      "node:url",
    ]);
    const serverText = readFileSync(serverPath, "utf8");
    expect(serverText).toContain("if (entry === import.meta.url)");
    expect(serverText).not.toMatch(/\b(?:Store|AgentService|CoreLifecycle|TaskRunSupervisor|createApp)\b/);
  });

  it("keeps Web on the channel ABI and Core client without backend source reach-through", () => {
    const webRoot = path.join(repoRoot, "apps", "web-console", "src");
    const violations: string[] = [];
    for (const filename of sourceFiles(webRoot)) {
      const references = moduleReferences(filename);
      violations.push(...references.unresolvedRuntimeLoads.map((load) => `${load} is not statically resolvable`));
      for (const specifier of references.specifiers) {
        if (specifier.startsWith(".")) {
          if (relativeImportEscapesRoot(filename, specifier, webRoot)) {
            violations.push(`${relative(filename)} escapes web/src through ${specifier}`);
          }
        } else if (specifier.startsWith("@tagent/")
          && !["@tagent/abi", "@tagent/core-client"].includes(packageName(specifier))) {
          violations.push(`${relative(filename)} imports backend workspace ${specifier}`);
        }
        if (isWorkspaceDeepImport(specifier)) violations.push(`${relative(filename)} deep-imports ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses normalized names and keeps the native workspace helper single-sourced", () => {
    const kebabSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const kebabFilename = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/;
    const violations: string[] = [];
    for (const workspace of workspaces) {
      const directoryName = path.basename(workspace.root);
      if (!kebabSegment.test(directoryName)) violations.push(`${workspace.root} is not kebab-case`);
      if (workspace.manifest.name !== `@tagent/${directoryName}`) {
        violations.push(`${workspace.root} does not match package name ${workspace.manifest.name}`);
      }
      if (["common", "shared"].includes(directoryName)) violations.push(`${workspace.root} is an unowned catch-all package`);
      const entries = filesBelow(workspace.absoluteRoot, () => true);
      for (const filename of entries) {
        const segments = path.relative(workspace.absoluteRoot, filename).split(path.sep);
        for (const segment of segments.slice(0, -1)) {
          if (!kebabSegment.test(segment)) violations.push(`${relative(filename)} has non-kebab directory ${segment}`);
        }
        const basename = segments.at(-1)!;
        const reactComponent = /^[A-Z][A-Za-z0-9]*\.tsx$/.test(basename);
        if (!basename.startsWith(".") && !kebabFilename.test(basename) && !reactComponent) {
          violations.push(`${relative(filename)} has non-standard filename`);
        }
      }
    }
    expect(violations).toEqual([]);

    const helperSources = ["src", ...workspaceGroups]
      .flatMap((root) => filesBelow(path.join(repoRoot, root), (filename) => path.basename(filename) === "workspace-fd-helper.py"))
      .map(relative);
    expect(helperSources).toEqual(["adapters/workspace-local/src/workspace-fd-helper.py"]);
  });

  it("proves the AST, deep-import, boundary, SCC, and topological gates detect regressions", () => {
    const probe = moduleReferencesFromSource(path.join(repoRoot, "probe.ts"), `
      import value from "./local.js";
      export * from "@tagent/a";
      type Imported = import("@tagent/b").Imported;
      const dynamic = import("@tagent/c");
      const required = require("@tagent/d");
    `);
    expect(probe.specifiers.sort()).toEqual([
      "./local.js",
      "@tagent/a",
      "@tagent/b",
      "@tagent/c",
      "@tagent/d",
    ]);
    const unresolved = moduleReferencesFromSource(path.join(repoRoot, "probe.ts"), `
      import(moduleName);
      require(resolveModule());
    `);
    expect(unresolved.unresolvedRuntimeLoads).toHaveLength(2);
    expect(relativeImportEscapesRoot(
      path.join(repoRoot, "packages/a/src/index.ts"),
      "../../../adapters/b/src/index.js",
      path.join(repoRoot, "packages/a"),
    )).toBe(true);
    expect(isWorkspaceDeepImport("@tagent/execution/src/domain/attempt.js")).toBe(true);

    const cyclic = new Map<string, readonly string[]>([["a", ["b"]], ["b", ["a"]]]);
    expect(stronglyConnectedComponents(cyclic)).toEqual([["a", "b"]]);
    expect(topologicalOrder(cyclic)).toEqual([]);
  });
});
