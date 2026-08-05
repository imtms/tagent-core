import type { ProgressSnapshot } from "../domain/index.js";
import type { GovernanceProgressRunView, GovernanceRunEventView } from "./governance-views.js";

export interface ProgressRepository {
  getProgressSnapshot(runId: string): ProgressSnapshot | undefined;
  updateProgressSnapshot(run: GovernanceProgressRunView, event: GovernanceRunEventView): ProgressSnapshot;
}
