import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RunEvent, TaskRun, TaskRunSummary, TranscriptItem } from "./api";
import { createStreamingDeltaBatcher } from "./streaming-delta-batcher";
import type { WorkspaceSnapshot } from "./workspace-controller";

export interface RunViewState {
  activeRun: TaskRun | null;
  selectedRun: TaskRun | null;
  runs: TaskRunSummary[];
  expandedRunId: string;
  events: RunEvent[];
  transcript: TranscriptItem[];
  streaming: string;
  liveThinking: string;
}

const initialRunViewState: RunViewState = {
  activeRun: null,
  selectedRun: null,
  runs: [],
  expandedRunId: "",
  events: [],
  transcript: [],
  streaming: "",
  liveThinking: "",
};

function resolveStateAction<Value>(action: SetStateAction<Value>, current: Value): Value {
  return typeof action === "function" ? (action as (value: Value) => Value)(current) : action;
}

export function runViewFromWorkspaceSnapshot(snapshot: WorkspaceSnapshot): RunViewState {
  const checkpoint = snapshot.active?.checkpoint;
  return {
    activeRun: snapshot.active,
    selectedRun: snapshot.latest,
    runs: snapshot.runHistory,
    expandedRunId: snapshot.latest?.id ?? "",
    events: checkpoint?.active && checkpoint.currentTool ? [{
      runId: snapshot.active!.id,
      seq: checkpoint.lastEventSeq,
      type: "tool.started",
      data: checkpoint.currentTool,
      createdAt: checkpoint.updatedAt,
    }] : [],
    transcript: snapshot.transcript,
    streaming: checkpoint?.active ? checkpoint.assistantPartial : "",
    liveThinking: "",
  };
}

export function runViewForStartedRun(current: RunViewState, run: TaskRun): RunViewState {
  return {
    ...current,
    activeRun: run,
    selectedRun: run,
    runs: [run, ...current.runs.filter((item) => item.id !== run.id)],
    expandedRunId: run.id,
    events: [],
    transcript: [],
    streaming: "",
    liveThinking: "",
  };
}

export function useRunViewState() {
  const [state, setState] = useState<RunViewState>(initialRunViewState);
  const activeRunIdRef = useRef("");
  const activeRunRef = useRef<TaskRun | null>(null);
  const replaceStreamingOnNextDeltaRef = useRef(false);
  const transcriptRunIdRef = useRef("");
  const transcriptAfterRef = useRef(0);
  const transcriptRefreshTaskRef = useRef<Promise<void>>(Promise.resolve());

  const setField = useCallback(<Key extends keyof RunViewState>(key: Key, action: SetStateAction<RunViewState[Key]>) => {
    setState((current) => ({ ...current, [key]: resolveStateAction(action, current[key]) }));
  }, []);
  const setActiveRun = useCallback<Dispatch<SetStateAction<TaskRun | null>>>((action) => setField("activeRun", action), [setField]);
  const setSelectedRun = useCallback<Dispatch<SetStateAction<TaskRun | null>>>((action) => setField("selectedRun", action), [setField]);
  const setRuns = useCallback<Dispatch<SetStateAction<TaskRunSummary[]>>>((action) => setField("runs", action), [setField]);
  const setExpandedRunId = useCallback<Dispatch<SetStateAction<string>>>((action) => setField("expandedRunId", action), [setField]);
  const setEvents = useCallback<Dispatch<SetStateAction<RunEvent[]>>>((action) => setField("events", action), [setField]);
  const setTranscript = useCallback<Dispatch<SetStateAction<TranscriptItem[]>>>((action) => setField("transcript", action), [setField]);
  const setStreaming = useCallback<Dispatch<SetStateAction<string>>>((action) => setField("streaming", action), [setField]);
  const setLiveThinking = useCallback<Dispatch<SetStateAction<string>>>((action) => setField("liveThinking", action), [setField]);
  const [streamingDeltaBatcher] = useState(() => createStreamingDeltaBatcher((outputDelta, thinkingDelta) => {
    if (outputDelta) setStreaming((current) => current + outputDelta);
    if (thinkingDelta) setLiveThinking((current) => current + thinkingDelta);
  }));

  useEffect(() => {
    activeRunIdRef.current = state.activeRun?.id ?? "";
    activeRunRef.current = state.activeRun;
  }, [state.activeRun]);

  const applyWorkspaceSnapshot = useCallback((snapshot: WorkspaceSnapshot) => {
    streamingDeltaBatcher.discard();
    replaceStreamingOnNextDeltaRef.current = false;
    transcriptRunIdRef.current = snapshot.latest?.id ?? "";
    transcriptAfterRef.current = snapshot.transcriptAfter;
    setState(runViewFromWorkspaceSnapshot(snapshot));
  }, [streamingDeltaBatcher]);

  const resetWorkspace = useCallback(() => {
    streamingDeltaBatcher.discard();
    replaceStreamingOnNextDeltaRef.current = false;
    transcriptRunIdRef.current = "";
    transcriptAfterRef.current = 0;
    setState(initialRunViewState);
  }, [streamingDeltaBatcher]);

  const startRun = useCallback((run: TaskRun) => {
    replaceStreamingOnNextDeltaRef.current = false;
    transcriptRunIdRef.current = run.id;
    transcriptAfterRef.current = 0;
    setState((current) => runViewForStartedRun(current, run));
  }, []);

  const openRun = useCallback((run: TaskRun, transcript: TranscriptItem[], after: number) => {
    transcriptRunIdRef.current = run.id;
    transcriptAfterRef.current = after;
    setState((current) => ({ ...current, selectedRun: run, expandedRunId: run.id, transcript }));
  }, []);

  return {
    ...state,
    setActiveRun,
    setSelectedRun,
    setRuns,
    setExpandedRunId,
    setEvents,
    setTranscript,
    setStreaming,
    setLiveThinking,
    streamingDeltaBatcher,
    activeRunIdRef,
    activeRunRef,
    replaceStreamingOnNextDeltaRef,
    transcriptRunIdRef,
    transcriptAfterRef,
    transcriptRefreshTaskRef,
    applyWorkspaceSnapshot,
    resetWorkspace,
    startRun,
    openRun,
  };
}
