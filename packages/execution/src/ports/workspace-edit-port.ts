export interface WorkspaceReadSnapshot { path: string; content: string; snapshotId: string; contentHash: string; bytes: number }
export interface WorkspacePatchHunk { oldText: string; newText: string }
export interface WorkspacePatchFile { path: string; snapshotId: string; contentHash?: string; hunks: WorkspacePatchHunk[] }
export interface WorkspacePatchRequest { patchId: string; files: WorkspacePatchFile[] }
export interface WorkspacePatchResult { patchId: string; changedFiles: Array<{ path: string; beforeHash: string; afterHash: string; bytesBefore: number; bytesAfter: number; firstChangedLine: number | null }> }
export interface WorkspaceEditPort {
  read(path: string, signal: AbortSignal): Promise<WorkspaceReadSnapshot>;
  patch(request: WorkspacePatchRequest, signal: AbortSignal): Promise<WorkspacePatchResult>;
}
