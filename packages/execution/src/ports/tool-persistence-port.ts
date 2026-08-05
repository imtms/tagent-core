import type { RunId } from "../domain/task-run.js";
import type { Artifact, PlanItem, RunCheck } from "@tagent/governance/domain";
import type { OperationRepository } from "@tagent/governance/ports";
import type { RunEventJournal } from "./run-event-journal.js";
import type { TaskRunRepository } from "./task-run-repository.js";

interface ExecutionEvidencePort {
  upsertPlanItem(runId: RunId, item: Omit<PlanItem, "runId">): void;
  markChecksStale(runId: RunId): number;
  upsertCheck(runId: RunId, check: RunCheck): void;
  addArtifact(runId: RunId, artifact: Omit<Artifact, "runId" | "createdAt">): Artifact;
}

export type ToolPersistencePort =
  & Pick<
    TaskRunRepository,
    "getRun" | "advanceRunPhase" | "setRunPhase" | "requestUserInput"
  >
  & Pick<OperationRepository, "claimOperation" | "updateOperation" | "listOperations">
  & Pick<ExecutionEvidencePort, "upsertPlanItem" | "markChecksStale" | "upsertCheck" | "addArtifact">
  & Pick<RunEventJournal, "appendEvent">;
