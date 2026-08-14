import { createHash } from "node:crypto";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile } from "../workspace-path.js";
import { currentAttemptOrdinal, durableTextResult, operationId, textResult } from "./shared.js";

const ListSchema = Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) });
const ReadSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) });
const WriteSchema = Type.Object({ path: Type.String(), content: Type.String() });
const EditSchema = Type.Object({ path: Type.String(), snapshotId: Type.String(), contentHash: Type.String(), oldText: Type.String(), newText: Type.String() });
const PatchSchema = Type.Object({
  patchId: Type.Optional(Type.String()),
  files: Type.Array(Type.Object({
    path: Type.String(), snapshotId: Type.String(), contentHash: Type.String(),
    hunks: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
  }), { minItems: 1, maxItems: 100 }),
});

export class ListToolProvider implements ToolProvider {
  readonly id = "workspace.list";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort, private readonly workspace: string) {}
  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof ListSchema>, Record<string, unknown>> = {
      name: "ls", label: "List directory", description: "List entries in a workspace directory.", parameters: ListSchema,
      policy: { operationType: "tool.list", workspaceAccess: "read_only" },
      execute: async (_id, params, signal) => {
        const target = params.path ?? ".";
        const entries = await listWorkspaceDirectory(this.workspace, target, signal);
        const limit = params.limit ?? 200;
        const names = entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit).map((entry) => `${entry.name}${entry.directory ? "/" : ""}`);
        return textResult(names.join("\n") || "Directory is empty", { path: path.resolve(this.workspace, target), totalEntries: entries.length, returnedEntries: names.length, truncated: entries.length > limit });
      },
    };
    return [tool];
  }
}

export class ReadToolProvider implements ToolProvider {
  readonly id = "workspace.read";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort, private readonly workspace: string) {}
  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof ReadSchema>, Record<string, unknown>> = {
      name: "read", label: "Read file", description: "Read a UTF-8 text file inside the workspace.", parameters: ReadSchema,
      policy: { operationType: "tool.read", workspaceAccess: "read_only" },
      execute: async (id, params, signal) => {
        const { path: filename, relative, metadata: file, buffer } = await readWorkspaceFile(this.workspace, params.path, signal);
        if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return textResult(`Binary file: ${params.path}`, { path: filename, type: "binary", bytes: file.size });
        const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
        const contentHash = createHash("sha256").update(content).digest("hex");
        const lines = content.split("\n");
        const offset = params.offset ?? 1, limit = params.limit ?? 300;
        return durableTextResult(this.capabilities, signal, id, lines.slice(offset - 1, offset - 1 + limit).join("\n"), {
          path: relative, absolutePath: filename, type: "text", bytes: file.size, totalLines: lines.length,
          offset, limit, snapshotId: `sha256:${contentHash}`, contentHash,
        }, `Read output: ${params.path}`);
      },
    };
    return [tool];
  }
}

export class WriteToolProvider implements ToolProvider {
  readonly id = "workspace.write";
  constructor(private readonly workspace: string) {}
  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof WriteSchema>, Record<string, unknown>> = {
      name: "write", label: "Write file", description: "Create or overwrite a UTF-8 file inside the workspace.", parameters: WriteSchema, executionMode: "sequential",
      policy: { operationType: "tool.write", workspaceAccess: "mutation", externalAction: true },
      execute: async (_id, params, signal) => {
        const { path: filename } = await writeWorkspaceFile(this.workspace, params.path, params.content, signal);
        return textResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`, { path: filename, bytes: Buffer.byteLength(params.content) });
      },
    };
    return [tool];
  }
}

export class EditToolProvider implements ToolProvider {
  readonly id = "workspace.edit";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort) {}
  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof EditSchema>, Record<string, unknown>> = {
      name: "edit", label: "Edit file", description: "Apply a snapshot-bound exact edit. Use snapshotId/contentHash returned by read; stale snapshots are rejected.", parameters: EditSchema, executionMode: "sequential",
      policy: { operationType: "tool.edit", workspaceAccess: "mutation", externalAction: true },
      execute: async (id, params, signal) => {
        if (!this.capabilities.workspaceEdit) throw new Error("Workspace edit port is unavailable");
        const payload = { patchId: operationId(this.capabilities.runId, currentAttemptOrdinal(this.capabilities) ?? 0, id), files: [{ path: params.path, snapshotId: params.snapshotId, contentHash: params.contentHash, hunks: [{ oldText: params.oldText, newText: params.newText }] }] };
        try {
          const result = await this.capabilities.workspaceEdit.patch(payload, signal);
          this.capabilities.publish("workspace.edit.completed", { toolCallId: id, patchId: result.patchId, changedFiles: result.changedFiles.length });
          return textResult(`Updated ${params.path}`, { patchId: result.patchId, mode: params.oldText === "" ? "append" : "replace", ...result.changedFiles[0] });
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "workspace.edit_failed";
          this.capabilities.publish("workspace.edit.rejected", { toolCallId: id, patchId: payload.patchId, code });
          throw error;
        }
      },
    };
    return [tool];
  }
}

export class PatchToolProvider implements ToolProvider {
  readonly id = "workspace.patch";
  constructor(private readonly capabilities: ToolCapabilityApplicationPort) {}
  provideTools(): readonly RuntimeTool[] {
    const tool: RuntimeTool<Static<typeof PatchSchema>, Record<string, unknown>> = {
      name: "patch", label: "Patch files", description: "Atomically apply a snapshot-bound multi-file patch after preflighting every file and hunk.", parameters: PatchSchema, executionMode: "sequential",
      policy: { operationType: "tool.patch", workspaceAccess: "mutation", externalAction: true },
      execute: async (id, params, signal) => {
        if (!this.capabilities.workspaceEdit) throw new Error("Workspace edit port is unavailable");
        const payload = { patchId: params.patchId ?? operationId(this.capabilities.runId, currentAttemptOrdinal(this.capabilities) ?? 0, id), files: params.files };
        try {
          const result = await this.capabilities.workspaceEdit.patch(payload, signal);
          this.capabilities.publish("workspace.edit.completed", { toolCallId: id, patchId: result.patchId, changedFiles: result.changedFiles.length });
          return textResult(`Updated ${result.changedFiles.length} files`, { patchId: result.patchId, changedFiles: result.changedFiles });
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "workspace.edit_failed";
          this.capabilities.publish("workspace.edit.rejected", { toolCallId: id, patchId: payload.patchId, code });
          throw error;
        }
      },
    };
    return [tool];
  }
}
