import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Store } from "../store/store.js";
import type { RunId } from "../core/types.js";

const MAX_OUTPUT = 24_000;
const ReadSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) });
const WriteSchema = Type.Object({ path: Type.String(), content: Type.String() });
const EditSchema = Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() });
const BashSchema = Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) });
const TaskRunSchema = Type.Union([
  Type.Object({ action: Type.Literal("get") }),
  Type.Object({ action: Type.Literal("phase"), phase: Type.Union([Type.Literal("discover"), Type.Literal("plan"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("review")]) }),
  Type.Object({ action: Type.Literal("plan"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Integer()) }),
  Type.Object({ action: Type.Literal("check"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), command: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), stale: Type.Optional(Type.Boolean()) }),
  Type.Object({ action: Type.Literal("artifact"), id: Type.String(), title: Type.String(), kind: Type.Optional(Type.String()), content: Type.Optional(Type.String()), uri: Type.Optional(Type.String()) }),
]);

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  const clipped = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n... output truncated` : text;
  return { content: [{ type: "text", text: clipped }], details };
}

function resolveInside(root: string, target: string) {
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes the workspace");
  return absolute;
}

export function createTools(store: Store, runId: RunId, workspace: string): AgentTool[] {
  const readTool: AgentTool<typeof ReadSchema, Record<string, unknown>> = {
    name: "read", label: "Read file", description: "Read a UTF-8 text file inside the workspace.", parameters: ReadSchema,
    async execute(_id, params: Static<typeof ReadSchema>) {
      const filename = resolveInside(workspace, params.path);
      const content = await readFile(filename, "utf8");
      const lines = content.split("\n");
      const offset = params.offset ?? 1;
      const limit = params.limit ?? 300;
      return textResult(lines.slice(offset - 1, offset - 1 + limit).join("\n"), { path: filename, totalLines: lines.length, offset, limit });
    },
  };

  const writeTool: AgentTool<typeof WriteSchema, Record<string, unknown>> = {
    name: "write", label: "Write file", description: "Create or overwrite a UTF-8 file inside the workspace.", parameters: WriteSchema, executionMode: "sequential",
    async execute(_id, params: Static<typeof WriteSchema>) {
      const filename = resolveInside(workspace, params.path);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, params.content, "utf8");
      return textResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`, { path: filename, bytes: Buffer.byteLength(params.content) });
    },
  };

  const editTool: AgentTool<typeof EditSchema, Record<string, unknown>> = {
    name: "edit", label: "Edit file", description: "Replace exact text in a workspace file. The old text must occur exactly once.", parameters: EditSchema, executionMode: "sequential",
    async execute(_id, params: Static<typeof EditSchema>) {
      const filename = resolveInside(workspace, params.path);
      const content = await readFile(filename, "utf8");
      const occurrences = content.split(params.oldText).length - 1;
      if (occurrences !== 1) throw new Error(`Expected oldText exactly once, found ${occurrences}`);
      await writeFile(filename, content.replace(params.oldText, params.newText), "utf8");
      return textResult(`Updated ${params.path}`, { path: filename });
    },
  };

  const bashTool: AgentTool<typeof BashSchema, Record<string, unknown>> = {
    name: "bash", label: "Run command", description: "Run a non-interactive shell command in the workspace. Destructive commands are blocked.", parameters: BashSchema, executionMode: "sequential",
    async execute(_id, params: Static<typeof BashSchema>, signal, onUpdate) {
      if (/\b(rm\s+-rf|mkfs|shutdown|reboot|poweroff|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)\b/i.test(params.command)) throw new Error("Command blocked by the minimal safety policy");
      return await new Promise<AgentToolResult<Record<string, unknown>>>((resolve, reject) => {
        const child = spawn("bash", ["-lc", params.command], { cwd: workspace, env: process.env });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), (params.timeoutSeconds ?? 30) * 1000);
        const abort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); onUpdate?.(textResult(chunk.toString(), { stream: "stdout" })); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); onUpdate?.(textResult(chunk.toString(), { stream: "stderr" })); });
        child.on("error", reject);
        child.on("close", (code, sig) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const combined = [stdout, stderr && `STDERR:\n${stderr}`].filter(Boolean).join("\n");
          if (signal?.aborted) return reject(new Error("Command aborted"));
          if (sig) return reject(new Error(`Command terminated by ${sig}\n${combined}`));
          if (code !== 0) return reject(new Error(`Command exited with code ${code}\n${combined}`));
          resolve(textResult(combined || "Command completed with no output", { exitCode: code }));
        });
      });
    },
  };

  const taskRunTool: AgentTool<typeof TaskRunSchema, Record<string, unknown>> = {
    name: "task_run", label: "Update task", description: "Inspect or update the current durable TaskRun plan, phase, checks, and artifacts.", parameters: TaskRunSchema, executionMode: "sequential",
    async execute(_id, params: Static<typeof TaskRunSchema>) {
      if (params.action === "phase") store.setRunPhase(runId, params.phase);
      if (params.action === "plan") store.upsertPlanItem(runId, { key: params.key, title: params.title, status: params.status, required: params.required ?? true, position: params.position ?? 0 });
      if (params.action === "check") store.upsertCheck(runId, { key: params.key, title: params.title, status: params.status, required: params.required ?? true, command: params.command ?? "", evidence: params.evidence ?? "", stale: params.stale ?? false });
      if (params.action === "artifact") store.addArtifact(runId, { id: params.id, title: params.title, kind: params.kind ?? "artifact", content: params.content ?? "", uri: params.uri ?? "" });
      return textResult(JSON.stringify(store.getRun(runId), null, 2));
    },
  };

  return [readTool, writeTool, editTool, bashTool, taskRunTool];
}

export async function ensureWorkspace(workspace: string) {
  await mkdir(workspace, { recursive: true });
  await access(workspace);
}
