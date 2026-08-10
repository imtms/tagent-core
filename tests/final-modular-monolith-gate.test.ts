import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeAbi, SessionSchema } from "@tagent/abi";
import { createApp } from "@tagent/http-fastify";

const root = process.cwd();
const source = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

function filesUnder(relative: string): string[] {
  const absolute = path.join(root, relative);
  return readdirSync(absolute).flatMap((name) => {
    const child = path.join(absolute, name);
    const childRelative = path.posix.join(relative, name);
    return statSync(child).isDirectory() ? filesUnder(childRelative) : [childRelative];
  });
}

function manifest(relative: string): { name: string; dependencies?: Record<string, string> } {
  return JSON.parse(source(relative)) as { name: string; dependencies?: Record<string, string> };
}

function buildWebConsole(): void {
  try {
    execFileSync("npm", ["run", "build", "-w", "@tagent/web-console"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    const failure = error as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
    const output = [failure.stdout, failure.stderr]
      .filter((value): value is string | Buffer => value !== undefined)
      .map((value) => value.toString())
      .join("\n")
      .trim();
    throw new Error(
      `Web Console build failed${failure.message ? `: ${failure.message}` : ""}${output ? `\n${output}` : ""}`,
      { cause: error },
    );
  }
}

function buildRootServer(): string[] {
  const output = mkdtempSync(path.join(tmpdir(), "tagent-root-build-"));
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.server.json", "--outDir", output], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    const walk = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
      const child = path.join(directory, name);
      return statSync(child).isDirectory()
        ? walk(child).map((file) => path.posix.join(name, file))
        : [name];
    });
    return walk(output).sort();
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

describe("final modular monolith gate", () => {
  it("publishes an acyclic workspace DAG with only the canonical ABI and client at the Web boundary", () => {
    const manifests = [
      "packages/abi/package.json",
      "packages/admission/package.json",
      "packages/core-client/package.json",
      "packages/execution/package.json",
      "packages/governance/package.json",
      "packages/learning/package.json",
      "packages/memory/package.json",
      "adapters/http-fastify/package.json",
      "adapters/persistence-sqlite/package.json",
      "adapters/runtime-pi/package.json",
      "adapters/workspace-local/package.json",
      "apps/core-service/package.json",
      "apps/web-console/package.json",
    ].map(manifest);
    const names = new Set(manifests.map((item) => item.name));
    const edges = new Map(manifests.map((item) => [
      item.name,
      Object.keys(item.dependencies ?? {}).filter((dependency) => dependency.startsWith("@tagent/")),
    ]));
    for (const dependencies of edges.values()) {
      expect(dependencies.every((dependency) => names.has(dependency))).toBe(true);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      expect(visiting.has(name), `workspace dependency cycle through ${name}`).toBe(false);
      visiting.add(name);
      for (const dependency of edges.get(name) ?? []) visit(dependency);
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of names) visit(name);

    expect(edges.get("@tagent/web-console")).toEqual(["@tagent/abi", "@tagent/core-client"]);
    expect([...edges.entries()].filter(([, dependencies]) => dependencies.includes("@tagent/web-console"))).toEqual([]);
  });

  it("removes every production compatibility surface and exposes Core only below /api/v1", () => {
    for (const removed of [
      "adapters/http-fastify/src/legacy/plugin.ts",
      "adapters/http-fastify/src/public/plugin.ts",
      "packages/abi/src/legacy",
      "packages/core-client/src/legacy-decoders.ts",
      "packages/memory/src/legacy.ts",
      "src/abi",
      "src/core-client",
      "src/app.ts",
      "src/auth.ts",
      "src/config.ts",
      "src/artifact-content.ts",
      "src/http-memory-adapter.ts",
      "vite.config.ts",
    ]) expect(existsSync(path.join(root, removed)), `${removed} must be deleted`).toBe(false);

    expect(filesUnder("src")).toEqual(["src/server.ts"]);

    const boundedProductionFiles = [
      "adapters/http-fastify/src/app.ts",
      ...filesUnder("adapters/http-fastify/src/v1").filter((file) => file.endsWith(".ts")),
      ...filesUnder("packages/abi/src").filter((file) => file.endsWith(".ts")),
      ...filesUnder("packages/core-client/src").filter((file) => file.endsWith(".ts")),
      "apps/web-console/src/api.ts",
      "apps/web-console/src/App.tsx",
      "src/server.ts",
    ];
    for (const file of boundedProductionFiles) {
      const content = source(file);
      expect(content, `${file} retains a legacy symbol`).not.toMatch(/Legacy(?:Compat|Decode|[A-Z])/);
      expect(content, `${file} retains a legacy import path`).not.toMatch(/(?:\/legacy\/|legacy-decoders|legacy\/plugin)/);
    }

    const app = source("adapters/http-fastify/src/app.ts");
    expect(app).toContain("app.register(v1ApiPlugin");
    expect(app).not.toContain("registerLegacyCompatibilityRoutes");
    for (const file of filesUnder("adapters/http-fastify/src/v1").filter((item) => item.endsWith(".ts"))) {
      expect(source(file), `${file} registers an unversioned API route`)
        .not.toMatch(/app\.(?:all|delete|get|patch|post|put)\(\s*["'`]\/api\/(?!v1(?:\/|["'`]))/);
    }
    expect(source("packages/abi/src/index.ts")).not.toContain("LegacyCompat");
    expect(source("packages/core-client/src/index.ts")).not.toContain("legacy-decoders");
    expect(source("packages/core-client/src/transport.ts")).not.toContain("legacyRequestIdFallback");
    expect(source("packages/memory/package.json")).not.toContain('"./legacy"');
  });

  it("compiles and releases only the root server entrypoint", () => {
    const serverConfig = JSON.parse(source("tsconfig.server.json")) as {
      files?: string[];
      include?: string[];
      compilerOptions?: { outDir?: string; rootDir?: string };
    };
    expect(serverConfig.files).toEqual(["src/server.ts"]);
    expect(serverConfig.include).toBeUndefined();
    expect(serverConfig.compilerOptions).toMatchObject({ outDir: "dist", rootDir: "src" });
    expect(buildRootServer()).toEqual(["server.js"]);

    const rootPackage = JSON.parse(source("package.json")) as {
      engines: { node: string; npm: string };
      scripts: { build: string };
    };
    expect(rootPackage.engines).toEqual({ node: "24.18.1", npm: ">=12" });
    expect(rootPackage.scripts.build).toContain("rm -rf dist && tsc -p tsconfig.server.json");

    const releaseBuild = source("scripts/build-release.sh");
    expect(releaseBuild).toContain('cp -a package.json package-lock.json dist "$core_release/"');
    expect(releaseBuild).toContain('cp -a "$install_root/node_modules" "$core_release/"');
    expect(releaseBuild).not.toContain("npm prune");
    expect(releaseBuild).not.toMatch(/cp\s+-a\s+src(?:\s|$)/);
    expect(releaseBuild).toContain('node --check "$core_release/dist/server.js"');
  });

  it("keeps HTTP, ABI, and client modules owned and reviewable", () => {
    const limits: Array<[string, number]> = [
      ["adapters/http-fastify/src/app.ts", 180],
      ["apps/web-console/src/api.ts", 300],
      ...filesUnder("adapters/http-fastify/src/v1").filter((file) => file.endsWith(".ts")).map((file) => [file, 300] as [string, number]),
      ...filesUnder("packages/abi/src/admin/v1").filter((file) => file.endsWith(".ts")).map((file) => [file, 300] as [string, number]),
      ...filesUnder("packages/abi/src/channel/v1").filter((file) => file.endsWith(".ts")).map((file) => [file, 300] as [string, number]),
      ...filesUnder("packages/abi/src/internal/v1").filter((file) => file.endsWith(".ts")).map((file) => [file, 300] as [string, number]),
      ...filesUnder("packages/core-client/src").filter((file) => file.endsWith(".ts")).map((file) => [file, 300] as [string, number]),
    ];
    for (const [file, limit] of limits) {
      expect(source(file).split("\n").length, `${file} exceeds its ownership limit`).toBeLessThanOrEqual(limit);
    }
    const webApi = source("apps/web-console/src/api.ts");
    expect(webApi).toContain("@tagent/abi");
    expect(webApi).toContain("@tagent/core-client");
    expect([...webApi.matchAll(/from\s+["'](@tagent\/[^"']+)["']/g)].map((match) => match[1]).sort())
      .toEqual(["@tagent/abi", "@tagent/core-client"]);
    expect(webApi).not.toMatch(/["'`]\/api\/(?!v1(?:\/|["'`]))/);
  });

  it("builds the migrated Web Console against the canonical ABI and client", { timeout: 180_000 }, () => {
    buildWebConsole();
  });

  it("keeps Core and Web release artifacts separate and documents the final contracts", () => {
    const release = source("scripts/release-manifest.mjs");
    expect(release).toContain("const coreRequiredReleaseFiles");
    expect(release).toContain("const webRequiredReleaseFiles");
    expect(release).not.toMatch(/webRequiredReleaseFiles\s*=\s*\[[\s\S]*gateway-readiness-probe/);
    expect(release).not.toMatch(/legacy/i);

    const documentContracts: Record<string, RegExp[]> = {
      "docs/MODULAR_MONOLITH.md": [/workspace map/i, /one Core process/i, /unit of work/i, /writer fence/i, /Web Console/i],
      "docs/API_V1.md": [/\/api\/v1/i, /channel/i, /admin/i, /internal/i, /successful JSON response/i, /JSON failure/i],
      "docs/NAMING_CONVENTIONS.md": [/TaskRun/i, /submission/i, /event consumer/i, /v1/i],
      "docs/ABI_VERSIONING.md": [
        /specVersion:\s*"1\.0"/i,
        /changes require a new major ABI/i,
        /removing or renaming a route, field, literal, or event type/i,
        /deprecation must name its successor, migration instructions, and removal release/i,
        /runtime validation/i,
      ],
      "docs/SECURITY_BOUNDARIES.md": [/fails closed/i, /service credential/i, /resource scopes/i, /exact-origin/i],
      "docs/DEPLOYMENT_AND_GATEWAY.md": [
        /Core-before-Gateway order/i,
        /release manifest/i,
        /writer (?:readiness|lease|fence)/i,
        /watermarks?/i,
        /rollback/i,
      ],
    };
    for (const [file, contracts] of Object.entries(documentContracts)) {
      const content = source(file);
      for (const contract of contracts) expect(content, `${file} must document ${contract}`).toMatch(contract);
    }
    expect(source("docs/MODULAR_MONOLITH.md")).toContain("excludes pre-refactor root source trees");
    expect(source("docs/API_V1.md")).toContain("Unversioned paths");
  });

  it("serves a strict v1 success envelope and no unversioned compatibility route", async () => {
    const app = createApp({
      persistence: {
        sessions: {
          createSessionIdempotent: ({ title }: { title: string }) => ({
            replayed: false,
            session: {
              id: "session-final",
              title,
              modelId: "gpt-5.6-sol",
              reasoningEffort: "high" as const,
              createdAt: 0,
              updatedAt: 0,
              latestRunStatus: null,
              latestRunPhase: null,
            },
          }),
        },
        submissions: {},
        operations: {},
        transcript: {},
        eventConsumers: {},
      } as never,
      service: { closeRuntimes: async () => undefined } as never,
      logger: false,
      onClose: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { "idempotency-key": "final-monolith-session" },
        payload: { title: "Final modular monolith" },
      });
      expect(response.statusCode).toBe(200);
      const envelope = response.json() as { data: unknown; requestId: string };
      expect(decodeAbi(SessionSchema, envelope.data)).toMatchObject({
        id: "session-final",
        title: "Final modular monolith",
      });
      expect(envelope.requestId).toEqual(expect.any(String));
      expect((await app.inject({ method: "GET", url: "/api/sessions" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
