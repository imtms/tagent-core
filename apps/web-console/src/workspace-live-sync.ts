export interface WorkspaceSyncToken {
  sessionId: string;
  generation: number;
}

export interface StreamSyncToken extends WorkspaceSyncToken {
  runId: string;
  streamGeneration: number;
}

export interface BackgroundSnapshotGuard {
  workspace: WorkspaceSyncToken;
  liveRevision: number;
}

export class WorkspaceLiveSyncCoordinator {
  private sessionId = "";
  private workspaceGeneration = 0;
  private streamGeneration = 0;
  private liveRevision = 0;
  private healthyRunId = "";
  private lastStreamActivityAt = 0;
  private recoveryRequested = false;

  enterWorkspace(sessionId: string): WorkspaceSyncToken {
    this.sessionId = sessionId;
    this.workspaceGeneration += 1;
    this.streamGeneration += 1;
    this.liveRevision += 1;
    this.healthyRunId = "";
    this.lastStreamActivityAt = 0;
    this.recoveryRequested = false;
    return this.workspaceToken();
  }

  captureWorkspace(sessionId: string): WorkspaceSyncToken | null {
    return sessionId === this.sessionId ? this.workspaceToken() : null;
  }

  isWorkspaceCurrent(token: WorkspaceSyncToken): boolean {
    return token.sessionId === this.sessionId && token.generation === this.workspaceGeneration;
  }

  beginStream(workspace: WorkspaceSyncToken, runId: string): StreamSyncToken | null {
    if (!this.isWorkspaceCurrent(workspace)) return null;
    this.streamGeneration += 1;
    this.liveRevision += 1;
    this.healthyRunId = "";
    this.lastStreamActivityAt = 0;
    return { ...workspace, runId, streamGeneration: this.streamGeneration };
  }

  isStreamCurrent(token: StreamSyncToken): boolean {
    return this.isWorkspaceCurrent(token)
      && token.streamGeneration === this.streamGeneration
      && token.runId.length > 0;
  }

  markStreamHealthy(token: StreamSyncToken, at = Date.now()): boolean {
    if (!this.isStreamCurrent(token)) return false;
    this.healthyRunId = token.runId;
    this.lastStreamActivityAt = at;
    this.liveRevision += 1;
    this.recoveryRequested = false;
    return true;
  }

  noteStreamActivity(token: StreamSyncToken, at = Date.now()): boolean {
    if (!this.isStreamCurrent(token)) return false;
    this.healthyRunId = token.runId;
    this.lastStreamActivityAt = at;
    this.liveRevision += 1;
    return true;
  }

  closeStream(token: StreamSyncToken, recover: boolean): void {
    if (!this.isStreamCurrent(token)) return;
    this.healthyRunId = "";
    this.lastStreamActivityAt = 0;
    this.liveRevision += 1;
    this.recoveryRequested ||= recover;
  }

  invalidateStream(sessionId: string): void {
    const workspace = this.captureWorkspace(sessionId);
    if (!workspace) return;
    this.streamGeneration += 1;
    this.liveRevision += 1;
    this.healthyRunId = "";
    this.lastStreamActivityAt = 0;
    this.recoveryRequested = true;
  }

  hasFreshStream(workspace: WorkspaceSyncToken, runId: string, at = Date.now(), maxAgeMs = 15_000): boolean {
    return this.isWorkspaceCurrent(workspace)
      && this.healthyRunId === runId
      && at - this.lastStreamActivityAt <= maxAgeMs;
  }

  snapshotGuard(workspace: WorkspaceSyncToken): BackgroundSnapshotGuard {
    return { workspace, liveRevision: this.liveRevision };
  }

  canCommitSnapshot(guard: BackgroundSnapshotGuard): boolean {
    return this.isWorkspaceCurrent(guard.workspace) && guard.liveRevision === this.liveRevision;
  }

  commitSnapshot(guard: BackgroundSnapshotGuard, at = Date.now()): boolean {
    if (!this.canCommitSnapshot(guard)) return false;
    this.liveRevision += 1;
    if (this.healthyRunId) this.lastStreamActivityAt = at;
    return true;
  }

  consumeRecoveryRequest(workspace: WorkspaceSyncToken): boolean {
    if (!this.isWorkspaceCurrent(workspace) || !this.recoveryRequested) return false;
    this.recoveryRequested = false;
    return true;
  }

  private workspaceToken(): WorkspaceSyncToken {
    return { sessionId: this.sessionId, generation: this.workspaceGeneration };
  }
}
