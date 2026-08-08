import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "@tagent/persistence-sqlite/store";
import type { ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { createTools, createWorkspaceArtifactSink, createWorkspaceEditPort, WorkspaceProjectContextSource } from "@tagent/workspace-local";

function applyTaskRunBatch(store: Store, runId: string, mutations: Parameters<ToolCapabilityApplicationPort["applyTaskRunBatch"]>[0]) {
  store.db.transaction(() => {
    for (const mutation of mutations) {
      if (mutation.action === "phase") store.setRunPhase(runId, mutation.phase);
      else if (mutation.action === "plan") store.upsertPlanItem(runId, mutation.item);
      else if (mutation.action === "check") store.upsertCheck(runId, mutation.check);
      else if (mutation.action === "mark_checks_stale") store.markChecksStale(runId);
      else store.addArtifact(runId, mutation.artifact);
    }
  })();
}

function tools(store: Store, runId: string, workspace: string) {
  const capabilities: ToolCapabilityApplicationPort = {
    runId,
    artifactSink: createWorkspaceArtifactSink(workspace),
    workspaceEdit: createWorkspaceEditPort(workspace),
    getRun: () => store.getRun(runId),
    authorizeWorkspaceMutation: () => ({ allowed: true, reason: "ordinary TaskRun" }),
    advanceRunPhase: (phase) => store.advanceRunPhase(runId, phase),
    setRunPhase: (phase) => store.setRunPhase(runId, phase),
    claimOperation: (id, operationType, payload) => store.claimOperation(id, runId, store.getRun(runId)!.attempt, operationType, payload),
    updateOperation: (id, update) => store.updateOperation(id, update),
    listOperations: (options) => store.listOperations(runId, options),
    upsertPlanItem: (item) => store.upsertPlanItem(runId, item),
    markChecksStale: () => store.markChecksStale(runId),
    upsertCheck: (check) => store.upsertCheck(runId, check),
    applyTaskRunBatch: (mutations) => applyTaskRunBatch(store, runId, mutations),
    addArtifact: (artifact) => store.addArtifact(runId, artifact),
    requestUserInput: (_toolCallId, prompt, fields) => store.requestUserInput(runId, prompt, fields),
    publish: (type, data) => store.appendEvent(runId, type, data),
  };
  return createTools(capabilities, workspace);
}

async function snapshot(read: ReturnType<typeof createTools>[number], file: string) {
  const result = await read.execute(`read-${file}`, { path: file }, undefined);
  return result.details as { snapshotId: string; contentHash: string };
}

describe("P0 reliable execution primitives", () => {
  it("rejects stale edits with a structured code and preserves the newer file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-p0-edit-"));
    await writeFile(path.join(workspace, "a.txt"), "one\ntwo\n");
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "edit");
    const created = tools(store, run.id, workspace); const read = created.find((tool) => tool.name === "read")!; const edit = created.find((tool) => tool.name === "edit")!;
    const original = await snapshot(read, "a.txt");
    await writeFile(path.join(workspace, "a.txt"), "newer\ntwo\n");
    await expect(edit.execute("stale", { path: "a.txt", ...original, oldText: "two", newText: "three" }, undefined)).rejects.toMatchObject({ code: "workspace.edit_stale" });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("newer\ntwo\n");
    expect(store.listEvents(run.id).at(-1)).toMatchObject({ type: "workspace.edit.rejected", data: { code: "workspace.edit_stale" } });
    store.close();
  });

  it("preflights all files before commit, avoids partial writes, and replays the durable operation", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-p0-patch-"));
    await writeFile(path.join(workspace, "a.txt"), "alpha\n"); await writeFile(path.join(workspace, "b.txt"), "beta\n");
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "patch");
    store.upsertCheck(run.id, { key: "tests", title: "Tests", status: "passed", required: true, command: "test", evidence: "old", stale: false });
    const created = tools(store, run.id, workspace); const read = created.find((tool) => tool.name === "read")!; const patch = created.find((tool) => tool.name === "patch")!;
    const a = await snapshot(read, "a.txt"); const b = await snapshot(read, "b.txt");
    await expect(patch.execute("bad", { patchId: "bad", files: [
      { path: "a.txt", ...a, hunks: [{ oldText: "alpha", newText: "changed" }] },
      { path: "b.txt", ...b, hunks: [{ oldText: "missing", newText: "changed" }] },
    ] }, undefined)).rejects.toMatchObject({ code: "workspace.edit_precondition_failed" });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("alpha\n");
    const result = await patch.execute("good", { patchId: "good", files: [
      { path: "a.txt", ...a, hunks: [{ oldText: "alpha", newText: "changed-a" }] },
      { path: "b.txt", ...b, hunks: [{ oldText: "beta", newText: "changed-b" }] },
    ] }, undefined);
    expect(store.getRun(run.id)?.checks[0].stale).toBe(true);
    await writeFile(path.join(workspace, "a.txt"), "external\n");
    expect(await patch.execute("good", { patchId: "good", files: [
      { path: "a.txt", ...a, hunks: [{ oldText: "alpha", newText: "changed-a" }] },
      { path: "b.txt", ...b, hunks: [{ oldText: "beta", newText: "changed-b" }] },
    ] }, undefined)).toEqual(result);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external\n");
    expect(store.listOperations(run.id).find((item) => item.id.endsWith(":good"))).toMatchObject({ operationType: "tool.patch", payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/), status: "succeeded" });
    store.close();
  });

  it("spills complete command output to a durable Artifact with bounded preview and zero discarded bytes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-p0-output-"));
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "output");
    const bash = tools(store, run.id, workspace).find((tool) => tool.name === "bash")!;
    const result = await bash.execute("large", { command: "python3 -c 'print(\"x\" * 1000000, end=\"\")'", timeoutSeconds: 10 }, undefined);
    expect(result.details).toMatchObject({ totalBytes: 1_000_000, storedBytes: 1_000_000, outputDiscardedBytes: 0, truncatedAtSource: false, artifactId: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((result.content[0] as { text: string }).text.length).toBeLessThan(25_000);
    const artifact = store.getRun(run.id)!.artifacts[0];
    expect((await readFile(path.join(workspace, artifact.uri))).length).toBe(1_000_000);
    expect(store.listEvents(run.id).some((event) => event.type === "tool.output.spilled" && event.data.outputDiscardedBytes === 0)).toBe(true);
    store.close();
  });

  it("reports the configured hard cap as source truncation instead of claiming completeness", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-p0-cap-"));
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "cap");
    const capabilities: ToolCapabilityApplicationPort = {
      runId: run.id, artifactSink: createWorkspaceArtifactSink(workspace, 64_000), workspaceEdit: createWorkspaceEditPort(workspace),
      getRun: () => store.getRun(run.id), authorizeWorkspaceMutation: () => ({ allowed: true, reason: "ordinary TaskRun" }), advanceRunPhase: (phase) => store.advanceRunPhase(run.id, phase), setRunPhase: (phase) => store.setRunPhase(run.id, phase),
      claimOperation: (id, operationType, payload) => store.claimOperation(id, run.id, store.getRun(run.id)!.attempt, operationType, payload), updateOperation: (id, update) => store.updateOperation(id, update), listOperations: (options) => store.listOperations(run.id, options),
      upsertPlanItem: (item) => store.upsertPlanItem(run.id, item), markChecksStale: () => store.markChecksStale(run.id), upsertCheck: (check) => store.upsertCheck(run.id, check), applyTaskRunBatch: (mutations) => applyTaskRunBatch(store, run.id, mutations), addArtifact: (artifact) => store.addArtifact(run.id, artifact), requestUserInput: (_id, prompt, fields) => store.requestUserInput(run.id, prompt, fields), publish: (type, data) => store.appendEvent(run.id, type, data),
    };
    const bash = createTools(capabilities, workspace).find((tool) => tool.name === "bash")!;
    const result = await bash.execute("capped", { command: "python3 -c 'print(\"z\" * 100000, end=\"\")'", timeoutSeconds: 10 }, undefined);
    expect(result.details).toMatchObject({ totalBytes: 100_000, storedBytes: 64_000, truncatedAtSource: true, outputDiscardedBytes: 36_000 });
    const artifact = store.getRun(run.id)!.artifacts[0];
    expect((await readFile(path.join(workspace, artifact.uri))).length).toBe(64_000);
    store.close();
  });

  it("discovers allowlisted project rules with hashes and rejects symlinked sources", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-p0-context-"));
    await writeFile(path.join(workspace, "AGENTS.md"), "# Rules\nRun tests.\n");
    const snapshot = new WorkspaceProjectContextSource(workspace).load();
    expect(snapshot.rules[0]).toMatchObject({ path: "AGENTS.md", selected: true, precedence: 0, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    await mkdir(path.join(workspace, "rules"));
    await expect(import("node:fs/promises").then(({ symlink }) => symlink("../AGENTS.md", path.join(workspace, "rules", "link.md")))).resolves.toBeUndefined();
    expect(() => new WorkspaceProjectContextSource(workspace, ["rules/link.md"]).load()).toThrow("non-symlink");
  });
});
