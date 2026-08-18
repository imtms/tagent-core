export function goalStartBlockedReason(currentRunId: string | null, busy: boolean): string | null {
  if (busy) return "Another Goal operation is still being processed.";
  if (currentRunId) return "This Goal already has an active TaskRun. Open or finish it before starting another Roadmap item.";
  return null;
}

export function shortRunId(runId: string): string {
  return runId.slice(0, 12);
}
