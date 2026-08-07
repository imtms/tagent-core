import { access, mkdir, open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { RunId } from "@tagent/execution/domain";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile } from "./workspace-path.js";

const MAX_OUTPUT = 24_000;
const MAX_DURABLE_OUTPUT = 16 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const ReadSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) });
const ListSchema = Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_ENTRIES })) });
const WriteSchema = Type.Object({ path: Type.String(), content: Type.String() });
const EditSchema = Type.Object({ path: Type.String(), snapshotId: Type.String(), contentHash: Type.String(), oldText: Type.String(), newText: Type.String() });
const PatchSchema = Type.Object({
  patchId: Type.Optional(Type.String()),
  files: Type.Array(Type.Object({
    path: Type.String(), snapshotId: Type.String(), contentHash: Type.String(),
    hunks: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
  }), { minItems: 1, maxItems: 100 }),
});
const BashSchema = Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) });
const BASH_CHAIN_WARNING_THRESHOLD = 3;
const MemorySearchSchema=Type.Object({query:Type.String(),kinds:Type.Optional(Type.Array(Type.Union([Type.Literal("fact"),Type.Literal("preference"),Type.Literal("episode"),Type.Literal("procedure")]))),maxResults:Type.Optional(Type.Integer({minimum:1,maximum:20}))});
const MemoryRecordSchema=Type.Object({id:Type.String()});
const MemoryTopicSchema=Type.Object({topicId:Type.String()});
const MemoryForgetSchema=Type.Object({ids:Type.Optional(Type.Array(Type.String())),topicIds:Type.Optional(Type.Array(Type.String())),reason:Type.Optional(Type.String()),gracePeriodMs:Type.Optional(Type.Number({minimum:1}))});
const TaskRunBatchMutationSchema = Type.Union([
  Type.Object({ action: Type.Literal("phase"), phase: Type.Union([Type.Literal("discover"), Type.Literal("plan"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("review")]) }),
  Type.Object({ action: Type.Literal("plan"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Integer()) }),
  Type.Object({ action: Type.Literal("check"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), command: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), stale: Type.Optional(Type.Boolean()) }),
  Type.Object({ action: Type.Literal("mark_checks_stale") }),
  Type.Object({ action: Type.Literal("artifact"), id: Type.String(), title: Type.String(), kind: Type.Optional(Type.String()), content: Type.Optional(Type.String()), uri: Type.Optional(Type.String()) }),
]);
const TaskRunSchema = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("batch"), Type.Literal("phase"), Type.Literal("plan"), Type.Literal("check"), Type.Literal("mark_checks_stale"), Type.Literal("operations"), Type.Literal("artifact"), Type.Literal("request_user_input")]),
  phase: Type.Optional(Type.Union([Type.Literal("discover"), Type.Literal("plan"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("review")])),
  key: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed")])),
  required: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Integer()), command: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), stale: Type.Optional(Type.Boolean()),
  id: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), content: Type.Optional(Type.String()), uri: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()), fields: Type.Optional(Type.Array(Type.Object({ key: Type.String(), label: Type.String(), description: Type.Optional(Type.String()), inputType: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("textarea")])), required: Type.Optional(Type.Boolean()), placeholder: Type.Optional(Type.String()) }), { minItems: 1, maxItems: 12 })),
  mutations: Type.Optional(Type.Array(TaskRunBatchMutationSchema, { minItems: 1, maxItems: 50 })),
});

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: previewText(text) }], details };
}

function previewText(text: string) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_OUTPUT) return text;
  const marker = "\n... output omitted; full content is available in the referenced Artifact ...\n";
  const budget = MAX_OUTPUT - Buffer.byteLength(marker);
  const head = Buffer.from(text).subarray(0, Math.floor(budget * .55)).toString("utf8");
  const tail = Buffer.from(text).subarray(-Math.ceil(budget * .45)).toString("utf8");
  return head + marker + tail;
}

