import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SessionInboxItem, type TaskRun, type TranscriptItem } from "../apps/web-console/src/api.js";
import {
  ApprovalDock,
  ConversationDateDivider,
  ExecutionTimeline,
  QueuePrompt,
  TAgentMark,
  UserInputCard,
  WorkspaceRunStatus,
  type RunApproval,
} from "../apps/web-console/src/AppPanels.js";
import { nextConversationPinState } from "../apps/web-console/src/conversation-scroll.js";
import { deriveCurrentOperation } from "../apps/web-console/src/current-operation.js";
import { createEventAcknowledger } from "../apps/web-console/src/event-acknowledger.js";
import { IntentPrefetchCache } from "../apps/web-console/src/intent-prefetch-cache.js";
import { canResumeRun, findActiveRun, isActiveRunStatus } from "../apps/web-console/src/run-state.js";
import { mergeTranscriptItems } from "../apps/web-console/src/transcript-projection.js";
import { createStreamingDeltaBatcher, type FrameScheduler } from "../apps/web-console/src/streaming-delta-batcher.js";
import { loadWorkspaceSnapshot } from "../apps/web-console/src/workspace-controller.js";
import { storedGateProfiles, storedStringLists, storedStringRecord } from "../apps/web-console/src/workspace-preferences.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-1",
    sessionId: "session-1",
    status: "running",
    phase: "implement",
    goal: "Ship the result",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    lastEventSeq: 0,
    transcriptCount: 0,
    resumable: false,
    launchRetryable: false,
    blockedReason: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    plan: [],
    checks: [],
    artifacts: [],
    continuations: [],
    checkpoint: null,
    contract: null,
    pendingUserInput: null,
    completionGate: { passed: false, failures: [] },
    supervision: {
      progress: null,
      latestDecision: null,
      latestGates: [],
      latestContextManifest: null,
      approvalRequests: [],
    },
    ...overrides,
  } as TaskRun;
}

