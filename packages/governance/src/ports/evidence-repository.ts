import type { Artifact, PlanItem, RunCheck } from "../domain/index.js";

export type ArtifactMetadata = Omit<Artifact, "content">;

export interface EvidenceRepository {
  upsertPlanItem(runId: string, item: Omit<PlanItem, "runId">): void;
  markChecksStale(runId: string): number;
  upsertCheck(runId: string, check: RunCheck): void;
  getArtifact(runId: string, artifactId: string): Artifact | undefined;
  listArtifacts(runId: string, after: number, limit: number): ArtifactMetadata[];
  addArtifact(runId: string, artifact: Omit<Artifact, "runId" | "createdAt">): Artifact;
}
