import type { EvidenceSource } from "../domain/index.js";
import type { GovernanceContextManifestView } from "./governance-views.js";

export interface ContextManifestRepository {
  recordContextManifest(manifest: GovernanceContextManifestView, evidenceSources?: readonly (EvidenceSource & { kind: "memory" })[]): GovernanceContextManifestView;
  listContextManifests(runId: string, limit?: number): GovernanceContextManifestView[];
  getLatestContextManifest(runId: string): GovernanceContextManifestView | undefined;
}
