import type { Artifact, PlanItem, RunCheck } from "../domain/index.js";

export interface EvidenceRepository {
  upsertPlanItem(runId: string, item: Omit<PlanItem, "runId">): void;
  markChecksStale(runId: string): number;
  upsertCheck(runId: string, check: RunCheck): void;
  getArtifact(runId: string, artifactId: string): Artifact | undefined;
  addArtifact(runId: string, artifact: Omit<Artifact, "runId" | "createdAt">): Artifact;
}
