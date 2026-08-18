import { useCallback, useState } from "react";
import { api, type TaskRun, type UserInputRequest } from "./api";
import { approvalResolutionNotice } from "./approval-display";
import type { useRunViewState } from "./use-run-view-state";

type RunApproval = TaskRun["supervision"]["approvalRequests"][number];
type RunViewOperations = Pick<ReturnType<typeof useRunViewState>,
  "activeRun" | "selectedRun" | "startRun" | "resumeRun" | "resolveRuns"
>;

export function useTaskRunOperations({
  workspaceId,
  currentWorkspaceIdRef,
  runView,
  pinToLatest,
  setError,
  setNotice,
}: {
  workspaceId: string;
  currentWorkspaceIdRef: { current: string };
  runView: RunViewOperations;
  pinToLatest: () => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  const [submittingUserInputId, setSubmittingUserInputId] = useState("");
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [resolvingApprovalDecision, setResolvingApprovalDecision] = useState<"approved" | "rejected" | "">("");
  const [retryingRunId, setRetryingRunId] = useState("");
  const { activeRun, selectedRun, startRun, resumeRun, resolveRuns } = runView;

  const submitRequestedInput = useCallback(async (request: UserInputRequest, values: Record<string, string>) => {
    if (submittingUserInputId) return;
    const targetWorkspaceId = workspaceId;
    setSubmittingUserInputId(request.id);
    setError("");
    setNotice("");
    try {
      if (!selectedRun) throw new Error("TaskRun is not selected");
      const resumed = await api.submitUserInput(selectedRun.id, request.id, values);
      if (currentWorkspaceIdRef.current !== targetWorkspaceId) return;
      resumeRun(resumed);
      setNotice("Information submitted. TaskRun resumed.");
      pinToLatest();
    } catch (cause) {
      if (currentWorkspaceIdRef.current === targetWorkspaceId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmittingUserInputId("");
    }
  }, [currentWorkspaceIdRef, pinToLatest, resumeRun, selectedRun, setError, setNotice, submittingUserInputId, workspaceId]);

  const resolveRunApproval = useCallback(async (approval: RunApproval, decision: "approved" | "rejected") => {
    if (resolvingApprovalId) return;
    const sourceRun = activeRun;
    const targetWorkspaceId = workspaceId;
    setResolvingApprovalId(approval.id);
    setResolvingApprovalDecision(decision);
    setError("");
    setNotice("");
    try {
      if (!sourceRun) throw new Error("TaskRun is not active");
      const updated = await api.resolveRunApproval(sourceRun.id, approval.id, decision);
      if (currentWorkspaceIdRef.current !== targetWorkspaceId) return;
      const refreshedSource = sourceRun.id !== updated.id ? await api.run(sourceRun.id) : updated;
      if (currentWorkspaceIdRef.current !== targetWorkspaceId) return;
      const resolvedRuns = refreshedSource.id === updated.id ? [updated] : [updated, refreshedSource];
      resolveRuns(resolvedRuns, decision === "approved" && sourceRun.id === updated.id);
      setNotice(approvalResolutionNotice(approval.actionType, decision));
    } catch (cause) {
      if (currentWorkspaceIdRef.current === targetWorkspaceId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResolvingApprovalId("");
      setResolvingApprovalDecision("");
    }
  }, [activeRun, currentWorkspaceIdRef, resolveRuns, resolvingApprovalId, setError, setNotice, workspaceId]);

  const retryLaunch = useCallback(async (run: TaskRun) => {
    if (retryingRunId) return;
    const targetWorkspaceId = workspaceId;
    setRetryingRunId(run.id);
    setError("");
    setNotice("");
    try {
      const result = await api.retryLaunch(run.id);
      if (currentWorkspaceIdRef.current !== targetWorkspaceId) return;
      startRun(result.run);
      setNotice("TaskRun launch retry started.");
    } catch (cause) {
      if (currentWorkspaceIdRef.current === targetWorkspaceId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetryingRunId("");
    }
  }, [currentWorkspaceIdRef, retryingRunId, setError, setNotice, startRun, workspaceId]);

  return {
    submittingUserInputId,
    submitRequestedInput,
    resolvingApprovalId,
    resolvingApprovalDecision,
    resolveRunApproval,
    retryingRunId,
    retryLaunch,
  };
}
