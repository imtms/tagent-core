import type { LearningService } from "../learning-service.js";
import type { ActiveLearningProjectionEffectApplier } from "../ports/active-learning-projection-effect.js";
import type { WorkflowLearningService } from "../workflow-learning-service.js";

/** Applies the single durable projection to both Learning-owned read models. */
export class LearningServicesProjectionApplier
implements ActiveLearningProjectionEffectApplier {
  constructor(
    private readonly learningService: LearningService,
    private readonly workflowService: WorkflowLearningService,
  ) {}

  apply(input: Parameters<ActiveLearningProjectionEffectApplier["apply"]>[0]): void {
    this.learningService.applyActiveProjection(input.projection);
    this.workflowService.applyActiveProjection(input.projection);
  }
}
