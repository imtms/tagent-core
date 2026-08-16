import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  GuardedSqliteUnitOfWork,
  SqlitePersistence,
  Store,
} from "@tagent/persistence-sqlite";
import {
  SqliteAttemptRepository,
} from "@tagent/persistence-sqlite/sqlite";
import type { MutationUnitOfWork } from "@tagent/persistence-sqlite/unit-of-work";
import { WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const repoRoot = process.cwd();
const packageRoot = "adapters/persistence-sqlite";
const sourceRoot = `${packageRoot}/src`;
const expectedExports = [
  ".",
  "./sqlite",
  "./store",
  "./unit-of-work",
  "./writer",
];
const expectedWorkspaceDependencies = [
  "@tagent/admission",
  "@tagent/execution",
  "@tagent/governance",
  "@tagent/learning",
  "@tagent/memory",
];

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function sourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  return readdirSync(absoluteRoot).flatMap((entry) => {
    if (entry === "dist" || entry === "node_modules") return [];
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
  visit(parsedSource(relativePath));
  return specifiers;
}

function usesRawDatabaseApi(relativePath: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && ["db", "prepare", "exec"].includes(node.name.text)) {
      const isRegularExpressionExec = node.name.text === "exec"
        && ts.isRegularExpressionLiteral(node.expression);
      if (!isRegularExpressionExec) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(relativePath));
  return found;
}

describe("SQLite persistence adapter workspace package", () => {
  it("publishes a private explicit ABI with only approved domain ports and SQLite runtime", () => {
    const root = readJson<{ version: string; devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);

    expect(manifest).toMatchObject({
      name: "@tagent/persistence-sqlite",
      version: root.version,
      private: true,
    });
    expect(root.devDependencies[manifest.name]).toBe(manifest.version);
    expect(Object.keys(manifest.exports).sort()).toEqual(expectedExports);
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      ...expectedWorkspaceDependencies,
      "better-sqlite3",
    ]);
    for (const dependency of expectedWorkspaceDependencies) {
      expect(manifest.dependencies[dependency]).toBe(root.version);
    }
    expect(manifest.dependencies["better-sqlite3"]).toBe("12.4.1");
    expect(manifest.devDependencies).toEqual({ "@types/better-sqlite3": "7.6.13" });
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      expect(subpath).not.toContain("*");
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain("npm run build -w @tagent/persistence-sqlite");
    expect(root.scripts.clean).toContain("@tagent/persistence-sqlite");
  });

  it("exposes the approved runtime and type surface", () => {
    expect(SqlitePersistence).toBeTypeOf("function");
    expect(SqliteAttemptRepository).toBeTypeOf("function");
    expect(WriterFenceGuard).toBeTypeOf("function");
    expect(GuardedSqliteUnitOfWork).toBeTypeOf("function");
    const unitOfWork: MutationUnitOfWork | undefined = undefined;
    expect(unitOfWork).toBeUndefined();
  });

  it("keeps the adapter independent from Core, HTTP, runtimes, tools, and application concrete code", () => {
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    const dependencies = new Set(Object.keys(manifest.dependencies));
    const violations: string[] = [];
    for (const relativePath of sourceFiles(sourceRoot)) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(path.join(repoRoot, relativePath)), specifier);
          const absoluteSourceRoot = path.join(repoRoot, sourceRoot);
          if (target !== absoluteSourceRoot && !target.startsWith(`${absoluteSourceRoot}${path.sep}`)) {
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

    const packageSource = sourceFiles(sourceRoot)
      .map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8"))
      .join("\n");
    expect(packageSource).not.toMatch(/@tagent\/(?:runtime-pi|core-client|abi)|Fastify|pi-(?:ai|agent|coding)|\/core\/|\/http\/|\/tools\/|\/apps?\//);
  });

  it("keeps production composition on one Store, connection, fence, unit of work, and adapter", () => {
    const serverSource = readFileSync(path.join(repoRoot, "apps/core-service/src/server.ts"), "utf8");
    const adapterSource = sourceFiles(sourceRoot)
      .map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8"))
      .join("\n");
    expect((serverSource.match(/new Store\(/g) ?? [])).toHaveLength(1);
    expect((serverSource.match(/claimCoreWriterConnectionWithRetry\(store/g) ?? [])).toHaveLength(1);
    expect((serverSource.match(/writerConnection\.writerGuard\.installConnectionGuard\(\)/g) ?? [])).toHaveLength(1);
    expect((serverSource.match(/createGuardedSqlitePersistence\(store, writerConnection\.writerGuard\)/g) ?? [])).toHaveLength(1);
    expect(serverSource).toContain("closeStore: () => store?.close()");
    expect(adapterSource).not.toMatch(/new Store\(/);
    expect(serverSource).toContain('from "@tagent/persistence-sqlite"');
    expect(serverSource).not.toMatch(/from "\.\/(?:store|persistence)\//);
  });

  it("keeps SQLite driver and raw database APIs inside the adapter", () => {
    const productionFiles = [
      ...sourceFiles("src"),
      ...sourceFiles("packages"),
      ...sourceFiles("adapters"),
      ...sourceFiles("apps"),
    ];
    const sqliteDriverImporters = productionFiles.filter((relativePath) =>
      moduleSpecifiers(relativePath).includes("better-sqlite3"));
    expect(sqliteDriverImporters.length).toBeGreaterThan(0);
    expect(sqliteDriverImporters.every((relativePath) => relativePath.startsWith(`${sourceRoot}/`))).toBe(true);

    const upperLayerViolations = sourceFiles("src").filter((relativePath) =>
      usesRawDatabaseApi(relativePath)
        && !relativePath.startsWith("src/store/")
        && !relativePath.startsWith("src/persistence/"));
    expect(upperLayerViolations).toEqual([]);
  });

  it("creates the single current SQLite shape", () => {
    const store = new Store(":memory:");
    try {
      expect(store.getSchemaVersion()).toBe(2);
      const tables = store.db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>;
      expect(tables).toHaveLength(89);
      expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
        "core_schema_migrations",
        "session_create_receipts",
        "submission_audit_receipts",
        "task_run_command_receipts",
        "workspace_goal_inbox_links",
        "workspace_goal_operation_receipts",
        "workspace_goal_roadmap_item_progress",
        "skills",
        "skill_revisions",
        "workspace_skill_bindings",
        "attempt_request_envelopes",
        "profile_mutation_receipts",
        "profile_operation_receipts",
        "profile_audit_events",
        "workspace_skill_revisions",
        "session_inbox_revisions",
        "skill_catalog_state",
        "profile_resource_revisions",
      ]));
      expect((store.db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("payload_json");
      expect((store.db.prepare("PRAGMA table_info(run_checks)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(["source_operation_id", "observed_at"]));
      expect((store.db.prepare("PRAGMA table_info(workspace_goal_run_links)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("link_mode");
      for (const table of ["sessions", "session_supervisor_inbox", "skills"]) {
        expect((store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)).toContain("revision");
      }
    } finally {
      store.close();
    }
  });

  it("resolves every compiled persistence export through Node ESM", () => {
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'await import("@tagent/persistence-sqlite");',
        'await import("@tagent/persistence-sqlite/store");',
        'await import("@tagent/persistence-sqlite/sqlite");',
        'await import("@tagent/persistence-sqlite/writer");',
        'await import("@tagent/persistence-sqlite/unit-of-work");',
      ].join("\n"),
    ], { cwd: repoRoot, stdio: "pipe" });
  });
});
