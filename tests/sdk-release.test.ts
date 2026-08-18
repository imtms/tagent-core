import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Gateway SDK release artifacts", () => {
  it("integrates both SDK archives and checksums into the release workflow", () => {
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(rootPackage.scripts["release:sdk"]).toContain("build-sdk-release.mjs");
    const releaseBuild = readFileSync("scripts/build-release.sh", "utf8");
    expect(releaseBuild).toContain('node scripts/build-sdk-release.mjs "$sdk_output_directory"');
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    for (const asset of [
      "tagent-abi-*.tgz",
      "tagent-abi-*.tgz.sha256",
      "tagent-core-client-*.tgz",
      "tagent-core-client-*.tgz.sha256",
    ]) expect(workflow).toContain(asset);
    expect(workflow).toContain('"$RUNNER_TEMP/tagent-abi-${VERSION}.tgz"');
    expect(workflow).toContain('"$RUNNER_TEMP/tagent-core-client-${VERSION}.tgz"');
  });

  it("packs installable ABI and Core Client archives with portable checksums and source maps", { timeout: 180_000 }, () => {
    const output = mkdtempSync(path.join(tmpdir(), "tagent-sdk-test-"));
    try {
      execFileSync(process.execPath, ["scripts/build-sdk-release.mjs", output], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 160_000,
      });
      for (const name of ["tagent-abi-0.8.8.tgz", "tagent-core-client-0.8.8.tgz"]) {
        const archive = path.join(output, name);
        const checksum = readFileSync(`${archive}.sha256`, "utf8");
        const expectedHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
        expect(checksum).toBe(`${expectedHash}  ${name}\n`);
        const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
        expect(entries).toContain("package/dist/index.js\n");
        expect(entries).toContain("package/dist/index.js.map\n");
        expect(entries).toContain("package/dist/index.d.ts\n");
        expect(entries).toContain("package/dist/index.d.ts.map\n");
        expect(entries).not.toContain(".tsbuildinfo");
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
