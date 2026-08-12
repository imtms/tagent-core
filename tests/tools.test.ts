import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite/store";
import type { RunEvent, RunId } from "@tagent/execution/domain";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { bashInvalidatesChecks, createTools, createWorkspaceArtifactSink, createWorkspaceEditPort, listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile } from "@tagent/workspace-local";

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
) {
  const capabilities: ToolCapabilityApplicationPort = {
    runId,
    artifactSink: createWorkspaceArtifactSink(workspace),
    workspaceEdit: createWorkspaceEditPort(workspace),
    getRun: () => store.getRun(runId),
    getRunExecutionState: () => store.getRunExecutionState(runId),
    authorizeWorkspaceMutation: () => ({ allowed: true, reason: "ordinary TaskRun" }),
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
    publish: (type, data) => {
      const event = store.appendEvent(runId, type, data);
      onEvent(event);
      return event;
    },
  };
  return createTools(capabilities, workspace);
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
    const result = await read.execute("1", { path: "hello.txt" }, undefined);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    const list = createTestTools(store, run.id, workspace).find((tool) => tool.name === "ls")!;
    expect((await list.execute("root", { path: "." }, undefined)).content[0]).toMatchObject({ type: "text", text: "hello.txt" });
    await expect(read.execute("2", { path: "../work-evil/secret.txt" }, undefined)).rejects.toThrow("escapes");
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
    await expect(read.execute("read-file-link", { path: "file-link" }, undefined)).rejects.toThrow(/Symbolic/);
    await expect(read.execute("read-dir-link", { path: "dir-link/secret.txt" }, undefined)).rejects.toThrow(/Symbolic/);
    await expect(read.execute("read-nested-link", { path: "nested/escape/secret.txt" }, undefined)).rejects.toThrow(/Symbolic/);
    await expect(list.execute("list-link", { path: "dir-link" }, undefined)).rejects.toThrow(/Symbolic/);
    await expect(write.execute("write-file-link", { path: "file-link", content: "changed" }, undefined)).rejects.toThrow(/Symbolic/);
    await expect(write.execute("write-dir-link", { path: "dir-link/new.txt", content: "changed" }, undefined)).rejects.toThrow(/Symbolic/);
    await expect(edit.execute("edit-link", { path: "file-link", snapshotId: "sha256:x", contentHash: "x", oldText: "outside", newText: "inside" }, undefined)).rejects.toThrow(/Symbolic/);
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
    const env = { ...process.env, TAGENT_FD_HELPER_READY: ready, TAGENT_FD_HELPER_RELEASE: release };

    const readPromise = readWorkspaceFile(workspace, "parent/inside.txt", { ...env, TAGENT_FD_HELPER_STAGE: "before_open" });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(outside, parent);
    await writeFile(release, "go");
    expect((await readPromise).buffer.toString()).toBe("inside");
    await rm(ready); await rm(release); await rm(parent); await rename(displaced, parent);

    const writePromise = writeWorkspaceFile(workspace, "parent/new.txt", "workspace-only", { ...env, TAGENT_FD_HELPER_STAGE: "after_parent_open" });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(outside, parent);
    await writeFile(release, "go");
    await writePromise;
    expect(await readFile(path.join(displaced, "new.txt"), "utf8")).toBe("workspace-only");
    await expect(readFile(path.join(outside, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(ready); await rm(release); await rm(parent); await rename(displaced, parent);

    const listPromise = listWorkspaceDirectory(workspace, "parent", { ...env, TAGENT_FD_HELPER_STAGE: "after_directory_open" });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(outside, parent);
    await writeFile(release, "go");
    expect((await listPromise).map((entry) => entry.name)).toContain("inside.txt");
    expect((await listWorkspaceDirectory(outside, ".")).map((entry) => entry.name)).toContain("inside.txt");
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
    expect((await list.execute("list", {}, undefined)).content[0]).toMatchObject({ type: "text", text: "binary.bin\nbom.txt" });
    expect((await read.execute("bom", { path: "bom.txt" }, undefined)).content[0]).toMatchObject({ type: "text", text: "hello" });
    expect((await read.execute("binary", { path: "binary.bin" }, undefined)).details).toMatchObject({ type: "binary", bytes: 3 });
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
    const snapshot = (await read.execute("append-read", { path: "notes.txt" }, undefined)).details as { snapshotId: string; contentHash: string };
    const result = await edit.execute("append-call", { path: "notes.txt", ...snapshot, oldText: "", newText: "three\n" }, undefined);
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
    const result = await bash.execute("large-output", { command: "yes x | head -c 400000", timeoutSeconds: 10 }, undefined);
    expect(result.details).toMatchObject({ exitCode: 0, captureTruncated: false, artifactId: expect.any(String), outputDiscardedBytes: 0 });
    const output = (result.content[0] as { type: string; text: string }).text;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(24_000);
    expect(output).toContain("trusted operation receipt");
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
    const first = await write.execute("stable-call", params, undefined);
    expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toBe("first");
    expect(store.getRun(run.id)?.checks[0].stale).toBe(true);
    await writeFile(path.join(workspace, "result.txt"), "tampered", "utf8");
    const replay = await write.execute("stable-call", params, undefined);
    expect(replay).toEqual(first);
    expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toBe("tampered");
    expect(store.listOperations(run.id)[0]).toMatchObject({ status: "succeeded", effects: [{ kind: "checks", action: "stale", count: 1 }] });
    await expect(write.execute("stable-call", { path: "result.txt", content: "different" }, undefined)).rejects.toThrow("different payload");
    store.close();
  });

  it("fences an identical Bash retry after the first failure", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-bash-guard-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "bash retry guard");
    const tools = createTestTools(store, run.id, workspace);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const firstId = "bash-first";
    store.recordToolAttempt(run.id, run.attempt, firstId, "bash", { command: "false", timeoutSeconds: 2 });
    await expect(bash.execute(firstId, { command: "false", timeoutSeconds: 2 }, undefined)).rejects.toThrow("code 1");
    store.completeToolAttempt(run.id, run.attempt, firstId, false, "failed");
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
    await expect(bash.execute("timeout", { command: "printf started; sleep 5", timeoutSeconds: 1 }, undefined)).rejects.toThrow(/timed out after 1s.*do not rerun/s);
    expect(store.listEvents(run.id).some((event) => event.type === "tool.bash.timed_out" && event.data.timeoutSeconds === 1)).toBe(true);
    store.close();
  });

  it("blocks destructive bash commands", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "tools");
    const bash = createTestTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    await expect(bash.execute("1", { command: "rm -rf ." }, undefined)).rejects.toThrow("blocked");
    store.close();
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
    await taskRun.execute("get", { action: "get" }, undefined);
    expect(events).toEqual([]);
    const mutationResult = await taskRun.execute("plan", { action: "plan", key: "work", title: "Work", status: "pending" }, undefined);
    const mutationText = mutationResult.content.find((item) => item.type === "text")?.text ?? "";
    expect(mutationText.length).toBeLessThan(1_000);
    expect(JSON.parse(mutationText)).toMatchObject({ ok: true, action: "plan", runId: run.id, phase: "plan", counts: { plan: 1 } });
    expect(mutationText).not.toContain('"contract"');
    expect(store.getRun(run.id)?.phase).toBe("plan");
    expect(events).toEqual(["run.updated:plan"]);
    await write.execute("write", { path: "result.txt", content: "done" }, undefined);
    expect(store.getRun(run.id)?.phase).toBe("implement");
    await bash.execute("verify", { command: "printf verified", timeoutSeconds: 5 }, undefined);
    await taskRun.execute("check", { action: "check", key: "test", title: "Test", status: "passed", command: "printf verified" }, undefined);
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
    await bash.execute("batch-verify", { command: "printf '12 passed'", timeoutSeconds: 5 }, undefined);
    const result = await taskRun.execute("batch-1", { action: "batch", mutations: [
      { action: "plan", key: "implement", title: "Implement", status: "done", position: 1 },
      { action: "check", key: "tests", title: "Tests", status: "passed", command: "printf '12 passed'" },
      { action: "artifact", id: "report", title: "Report", uri: "artifact://report" },
      { action: "phase", phase: "review" },
    ] }, undefined);
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
    await bash.execute("baseline", { command: "ls", timeoutSeconds: 5 }, undefined);
    await taskRun.execute("baseline-check", { action: "check", key: "baseline", title: "Baseline", status: "passed", command: "ls" }, undefined);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(false);

    await bash.execute("observe", { command: "ls", timeoutSeconds: 5 }, undefined);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(false);
    expect(bashInvalidatesChecks(`cd ${workspace} && npm run lint && npx vitest run tests/tools.test.ts`)).toBe(false);
    await bash.execute("mutate", { command: "touch changed.txt", timeoutSeconds: 5 }, undefined);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(true);
    store.close();
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
    ] }, undefined)).rejects.toThrow();
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
    await expect(taskRun.execute("missing", { action: "artifact", title: "Result" }, undefined)).rejects.toThrow('requires "id"');
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

});
