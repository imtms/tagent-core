import type { GovernanceContextManifestView } from "./governance-views.js";

export interface ContextManifestRepository {
  recordContextManifest(manifest: GovernanceContextManifestView): GovernanceContextManifestView;
  listContextManifests(runId: string, limit?: number): GovernanceContextManifestView[];
  getLatestContextManifest(runId: string): GovernanceContextManifestView | undefined;
}
