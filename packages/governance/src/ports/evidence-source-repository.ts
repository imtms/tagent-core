import type { EvidenceSource } from "../domain/index.js";

export interface EvidenceSourceRepository {
  /** Resolve exact immutable evidence sources owned by one TaskRun. Unknown refs are omitted. */
  resolveEvidenceSources(runId: string, refs: readonly string[]): EvidenceSource[];
}