function safeArtifactId(value: string) { return value.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 180); }

async function persistToolOutputArtifact(
  capabilities: ToolCapabilityApplicationPort, toolCallId: string, content: string | Buffer,
  title: string, totalBytes: number, truncatedAtSource: boolean,
) {
  if (!capabilities.artifactSink) throw new Error("Durable Artifact sink is required for oversized tool output");
  const run = capabilities.getRun();
  if (!run) throw new Error("Run not found");
  const artifactId = safeArtifactId(`${capabilities.runId}:${run.attempt}:${toolCallId}:output`);
  const stored = await capabilities.artifactSink.write({ runId: capabilities.runId, artifactId, title, kind: "tool-output", content, totalBytes, truncatedAtSource, mediaType: "text/plain; charset=utf-8" });
  capabilities.addArtifact({ id: artifactId, title, kind: "tool-output", content: "", uri: stored.uri });
  return stored;
}

async function durableTextResult(
  capabilities: ToolCapabilityApplicationPort, toolCallId: string, text: string,
  details: Record<string, unknown> = {}, title = "Tool output", sourceTotalBytes = Buffer.byteLength(text), truncatedAtSource = false,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const shown = previewText(text);
  const totalBytes = sourceTotalBytes;
  if (totalBytes <= MAX_OUTPUT && !truncatedAtSource) return { content: [{ type: "text", text: shown }], details: { ...details, totalBytes, shownBytes: Buffer.byteLength(shown), outputDiscardedBytes: 0 } };
  const stored = await persistToolOutputArtifact(capabilities, toolCallId, text, title, totalBytes, truncatedAtSource);
  capabilities.publish("tool.output.spilled", { toolCallId, artifactId: stored.artifactId, totalBytes, shownBytes: Buffer.byteLength(shown), storedBytes: stored.storedBytes, sha256: stored.sha256, truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, totalBytes - stored.storedBytes) });
  return { content: [{ type: "text", text: shown }], details: { ...details, artifactId: stored.artifactId, artifactUri: stored.uri, sha256: stored.sha256, totalBytes, storedBytes: stored.storedBytes, shownBytes: Buffer.byteLength(shown), truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, totalBytes - stored.storedBytes) } };
}

function appendDurableCapture(current: string, chunk: string) {
  if (Buffer.byteLength(current) >= MAX_DURABLE_OUTPUT) return { text: current, droppedBytes: Buffer.byteLength(chunk) };
  const remaining = MAX_DURABLE_OUTPUT - Buffer.byteLength(current);
  const buffer = Buffer.from(chunk);
  return { text: current + buffer.subarray(0, remaining).toString("utf8"), droppedBytes: Math.max(0, buffer.length - remaining) };
}

function operationId(runId: RunId, attempt: number, toolCallId: string) {
  return `${runId}:${attempt}:${toolCallId}`;
}

