import { useEffect, useMemo, useState } from "react";
import { api, type CaptureJob, type RuntimeStatus } from "./api";

export function indexMemoryJobsByMessage(jobs: readonly CaptureJob[]): Map<number, CaptureJob> {
  const byMessageId = new Map<number, CaptureJob>();
  for (const job of jobs) {
    if (job.request.captureSource?.kind && job.request.captureSource.kind !== "user_message") continue;
    for (const source of job.request.sourceRefs) {
      if (source.sourceType !== "message") continue;
      const messageId = Number(source.sourceId);
      const previous = byMessageId.get(messageId);
      if (Number.isFinite(messageId) && (!previous || job.updatedAt > previous.updatedAt)) byMessageId.set(messageId, job);
    }
  }
  return byMessageId;
}

export function useMemoryAnnotations(runtimeStatus: RuntimeStatus | null, workspaceId: string) {
  const [jobs, setJobs] = useState<CaptureJob[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!runtimeStatus?.memoryEnabled || !workspaceId) {
      setJobs([]);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    let closed = false;
    let polling = false;
    const scope = { type: "workspace" as const, id: runtimeStatus.memoryWorkspaceScopeId ?? "default" };
    const refresh = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const nextJobs = await api.memoryJobs(scope);
        if (!closed) {
          setJobs(nextJobs);
          setLoaded(true);
        }
      } catch {
        if (!closed) setLoaded(true);
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [runtimeStatus?.memoryEnabled, runtimeStatus?.memoryWorkspaceScopeId, workspaceId]);

  return {
    loaded,
    byMessageId: useMemo(() => indexMemoryJobsByMessage(jobs), [jobs]),
  };
}
