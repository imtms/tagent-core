import type { RunEvent, RunId } from "../domain/task-run.js";
import type { ExecutionStateView } from "./execution-state.js";

type RunEventState = ExecutionStateView<
  | "checkpointDrafts" | "checkpointTimers" | "checkpointTokens" | "closing"
  | "lastCheckpointTranscriptSeq" | "listeners" | "persistence",
  "events" | "runtimeMutations" | "transcript"
>;

export class RunEventHub {
  constructor(private readonly state: RunEventState) {}


  public updateCheckpoint(event: RunEvent) {
    const draft = this.state.checkpointDrafts.get(event.runId);
    if (!draft) return;
    const relevant = event.type.startsWith("message.") || event.type.startsWith("tool.") || event.type === "provider.failure";
    if (!relevant) return;
    draft.lastEventSeq = Math.max(draft.lastEventSeq, event.seq);
    if (event.type === "message.started") draft.assistantPartial = "";
    if (event.type === "message.delta") draft.assistantPartial += String(event.data.delta ?? "");
    if (event.type === "message.retrying") draft.assistantPartial = "";
    if (event.type === "tool.started") draft.currentTool = {
      toolCallId: String(event.data.toolCallId ?? ""),
      toolName: String(event.data.toolName ?? "tool"),
      startedAt: event.createdAt,
      lastActivityAt: event.createdAt,
    };
    if (event.type === "tool.progress" && draft.currentTool?.toolCallId === String(event.data.toolCallId ?? "")) {
      draft.currentTool.lastActivityAt = event.createdAt;
    }
    if (event.type === "provider.failure" && draft.currentTool) draft.currentTool.lastActivityAt = event.createdAt;
    if ((event.type === "tool.completed" || event.type === "tool.failed") && draft.currentTool?.toolCallId === String(event.data.toolCallId ?? "")) draft.currentTool = null;
    const transcriptBoundary = event.type === "tool.completed" || event.type === "tool.failed" || event.type === "message.completed";
    if (transcriptBoundary) this.state.lastCheckpointTranscriptSeq.set(event.runId, this.state.persistence.transcript.getLastTranscriptSeq(event.runId));
    // Streaming text remains recoverable through the debounced checkpoint. Persist
    // immediately only at tool/transcript boundaries where durable replay semantics change.
    const immediate = event.type === "tool.started" || transcriptBoundary;
    if (immediate) this.flushCheckpoint(event.runId);
    else this.scheduleCheckpoint(event.runId);
  }

  public scheduleCheckpoint(runId: RunId) {
    if (this.state.checkpointTimers.has(runId) || this.state.closing) return;
    const timer = setTimeout(() => {
      this.state.checkpointTimers.delete(runId);
      try {
        this.flushCheckpoint(runId);
      } catch {
        // A terminal transition or newer Attempt invalidates the token. The
        // fenced repository guarantees that the stale draft was not written.
      }
    }, 500);
    timer.unref?.();
    this.state.checkpointTimers.set(runId, timer);
  }

  public flushCheckpoint(runId: RunId) {
    const draft = this.state.checkpointDrafts.get(runId);
    const token = this.state.checkpointTokens.get(runId);
    if (!draft || !token) return;
    const timer = this.state.checkpointTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.state.checkpointTimers.delete(runId);
    const lastTranscriptSeq = this.state.lastCheckpointTranscriptSeq.get(runId) ?? this.state.persistence.transcript.getLastTranscriptSeq(runId);
    this.state.lastCheckpointTranscriptSeq.set(runId, lastTranscriptSeq);
    const { runId: _runId, attempt: _attempt, ...checkpoint } = draft;
    this.state.persistence.runtimeMutations.upsertCheckpoint({
      attemptId: token.attemptId,
      expectedVersion: token.expectedVersion,
      leaseToken: token.leaseToken,
      fence: token.executionFence,
    }, { ...checkpoint, lastTranscriptSeq });
  }

  subscribe(runId: RunId, listener: (event: RunEvent) => void) {
    let listeners = this.state.listeners.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.state.listeners.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.state.listeners.delete(runId);
    };
  }

  replay(runId: RunId, after = 0) {
    return this.state.persistence.events.listEvents(runId, after);
  }

  public publish(event: RunEvent) {
    for (const listener of this.state.listeners.get(event.runId) ?? []) listener(event);
  }
}
