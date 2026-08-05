import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite/store";
import type { RunEvent, RunId } from "@tagent/execution/domain";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { createTools, listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile } from "@tagent/workspace-local";

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
    getRun: () => store.getRun(runId),
    advanceRunPhase: (phase) => store.advanceRunPhase(runId, phase),
    setRunPhase: (phase) => store.setRunPhase(runId, phase),
    claimOperation: (id, operationType, payload) =>
      store.claimOperation(id, runId, store.getRun(runId)!.attempt, operationType, payload),
    updateOperation: (id, update) => store.updateOperation(id, update),
    listOperations: () => store.listOperations(runId),
    upsertPlanItem: (item) => store.upsertPlanItem(runId, item),
    markChecksStale: () => store.markChecksStale(runId),
    upsertCheck: (check) => store.upsertCheck(runId, check),
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
    await expect(edit.execute("edit-link", { path: "file-link", oldText: "outside", newText: "inside" }, undefined)).rejects.toThrow(/Symbolic/);
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
    const edit = createTestTools(store, run.id, workspace).find((tool) => tool.name === "edit")!;
    const result = await edit.execute("append-call", { path: "notes.txt", oldText: "", newText: "three\n" }, undefined);
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
    expect(result.details).toMatchObject({ exitCode: 0, captureTruncated: true });
    expect((result.content[0] as { type: string; text: string }).text.length).toBeLessThanOrEqual(24_030);
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
    await taskRun.execute("check", { action: "check", key: "test", title: "Test", status: "passed", evidence: "ok" }, undefined);
    expect(store.getRun(run.id)?.phase).toBe("verify");
    expect(events.at(-1)).toBe("run.updated:verify");
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