describe("Web workbench behavior", () => {
  it("replaces a pending tool projection with its later completed result", () => {
    const pending = {
      seq: 1, index: 0, attempt: 1, kind: "tool", toolCallId: "call-1", toolName: "read",
      arguments: { path: "a.txt" }, result: "", isError: false, status: "pending", createdAt: 1,
    } satisfies TranscriptItem;
    const completed = {
      ...pending, seq: 2, result: "contents", status: "completed", createdAt: 2,
    } satisfies TranscriptItem;

    expect(mergeTranscriptItems([pending], [completed])).toEqual([completed]);
  });

  it("keeps non-tool transcript items ordered while deduplicating exact projections", () => {
    const assistant = { seq: 3, index: 0, attempt: 1, kind: "assistant", text: "done", createdAt: 3 } satisfies TranscriptItem;
    const user = { seq: 1, attempt: 1, kind: "user", text: "start", createdAt: 1 } satisfies TranscriptItem;
    expect(mergeTranscriptItems([assistant], [user, assistant])).toEqual([user, assistant]);
  });

  it("linearly merges an interleaved delta and keeps the last value for duplicate keys", () => {
    const first = { seq: 1, attempt: 1, kind: "user", text: "first", createdAt: 1 } satisfies TranscriptItem;
    const stale = { seq: 3, index: 0, attempt: 1, kind: "assistant", text: "stale", createdAt: 3 } satisfies TranscriptItem;
    const current = { ...stale, text: "current" } satisfies TranscriptItem;
    const middle = { seq: 2, index: 0, attempt: 1, kind: "assistant", text: "middle", createdAt: 2 } satisfies TranscriptItem;

    expect(mergeTranscriptItems([first, stale, current], [middle])).toEqual([first, middle, current]);
  });

  it("coalesces streaming token deltas into one update per animation frame", () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    const scheduler: FrameScheduler = {
      request(callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
      cancel(handle) { callbacks.delete(handle as number); },
    };
    const apply = vi.fn();
    const batcher = createStreamingDeltaBatcher(apply, scheduler);

    for (let index = 0; index < 100; index += 1) batcher.appendOutput("x");
    batcher.appendThinking("reasoning");
    expect(callbacks).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    callbacks.values().next().value!();
    expect(apply).toHaveBeenCalledWith("x".repeat(100), "reasoning");
  });

  it("flushes or discards a pending streaming frame deterministically", () => {
    const callbacks = new Map<number, () => void>();
    const scheduler: FrameScheduler = {
      request(callback) { callbacks.set(1, callback); return 1; },
      cancel(handle) { callbacks.delete(handle as number); },
    };
    const apply = vi.fn();
    const batcher = createStreamingDeltaBatcher(apply, scheduler);
    batcher.appendOutput("visible");
    batcher.flush();
    expect(apply).toHaveBeenLastCalledWith("visible", "");
    expect(callbacks).toHaveLength(0);
    batcher.appendOutput("stale");
    batcher.discard();
    expect(callbacks).toHaveLength(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("coalesces acknowledgements and flushes the highest cursor on time", () => {
    vi.useFakeTimers();
    const acknowledge = vi.fn();
    const cursor = createEventAcknowledger(acknowledge, 500);
    cursor.schedule(2);
    cursor.schedule(7);
    cursor.schedule(4);
    expect(acknowledge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(7);
  });

  it("flushes the final acknowledgement when a stream unmounts", () => {
    vi.useFakeTimers();
    const acknowledge = vi.fn();
    const cursor = createEventAcknowledger(acknowledge);
    cursor.schedule(9);
    cursor.close();
    vi.runAllTimers();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(9);
    cursor.schedule(10);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("classifies active and resumable Runs without bypassing pending approvals", () => {
    expect(["running", "waiting_input", "blocked"].every((status) =>
      isActiveRunStatus(status as TaskRun["status"]))).toBe(true);
    expect(isActiveRunStatus("interrupted")).toBe(false);
    expect(findActiveRun([
      run({ id: "done", status: "completed" }),
      run({ id: "blocked", status: "blocked" }),
    ])?.id).toBe("blocked");

    const interrupted = run({ status: "interrupted", resumable: true });
    expect(canResumeRun(interrupted, null)).toBe(true);
    expect(canResumeRun(run({
      resumable: true,
      supervision: { ...interrupted.supervision, approvalRequests: [{ status: "pending" } as RunApproval] },
    }), null)).toBe(false);
  });

  it("deduplicates intent prefetches, expires old values, and retries failures", async () => {
    let now = 0;
    const cache = new IntentPrefetchCache<string, string>(10, 2, () => now);
    const loader = vi.fn(async () => "workspace");
    const first = cache.load("one", loader);
    const second = cache.load("one", loader);
    expect(first).toBe(second);
    await expect(first).resolves.toBe("workspace");
    expect(cache.peek("one")).toBe("workspace");
    expect(loader).toHaveBeenCalledOnce();

    now = 11;
    expect(cache.peek("one")).toBeUndefined();
    const failure = vi.fn(async () => { throw new Error("offline"); });
    await expect(cache.load("two", failure)).rejects.toThrow("offline");
    await expect(cache.load("two", failure)).rejects.toThrow("offline");
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("loads an empty workspace snapshot without hydrating nonexistent Runs", async () => {
    vi.spyOn(api, "messages").mockResolvedValue([]);
    vi.spyOn(api, "runs").mockResolvedValue([]);
    vi.spyOn(api, "inbox").mockResolvedValue([]);
    const hydrate = vi.spyOn(api, "run");
    await expect(loadWorkspaceSnapshot("session-1")).resolves.toEqual({
      sessionId: "session-1", history: [], runHistory: [], queued: [], active: null, latest: null,
      transcript: [], transcriptAfter: 0,
    });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("validates persisted workspace preferences instead of trusting arbitrary JSON", () => {
    const values = new Map([
      ["strings", JSON.stringify({ valid: "value", invalid: 1 })],
      ["lists", JSON.stringify({ valid: ["one", "two"], invalid: [1] })],
      ["tagent.gate-profiles", JSON.stringify({ one: "strict", two: "unknown" })],
    ]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
    expect(storedStringRecord("strings")).toEqual({ valid: "value" });
    expect(storedStringLists("lists")).toEqual({ valid: ["one", "two"] });
    expect(storedGateProfiles()).toEqual({ one: "strict" });
  });

  it("keeps a reader unpinned after an upward scroll and repins at the live edge", () => {
    expect(nextConversationPinState({
      pinned: true, previousTop: 100, nextTop: 90, gap: 500,
      viewportResized: false, settling: false, programmatic: false,
    })).toBe(false);
    expect(nextConversationPinState({
      pinned: false, previousTop: 90, nextTop: 90, gap: 20,
      viewportResized: false, settling: false, programmatic: false,
    })).toBe(true);
  });

  it("derives running, waiting, stalled, and terminal operation states from durable timestamps", () => {
    const active = run({
      updatedAt: 1_000,
      checkpoint: {
        runId: "run-1", active: true, attempt: 1, assistantPartial: "", lastEventSeq: 1, lastTranscriptSeq: 0,
        currentTool: { toolCallId: "call", toolName: "bash", startedAt: 1_000, lastActivityAt: 1_000 },
        updatedAt: 1_000,
      },
    });
    expect(deriveCurrentOperation(active, 2_000)).toMatchObject({ state: "running", toolName: "bash" });
    expect(deriveCurrentOperation(active, 20_000).state).toBe("waiting");
    expect(deriveCurrentOperation(active, 122_000).state).toBe("stalled");
    expect(deriveCurrentOperation(run({ status: "completed", completedAt: 5 }), 10).state).toBe("completed");
  });

  it("renders workspace status and date orientation accessibly", () => {
    const idle = renderToStaticMarkup(<WorkspaceRunStatus session={{
      id: "session", title: "Workspace", modelId: "model", reasoningEffort: "high",
      createdAt: 1, updatedAt: 1, latestRunStatus: null, latestRunPhase: null,
    }} />);
    expect(idle).toContain("No tasks");
    const divider = renderToStaticMarkup(<ConversationDateDivider value={Date.UTC(2026, 7, 16)} />);
    expect(divider).toContain('role="separator"');
    expect(renderToStaticMarkup(<TAgentMark />)).toContain('aria-hidden="true"');
  });

  it("renders requested-input and approval checkpoints in the primary work area", () => {
    const input = renderToStaticMarkup(<UserInputCard
      request={{
        id: "input-1", runId: "run-1", prompt: "Choose target",
        fields: [{ key: "target", label: "Target", description: "Environment", inputType: "text", required: true, placeholder: "staging" }],
        attempt: 1, status: "pending", response: {}, requestedAt: 1, submittedAt: null,
      }}
      submitting={false}
      onSubmit={async () => undefined}
    />);
    expect(input).toContain("Information needed to continue");
    expect(input).toContain("Submit and resume");
    expect(input).toContain("Target *");
    expect(input).toContain('disabled=""');

    const approval = {
      id: "approval-1", status: "pending", actionType: "execute_external_action",
      reason: "Deploy release", metadata: {},
    } as RunApproval;
    const dock = renderToStaticMarkup(<ApprovalDock
      run={run({ supervision: { ...run().supervision, approvalRequests: [approval] } })}
      approvals={[approval]}
      resolvingId=""
      resolvingDecision=""
      onResolve={async () => undefined}
    />);
    expect(dock).toContain("External action needs your approval");
    expect(dock).toContain("Approve &amp; execute");
  });

  it("renders a live execution trace and queued prompt controls from state", () => {
    const tool = {
      seq: 2, index: 0, attempt: 1, kind: "tool", toolCallId: "call", toolName: "bash",
      arguments: { command: "npm test" }, result: "", isError: false, status: "pending", createdAt: 2,
    } satisfies TranscriptItem;
    const trace = renderToStaticMarkup(<ExecutionTimeline
      runId="run-1" isRunning items={[tool]} events={[]} liveThinking="" liveOutput=""
    />);
    expect(trace).toContain("Execution trace");
    expect(trace).toContain("npm test");
    expect(trace).toContain('aria-expanded="true"');

    const item = {
      id: "item-1", sessionId: "session-1", content: "Fix tests", status: "queued",
      decision: "pending", runId: null, position: 0, revision: 1, createdAt: 1, updatedAt: 1,
      analysis: {
        summary: "Fix tests", intent: "new_task", targetRunId: null, priority: 10,
        urgency: "normal", relation: "independent", acceptanceCriteria: ["Tests pass"],
        confidence: 1, reason: "ready",
      },
    } as SessionInboxItem;
    const queue = renderToStaticMarkup(<QueuePrompt
      item={item} index={0} editing={false} draft={item.content} busy={false} starting={false}
      dragging={false} canMoveUp={false} canMoveDown={false}
      onEdit={() => undefined} onDraftChange={() => undefined} onSave={() => undefined}
      onCancelEdit={() => undefined} onStart={() => undefined} onToggleDefer={() => undefined}
      onMergeFirst={() => undefined} onDelete={() => undefined} onMoveUp={() => undefined}
      onMoveDown={() => undefined} onDragStart={() => undefined} onDragEnd={() => undefined}
      onDrop={() => undefined}
    />);
    expect(queue).toContain("Run now");
    expect(queue).toContain("Defer");
    expect(queue).toContain("Move up");
    expect(queue).toContain("Acceptance criteria");
  });
});
