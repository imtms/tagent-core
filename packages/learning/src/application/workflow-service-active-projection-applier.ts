import type { ActiveLearningProjectionEffectApplier } from "../ports/active-learning-projection-effect.js";
import type { WorkflowLearningService } from "../workflow-learning-service.js";

/** Learning-owned production bridge; Core only wires it and cannot reproduce projection policy. */
export class WorkflowServiceActiveProjectionApplier
implements ActiveLearningProjectionEffectApplier {
  constructor(private readonly workflowService: WorkflowLearningService) {}

  apply(input: Parameters<ActiveLearningProjectionEffectApplier["apply"]>[0]): void {
    this.workflowService.applyActiveProjection(input.projection);
  }
}
