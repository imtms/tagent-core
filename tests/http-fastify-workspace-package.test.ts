import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { AdminConfigStatusResponseSchema, decodeAbi, MEMORY_SOURCE_TYPES, PROFILE_SERVICE_SCOPES } from "@tagent/abi";
import { ConsoleDecode } from "@tagent/core-client";
import { createApp, secureEqual, type ServiceCredential } from "@tagent/http-fastify";
import { SERVICE_SCOPES } from "@tagent/http-fastify/auth";
import * as V1 from "@tagent/http-fastify/v1";

const repoRoot = process.cwd();
const packageRoot = "adapters/http-fastify";
const sourceRoot = `${packageRoot}/src`;
const apps: Array<ReturnType<typeof createApp>> = [];

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
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot, entry);
    const absolutePath = path.join(repoRoot, relativePath);
    return statSync(absolutePath).isDirectory()
      ? sourceFiles(relativePath)
      : entry.endsWith(".ts") ? [relativePath] : [];
  }).sort();
}

function parsedSource(relativePath: string): ts.SourceFile {
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
  const add = (node: ts.Node | undefined): void => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(relativePath));
  return specifiers;
}

const httpMethods = new Set(["all", "delete", "get", "head", "options", "patch", "post", "put"]);

function routeInventory(relativePath: string): string[] {
  const routes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && httpMethods.has(node.expression.name.text)) {
      const route = node.arguments[0];
      if (route && (ts.isStringLiteral(route) || ts.isNoSubstitutionTemplateLiteral(route))) {
        routes.push(`${node.expression.name.text.toUpperCase()} ${route.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(relativePath));
  return routes;
}

function testApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({
    persistence: {
      sessions: {
        createSession: (title: string) => ({
          id: "session-http-package",
          title,
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high" as const,
          createdAt: 0,
          updatedAt: 0,
          latestRunStatus: null,
          latestRunPhase: null,
        }),
        createSessionIdempotent: ({ title }: { title: string }) => ({
          session: { id: "session-http-package", title, modelId: "gpt-5.6-sol", reasoningEffort: "high" as const, createdAt: 0, updatedAt: 0, latestRunStatus: null, latestRunPhase: null },
          replayed: false,
        }),
        getSession: (id: string) => ({ id, title: "Workspace", modelId: "gpt-5.6-sol", reasoningEffort: "high" as const, createdAt: 0, updatedAt: 0, latestRunStatus: null, latestRunPhase: null }),
        updateSession: (id: string, settings: { title?: string; modelId?: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }) => ({ id, title: settings.title ?? "Workspace", modelId: settings.modelId ?? "gpt-5.6-sol", reasoningEffort: settings.reasoningEffort ?? "high", createdAt: 0, updatedAt: 1, latestRunStatus: null, latestRunPhase: null }),
      },
      submissions: {},
      taskRuns: {},
      supervisorDecisions: {},
      contextManifests: {},
      controlInbox: {},
      operations: {},
      transcript: {},
      evidence: {},
      eventConsumers: {},
    } as never,
    service: { closeRuntimes: async () => undefined } as never,
    logger: false,
    onClose: async () => undefined,
    ...overrides,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Fastify HTTP adapter workspace package", () => {
  it("keeps route modules independent from plugin composition", () => {
    const violations = sourceFiles(`${sourceRoot}/v1`)
      .filter((relativePath) => path.basename(relativePath) !== "plugin.ts")
      .flatMap((relativePath) => moduleSpecifiers(relativePath)
        .filter((specifier) => specifier === "./plugin.js")
        .map(() => relativePath));
    expect(violations).toEqual([]);
  });

  it("publishes only the compiled root, auth, ports, and v1 package entry points", () => {
    const root = readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> }>("package.json");
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    expect(manifest).toMatchObject({ name: "@tagent/http-fastify", version: "0.8.19", private: true });
    expect(root.devDependencies[manifest.name]).toBe(manifest.version);
    expect(root.dependencies).not.toHaveProperty("fastify");
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./auth", "./ports", "./v1"]);
    expect(manifest.dependencies).toEqual({
      "@tagent/abi": "0.8.19",
      "@tagent/admission": "0.8.19",
      "@tagent/execution": "0.8.19",
      "@tagent/governance": "0.8.19",
      fastify: "^5.10.0",
      typebox: "^1.1.24",
    });
    for (const target of Object.values(manifest.exports)) {
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(target.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(`${target.types}\n${target.import}`).not.toContain("/src/");
    }
    expect(root.scripts["build:packages"]).toContain(packageRoot);
    expect(root.scripts.clean).toContain("@tagent/http-fastify");
  });

  it("has no root HTTP facade or removed scope mapper export", () => {
    expect(sourceFiles("src")).toEqual(["src/host.ts"]);
    for (const removed of ["src/app.ts", "src/auth.ts"]) {
      expect(existsSync(path.join(repoRoot, removed)), `${removed} must remain deleted`).toBe(false);
    }
    expect(readFileSync(path.join(repoRoot, sourceRoot, "index.ts"), "utf8"))
      .not.toContain("requiredServiceScope");
    expect(readFileSync(path.join(repoRoot, sourceRoot, "auth.ts"), "utf8"))
      .not.toContain("requiredServiceScope");
  });

  it("keeps adapter imports inside its declared package boundary", () => {
    const manifest = readJson<PackageManifest>(`${packageRoot}/package.json`);
    const declared = new Set(Object.keys(manifest.dependencies));
    const violations: string[] = [];
    for (const relativePath of sourceFiles(sourceRoot)) {
      for (const specifier of moduleSpecifiers(relativePath)) {
        if (specifier.startsWith(".")) {
          const target = path.resolve(repoRoot, path.dirname(relativePath), specifier);
          const adapterRoot = path.resolve(repoRoot, sourceRoot);
          if (target !== adapterRoot && !target.startsWith(`${adapterRoot}${path.sep}`)) {
            violations.push(`${relativePath} escapes to ${specifier}`);
          }
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!declared.has(packageName)) violations.push(`${relativePath} imports undeclared ${specifier}`);
        if (specifier.includes("/src/")) violations.push(`${relativePath} deep-imports ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("registers only v1 public, channel, admin, and internal API routes", () => {
    const v1Routes = sourceFiles(`${sourceRoot}/v1`).flatMap(routeInventory);
    expect(v1Routes.length).toBeGreaterThan(0);
    expect(v1Routes.every((route) => /^\w+ \/api\/v1(?:\/|$)/.test(route))).toBe(true);
    for (const sentinel of [
      "GET /api/v1/health",
      "POST /api/v1/sessions",
      "GET /api/v1/task-runs/:taskRunId",
      "GET /api/v1/admin/config/status",
      "ALL /api/v1/admin/*",
      "ALL /api/v1/internal/*",
      "ALL /api/v1/*",
    ]) expect(v1Routes).toContain(sentinel);

    const appSource = readFileSync(path.join(repoRoot, sourceRoot, "app.ts"), "utf8");
    expect(appSource).toContain("app.register(v1ApiPlugin");
    expect(appSource).not.toContain("registerPublicRoutes");
    expect(routeInventory(`${sourceRoot}/app.ts`)).toEqual([]);
  });

  it("serves the v1 envelope while rejecting unversioned API and SPA paths", async () => {
    const app = testApp({
      generationStatus: () => ({
        generationId: "generation-health",
        activeRelease: "1".repeat(40),
        activationPhase: "committed",
        activationRequestId: "request-health",
        recentCrashes: 1,
        maxCrashes: 5,
      }),
    });
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      data: {
        ok: true,
        service: "tagent-core",
        generation: { generationId: "generation-health", activationPhase: "committed", recentCrashes: 1 },
      },
      requestId: expect.any(String),
    });

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { "idempotency-key": "http-package-session" },
      payload: { title: "HTTP package boundary" },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      data: { id: "session-http-package", title: "HTTP package boundary" },
      requestId: expect.any(String),
    });

    for (const url of ["/api/health", "/api/sessions", "/", "/workspace/deep-link"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body.toLowerCase(), url).not.toContain("<!doctype html>");
    }
    for (const [url, surface] of [
      ["/api/v1/admin/not-a-route", "admin"],
      ["/api/v1/internal/not-a-route", "internal"],
      ["/api/v1/not-a-route", "public"],
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toMatchObject({
        error: {
          code: "route.not_found",
          details: { surface },
          requestId: expect.any(String),
        },
      });
    }
  });

  it("preserves every legal Memory provenance source through the jobs route and Console decoder", async () => {
    const jobs = MEMORY_SOURCE_TYPES.map((sourceType, index) => ({
      id: `capture-job-${index}`,
      status: "completed",
      attempts: 1,
      createdAt: 1_788_000_000_000 + index,
      updatedAt: 1_788_000_001_000 + index,
      request: { sourceRefs: [{ sourceType, sourceId: `${sourceType}:fixture`, revision: "1" }] },
    }));
    const app = testApp({
      memory: { listCaptureJobs: async () => jobs } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/memory/jobs",
      payload: { scopes: [{ type: "session", id: "session-fixture" }], limit: 100 },
    });

    expect(response.statusCode).toBe(200);
    const envelope = response.json() as { data: unknown; requestId: string };
    await expect(ConsoleDecode.captureJobs(envelope.data)).resolves.toEqual(jobs);
  });

  it("serves config status in the published Admin v1 response shape", async () => {
    const runtimeConfig = {
      runtime: "in-process",
      provider: "openai-compatible",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      modelId: "model-fixture",
      fallbackModelIds: [],
      credentialConfigured: true,
      providerTimeoutMs: 15_000,
      providerMaxRetries: 2,
      runTimeoutMs: 900_000,
      maxContinuations: 3,
      schemaVersion: 35,
      memoryEnabled: true,
      memoryBackend: "postgres",
      memoryColdBackend: "s3",
    };
    const app = testApp({ runtimeConfig });

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config/status" });

    expect(response.statusCode).toBe(200);
    expect(decodeAbi(AdminConfigStatusResponseSchema, response.json())).toMatchObject({
      data: { runTimeoutMs: 900_000 },
    });
  });

  it("exports only current credential helpers and v1 route components", () => {
    const credential: ServiceCredential = {
      token: "current-service-credential",
      scopes: ["sessions:read"],
    };
    expect(credential.scopes).toEqual(["sessions:read"]);
    expect(secureEqual("same", "same")).toBe(true);
    expect(secureEqual("same", "different")).toBe(false);
    expect(PROFILE_SERVICE_SCOPES.every((scope) => SERVICE_SCOPES.includes(scope))).toBe(true);
    expect(V1.v1ApiPlugin).toEqual(expect.any(Function));
    expect(V1.registerPublicV1Routes).toEqual(expect.any(Function));
    expect(V1.registerChannelV1Routes).toEqual(expect.any(Function));
    expect(V1.registerAdminV1Routes).toEqual(expect.any(Function));
    expect(V1.registerInternalV1Routes).toEqual(expect.any(Function));
  });

  it("resolves the current public ABI through compiled Node ESM", () => {
    const script = `
      const root = await import("@tagent/http-fastify");
      const auth = await import("@tagent/http-fastify/auth");
      const ports = await import("@tagent/http-fastify/ports");
      const v1 = await import("@tagent/http-fastify/v1");
      if (typeof root.createApp !== "function" || typeof root.secureEqual !== "function") process.exit(1);
      if (typeof auth.secureEqual !== "function" || !Array.isArray(auth.SERVICE_SCOPES)) process.exit(1);
      if ("requiredServiceScope" in root) process.exit(1);
      if (Object.keys(ports).length !== 0) process.exit(1);
      if (typeof v1.v1ApiPlugin !== "function" || typeof v1.V1HttpError !== "function") process.exit(1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
