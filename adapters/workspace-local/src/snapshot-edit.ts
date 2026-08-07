import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceEditPort, WorkspacePatchRequest, WorkspacePatchResult, WorkspaceReadSnapshot } from "@tagent/execution/ports";
import { commitWorkspaceFiles, readWorkspaceFile } from "./workspace-path.js";

export class WorkspaceEditError extends Error {
  constructor(message: string, readonly code: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = "WorkspaceEditError"; }
}

export function workspaceContentHash(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function changedLine(before: string, after: string) {
  const left = before.split("\n"); const right = after.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) if (left[index] !== right[index]) return index + 1;
  return null;
}

export class SnapshotWorkspaceEdit implements WorkspaceEditPort {
  constructor(private readonly workspace: string) {}

  async read(path: string): Promise<WorkspaceReadSnapshot> {
    const source = await readWorkspaceFile(this.workspace, path);
    const content = source.buffer.toString("utf8").replace(/^\uFEFF/, "");
    const contentHash = workspaceContentHash(content);
    return { path: source.relative, content, contentHash, snapshotId: `sha256:${contentHash}`, bytes: source.buffer.length };
  }

  async patch(request: WorkspacePatchRequest): Promise<WorkspacePatchResult> {
    if (!request.files.length) throw new WorkspaceEditError("Patch requires at least one file", "workspace.edit_invalid");
    if (new Set(request.files.map((file) => file.path)).size !== request.files.length) throw new WorkspaceEditError("Patch contains duplicate file paths", "workspace.edit_invalid");
    const prepared: Array<{ path: string; content: string; before: string; beforeHash: string; afterHash: string; firstChangedLine: number | null }> = [];
    for (const file of request.files) {
      const source = await this.read(file.path);
      const expected = file.contentHash || file.snapshotId.replace(/^sha256:/, "");
      if (!expected || expected !== source.contentHash || (file.snapshotId && file.snapshotId !== source.snapshotId)) {
        throw new WorkspaceEditError(`Workspace snapshot is stale for ${file.path}`, "workspace.edit_stale", { path: file.path, expectedContentHash: expected, actualContentHash: source.contentHash, actualSnapshotId: source.snapshotId });
      }
      let content = source.content;
      for (const [index, hunk] of file.hunks.entries()) {
        if (hunk.oldText === "") { content += hunk.newText; continue; }
        const occurrences = content.split(hunk.oldText).length - 1;
        if (occurrences !== 1) throw new WorkspaceEditError(`Expected oldText exactly once in ${file.path}, found ${occurrences}`, "workspace.edit_precondition_failed", { path: file.path, hunk: index, occurrences });
        content = content.replace(hunk.oldText, hunk.newText);
      }
      prepared.push({ path: file.path, content, before: source.content, beforeHash: source.contentHash, afterHash: workspaceContentHash(content), firstChangedLine: changedLine(source.content, content) });
    }
    await commitWorkspaceFiles(this.workspace, prepared.map(({ path, content, beforeHash }) => ({ path, content, expectedHash: beforeHash })));
    return {
      patchId: request.patchId || randomUUID(),
      changedFiles: prepared.map((file) => ({ path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash, bytesBefore: Buffer.byteLength(file.before), bytesAfter: Buffer.byteLength(file.content), firstChangedLine: file.firstChangedLine })),
    };
  }
}

export function createWorkspaceEditPort(workspace: string): WorkspaceEditPort { return new SnapshotWorkspaceEdit(workspace); }
