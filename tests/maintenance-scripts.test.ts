import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("maintenance scripts", () => {
  it("retries only transient npm audit transport failures", async () => {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/audit-dependencies.mjs")).href;
    const { auditWithRetry, isRetryableAuditFailure } = await import(moduleUrl) as {
      auditWithRetry(options: {
        run(): Promise<{ code: number; stdout: string; stderr: string }>;
        wait(milliseconds: number): Promise<void>;
        write(stream: "stdout" | "stderr", value: string): void;
        maxAttempts: number;
        retryDelaysMs: number[];
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
    expect(releaseBuild.match(/npm ci --no-audit/g)).toHaveLength(2);
  });
});
