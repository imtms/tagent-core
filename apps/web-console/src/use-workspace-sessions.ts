import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, type Session } from "./api";
import { createRequestId } from "./id";

export interface WorkspaceAuthorityToken {
  workspaceId: string;
  generation: number;
}

export class WorkspaceAuthority {
  private workspaceId = "";
  private generation = 0;

  enter(workspaceId: string): WorkspaceAuthorityToken {
    this.workspaceId = workspaceId;
    this.generation += 1;
    return this.token();
  }

  capture(workspaceId: string): WorkspaceAuthorityToken | null {
    return workspaceId === this.workspaceId ? this.token() : null;
  }

  isCurrent(token: WorkspaceAuthorityToken): boolean {
    return token.workspaceId === this.workspaceId && token.generation === this.generation;
  }

  currentWorkspaceId(): string {
    return this.workspaceId;
  }

  private token(): WorkspaceAuthorityToken {
    return { workspaceId: this.workspaceId, generation: this.generation };
  }
}

export class WorkspaceCreationGuard {
  private active = false;

  tryEnter(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  release(): void {
    this.active = false;
  }
}

export function replaceWorkspace(workspaces: readonly Session[], updated: Session): Session[] {
  return workspaces.map((workspace) => workspace.id === updated.id ? updated : workspace);
}

const initialWorkspaceRequestId = createRequestId();
const WORKSPACE_CREATE_GUARD_MS = 500;

export function workspaceCreateGuardDelay(startedAt: number, now: number): number {
  return Math.max(0, WORKSPACE_CREATE_GUARD_MS - (now - startedAt));
}

export function useWorkspaceSessions({
  hasActiveRun,
  setError,
  setNotice,
}: {
  hasActiveRun: boolean;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
}) {
  const [workspaces, setWorkspaces] = useState<Session[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState("");
  const [workspaceTitleDraft, setWorkspaceTitleDraft] = useState("");
  const [savingExecutionProfile, setSavingExecutionProfile] = useState(false);
  const authorityRef = useRef(new WorkspaceAuthority());
  const creationGuardRef = useRef(new WorkspaceCreationGuard());
  const createReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRenameRef = useRef(false);
  const renameSubmittingRef = useRef(false);

  useLayoutEffect(() => {
    if (!authorityRef.current.capture(workspaceId)) authorityRef.current.enter(workspaceId);
    setSavingExecutionProfile(false);
  }, [workspaceId]);

  useEffect(() => {
    let closed = false;
    setWorkspacesLoading(true);
    void (async () => {
      try {
        let items = await api.sessions();
        if (!items.length) items = [await api.createSession("First workspace", initialWorkspaceRequestId)];
        if (closed) return;
        setWorkspaces(items);
        if (!authorityRef.current.currentWorkspaceId()) {
          authorityRef.current.enter(items[0].id);
          setWorkspaceId(items[0].id);
        }
      } catch (cause) {
        if (!closed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!closed) setWorkspacesLoading(false);
      }
    })();
    return () => { closed = true; };
  }, [setError]);

  useEffect(() => () => {
    if (createReleaseTimerRef.current) clearTimeout(createReleaseTimerRef.current);
  }, []);

  const createWorkspace = useCallback(async (prepareSelection: (workspaceId: string) => void) => {
    if (!creationGuardRef.current.tryEnter()) return null;
    const startedAt = Date.now();
    let created = false;
    setCreatingWorkspace(true);
    setError("");
    setNotice("");
    try {
      const workspace = await api.createSession(`Workspace ${workspaces.length + 1}`);
      prepareSelection(workspace.id);
      authorityRef.current.enter(workspace.id);
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
      setWorkspaceId(workspace.id);
      created = true;
      return workspace;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      const release = () => {
        createReleaseTimerRef.current = null;
        creationGuardRef.current.release();
        setCreatingWorkspace(false);
      };
      if (!created) {
        release();
      } else {
        createReleaseTimerRef.current = setTimeout(
          release,
          workspaceCreateGuardDelay(startedAt, Date.now()),
        );
      }
    }
  }, [workspaces.length, setError, setNotice]);

  const selectWorkspace = useCallback((workspace: Session, prepareSelection: (workspaceId: string) => void) => {
    if (workspace.id === authorityRef.current.currentWorkspaceId()) return false;
    prepareSelection(workspace.id);
    authorityRef.current.enter(workspace.id);
    setWorkspaceId(workspace.id);
    return true;
  }, []);

  const beginRenameWorkspace = useCallback((workspace: Session) => {
    cancelRenameRef.current = false;
    setRenamingWorkspaceId(workspace.id);
    setWorkspaceTitleDraft(workspace.title);
  }, []);

  const cancelRenameWorkspace = useCallback(() => {
    cancelRenameRef.current = true;
    setRenamingWorkspaceId("");
    setWorkspaceTitleDraft("");
  }, []);

  const commitRenameWorkspace = useCallback(async (workspace: Session) => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    if (renameSubmittingRef.current) return;
    const title = workspaceTitleDraft.trim();
    if (!title) {
      setError("Workspace name is required.");
      return;
    }
    if (title === workspace.title) {
      setRenamingWorkspaceId("");
      setWorkspaceTitleDraft("");
      return;
    }
    renameSubmittingRef.current = true;
    setError("");
    try {
      const updated = await api.renameSession(workspace.id, title);
      setWorkspaces((current) => replaceWorkspace(current, updated));
      setRenamingWorkspaceId("");
      setWorkspaceTitleDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      renameSubmittingRef.current = false;
    }
  }, [setError, workspaceTitleDraft]);

  const updateExecutionProfile = useCallback(async (settings: { modelId?: string; reasoningEffort?: Session["reasoningEffort"] }) => {
    const authority = authorityRef.current.capture(workspaceId);
    if (!authority || !workspaceId || savingExecutionProfile) return;
    const activeAtStart = hasActiveRun;
    setSavingExecutionProfile(true);
    setError("");
    setNotice("");
    try {
      const updated = await api.updateSession(workspaceId, settings);
      if (!authorityRef.current.isCurrent(authority)) return;
      setWorkspaces((current) => replaceWorkspace(current, updated));
      setNotice(activeAtStart
        ? "Execution preference saved for the next TaskRun; the active TaskRun keeps its original profile."
        : "Workspace execution preference saved.");
    } catch (cause) {
      if (authorityRef.current.isCurrent(authority)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (authorityRef.current.isCurrent(authority)) setSavingExecutionProfile(false);
    }
  }, [hasActiveRun, savingExecutionProfile, setError, setNotice, workspaceId]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaces, workspaceId],
  );

  return {
    workspaces,
    setWorkspaces,
    workspacesLoading,
    workspaceId,
    selectedWorkspace,
    creatingWorkspace,
    createWorkspace,
    selectWorkspace,
    renamingWorkspaceId,
    workspaceTitleDraft,
    setWorkspaceTitleDraft,
    beginRenameWorkspace,
    cancelRenameWorkspace,
    commitRenameWorkspace,
    savingExecutionProfile,
    updateExecutionProfile,
  };
}
