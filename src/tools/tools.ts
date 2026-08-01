import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Store } from "../store/store.js";
import type { RunEvent, RunId } from "../core/types.js";
import type { MemoryFacade } from "../memory/memory-service.js";
import type { MemoryKind } from "../memory/types.js";

const MAX_OUTPUT = 24_000;
const MAX_CAPTURE = 256_000;
const MAX_LIST_ENTRIES = 500;
const ReadSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) });
const ListSchema = Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_ENTRIES })) });
const WriteSchema = Type.Object({ path: Type.String(), content: Type.String() });
const EditSchema = Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() });
const BashSchema = Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) });
const MemorySearchSchema=Type.Object({query:Type.String(),kinds:Type.Optional(Type.Array(Type.Union([Type.Literal("fact"),Type.Literal("preference"),Type.Literal("episode"),Type.Literal("procedure")]))),maxResults:Type.Optional(Type.Integer({minimum:1,maximum:20}))});
const MemoryRecordSchema=Type.Object({id:Type.String()});
const MemoryTopicSchema=Type.Object({topicId:Type.String()});
const MemoryForgetSchema=Type.Object({ids:Type.Optional(Type.Array(Type.String())),topicIds:Type.Optional(Type.Array(Type.String())),reason:Type.Optional(Type.String()),gracePeriodMs:Type.Optional(Type.Number({minimum:1}))});
const TaskRunSchema = Type.Union([
  Type.Object({ action: Type.Literal("get") }),
  Type.Object({ action: Type.Literal("phase"), phase: Type.Union([Type.Literal("discover"), Type.Literal("plan"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("review")]) }),
  Type.Object({ action: Type.Literal("plan"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Integer()) }),
  Type.Object({ action: Type.Literal("check"), key: Type.String(), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped")]), required: Type.Optional(Type.Boolean()), command: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), stale: Type.Optional(Type.Boolean()) }),
  Type.Object({ action: Type.Literal("mark_checks_stale") }),
  Type.Object({ action: Type.Literal("operations") }),
  Type.Object({ action: Type.Literal("artifact"), id: Type.String(), title: Type.String(), kind: Type.Optional(Type.String()), content: Type.Optional(Type.String()), uri: Type.Optional(Type.String()) }),
  Type.Object({ action: Type.Literal("spawn_proposal"), goal: Type.String(), acceptanceCriteria: Type.Array(Type.String()), relation: Type.Optional(Type.Union([Type.Literal("depends_on"), Type.Literal("follow_up"), Type.Literal("parallel"), Type.Literal("derived")])) }),
]);

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  const clipped = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n... output truncated` : text;
  return { content: [{ type: "text", text: clipped }], details };
}

function appendCapture(current: string, chunk: string) {
  const next = current + chunk;
  return next.length <= MAX_CAPTURE ? next : next.slice(-MAX_CAPTURE);
}

function firstChangedLine(before: string, after: string) {
  const left = before.split("\n");
  const right = after.split("\n");
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return index + 1;
  return null;
}

function resolveInside(root: string, target: string) {
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes the workspace");
  return absolute;
}

function operationId(runId: RunId, attempt: number, toolCallId: string) {
  return `${runId}:${attempt}:${toolCallId}`;
}

async function executeMutation(
  store: Store,
  runId: RunId,
  toolCallId: string,
  operationType: string,
  payload: unknown,
  effect: () => Promise<AgentToolResult<Record<string, unknown>>>,
) {
  const run = store.getRun(runId);
  if (!run) throw new Error("Run not found");
  const id = operationId(runId, run.attempt, toolCallId);
  const receipt = store.claimOperation(id, runId, run.attempt, operationType, payload);
  if (!receipt.claimed) {
    if (receipt.status === "succeeded") return receipt.result as AgentToolResult<Record<string, unknown>>;
    throw new Error(`Operation ${id} cannot be replayed from status ${receipt.status}`);
  }
  try {
    store.advanceRunPhase(runId, "implement");
    const result = await effect();
    const staleChecks = store.markChecksStale(runId);
    store.updateOperation(id, { status: "succeeded", stage: "completed", effects: [{ kind: "checks", action: "stale", count: staleChecks }], result });
    return result;
  } catch (error) {
    store.updateOperation(id, { status: "failed", stage: "execution_failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function createTools(store: Store, runId: RunId, workspace: string, onEvent?: (event: RunEvent) => void, memory?:MemoryFacade, memoryScopeId="default", memorySubjectId?:string): AgentTool[] {
  const listTool: AgentTool<typeof ListSchema, Record<string, unknown>> = {
    name: "ls", label: "List directory", description: "List entries in a workspace directory.", parameters: ListSchema,
    async execute(_id, params: Static<typeof ListSchema>) {
      const target = params.path ?? ".";
      const dirname = resolveInside(workspace, target);
      const entries = await readdir(dirname, { withFileTypes: true });
      const limit = params.limit ?? 200;
      const names = entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
      return textResult(names.join("\n") || "Directory is empty", { path: dirname, totalEntries: entries.length, returnedEntries: names.length, truncated: entries.length > limit });
    },
  };

  const readTool: AgentTool<typeof ReadSchema, Record<string, unknown>> = {
    name: "read", label: "Read file", description: "Read a UTF-8 text file inside the workspace.", parameters: ReadSchema,
    async execute(_id, params: Static<typeof ReadSchema>) {
      const filename = resolveInside(workspace, params.path);
      const file = await stat(filename);
      const buffer = await readFile(filename);
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return textResult(`Binary file: ${params.path}`, { path: filename, type: "binary", bytes: file.size });
      const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
      const lines = content.split("\n");
      const offset = params.offset ?? 1;
      const limit = params.limit ?? 300;
      return textResult(lines.slice(offset - 1, offset - 1 + limit).join("\n"), { path: filename, type: "text", bytes: file.size, totalLines: lines.length, offset, limit });
    },
  };

  const writeTool: AgentTool<typeof WriteSchema, Record<string, unknown>> = {
    name: "write", label: "Write file", description: "Create or overwrite a UTF-8 file inside the workspace.", parameters: WriteSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof WriteSchema>) {
      return executeMutation(store, runId, id, "tool.write", params, async () => {
        const filename = resolveInside(workspace, params.path);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, params.content, "utf8");
        return textResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`, { path: filename, bytes: Buffer.byteLength(params.content) });
      });
    },
  };

  const editTool: AgentTool<typeof EditSchema, Record<string, unknown>> = {
    name: "edit", label: "Edit file", description: "Replace exact text in a workspace file. The old text must occur exactly once.", parameters: EditSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof EditSchema>) {
      return executeMutation(store, runId, id, "tool.edit", params, async () => {
        const filename = resolveInside(workspace, params.path);
        const content = await readFile(filename, "utf8");
        const newContent = params.oldText === "" ? content + params.newText : (() => {
          const occurrences = content.split(params.oldText).length - 1;
          if (occurrences !== 1) throw new Error(`Expected oldText exactly once, found ${occurrences}`);
          return content.replace(params.oldText, params.newText);
        })();
        await writeFile(filename, newContent, "utf8");
        return textResult(`Updated ${params.path}`, { path: filename, mode: params.oldText === "" ? "append" : "replace", bytesBefore: Buffer.byteLength(content), bytesAfter: Buffer.byteLength(newContent), firstChangedLine: firstChangedLine(content, newContent) });
      });
    },
  };

  const bashTool: AgentTool<typeof BashSchema, Record<string, unknown>> = {
    name: "bash", label: "Run command", description: "Run a non-interactive shell command in the workspace. Destructive commands are blocked.", parameters: BashSchema, executionMode: "sequential",
    async execute(id, params: Static<typeof BashSchema>, signal, onUpdate) {
      return executeMutation(store, runId, id, "tool.bash", params, async () => {
        if (/\b(rm\s+-rf|mkfs|shutdown|reboot|poweroff|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)\b/i.test(params.command)) throw new Error("Command blocked by the minimal safety policy");
        return await new Promise<AgentToolResult<Record<string, unknown>>>((resolve, reject) => {
          const child = spawn("bash", ["-lc", params.command], { cwd: workspace, env: process.env, detached: process.platform !== "win32" });
        let stdout = "";
        let stderr = "";
        let progressBuffer = "";
        let progressTimer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const flushProgress = () => { if (progressBuffer) onUpdate?.(textResult(progressBuffer, { stream: "combined" })); progressBuffer = ""; progressTimer = undefined; };
        const terminate = () => {
          if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
          else child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
            else child.kill("SIGKILL");
          }, 2_000);
        };
        const timer = setTimeout(terminate, (params.timeoutSeconds ?? 30) * 1000);
        const abort = terminate;
        signal?.addEventListener("abort", abort, { once: true });
        const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (stream === "stdout") stdout = appendCapture(stdout, text); else stderr = appendCapture(stderr, text);
          progressBuffer += text;
          if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
        };
        child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
        child.on("error", reject);
        child.on("close", (code, sig) => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (progressTimer) clearTimeout(progressTimer);
          flushProgress();
          signal?.removeEventListener("abort", abort);
          const combined = [stdout, stderr && `STDERR:\n${stderr}`].filter(Boolean).join("\n");
          if (signal?.aborted) return reject(new Error("Command aborted"));
          if (sig) return reject(new Error(`Command terminated by ${sig}\n${combined}`));
          if (code !== 0) return reject(new Error(`Command exited with code ${code}\n${combined}`));
          resolve(textResult(combined || "Command completed with no output", { exitCode: code, capturedBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), captureTruncated: stdout.length >= MAX_CAPTURE || stderr.length >= MAX_CAPTURE }));
        });
        });
      });
    },
  };

  const taskRunTool: AgentTool<typeof TaskRunSchema, Record<string, unknown>> = {
    name: "task_run", label: "Update task", description: "Inspect or update the current durable TaskRun. Mutations return a compact receipt; use action=get only when the full state is needed.", parameters: TaskRunSchema, executionMode: "sequential",
    async execute(_id, params: Static<typeof TaskRunSchema>) {
      if (params.action === "phase") store.setRunPhase(runId, params.phase);
      if (params.action === "plan") store.upsertPlanItem(runId, { key: params.key, title: params.title, status: params.status, required: params.required ?? true, position: params.position ?? 0 });
      if (params.action === "check") store.upsertCheck(runId, { key: params.key, title: params.title, status: params.status, required: params.required ?? true, command: params.command ?? "", evidence: params.evidence ?? "", stale: params.stale ?? false });
      if (params.action === "mark_checks_stale") store.markChecksStale(runId);
      if (params.action === "operations") return textResult(JSON.stringify(store.listOperations(runId), null, 2));
      if (params.action === "artifact") store.addArtifact(runId, { id: params.id, title: params.title, kind: params.kind ?? "artifact", content: params.content ?? "", uri: params.uri ?? "" });
      if (params.action === "spawn_proposal") store.createSpawnProposal(runId, params.goal.trim(), params.acceptanceCriteria, params.relation ?? "derived");
      const changed = params.action !== "get";
      const run = store.getRun(runId);
      if (changed) onEvent?.(store.appendEvent(runId, "run.updated", { action: params.action, phase: run?.phase ?? "discover" }));
      if (!changed) return textResult(JSON.stringify(run, null, 2));
      return textResult(JSON.stringify({
        ok: true, action: params.action, runId, status: run?.status, phase: run?.phase,
        completionGate: run?.completionGate,
        counts: { plan: run?.plan.length ?? 0, checks: run?.checks.length ?? 0, artifacts: run?.artifacts.length ?? 0 },
      }), { compact: true });
    },
  };

  const tools:AgentTool[]=[listTool, readTool, writeTool, editTool, bashTool, taskRunTool];
  if(memory){const scope={type:"workspace" as const,id:memoryScopeId};const access={subjectId:memorySubjectId??`run:${runId}`,scopes:[scope],purpose:"agent_recall" as const};
    const memorySearchTool:AgentTool<typeof MemorySearchSchema,Record<string,unknown>>={name:"memory_search",label:"Search memory",description:"Search long-term memory when automatic recall is insufficient. Returns cards, topic IDs, confidence and provenance routes.",parameters:MemorySearchSchema,async execute(_id,params:Static<typeof MemorySearchSchema>){const result=await memory.recall({access,cue:params.query,kinds:params.kinds as MemoryKind[]|undefined,maxCards:params.maxResults??8,maxColdTopics:0});return textResult(JSON.stringify({cards:result.cards,topicIds:result.trace.topicIds,trace:result.trace},null,2));}};tools.push(memorySearchTool);
    const memoryTopicTool:AgentTool<typeof MemoryTopicSchema,Record<string,unknown>>={name:"memory_topic_get",label:"Read memory topic",description:"Read one complete canonical Cold Topic page by exact topic ID.",parameters:MemoryTopicSchema,async execute(_id,params:Static<typeof MemoryTopicSchema>){const topic=await memory.getColdTopic(access,params.topicId);if(!topic)throw new Error("Memory topic not found");return textResult(topic.body,{topicId:params.topicId,revision:topic.revision.revision,checksum:topic.revision.checksum});}};tools.push(memoryTopicTool);
    const memoryRecordTool:AgentTool<typeof MemoryRecordSchema,Record<string,unknown>>={name:"memory_record_get",label:"Read memory record",description:"Read one full memory record including source references, provenance, status, validity and canonical semantics.",parameters:MemoryRecordSchema,async execute(_id,params:Static<typeof MemoryRecordSchema>){const record=await memory.getRecord(access,params.id);if(!record)throw new Error("Memory record not found");return textResult(JSON.stringify(record,null,2));}};tools.push(memoryRecordTool);
    const memoryForgetTool:AgentTool<typeof MemoryForgetSchema,Record<string,unknown>>={name:"memory_forget",label:"Forget memory",description:"Forget specified memory record IDs or Topic IDs. Use only when the user explicitly requests deletion or correction.",parameters:MemoryForgetSchema,executionMode:"sequential",async execute(id,params:Static<typeof MemoryForgetSchema>){return executeMutation(store,runId,id,"tool.memory_forget",params,async()=>textResult(JSON.stringify(await memory.forget({access:{...access,purpose:"memory_admin"},scope,ids:params.ids,topicIds:params.topicIds,reason:params.reason,gracePeriodMs:params.gracePeriodMs}),null,2)));}};tools.push(memoryForgetTool);
  }
  return tools;
}

export async function ensureWorkspace(workspace: string) {
  await mkdir(workspace, { recursive: true });
  await access(workspace);
}
