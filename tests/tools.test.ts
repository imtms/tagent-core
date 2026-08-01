import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { createTools } from "../src/tools/tools.js";

describe("workspace tools", () => {
  it("reads workspace files and rejects path escape", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    await writeFile(path.join(workspace, "hello.txt"), "hello\nworld", "utf8");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "tools");
    const read = createTools(store, run.id, workspace).find((tool) => tool.name === "read")!;
    const result = await read.execute("1", { path: "hello.txt" }, undefined);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    await expect(read.execute("2", { path: "../secret" }, undefined)).rejects.toThrow("escapes");
    store.close();
  });

  it("lists directories, strips UTF-8 BOM, and returns binary metadata", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    await writeFile(path.join(workspace, "bom.txt"), "\uFEFFhello", "utf8");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "inspect tools");
    const tools = createTools(store, run.id, workspace);
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
    const edit = createTools(store, run.id, workspace).find((tool) => tool.name === "edit")!;
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
    const bash = createTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
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
    const write = createTools(store, run.id, workspace).find((tool) => tool.name === "write")!;
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
    const bash = createTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    await expect(bash.execute("1", { command: "rm -rf ." }, undefined)).rejects.toThrow("blocked");
    store.close();
  });

  it("publishes task updates and infers phases from plan, mutation, and checks", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "phase events");
    const events: string[] = [];
    const tools = createTools(store, run.id, workspace, (event) => events.push(`${event.type}:${event.data.phase}`));
    const taskRun = tools.find((tool) => tool.name === "task_run")!;
    const write = tools.find((tool) => tool.name === "write")!;
    await taskRun.execute("get", { action: "get" }, undefined);
    expect(events).toEqual([]);
    await taskRun.execute("plan", { action: "plan", key: "work", title: "Work", status: "pending" }, undefined);
    expect(store.getRun(run.id)?.phase).toBe("plan");
    expect(events).toEqual(["run.updated:plan"]);
    await write.execute("write", { path: "result.txt", content: "done" }, undefined);
    expect(store.getRun(run.id)?.phase).toBe("implement");
    await taskRun.execute("check", { action: "check", key: "test", title: "Test", status: "passed", evidence: "ok" }, undefined);
    expect(store.getRun(run.id)?.phase).toBe("verify");
    expect(events.at(-1)).toBe("run.updated:verify");
    store.close();
  });
  it("lets the agent propose a derived TaskRun without launching it", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-"));
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "discover follow-up");
    const taskRun = createTools(store, run.id, workspace).find((tool) => tool.name === "task_run")!;
    await taskRun.execute("spawn", { action: "spawn_proposal", goal: "Deploy the verified build", acceptanceCriteria: ["Health check passes"], relation: "follow_up" }, undefined);
    expect(store.listSpawnProposals(run.id)).toEqual([expect.objectContaining({ goal: "Deploy the verified build", status: "proposed", relation: "follow_up" })]);
    expect(store.listRuns(session.id)).toHaveLength(1);
    store.close();
  });

});