async function executeMutation(
  capabilities: ToolCapabilityApplicationPort,
  toolCallId: string,
  operationType: string,
  payload: unknown,
  effect: () => Promise<AgentToolResult<Record<string, unknown>>>,
) {
  const { runId } = capabilities;
  const run = capabilities.getRun();
  if (!run) throw new Error("Run not found");
  const id = operationId(runId, run.attempt, toolCallId);
  const receipt = capabilities.claimOperation(id, operationType, payload);
  if (!receipt.claimed) {
    if (receipt.status === "succeeded") return receipt.result as AgentToolResult<Record<string, unknown>>;
    throw new Error(`Operation ${id} cannot be replayed from status ${receipt.status}`);
  }
  try {
    capabilities.advanceRunPhase("implement");
    const result = await effect();
    const staleChecks = capabilities.markChecksStale();
    capabilities.updateOperation(id, { status: "succeeded", stage: "completed", effects: [{ kind: "checks", action: "stale", count: staleChecks }], result });
    return result;
  } catch (error) {
    capabilities.updateOperation(id, { status: "failed", stage: "execution_failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function createTools(capabilities: ToolCapabilityApplicationPort, workspace: string): AgentTool[] {
  const requireWorkspaceMutationAuthorization = () => {
    const authorization = capabilities.authorizeWorkspaceMutation();
    if (!authorization.allowed) throw new Error(`Workspace Goal mutation guard: ${authorization.reason}`);
  };
  const { runId } = capabilities;
  const listTool: AgentTool<typeof ListSchema, Record<string, unknown>> = {
    name: "ls", label: "List directory", description: "List entries in a workspace directory.", parameters: ListSchema,
    async execute(_id, params: Static<typeof ListSchema>) {
      const target = params.path ?? ".";
      const entries = await listWorkspaceDirectory(workspace, target);
      const limit = params.limit ?? 200;
      const names = entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit).map((entry) => `${entry.name}${entry.directory ? "/" : ""}`);
      return textResult(names.join("\n") || "Directory is empty", { path: path.resolve(workspace, target), totalEntries: entries.length, returnedEntries: names.length, truncated: entries.length > limit });
    },
  };

  const readTool: AgentTool<typeof ReadSchema, Record<string, unknown>> = {
    name: "read", label: "Read file", description: "Read a UTF-8 text file inside the workspace.", parameters: ReadSchema,
    async execute(id, params: Static<typeof ReadSchema>) {
      const { path: filename, relative, metadata: file, buffer } = await readWorkspaceFile(workspace, params.path);
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return textResult(`Binary file: ${params.path}`, { path: filename, type: "binary", bytes: file.size });
      const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
      const contentHash = createHash("sha256").update(content).digest("hex");
      const snapshotId = `sha256:${contentHash}`;
      const lines = content.split("\n");
      const offset = params.offset ?? 1;
      const limit = params.limit ?? 300;
      return durableTextResult(capabilities, id, lines.slice(offset - 1, offset - 1 + limit).join("\n"), { path: relative, absolutePath: filename, type: "text", bytes: file.size, totalLines: lines.length, offset, limit, snapshotId, contentHash }, `Read output: ${params.path}`);
    },
  };

  const writeTool: AgentTool<typeof WriteSchema, Record<string, unknown>> = {
    name: "write", label: "Write file", description: "Create or overwrite a UTF-8 file inside the workspace.", parameters: WriteSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof WriteSchema>) {
      requireWorkspaceMutationAuthorization();
      return executeMutation(capabilities, id, "tool.write", params, async () => {
        const { path: filename } = await writeWorkspaceFile(workspace, params.path, params.content);
        return textResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`, { path: filename, bytes: Buffer.byteLength(params.content) });
      });
    },
  };

  const editTool: AgentTool<typeof EditSchema, Record<string, unknown>> = {
    name: "edit", label: "Edit file", description: "Apply a snapshot-bound exact edit. Use snapshotId/contentHash returned by read; stale snapshots are rejected.", parameters: EditSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof EditSchema>) {
      requireWorkspaceMutationAuthorization();
      if (!capabilities.workspaceEdit) throw new Error("Workspace edit port is unavailable");
      const payload = { patchId: operationId(runId, capabilities.getRun()?.attempt ?? 0, id), files: [{ path: params.path, snapshotId: params.snapshotId, contentHash: params.contentHash, hunks: [{ oldText: params.oldText, newText: params.newText }] }] };
      return executeMutation(capabilities, id, "tool.edit", payload, async () => {
        try {
          const result = await capabilities.workspaceEdit!.patch(payload);
          capabilities.publish("workspace.edit.completed", { toolCallId: id, patchId: result.patchId, changedFiles: result.changedFiles.length });
          return textResult(`Updated ${params.path}`, { patchId: result.patchId, mode: params.oldText === "" ? "append" : "replace", ...result.changedFiles[0] });
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "workspace.edit_failed";
          capabilities.publish("workspace.edit.rejected", { toolCallId: id, patchId: payload.patchId, code });
          throw error;
        }
      });
    },
  };

  const patchTool: AgentTool<typeof PatchSchema, Record<string, unknown>> = {
    name: "patch", label: "Patch files", description: "Atomically apply a snapshot-bound multi-file patch after preflighting every file and hunk.", parameters: PatchSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof PatchSchema>) {
      requireWorkspaceMutationAuthorization();
      if (!capabilities.workspaceEdit) throw new Error("Workspace edit port is unavailable");
      const payload = { patchId: params.patchId ?? operationId(runId, capabilities.getRun()?.attempt ?? 0, id), files: params.files };
      return executeMutation(capabilities, id, "tool.patch", payload, async () => {
        try {
          const result = await capabilities.workspaceEdit!.patch(payload);
          capabilities.publish("workspace.edit.completed", { toolCallId: id, patchId: result.patchId, changedFiles: result.changedFiles.length });
          return textResult(`Updated ${result.changedFiles.length} files`, { patchId: result.patchId, changedFiles: result.changedFiles });
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "workspace.edit_failed";
          capabilities.publish("workspace.edit.rejected", { toolCallId: id, patchId: payload.patchId, code });
          throw error;
        }
      });
    },
  };

  const bashTool: AgentTool<typeof BashSchema, Record<string, unknown>> = {
    name: "bash", label: "Run command", description: "Run a non-interactive shell command in the workspace. Destructive commands are blocked.", parameters: BashSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof BashSchema>, signal, onUpdate) {
      requireWorkspaceMutationAuthorization();
      return executeMutation(capabilities, id, "tool.bash", params, async () => {
        if (/\b(rm\s+-rf|mkfs|shutdown|reboot|poweroff|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)\b/i.test(params.command)) throw new Error("Command blocked by the minimal safety policy");
        const chainedStages = (params.command.match(/(?:&&|;|\|\||\n)/g) ?? []).length + 1;
        if (chainedStages >= BASH_CHAIN_WARNING_THRESHOLD) capabilities.publish("tool.bash.composite", { toolCallId: id, chainedStages, recommendation: "Split build, test, deploy, restart, and polling into separately evidenced commands so a late timeout does not repeat earlier stages." });
        return await new Promise<AgentToolResult<Record<string, unknown>>>((resolve, reject) => {
          const child = spawn("bash", ["-lc", params.command], { cwd: workspace, env: process.env, detached: process.platform !== "win32" });
        let stdout = "";
        let stderr = "";
        const captureRelative = `.tagent/tmp/${safeArtifactId(`${runId}-${id}`)}.log`;
        const capturePath = path.join(workspace, captureRelative);
        let captureFile: Awaited<ReturnType<typeof open>> | undefined;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let sourceDroppedBytes = 0;
        let progressBuffer = "";
        let progressTimer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const flushProgress = () => { if (progressBuffer) onUpdate?.(textResult(progressBuffer, { stream: "combined" })); progressBuffer = ""; progressTimer = undefined; };
        const terminate = () => {
          if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
          else child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
            else child.kill("SIGKILL");
          }, 2_000);
        };
        const captureReady = mkdir(path.dirname(capturePath), { recursive: true }).then(() => open(capturePath, "w", 0o600)).then((file) => { captureFile = file; });
        let captureWrites = Promise.resolve();
        const timeoutSeconds = params.timeoutSeconds ?? 30;
        const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutSeconds * 1000);
        const abort = terminate;
        signal?.addEventListener("abort", abort, { once: true });
        const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
          const text = chunk.toString("utf8");
          const capturedBytesBefore = Math.min(stdoutBytes + stderrBytes, capabilities.artifactSink?.maxBytes ?? MAX_DURABLE_OUTPUT);
          if (stream === "stdout") { stdoutBytes += chunk.length; const captured = appendDurableCapture(stdout, text); stdout = captured.text; sourceDroppedBytes += captured.droppedBytes; }
          else { stderrBytes += chunk.length; const captured = appendDurableCapture(stderr, text); stderr = captured.text; sourceDroppedBytes += captured.droppedBytes; }
          const remainingArtifactBytes = Math.max(0, (capabilities.artifactSink?.maxBytes ?? MAX_DURABLE_OUTPUT) - capturedBytesBefore);
          const artifactChunk = chunk.subarray(0, remainingArtifactBytes);
          captureWrites = captureWrites.then(async () => { await captureReady; if (artifactChunk.length) await captureFile!.write(artifactChunk); });
          progressBuffer += text;
          if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
        };
        child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
        child.on("error", reject);
        child.on("close", (code, sig) => { void (async () => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (progressTimer) clearTimeout(progressTimer);
          flushProgress();
          signal?.removeEventListener("abort", abort);
          await captureReady;
          await captureWrites;
          await captureFile!.sync();
          await captureFile!.close();
          const combined = [stdout, stderr && `STDERR:\n${stderr}`].filter(Boolean).join("\n");
          const totalBytes = stdoutBytes + stderrBytes;
          let result: AgentToolResult<Record<string, unknown>>;
          if (totalBytes > MAX_OUTPUT || sourceDroppedBytes > 0) {
            const stored = await persistToolOutputArtifact(capabilities, id, await readWorkspaceFile(workspace, captureRelative).then((value) => value.buffer), `Command output: ${params.command.slice(0, 80)}`, totalBytes, totalBytes > (capabilities.artifactSink?.maxBytes ?? MAX_DURABLE_OUTPUT));
            const shown = previewText(combined || "Command completed with no output");
            capabilities.publish("tool.output.spilled", { toolCallId: id, artifactId: stored.artifactId, totalBytes, shownBytes: Buffer.byteLength(shown), storedBytes: stored.storedBytes, sha256: stored.sha256, truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, totalBytes - stored.storedBytes) });
            result = { content: [{ type: "text", text: shown }], details: { exitCode: code, stdoutBytes, stderrBytes, capturedBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), captureTruncated: stored.truncatedAtSource, artifactId: stored.artifactId, artifactUri: stored.uri, sha256: stored.sha256, totalBytes, storedBytes: stored.storedBytes, shownBytes: Buffer.byteLength(shown), truncatedAtSource: stored.truncatedAtSource, outputDiscardedBytes: Math.max(0, totalBytes - stored.storedBytes) } };
          } else {
            result = await durableTextResult(capabilities, id, combined || "Command completed with no output", { exitCode: code, stdoutBytes, stderrBytes, capturedBytes: totalBytes, captureTruncated: false }, `Command output: ${params.command.slice(0, 80)}`, totalBytes, false);
          }
          await unlink(capturePath).catch(() => undefined);
          const artifact = typeof result.details.artifactId === "string" ? `; artifactId=${result.details.artifactId}` : "";
          const output = (result.content[0] as { text: string }).text;
          if (signal?.aborted) return reject(new Error(`Command aborted${artifact}`));
          if (timedOut) {
            capabilities.publish("tool.bash.timed_out", { toolCallId: id, timeoutSeconds, commandHash: createHash("sha256").update(params.command).digest("hex"), artifactId: result.details.artifactId ?? null, stdoutBytes, stderrBytes });
            return reject(new Error(`Command timed out after ${timeoutSeconds}s${artifact}. Inspect the preserved output before retrying; do not rerun the identical command unchanged.\n${output}`));
          }
          if (sig) return reject(new Error(`Command terminated by ${sig}${artifact}\n${output}`));
          if (code !== 0) return reject(new Error(`Command exited with code ${code}${artifact}\n${output}`));
          resolve(result);
        })().catch(reject); });
        });
      });
    },
  };

  const taskRunTool: AgentTool<typeof TaskRunSchema, Record<string, unknown>> = {
    name: "task_run", label: "Update task", description: "Inspect or update the current durable TaskRun. Use action=batch to combine independent plan/check/phase/artifact mutations into one model round-trip. Mutations return a compact receipt; use action=get only when the full state is needed.", parameters: TaskRunSchema, executionMode: "sequential",
    async execute(_id, params: Static<typeof TaskRunSchema>) {
      const validateMutation = (mutation: Static<typeof TaskRunBatchMutationSchema>) => {
        if (mutation.action === "plan" || mutation.action === "check") {
          if (!mutation.key.trim() || !mutation.title.trim()) throw new Error(`task_run action="${mutation.action}" requires non-empty "key" and "title".`);
        }
        if (mutation.action === "artifact" && (!mutation.id.trim() || !mutation.title.trim())) throw new Error('task_run action="artifact" requires non-empty "id" and "title".');
      };
      const applyMutation = (mutation: Static<typeof TaskRunBatchMutationSchema>) => {
        const requireMutationText = (name: "key" | "title" | "id") => { const value = name in mutation ? mutation[name as keyof typeof mutation] : undefined; if (typeof value !== "string" || !value.trim()) throw new Error(`task_run action="${mutation.action}" requires "${name}".`); return value; };
        if (mutation.action === "phase") capabilities.setRunPhase(mutation.phase);
        if (mutation.action === "plan") capabilities.upsertPlanItem({ key: requireMutationText("key"), title: requireMutationText("title"), status: mutation.status, required: mutation.required ?? true, position: mutation.position ?? 0 });
        if (mutation.action === "check") capabilities.upsertCheck({ key: requireMutationText("key"), title: requireMutationText("title"), status: mutation.status, required: mutation.required ?? true, command: mutation.command ?? "", evidence: mutation.evidence ?? "", stale: mutation.stale ?? false });
        if (mutation.action === "mark_checks_stale") capabilities.markChecksStale();
        if (mutation.action === "artifact") capabilities.addArtifact({ id: requireMutationText("id"), title: requireMutationText("title"), kind: mutation.kind ?? "artifact", content: mutation.content ?? "", uri: mutation.uri ?? "" });
      };
      const requireText = (name: "key" | "title" | "id" | "prompt") => { const value = params[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`task_run action="${params.action}" requires "${name}".`); return value; };
      if (params.action === "batch") {
        if (!params.mutations?.length) throw new Error('task_run action="batch" requires "mutations".');
        for (const mutation of params.mutations) validateMutation(mutation);
        for (const mutation of params.mutations) applyMutation(mutation);
      }
      if (params.action === "phase") { if (!params.phase) throw new Error('task_run action="phase" requires "phase".'); capabilities.setRunPhase(params.phase); }
      if (params.action === "plan") { const status = params.status; if (!status || !["pending","in_progress","done","blocked","skipped"].includes(status)) throw new Error('task_run action="plan" requires a plan status.'); capabilities.upsertPlanItem({ key: requireText("key"), title: requireText("title"), status: status as "pending"|"in_progress"|"done"|"blocked"|"skipped", required: params.required ?? true, position: params.position ?? 0 }); }
      if (params.action === "check") { const status = params.status; if (!status || !["pending","running","passed","failed","blocked","skipped"].includes(status)) throw new Error('task_run action="check" requires a check status.'); capabilities.upsertCheck({ key: requireText("key"), title: requireText("title"), status: status as "pending"|"running"|"passed"|"failed"|"blocked"|"skipped", required: params.required ?? true, command: params.command ?? "", evidence: params.evidence ?? "", stale: params.stale ?? false }); }
      if (params.action === "mark_checks_stale") capabilities.markChecksStale();
      if (params.action === "operations") return textResult(JSON.stringify(capabilities.listOperations(), null, 2));
      if (params.action === "artifact") capabilities.addArtifact({ id: requireText("id"), title: requireText("title"), kind: params.kind ?? "artifact", content: params.content ?? "", uri: params.uri ?? "" });
      if (params.action === "request_user_input") {
        const keys = new Set<string>();
        if (!params.fields?.length) throw new Error('task_run action="request_user_input" requires "fields".');
        const fields = params.fields.map((field) => {
          const key = field.key.trim();
          if (!key || keys.has(key)) throw new Error("User input field keys must be non-empty and unique");
          keys.add(key);
          return { key, label: field.label.trim() || key, description: field.description?.trim() ?? "", inputType: field.inputType ?? "text" as const, required: field.required ?? true, placeholder: field.placeholder?.trim() ?? "" };
        });
        const request = capabilities.requestUserInput(_id, requireText("prompt").trim(), fields);
        return textResult(JSON.stringify({ ok: true, action: params.action, runId, status: "waiting_input", requestId: request.id, requiredFields: request.fields.map((field) => field.key) }), { compact: true });
      }
      const changed = params.action !== "get";
      const run = capabilities.getRun();
      if (changed) capabilities.publish("run.updated", { action: params.action, phase: run?.phase ?? "discover" });
      if (!changed) return textResult(JSON.stringify(run, null, 2));
      return textResult(JSON.stringify({
        ok: true, action: params.action, runId, status: run?.status, phase: run?.phase,
        completionGate: run?.completionGate,
        counts: { plan: run?.plan.length ?? 0, checks: run?.checks.length ?? 0, artifacts: run?.artifacts.length ?? 0 },
      }), { compact: true });
    },
  };

  const tools:AgentTool[]=[listTool, readTool, writeTool, editTool, patchTool, bashTool, taskRunTool];
  const memory = capabilities.memory;
  if(memory){
    const memorySearchTool:AgentTool<typeof MemorySearchSchema,Record<string,unknown>>={name:"memory_search",label:"Search memory",description:"Search long-term memory when automatic recall is insufficient. Returns cards, topic IDs, confidence and provenance routes.",parameters:MemorySearchSchema,async execute(_id,params:Static<typeof MemorySearchSchema>){return textResult(JSON.stringify(await memory.search(params.query,params.kinds,params.maxResults),null,2));}};tools.push(memorySearchTool);
    const memoryTopicTool:AgentTool<typeof MemoryTopicSchema,Record<string,unknown>>={name:"memory_topic_get",label:"Read memory topic",description:"Read one complete canonical Cold Topic page by exact topic ID.",parameters:MemoryTopicSchema,async execute(_id,params:Static<typeof MemoryTopicSchema>){const topic=await memory.getTopic(params.topicId);if(!topic)throw new Error("Memory topic not found");return textResult(topic.body,{topicId:params.topicId,revision:topic.revision,checksum:topic.checksum});}};tools.push(memoryTopicTool);
    const memoryRecordTool:AgentTool<typeof MemoryRecordSchema,Record<string,unknown>>={name:"memory_record_get",label:"Read memory record",description:"Read one full memory record including source references, provenance, status, validity and canonical semantics.",parameters:MemoryRecordSchema,async execute(_id,params:Static<typeof MemoryRecordSchema>){const record=await memory.getRecord(params.id);if(!record)throw new Error("Memory record not found");return textResult(JSON.stringify(record,null,2));}};tools.push(memoryRecordTool);
    const memoryForgetTool:AgentTool<typeof MemoryForgetSchema,Record<string,unknown>>={name:"memory_forget",label:"Forget memory",description:"Forget specified memory record IDs or Topic IDs. Use only when the user explicitly requests deletion or correction.",parameters:MemoryForgetSchema,executionMode:"sequential",async execute(id,params:Static<typeof MemoryForgetSchema>){return executeMutation(capabilities,id,"tool.memory_forget",params,async()=>textResult(JSON.stringify(await memory.forget(params),null,2)));}};tools.push(memoryForgetTool);
  }
  return tools;
}

export async function ensureWorkspace(workspace: string) {
  await mkdir(workspace, { recursive: true });
  await access(workspace);
}
