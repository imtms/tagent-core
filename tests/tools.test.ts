import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite/store";
import type { RunEvent, RunId } from "@tagent/execution/domain";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { bashCommandIsDestructive, bashInvalidatesChecks, composeWorkspaceTools, createLocalSubprocessPort, createWorkspaceArtifactSink, createWorkspaceEditPort, listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile } from "@tagent/workspace-local";

const testSignal = new AbortController().signal;

async function waitForFile(filename: string) {
  for (let index = 0; index < 1_000; index += 1) {
    try { await readFile(filename); return; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

function createTestTools(
  store: Store,
  runId: RunId,
  workspace: string,
  onEvent: (event: RunEvent) => void = () => undefined,
  overrides: Partial<ToolCapabilityApplicationPort> = {},
) {
  const capabilities: ToolCapabilityApplicationPort = {
    runId,
    artifactSink: createWorkspaceArtifactSink(workspace),
    workspaceEdit: createWorkspaceEditPort(workspace),
    getRun: () => store.getRun(runId),
    getRunExecutionState: () => store.getRunExecutionState(runId),
    isCurrentAttempt: () => true,
    authorizeWorkspaceMutation: () => ({ allowed: true, reason: "ordinary TaskRun" }),
    authorizeExternalAction: () => ({ allowed: true, reason: "ordinary TaskRun" }),
    advanceRunPhase: (phase) => store.advanceRunPhase(runId, phase),
    setRunPhase: (phase) => store.setRunPhase(runId, phase),
    claimOperation: (id, operationType, payload) =>
      store.claimOperation(id, runId, store.getRun(runId)!.attempt, operationType, payload),
    updateOperation: (id, update) => store.updateOperation(id, update),
    listOperations: (options) => store.listOperations(runId, options),
    upsertPlanItem: (item) => store.upsertPlanItem(runId, item),
    markChecksStale: () => store.markChecksStale(runId),
    upsertCheck: (check) => store.upsertCheck(runId, check),
    applyTaskRunBatch: (mutations) => store.db.transaction(() => {
      for (const mutation of mutations) {
        if (mutation.action === "phase") store.setRunPhase(runId, mutation.phase);
        else if (mutation.action === "plan") store.upsertPlanItem(runId, mutation.item);
        else if (mutation.action === "check") store.upsertCheck(runId, mutation.check);
        else if (mutation.action === "mark_checks_stale") store.markChecksStale(runId);
        else store.addArtifact(runId, mutation.artifact);
      }
    })(),
    addArtifact: (artifact) => store.addArtifact(runId, artifact),
    requestUserInput: (_toolCallId, prompt, fields) => store.requestUserInput(runId, prompt, fields),
    recordToolAttempt: (toolCallId, toolName, args) => store.recordToolAttempt(runId, store.getRun(runId)!.attempt, toolCallId, toolName, args),
    completeToolAttempt: (toolCallId, success, error) => store.completeToolAttempt(runId, store.getRun(runId)!.attempt, toolCallId, success, error),
    consumeAtomicallySettledToolCall: () => false,
    publish: (type, data) => {
      const event = store.appendEvent(runId, type, data);
      onEvent(event);
      return event;
    },
    history: {
      search: async (query, signal) => {
        signal.throwIfAborted();
        const beforeSeq = store.getLastTranscriptSeq(runId);
        const result = store.searchTranscriptLiteral(runId, query, { beforeSeq, limit: 8, snippetChars: 320 });
        signal.throwIfAborted();
        return { ...result, beforeSeq };
      },
    },
    ...overrides,
  };
  return [...composeWorkspaceTools(capabilities, workspace, createLocalSubprocessPort()).catalog.tools];
}

describe("workspace tools", () => {
  it("reads the workspace root and rejects traversal into a similar-prefix sibling", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "tagent-tools-boundary-"));
    const workspace = path.join(parent, "work");
    const sibling = path.join(parent, "work-evil");
    await mkdir(workspace); await mkdir(sibling);
    await writeFile(path.join(workspace, "hello.txt"), "hello\nworld", "utf8");
    await writeFile(path.join(sibling, "secret.txt"), "sibling-secret", "utf8");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "tools");
    const read = createTestTools(store, run.id, workspace).find((tool) => tool.name === "read")!;
    const result = await read.execute("1", { path: "hello.txt" }, testSignal);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    const list = createTestTools(store, run.id, workspace).find((tool) => tool.name === "ls")!;
    expect((await list.execute("root", { path: "." }, testSignal)).content[0]).toMatchObject({ type: "text", text: "hello.txt" });
    await expect(read.execute("2", { path: "../work-evil/secret.txt" }, testSignal)).rejects.toThrow("escapes");
    expect(store.listOperations(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationType: "tool.read", status: "succeeded", effects: [{ kind: "workspace", action: "read_only" }] }),
      expect.objectContaining({ operationType: "tool.list", status: "succeeded", effects: [{ kind: "workspace", action: "read_only" }] }),
    ]));
    store.close();
  });

  it("rejects file, directory, nested, and create-target symlink escapes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-symlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "tagent-tools-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "outside-secret", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "file-link"));
    await symlink(outside, path.join(workspace, "dir-link"));
    await mkdir(path.join(workspace, "nested"));
    await symlink(outside, path.join(workspace, "nested", "escape"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "symlink boundaries");
    const tools = createTestTools(store, run.id, workspace);
    const read = tools.find((tool) => tool.name === "read")!;
    const list = tools.find((tool) => tool.name === "ls")!;
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    await expect(read.execute("read-file-link", { path: "file-link" }, testSignal)).rejects.toThrow(/Symbolic/);
    await expect(read.execute("read-dir-link", { path: "dir-link/secret.txt" }, testSignal)).rejects.toThrow(/Symbolic/);
    await expect(read.execute("read-nested-link", { path: "nested/escape/secret.txt" }, testSignal)).rejects.toThrow(/Symbolic/);
    await expect(list.execute("list-link", { path: "dir-link" }, testSignal)).rejects.toThrow(/Symbolic/);
    await expect(write.execute("write-file-link", { path: "file-link", content: "changed" }, testSignal)).rejects.toThrow(/Symbolic/);
    await expect(write.execute("write-dir-link", { path: "dir-link/new.txt", content: "changed" }, testSignal)).rejects.toThrow(/Symbolic/);
    await expect(edit.execute("edit-link", { path: "file-link", snapshotId: "sha256:x", contentHash: "x", oldText: "outside", newText: "inside" }, testSignal)).rejects.toThrow(/Symbolic/);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside-secret");
    store.close();
  });

  it("pins parent directory descriptors across concurrent directory-to-symlink swaps", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-race-"));
    const outside = await mkdtemp(path.join(tmpdir(), "tagent-tools-race-outside-"));
    const parent = path.join(workspace, "parent");
    const displaced = path.join(workspace, "parent-displaced");
    await mkdir(parent);
    await writeFile(path.join(parent, "inside.txt"), "inside", "utf8");
    await writeFile(path.join(outside, "inside.txt"), "outside", "utf8");
    const ready = path.join(workspace, ".ready");
    const release = path.join(workspace, ".release");
    const env = { TAGENT_FD_HELPER_READY: ready, TAGENT_FD_HELPER_RELEASE: release };

    const readPromise = readWorkspaceFile(workspace, "parent/inside.txt", testSignal, { ...env, TAGENT_FD_HELPER_STAGE: "before_open" });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(outside, parent);
    await writeFile(release, "go");
    expect((await readPromise).buffer.toString()).toBe("inside");
    await rm(ready); await rm(release); await rm(parent); await rename(displaced, parent);

    const writePromise = writeWorkspaceFile(workspace, "parent/new.txt", "workspace-only", testSignal, { ...env, TAGENT_FD_HELPER_STAGE: "after_parent_open" });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(outside, parent);
    await writeFile(release, "go");
    await writePromise;
    expect(await readFile(path.join(displaced, "new.txt"), "utf8")).toBe("workspace-only");
    await expect(readFile(path.join(outside, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(ready); await rm(release); await rm(parent); await rename(displaced, parent);

    const listPromise = listWorkspaceDirectory(workspace, "parent", testSignal, { ...env, TAGENT_FD_HELPER_STAGE: "after_directory_open" });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(outside, parent);
    await writeFile(release, "go");
    expect((await listPromise).map((entry) => entry.name)).toContain("inside.txt");
    expect((await listWorkspaceDirectory(outside, ".", testSignal)).map((entry) => entry.name)).toContain("inside.txt");
  });

  it("terminates and joins a paused workspace helper when its caller aborts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-abort-"));
    await writeFile(path.join(workspace, "inside.txt"), "inside", "utf8");
    const ready = path.join(workspace, ".ready");
    const release = path.join(workspace, ".release");
    const controller = new AbortController();
    const pending = readWorkspaceFile(workspace, "inside.txt", controller.signal, {
      TAGENT_FD_HELPER_READY: ready,
      TAGENT_FD_HELPER_RELEASE: release,
      TAGENT_FD_HELPER_STAGE: "before_open",
    });
    await waitForFile(ready);
    controller.abort(new Error("workspace read cancelled"));
    await expect(pending).rejects.toThrow("workspace read cancelled");
    await expect(readFile(release)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(workspace, { recursive: true, force: true });
  });

  it("lists directories, strips UTF-8 BOM, and returns binary metadata", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    await writeFile(path.join(workspace, "bom.txt"), "\uFEFFhello", "utf8");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "inspect tools");
    const tools = createTestTools(store, run.id, workspace);
    const list = tools.find((tool) => tool.name === "ls")!;
    const read = tools.find((tool) => tool.name === "read")!;
    expect((await list.execute("list", {}, testSignal)).content[0]).toMatchObject({ type: "text", text: "binary.bin\nbom.txt" });
    expect((await read.execute("bom", { path: "bom.txt" }, testSignal)).content[0]).toMatchObject({ type: "text", text: "hello" });
    expect((await read.execute("binary", { path: "binary.bin" }, testSignal)).details).toMatchObject({ type: "binary", bytes: 3 });
    store.close();
  });

  it("appends through edit and reports the first changed line", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    await writeFile(path.join(workspace, "notes.txt"), "one\ntwo\n", "utf8");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "append");
    const created = createTestTools(store, run.id, workspace);
    const edit = created.find((tool) => tool.name === "edit")!;
    const read = created.find((tool) => tool.name === "read")!;
    const snapshot = (await read.execute("append-read", { path: "notes.txt" }, testSignal)).details as { snapshotId: string; contentHash: string };
    const result = await edit.execute("append-call", { path: "notes.txt", ...snapshot, oldText: "", newText: "three\n" }, testSignal);
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(result.details).toMatchObject({ mode: "append", firstChangedLine: 3 });
    store.close();
  });

  it("bounds bash output capture", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "large output");
    const bash = createTestTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    const result = await bash.execute("large-output", { command: "yes x | head -c 400000", timeoutSeconds: 10 }, testSignal);
    expect(result.details).toMatchObject({ exitCode: 0, captureTruncated: false, artifactId: expect.any(String), outputDiscardedBytes: 0 });
    const output = (result.content[0] as { type: string; text: string }).text;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(24_000);
    expect(output).toContain("trusted operation receipt");
    store.close();
  });

  it("removes Bash capture files when Artifact persistence fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-capture-cleanup-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "capture cleanup");
    const write = vi.fn(async () => { throw new Error("artifact persistence failed"); });
    const bash = createTestTools(store, run.id, workspace, () => undefined, {
      artifactSink: { maxBytes: 64_000, write },
    }).find((tool) => tool.name === "bash")!;

    await expect(bash.execute("spill-failure", {
      command: "node -e \"process.stdout.write('x'.repeat(30000))\"",
      timeoutSeconds: 10,
    }, testSignal)).rejects.toThrow("artifact persistence failed");

    expect(write).toHaveBeenCalledOnce();
    expect(await readdir(path.join(workspace, ".tagent/tmp"))).toEqual([]);
    store.close();
  });

  it("replays mutating tool receipts without repeating side effects and stales checks", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "idempotent write");
    store.upsertCheck(run.id, { key: "test", title: "Tests", status: "passed", required: true, command: "npm test", evidence: "old", stale: false });
    const write = createTestTools(store, run.id, workspace).find((tool) => tool.name === "write")!;
    const params = { path: "result.txt", content: "first" };
    const first = await write.execute("stable-call", params, testSignal);
    expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toBe("first");
    expect(store.getRun(run.id)?.checks[0].stale).toBe(true);
    await writeFile(path.join(workspace, "result.txt"), "tampered", "utf8");
    const replay = await write.execute("stable-call", params, testSignal);
    expect(replay).toEqual(first);
    expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toBe("tampered");
    expect(store.listOperations(run.id)[0]).toMatchObject({ status: "succeeded", effects: expect.arrayContaining([{ kind: "checks", action: "stale", count: 1 }]) });
    await expect(write.execute("stable-call", { path: "result.txt", content: "different" }, testSignal)).rejects.toThrow("different payload");
    store.close();
  });

  it("fences an identical Bash retry after the first failure", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-bash-guard-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "bash retry guard");
    const tools = createTestTools(store, run.id, workspace);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const firstId = "bash-first";
    await expect(bash.execute(firstId, { command: "false", timeoutSeconds: 2 }, testSignal)).rejects.toThrow("code 1");
    const next = store.recordToolAttempt(run.id, run.attempt, "bash-second", "bash", { command: "false", timeoutSeconds: 2 });
    expect(next.guard).toMatchObject({ blocked: true, reason: expect.stringContaining("already failed or timed out") });
    expect(store.listOperations(run.id)).toHaveLength(1);
    store.close();
  });

  it("reports Bash timeout distinctly and preserves retry guidance", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-bash-timeout-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "bash timeout");
    const bash = createTestTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    await expect(bash.execute("timeout", { command: "printf started; sleep 5", timeoutSeconds: 1 }, testSignal)).rejects.toThrow(/timed out after 1s.*do not rerun/s);
    expect(store.listEvents(run.id).some((event) => event.type === "tool.bash.timed_out" && event.data.timeoutSeconds === 1)).toBe(true);
    store.close();
  });

  it("blocks destructive bash commands", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "tools");
    const bash = createTestTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    await expect(bash.execute("1", { command: "rm -rf ." }, testSignal)).rejects.toThrow("blocked");
    store.close();
  });

  it("recognizes common destructive flag variants without matching quoted text", () => {
    for (const command of [
      "rm -r -f .",
      "rm --recursive --force .",
      "rm -fr .",
      "git clean -fdx",
      "git clean --force -d",
      "R=rm; $R -rf .",
      "command /bin/rm -rf .",
      "echo safe & (rm -rf .)",
    ]) expect(bashCommandIsDestructive(command), command).toBe(true);
    expect(bashCommandIsDestructive("echo 'rm -rf .'")).toBe(false);
  });

  it("publishes task updates and infers phases from plan, mutation, and checks", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "phase events");
    const events: string[] = [];
    const tools = createTestTools(store, run.id, workspace, (event) => events.push(`${event.type}:${event.data.phase}`));
    const taskRun = tools.find((tool) => tool.name === "task_run")!;
    const write = tools.find((tool) => tool.name === "write")!;
    const bash = tools.find((tool) => tool.name === "bash")!;
    await taskRun.execute("get", { action: "get" }, testSignal);
    expect(events).toEqual([]);
    const mutationResult = await taskRun.execute("plan", { action: "plan", key: "work", title: "Work", status: "pending" }, testSignal);
    const mutationText = mutationResult.content.find((item) => item.type === "text")?.text ?? "";
    expect(mutationText.length).toBeLessThan(1_000);
    expect(JSON.parse(mutationText)).toMatchObject({ ok: true, action: "plan", runId: run.id, phase: "plan", counts: { plan: 1 } });
    expect(mutationText).not.toContain('"contract"');
    expect(store.getRun(run.id)?.phase).toBe("plan");
    expect(events).toEqual(["run.updated:plan"]);
    await write.execute("write", { path: "result.txt", content: "done" }, testSignal);
    expect(store.getRun(run.id)?.phase).toBe("implement");
    await bash.execute("verify", { command: "printf verified", timeoutSeconds: 5 }, testSignal);
    await taskRun.execute("check", { action: "check", key: "test", title: "Test", status: "passed", command: "printf verified" }, testSignal);
    expect(store.getRun(run.id)?.phase).toBe("verify");
    expect(events.at(-1)).toBe("run.updated:verify");
    store.close();
  });
  it("batches independent task_run mutations into one compact receipt", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-batch-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "batch");
    const events: RunEvent[] = [];
    const tools = createTestTools(store, run.id, workspace, (event) => events.push(event));
    const taskRun = tools.find((tool) => tool.name === "task_run")!;
    const bash = tools.find((tool) => tool.name === "bash")!;
    await bash.execute("batch-verify", { command: "printf '12 passed'", timeoutSeconds: 5 }, testSignal);
    const result = await taskRun.execute("batch-1", { action: "batch", mutations: [
      { action: "plan", key: "implement", title: "Implement", status: "done", position: 1 },
      { action: "check", key: "tests", title: "Tests", status: "passed", command: "printf '12 passed'" },
      { action: "artifact", id: "report", title: "Report", uri: "artifact://report" },
      { action: "phase", phase: "review" },
    ] }, testSignal);
    expect(store.getRun(run.id)).toMatchObject({ phase: "review", plan: [{ key: "implement", status: "done" }], checks: [{ key: "tests", status: "passed", stale: false }], artifacts: [{ id: "report" }] });
    expect(events.filter((event) => event.type === "run.updated")).toHaveLength(1);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ ok: true, action: "batch", counts: { plan: 1, checks: 1, artifacts: 1 } });
    store.close();
  });

  it("preserves trusted checks for observation Bash commands and stales them for mutations", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-check-staleness-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "check staleness");
    const tools = createTestTools(store, run.id, workspace);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const taskRun = tools.find((tool) => tool.name === "task_run")!;
    await bash.execute("baseline", { command: "ls", timeoutSeconds: 5 }, testSignal);
    await taskRun.execute("baseline-check", { action: "check", key: "baseline", title: "Baseline", status: "passed", command: "ls" }, testSignal);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(false);

    await bash.execute("observe", { command: "echo 'git add file' | grep git", timeoutSeconds: 5 }, testSignal);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(false);
    expect(store.getOperation(`${run.id}:${run.attempt}:observe`)?.effects).toEqual(expect.arrayContaining([
      { kind: "workspace", action: "read_only" },
    ]));
    expect(bashInvalidatesChecks(`cd ${workspace} && npm run lint && npx vitest run tests/tools.test.ts`)).toBe(false);
    await bash.execute("mutate", { command: "touch changed.txt", timeoutSeconds: 5 }, testSignal);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(true);
    expect(store.getOperation(`${run.id}:${run.attempt}:mutate`)?.effects).toEqual(expect.arrayContaining([
      { kind: "workspace", action: "mutation" },
    ]));
    store.close();
  });

  it("classifies shell command positions and snapshot mutation flags", () => {
    for (const command of [
      'echo "git add file"',
      "ls | grep rm",
      "cat README.md | grep mv",
      "npm test",
      "npx vitest run",
      "python -m pytest",
    ]) expect(bashInvalidatesChecks(command), command).toBe(false);
    for (const command of [
      "git add file",
      "rm file",
      "mv a b",
      "npm test -- --updateSnapshot",
      "npx vitest --update",
      "python -m pytest --snapshot-update",
    ]) expect(bashInvalidatesChecks(command), command).toBe(true);
  });

  it("rolls back every task_run batch mutation when one mutation fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-batch-rollback-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "atomic batch");
    store.addArtifact(run.id, { id: "duplicate", title: "Existing", kind: "artifact", content: "", uri: "" });
    const taskRun = createTestTools(store, run.id, workspace).find((tool) => tool.name === "task_run")!;
    await expect(taskRun.execute("batch-fail", { action: "batch", mutations: [
      { action: "plan", key: "must-rollback", title: "Must rollback", status: "done" },
      { action: "artifact", id: "duplicate", title: "Duplicate" },
    ] }, testSignal)).rejects.toThrow();
    expect(store.getRun(run.id)?.plan).toEqual([]);
    expect(store.getRun(run.id)?.artifacts.map((artifact) => artifact.id)).toEqual(["duplicate"]);
    store.close();
  });

  it("exposes task_run as a top-level object schema and returns corrective action errors", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "schema");
    const taskRun = createTestTools(store, run.id, workspace).find((tool) => tool.name === "task_run")!;
    expect((taskRun.parameters as { type?: string }).type).toBe("object");
    expect(taskRun.parameters).not.toHaveProperty("anyOf");
    await expect(taskRun.execute("missing", { action: "artifact", title: "Result" }, testSignal)).rejects.toThrow('requires "id"');
    store.close();
  });

  it("does not expose the removed spawn proposal action", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "schema");
    const taskRun = createTestTools(store, run.id, workspace).find((tool) => tool.name === "task_run")!;
    expect(JSON.stringify(taskRun.parameters)).not.toContain("spawn_proposal");
    store.close();
  });

  it("searches only earlier same-Run durable history with fixed literal bounds", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-history-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "history search");
    store.appendTranscript(run.id, run.attempt, { role: "user", content: "Earlier receipt receipt:op_%_literal", timestamp: 1 });
    store.appendTranscript(run.id, run.attempt, { role: "user", content: "Second receipt receipt:op_%_literal", timestamp: 2 });
    store.appendTranscript(run.id, run.attempt, { role: "user", content: "Current query receipt:op_%_literal", timestamp: 3 });
    const history = createTestTools(store, run.id, workspace).find((tool) => tool.name === "history_search")!;
    expect(history.parameters).toMatchObject({ type: "object", properties: { query: expect.any(Object) } });
    expect(history.parameters).not.toHaveProperty("properties.runId");
    const result = await history.execute("history-call", { query: "receipt:op_%_literal" }, testSignal);
    const payload = JSON.parse((result.content[0] as { text: string }).text) as { beforeSeq: number; matches: Array<{ seq: number; snippet: string }>; truncated: boolean };
    expect(payload).toMatchObject({ beforeSeq: 3, truncated: false, matches: [{ seq: 2 }, { seq: 1 }] });
    expect(payload.matches.every((match) => match.snippet.length <= 322)).toBe(true);
    expect(store.db.prepare(`SELECT tool_call_id as toolCallId,tool_name as toolName,status
      FROM tool_attempts WHERE run_id=? AND tool_call_id=?`).get(run.id, "history-call")).toMatchObject({
      toolCallId: "history-call", toolName: "history_search", status: "succeeded",
    });

    const controller = new AbortController();
    controller.abort(new Error("history cancelled"));
    await expect(history.execute("history-aborted", { query: "receipt" }, controller.signal)).rejects.toMatchObject({ code: "ABORTED_BEFORE_DISPATCH" });
    store.close();
  });

});
