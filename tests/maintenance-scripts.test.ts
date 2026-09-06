import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("maintenance scripts", () => {
  it("normalizes Windows-relative paths before enforcing Web CSS importer ownership", async () => {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "apps/web-console/scripts/path-utils.mjs")).href;
    const { normalizeRelativePath } = await import(moduleUrl) as { normalizeRelativePath(value: string): string };
    expect(normalizeRelativePath("src\\main.tsx")).toBe("src/main.tsx");
    expect(normalizeRelativePath("src/main.tsx")).toBe("src/main.tsx");
  });

  it("retries only transient npm audit transport failures", async () => {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/audit-dependencies.mjs")).href;
    const { auditCoordinatesFromLockfile, auditGitHubFallback, auditWithRetry, isRetryableAuditFailure } = await import(moduleUrl) as {
      auditCoordinatesFromLockfile(
        lockfile: object,
        options?: { omitDev?: boolean },
      ): string[];
      auditGitHubFallback(options: {
        lockfile: object;
        omitDev?: boolean;
        token?: string;
        query(options: { coordinates: string[]; severity: string; token?: string }): Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>;
        wait(milliseconds: number): Promise<void>;
        write(stream: "stdout" | "stderr", value: string): void;
      }): Promise<number>;
      auditWithRetry(options: {
        run(): Promise<{ code: number; stdout: string; stderr: string }>;
        wait(milliseconds: number): Promise<void>;
        write(stream: "stdout" | "stderr", value: string): void;
        maxAttempts: number;
        retryDelaysMs: number[];
        fallback?(): Promise<number>;
      }): Promise<number>;
      isRetryableAuditFailure(output: string): boolean;
    };
    expect(isRetryableAuditFailure("npm warn audit network timeout at: https://registry.npmjs.org")).toBe(true);
    expect(isRetryableAuditFailure("fast-uri Severity: high")).toBe(false);

    const transientResults = [
      { code: 1, stdout: "", stderr: "npm error audit endpoint returned an error" },
      { code: 0, stdout: "found 0 vulnerabilities\n", stderr: "" },
    ];
    const waits: number[] = [];
    const writes: string[] = [];
    expect(await auditWithRetry({
      run: async () => transientResults.shift()!,
      wait: async (milliseconds) => { waits.push(milliseconds); },
      write: (_stream, value) => { writes.push(value); },
      maxAttempts: 3,
      retryDelaysMs: [7, 11],
    })).toBe(0);
    expect(waits).toEqual([7]);
    expect(writes.join("\n")).toContain("retrying");

    let vulnerabilityRuns = 0;
    expect(await auditWithRetry({
      run: async () => {
        vulnerabilityRuns += 1;
        return { code: 1, stdout: "fast-uri Severity: high", stderr: "" };
      },
      wait: async () => undefined,
      write: () => undefined,
      maxAttempts: 3,
      retryDelaysMs: [0, 0],
    })).toBe(1);
    expect(vulnerabilityRuns).toBe(1);

    let fallbackRuns = 0;
    expect(await auditWithRetry({
      run: async () => ({ code: 1, stdout: "", stderr: "npm error audit endpoint returned an error" }),
      wait: async () => undefined,
      write: () => undefined,
      maxAttempts: 2,
      retryDelaysMs: [0],
      fallback: async () => {
        fallbackRuns += 1;
        return 0;
      },
    })).toBe(0);
    expect(fallbackRuns).toBe(1);

    const lockfile = {
      packages: {
        "": { version: "0.8.32" },
        "node_modules/production-package": { version: "1.2.3" },
        "node_modules/dev-package": { version: "2.0.0", dev: true },
        "node_modules/workspace-link": { resolved: "packages/workspace-link", link: true },
        "node_modules/wrapper/node_modules/@scope/nested": { version: "3.1.4" },
      },
    };
    expect(auditCoordinatesFromLockfile(lockfile)).toEqual([
      "@scope/nested@3.1.4",
      "dev-package@2.0.0",
      "production-package@1.2.3",
    ]);
    expect(auditCoordinatesFromLockfile(lockfile, { omitDev: true })).toEqual([
      "@scope/nested@3.1.4",
      "production-package@1.2.3",
    ]);

    const queries: Array<{ coordinates: string[]; severity: string; token?: string }> = [];
    const fallbackOutput: string[] = [];
    expect(await auditGitHubFallback({
      lockfile,
      omitDev: true,
      token: "test-token",
      query: async (options) => {
        queries.push(options);
        return { code: 0, stdout: "", stderr: "" };
      },
      wait: async () => undefined,
      write: (_stream, value) => { fallbackOutput.push(value); },
    })).toBe(0);
    expect(queries).toEqual([
      {
        coordinates: ["@scope/nested@3.1.4", "production-package@1.2.3"],
        severity: "high",
        token: "test-token",
      },
      {
        coordinates: ["@scope/nested@3.1.4", "production-package@1.2.3"],
        severity: "critical",
        token: "test-token",
      },
    ]);
    expect(fallbackOutput.join("\n")).toContain("2 exact lockfile package versions");

    let vulnerableQueries = 0;
    expect(await auditGitHubFallback({
      lockfile,
      query: async () => {
        vulnerableQueries += 1;
        return { code: 1, stdout: "", stderr: "high: GHSA-test\n" };
      },
      wait: async () => undefined,
      write: () => undefined,
    })).toBe(1);
    expect(vulnerableQueries).toBe(1);
  });

  it("uses path-aware documentation containment on Windows separators", () => {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/path-containment.mjs")).href;
    const source = [
      'import path from "node:path";',
      `const { isPathInside } = await import(${JSON.stringify(moduleUrl)});`,
      'const root = "C:\\\\projects\\\\tagent-core\\\\docs";',
      'process.stdout.write(JSON.stringify({ inside: isPathInside(root, `${root}\\\\API_V1.md`, path.win32), sibling: isPathInside(root, "C:\\\\projects\\\\tagent-core\\\\docs-evil\\\\API_V1.md", path.win32) }));',
    ].join("\n");
    expect(JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" }))).toEqual({
      inside: true,
      sibling: false,
    });
  });

  it("copies and resets build assets without shell-specific commands", () => {
    const script = path.join(repoRoot, "scripts/build-files.mjs");
    const directory = mkdtempSync(path.join(tmpdir(), "tagent-build-files-"));
    try {
      writeFileSync(path.join(directory, "source.txt"), "portable\n");
      execFileSync(process.execPath, [script, "copy", "source.txt", "dist/nested/copied.txt"], { cwd: directory });
      expect(readFileSync(path.join(directory, "dist/nested/copied.txt"), "utf8")).toBe("portable\n");
      execFileSync(process.execPath, [script, "reset", "dist"], { cwd: directory });
      expect(existsSync(path.join(directory, "dist"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    for (const filename of ["package.json", "packages/memory/package.json", "adapters/persistence-sqlite/package.json", "adapters/workspace-local/package.json"]) {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, filename), "utf8")) as { scripts: { build: string } };
      expect(manifest.scripts.build, filename).toContain("build-files.mjs");
      expect(manifest.scripts.build, filename).not.toMatch(/(?:^|&&)\s*(?:mkdir|cp|chmod|rm\s+-rf)\b/);
    }
  });

  it("keeps CI installs audit-free and release audits explicit", () => {
    const releaseWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const ciWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const releaseBuild = readFileSync(path.join(repoRoot, "scripts/build-release.sh"), "utf8");
    expect(releaseWorkflow.match(/npm ci --no-audit/g)).toHaveLength(2);
    expect(ciWorkflow.match(/npm ci --no-audit/g)).toHaveLength(2);
    expect(releaseWorkflow).toContain("npm run audit:production");
    expect(releaseWorkflow).toContain("npm run audit:all");
    expect(releaseWorkflow.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(2);
    expect(releaseBuild.match(/npm ci --no-audit/g)).toHaveLength(2);
  });
});
