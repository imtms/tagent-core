export interface ProjectContextRule {
  path: string;
  content: string;
  sha256: string;
  precedence: number;
  bytes: number;
  selected: boolean;
  reason: string;
}

export interface ProjectContextSnapshot {
  snapshotHash: string;
  rules: ProjectContextRule[];
}

/** Core-owned, auditable project context discovery. Rules never grant capabilities or authority. */
export interface ContextSourcePort {
  load(): ProjectContextSnapshot;
}
