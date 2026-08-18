import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("maintenance scripts", () => {
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
});
