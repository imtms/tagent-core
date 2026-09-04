import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite/store";
import type { RunEvent, RunId } from "@tagent/execution/domain";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { bashCommandEffect, bashCommandIsDestructive, bashCommandTargetsHostingCore, bashInvalidatesChecks, bashRequiresExplicitApproval, composeWorkspaceTools, createLocalSubprocessPort, createWorkspaceArtifactSink, createWorkspaceEditPort, listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile } from "@tagent/workspace-local";

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
    inspectExternalActionAuthorization: () => ({ allowed: true, reason: "ordinary TaskRun" }),
    activateExternalActionAuthorization: () => ({ allowed: true, reason: "ordinary TaskRun" }),
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
      search: async (query, searchOptions, signal) => {
        signal.throwIfAborted();
        const currentSeq = store.getLastTranscriptSeq(runId);
        const beforeSeq = searchOptions.beforeSeq === undefined ? currentSeq : Math.min(currentSeq, searchOptions.beforeSeq);
        const options = { ...searchOptions, beforeSeq, limit: 8, snippetChars: 320 };
        const result = searchOptions.mode === "terms"
          ? store.searchTranscriptTerms(runId, query, options)
          : store.searchTranscriptLiteral(runId, query, options);
        signal.throwIfAborted();
        return { ...result, beforeSeq, nextBeforeSeq: result.truncated ? result.matches.at(-1)?.seq ?? null : null };
      },
      get: async (seq, signal) => {
        signal.throwIfAborted();
        const currentSeq = store.getLastTranscriptSeq(runId);
        if (seq >= currentSeq) return undefined;
        const entry = store.listTranscriptEntries(runId, { after: seq - 1, limit: 1 })[0];
        return entry?.seq === seq ? entry : undefined;
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

  it("uses raw BOM-bearing bytes for snapshot-bound replacement and edit", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-bom-snapshot-"));
    const original = Buffer.from("\uFEFFhello", "utf8");
    await writeFile(path.join(workspace, "bom.txt"), original);
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "edit BOM text");
    const tools = createTestTools(store, run.id, workspace);
    const read = tools.find((tool) => tool.name === "read")!;
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;

    const first = await read.execute("bom-replace-read", { path: "bom.txt" }, testSignal);
    expect(first.details).toMatchObject({ contentHash: createHash("sha256").update(original).digest("hex") });
    await write.execute("bom-replace", { path: "bom.txt", content: "replaced", ...(first.details as object) }, testSignal);
    expect(await readFile(path.join(workspace, "bom.txt"), "utf8")).toBe("replaced");

    await writeFile(path.join(workspace, "bom.txt"), original);
    const second = await read.execute("bom-edit-read", { path: "bom.txt" }, testSignal);
    await edit.execute("bom-edit", { path: "bom.txt", ...(second.details as object), oldText: "hello", newText: "updated" }, testSignal);
    expect(await readFile(path.join(workspace, "bom.txt"), "utf8")).toBe("updated");
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

  it("requires a current snapshot before replacing an existing file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-write-snapshot-"));
    await writeFile(path.join(workspace, "existing.txt"), "original", "utf8");
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "snapshot-bound replace");
    const tools = createTestTools(store, run.id, workspace);
    const read = tools.find((tool) => tool.name === "read")!;
    const write = tools.find((tool) => tool.name === "write")!;
    await expect(write.execute("blind-replace", { path: "existing.txt", content: "unsafe" }, testSignal)).rejects.toThrow("already exists");
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe("original");

    const snapshot = await read.execute("read-snapshot", { path: "existing.txt" }, testSignal);
    const details = snapshot.details as { snapshotId: string; contentHash: string };
    await write.execute("snapshot-replace", { path: "existing.txt", content: "replaced", ...details }, testSignal);
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe("replaced");

    await expect(write.execute("stale-replace", { path: "existing.txt", content: "stale", ...details }, testSignal)).rejects.toThrow("stale");
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe("replaced");
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

  it("recognizes hosting Core lifecycle commands without matching benign data", () => {
    for (const command of [
      "systemctl restart tagent-core.service",
      "sudo systemctl stop tagent-core",
      "sudo -n /bin/systemctl try-restart tagent-core.service",
      "env systemctl reload-or-restart tagent-core.service",
      "service tagent-core restart",
      "sudo service tagent-core stop",
      "/etc/init.d/tagent-core restart",
      "bash -lc 'systemctl restart tagent-core.service'",
      "sudo -u root sh -c 'service tagent-core restart'",
      "echo \"$(systemctl restart tagent-core.service)\"",
    ]) expect(bashCommandTargetsHostingCore(command), command).toBe(true);
    for (const command of [
      "echo 'systemctl restart tagent-core.service'",
      "printf '%s' 'service tagent-core restart'",
      "systemctl status tagent-core.service",
      "systemctl start tagent-core.service",
      "systemctl restart tagent-worker.service",
      "systemctl --host remote restart tagent-core.service",
      "systemctl -M container restart tagent-core.service",
      "systemctl --user restart tagent-core.service",
      "systemctl --root=/mnt restart tagent-core.service",
      "service tagent-core status",
      "./fixtures/init.d/tagent-core restart",
      "bash -lc 'echo systemctl restart tagent-core.service'",
    ]) expect(bashCommandTargetsHostingCore(command), command).toBe(false);
  });

  it("blocks hosting Core lifecycle commands with durable handoff guidance", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-core-lifecycle-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "restart Core safely");
    const bash = createTestTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    for (const [index, command] of [
      "systemctl restart tagent-core.service",
      "sudo systemctl stop tagent-core.service",
      "service tagent-core restart",
      "bash -lc 'systemctl restart tagent-core.service'",
    ].entries()) {
      await expect(bash.execute(`core-lifecycle-${index}`, { command }, testSignal))
        .rejects.toThrow(/core_generation_activate/);
    }
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM tool_attempts").get()).toEqual({ count: 0 });
    expect(store.listOperations(run.id)).toEqual([]);
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
    await taskRun.execute("get", { action: "get" }, testSignal);
    expect(events).toEqual([]);
    const mutationResult = await taskRun.execute("plan", { action: "plan", key: "work", title: "Work", status: "pending" }, testSignal);
    const mutationText = mutationResult.content.find((item) => item.type === "text")?.text ?? "";
    expect(mutationText.length).toBeLessThan(1_000);
    expect(JSON.parse(mutationText)).toMatchObject({ ok: true, action: "plan", runId: run.id, phase: "plan", counts: { plan: 1 } });
    expect(mutationText).not.toContain('"contract"');
    expect(store.getRun(run.id)).toMatchObject({ phase: "plan", plan: [{ schemaVersion: 2, objectiveIds: [], criterionIds: [], dependencies: [], createdAttempt: 1, updatedAttempt: 1 }] });
    expect(events).toEqual(["run.updated:plan"]);
    await write.execute("write", { path: "result.txt", content: "done" }, testSignal);
    expect(store.getRun(run.id)?.phase).toBe("implement");
    await bash.execute("verify", { command: "printf verified", timeoutSeconds: 5 }, testSignal);
    await taskRun.execute("check", { action: "check", key: "test", title: "Test", status: "passed", command: "printf verified" }, testSignal);
    expect(store.getRun(run.id)?.phase).toBe("verify");
    expect(events.at(-1)).toBe("run.updated:verify");
    store.close();
  });

  it("does not require Run-local criterion IDs for legacy Roadmap Goal criteria", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-roadmap-plan-"));
    const store = new Store(":memory:");
    const goalPrompt = "[Workspace Goal criterion stored] Durable state is stored";
    const run = store.createRun(store.createSession().id, "persist roadmap item", "legacy-roadmap-plan", {
      sourceInput: "persist roadmap item",
      summary: "persist roadmap item",
      objectives: [{ id: "roadmap-persist", summary: "Persist", timing: "current", kind: "change" }],
      acceptanceCriteria: [goalPrompt],
      scope: "Persist",
      nonGoals: [],
      sourceInboxIds: [],
      parentRunId: null,
      relation: "independent",
      intent: "new_task",
      decisionReason: "legacy immutable Roadmap contract",
      routerVersion: "workspace-goal-roadmap-v1",
      workspaceGoal: {
        goalId: "goal-1", mode: "roadmap", definitionRevisionId: "definition-1", definitionRevision: 1,
        definitionHash: "a".repeat(64), title: "Goal", outcome: "Stored", scope: [], nonGoals: [],
        criteria: [{ key: "stored", title: "Durable state is stored", required: true }],
        roadmapRevisionId: "roadmap-1", roadmapRevision: 1, roadmapHash: "b".repeat(64),
        approvedRoadmapItemIds: ["persist"], targetRoadmapItemIds: ["persist"],
        roadmapItems: [{ id: "persist", title: "Persist", outcome: "Stored", verification: "Run tests", criterionKeys: ["stored"] }],
        targetCriterionKeys: ["stored"], criterionPrompts: [{ key: "stored", prompt: goalPrompt }], attachedAt: Date.now(),
      },
    });
    const taskRun = createTestTools(store, run.id, workspace).find((tool) => tool.name === "task_run")!;
    await expect(taskRun.execute("roadmap-plan", {
      action: "plan", key: "persist", title: "Persist", status: "done", objectiveIds: ["roadmap-persist"],
    }, testSignal)).resolves.toBeDefined();
    expect(store.getRun(run.id)?.plan).toMatchObject([{ criterionIds: [] }]);
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
    expect(bashInvalidatesChecks(`cd ${workspace} && npm run lint && npx vitest run tests/tools.test.ts`)).toBe(true);
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
      "sed -n '1,20p' README.md",
    ]) expect(bashInvalidatesChecks(command), command).toBe(false);
    for (const command of [
      "git add file",
      "rm file",
      "mv a b",
      "npm test",
      "npx vitest run",
      "python -m pytest",
      "npm test -- --updateSnapshot",
      "npx vitest --update",
      "python -m pytest --snapshot-update",
    ]) expect(bashInvalidatesChecks(command), command).toBe(true);
  });

  it("requires explicit approval unless Bash is a proven workspace-relative observation", () => {
    for (const command of [
      "rg Router .",
      "rg --files .",
      "find . -maxdepth 1 -type f",
      "ls -la .",
      "printf ready; pwd",
    ]) expect(bashRequiresExplicitApproval(command), command).toBe(false);
    for (const command of [
      "curl -X POST https://example.com/deploy",
      "git status --short",
      "cat README.md",
      "sed -n '1,20p' README.md",
      "cd; pwd",
      "cd linked-directory; rg needle .",
      "rg --follow needle .",
      "rg -L needle .",
      "rg needle linked-file",
      "rg --files linked-directory",
      "find linked-directory -type f",
      "find -L . -type f",
      "ls linked-directory",
      "ls -L .",
      "cat /etc/passwd",
      "rg secret ../outside",
      "touch changed.txt",
      "printf changed > result.txt",
      "cat </etc/passwd",
      "cat < ../outside",
      "cat <<< secret",
      "ps aux",
      "cat $HOME/.config/token",
      "npm test -- --run",
    ]) expect(bashRequiresExplicitApproval(command), command).toBe(true);
  });

  it("fails executable observation options and workspace-code verification out of the read-only class", () => {
    const executableOptions = [
      "sed -n '1e touch escaped.txt' README.md",
      "sed -n -e '1w escaped.txt' README.md",
      "sed -n -f scripts/observe.sed README.md",
      "rg --pre 'touch escaped.txt' needle .",
      "rg --pre=./preprocessor needle .",
      "git diff --ext-diff",
      "git show --textconv HEAD:file.txt",
      "git log --output=escaped.txt -1",
      "find . -fprint escaped.txt",
      "cat < README.md",
      "GIT_EXTERNAL_DIFF=./escape git diff",
    ];
    for (const command of executableOptions) {
      expect(bashCommandEffect(command), command).toBe("mutation_or_external");
      expect(bashInvalidatesChecks(command), command).toBe(true);
      expect(bashRequiresExplicitApproval(command), command).toBe(true);
    }
    for (const command of [
      "npm test", "pnpm run lint", "yarn typecheck", "npx vitest run",
      "python -m pytest", "go test ./...", "cargo clippy", "eslint src",
    ]) {
      expect(bashCommandEffect(command), command).toBe("code_execution");
      expect(bashInvalidatesChecks(command), command).toBe(true);
      expect(bashRequiresExplicitApproval(command), command).toBe(true);
    }
    for (const command of ["rg needle src", "git diff --no-ext-diff --no-textconv", "sed -n '1,20p' README.md"]) {
      expect(bashCommandEffect(command), command).toBe("read_only");
    }
  });

  it("requires Attempt approval and records workspace verification as code execution", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-code-effect-"));
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "printf verified" } }), "utf8");
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "execute workspace verification");
    const denied = createTestTools(store, run.id, workspace, undefined, {
      inspectExternalActionAuthorization: () => ({ allowed: false, reason: "operator approval required" }),
    }).find((tool) => tool.name === "bash")!;
    await expect(denied.execute("denied-test", { command: "npm test", timeoutSeconds: 5 }, testSignal))
      .rejects.toThrow(/External action approval guard/);
    expect(store.listOperations(run.id)).toEqual([]);

    const bash = createTestTools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    await bash.execute("approved-test", { command: "npm test", timeoutSeconds: 5 }, testSignal);
    expect(store.getOperation(`${run.id}:${run.attempt}:approved-test`)?.effects).toEqual(expect.arrayContaining([
      { kind: "workspace", action: "code_execution" },
    ]));
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

  it("pages and retrieves only earlier same-Run durable history with fixed literal bounds", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-tools-history-"));
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "history search");
    for (let index = 1; index <= 10; index += 1) {
      store.appendTranscript(run.id, run.attempt, {
        role: "user",
        content: `Earlier receipt ${index} receipt:op_%_literal`,
        timestamp: index,
      });
    }
    store.appendTranscript(run.id, run.attempt, { role: "user", content: "Current query receipt:op_%_literal", timestamp: 11 });
    const history = createTestTools(store, run.id, workspace).find((tool) => tool.name === "history_search")!;
    expect(history.parameters).toMatchObject({
      type: "object",
      properties: {
        action: expect.any(Object),
        mode: expect.any(Object),
        query: expect.any(Object),
        beforeSeq: expect.any(Object),
        seq: expect.any(Object),
        attempt: expect.any(Object),
        role: expect.any(Object),
        kind: expect.any(Object),
      },
    });
    expect(history.parameters).not.toHaveProperty("properties.runId");
    const firstResult = await history.execute("history-call", { query: "receipt:op_%_literal" }, testSignal);
    const first = JSON.parse((firstResult.content[0] as { text: string }).text) as {
      beforeSeq: number;
      nextBeforeSeq: number | null;
      matches: Array<{ seq: number; snippet: string }>;
      truncated: boolean;
    };
    expect(first).toMatchObject({
      action: "search",
      beforeSeq: 11,
      nextBeforeSeq: 3,
      truncated: true,
      matches: [{ seq: 10 }, { seq: 9 }, { seq: 8 }, { seq: 7 }, { seq: 6 }, { seq: 5 }, { seq: 4 }, { seq: 3 }],
    });
    expect(first.matches.every((match) => match.snippet.length <= 322)).toBe(true);

    const secondResult = await history.execute("history-page-2", {
      query: "receipt:op_%_literal",
      beforeSeq: first.nextBeforeSeq!,
    }, testSignal);
    const second = JSON.parse((secondResult.content[0] as { text: string }).text) as {
      beforeSeq: number;
      nextBeforeSeq: number | null;
      matches: Array<{ seq: number }>;
      truncated: boolean;
    };
    expect(second).toMatchObject({
      beforeSeq: 3,
      nextBeforeSeq: null,
      truncated: false,
      matches: [{ seq: 2 }, { seq: 1 }],
    });
    expect(new Set([...first.matches, ...second.matches].map((match) => match.seq)).size).toBe(10);

    const termsResult = await history.execute("history-terms", {
      mode: "terms", query: "Earlier literal", attempt: 1, role: "user",
    }, testSignal);
    const terms = JSON.parse((termsResult.content[0] as { text: string }).text) as {
      semantics: string; matches: Array<{ seq: number; role: string }>;
    };
    expect(terms.semantics).toBe("unicode terms (all terms)");
    expect(terms.matches).toHaveLength(8);
    expect(terms.matches.every((match) => match.role === "user" && match.seq < 11)).toBe(true);

    const exactResult = await history.execute("history-get", { action: "get", seq: 1 }, testSignal);
    const exact = JSON.parse((exactResult.content[0] as { text: string }).text) as {
      action: string;
      exactSeq: number;
      entry: { seq: number; message: { role: string; content: string } };
    };
    expect(exact).toMatchObject({
      action: "get",
      exactSeq: 1,
      entry: { seq: 1, message: { role: "user", content: "Earlier receipt 1 receipt:op_%_literal" } },
    });
    await expect(history.execute("history-get-current", { action: "get", seq: 11 }, testSignal)).rejects.toThrow("unavailable");
    await expect(history.execute("history-get-future", { action: "get", seq: 99 }, testSignal)).rejects.toThrow("unavailable");
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
