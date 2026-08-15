import type { TaskRunRepository } from "@tagent/execution/ports";
import type { SemanticLearningJobQueue } from "./semantic-learning-job-queue.js";
import type { WorkflowLearningRepository } from "./workflow-learning-repository.js";

type SynchronousWorkflowResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface WorkflowUnitOfWork {
  run<T>(work: () => T & SynchronousWorkflowResult<T>): T;
}

export type WorkflowLearningPersistencePort =
  & Pick<TaskRunRepository, "getRun">
  & SemanticLearningJobQueue
  & { unitOfWork: WorkflowUnitOfWork; workflow: WorkflowLearningRepository };
