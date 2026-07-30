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
});
