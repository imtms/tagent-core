import type { LearningEffectRepository } from "./learning-effect-repository.js";
import type { LearningProjectionDeliveryRepository } from "./learning-projection-delivery-repository.js";

type SynchronousLearningProjectionResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface LearningProjectionUnitOfWork {
  run<T>(work: () => T & SynchronousLearningProjectionResult<T>): T;
}

export interface LearningProjectionIntegrationPersistencePort {
  unitOfWork: LearningProjectionUnitOfWork;
  delivery: LearningProjectionDeliveryRepository;
  effects: LearningEffectRepository;
}
