import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ContextSourcePort, ProjectContextSnapshot } from "@tagent/execution/ports";

const MAX_RULE_BYTES = 128 * 1024;

function normalizedRelative(value: string) {
  if (!value || value.includes("\0") || path.isAbsolute(value)) throw new Error(`Project rule path must be workspace-relative: ${value}`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`Project rule path escapes the workspace: ${value}`);
  return normalized;
}

export class WorkspaceProjectContextSource implements ContextSourcePort {
  private readonly root: string;
  private readonly files: string[];

  constructor(workspace: string, files: string[] = ["AGENTS.md"]) {
    this.root = realpathSync(workspace);
    this.files = [...new Set(files.map(normalizedRelative))];
  }

  load(): ProjectContextSnapshot {
    const rules: ProjectContextSnapshot["rules"] = [];
    for (const [precedence, relative] of this.files.entries()) {
      const filename = path.resolve(this.root, relative);
      if (filename !== this.root && !filename.startsWith(`${this.root}${path.sep}`)) throw new Error(`Project rule path escapes the workspace: ${relative}`);
      let metadata;
      try { metadata = lstatSync(filename); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Project rule source must be a regular non-symlink file: ${relative}`);
      if (metadata.size > MAX_RULE_BYTES) throw new Error(`Project rule source exceeds ${MAX_RULE_BYTES} bytes: ${relative}`);
      const content = readFileSync(filename, "utf8").replace(/^\uFEFF/, "");
      const hash = createHash("sha256").update(content).digest("hex");
      rules.push({ path: relative, content, sha256: hash, precedence, bytes: Buffer.byteLength(content), selected: true, reason: "selected by configured project-rule precedence" });
    }
    const snapshotHash = createHash("sha256").update(JSON.stringify(rules.map(({ path: rulePath, sha256, precedence }) => ({ path: rulePath, sha256, precedence })))).digest("hex");
    return { snapshotHash, rules };
  }
}

export function createProjectContextSource(workspace: string, files?: string[]): ContextSourcePort {
  return new WorkspaceProjectContextSource(workspace, files);
}
