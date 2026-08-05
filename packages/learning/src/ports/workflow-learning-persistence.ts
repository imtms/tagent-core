import type { TaskRunRepository } from "@tagent/execution/ports";
import type { LearningProjectionQueue } from "./learning-projection-queue.js";
import type { SemanticLearningJobQueue } from "./semantic-learning-job-queue.js";
import type { WorkflowLearningRepository } from "./workflow-learning-repository.js";

type SynchronousWorkflowResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface WorkflowUnitOfWork {
  run<T>(work: () => T & SynchronousWorkflowResult<T>): T;
}

export type WorkflowLearningPersistencePort =
  & Pick<TaskRunRepository, "getRun">
  & LearningProjectionQueue
  & SemanticLearningJobQueue
  & { unitOfWork: WorkflowUnitOfWork; workflow: WorkflowLearningRepository };

/** @deprecated Use WorkflowLearningPersistencePort. */
export type WorkflowServicePersistencePort = WorkflowLearningPersistencePort;
