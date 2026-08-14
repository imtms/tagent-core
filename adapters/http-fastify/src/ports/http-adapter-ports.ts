export interface HttpWriterReadiness { isWriterReady(): boolean }

export type HttpRuntimeConfig = object & {
  memoryWorkspaceScopeId?: string;
  releaseVersion?: string;
  schemaVersion?: number;
  governanceApprovalAuthority?: "legacy" | "canonical";
};

export interface HttpLearningFeatureState {
  memoryEnabled: boolean;
  learningEnabled: boolean;
  autoExecutionEnabled: boolean;
  [key: string]: unknown;
}

export interface HttpLearningControlPort {
  requireLearning(): void;
  snapshot(): HttpLearningFeatureState;
}

export interface HttpMemoryScope { type: "user" | "workspace" | "project" | "session"; id: string }
export interface HttpMemoryAccess { subjectId: string; scopes: HttpMemoryScope[]; purpose: "agent_recall" | "memory_admin" | "capture" }

export interface HttpMemoryPort {
  enqueueCapture(request: unknown): Promise<unknown>;
  listCaptureJobs?(access: HttpMemoryAccess, limit?: number): Promise<unknown>;
  status(access: HttpMemoryAccess): Promise<unknown>;
  recall(request: unknown, signal: AbortSignal): Promise<unknown>;
  getColdTopic(access: HttpMemoryAccess, topicId: string): Promise<unknown | null>;
  upsert(access: HttpMemoryAccess, records: unknown[], topics?: unknown[]): Promise<unknown>;
  export(access: HttpMemoryAccess, scope: HttpMemoryScope, limit?: number): Promise<unknown>;
  forget(request: unknown): Promise<unknown>;
  restore(request: unknown): Promise<unknown>;
  enqueueReindex?(access: HttpMemoryAccess): Promise<unknown>;
  listReindexJobs?(access: HttpMemoryAccess, limit?: number): Promise<unknown>;
  govern?(request: unknown): Promise<unknown>;
  feedback?(access: HttpMemoryAccess, scope: HttpMemoryScope, recordId: string, signal: string, options?: { runId?: string; note?: string }): Promise<unknown>;
  getCoreSnapshot?(access: HttpMemoryAccess, signal: AbortSignal): Promise<unknown>;
  generateCoreSnapshot?(access: HttpMemoryAccess): Promise<unknown>;
  updateCoreSnapshot?(access: HttpMemoryAccess, markdown: string): Promise<unknown>;
  readiness(access: HttpMemoryAccess): Promise<{ ready: boolean; degraded: boolean; reasons: string[] }>;
}

export interface HttpArtifactContentPort {
  filename(title: string, uri: string): string;
  isMarkdown(kind: string, title: string, uri: string): boolean;
  isText(kind: string, title: string, uri: string, content: string): boolean;
  loadSource(content: string, uri: string, workspaceRoot: string, signal: AbortSignal): Promise<{ content: string; source: "inline" | "file" }>;
  loadDownload(content: string, uri: string, workspaceRoot: string, signal: AbortSignal): Promise<{ buffer: Buffer; source: "inline" | "file" }>;
}
