import { WorkspaceGoalService, validateWorkspaceGoalRoadmap, type WorkspaceGoal, type WorkspaceGoalDefinition, type WorkspaceGoalRepository, type WorkspaceGoalRoadmap } from "@tagent/governance";
import type { AdmissionCoordinator } from "@tagent/admission";

export interface WorkspaceGoalRoadmapGenerator {
  readonly model: string;
  generate(input: { goalId: string; definition: WorkspaceGoalDefinition }): Promise<WorkspaceGoalRoadmap>;
}

/** Cross-domain Goal use cases assembled at the Core boundary. */
export class CoreWorkspaceGoalApplication {
  private readonly goals: WorkspaceGoalService;
  private readonly roadmapGenerations = new Map<string, Promise<WorkspaceGoal>>();

  constructor(
    repository: WorkspaceGoalRepository,
    private readonly admission: Pick<AdmissionCoordinator, "enqueueGoalRoadmapItem">,
    private readonly generator?: WorkspaceGoalRoadmapGenerator,
  ) {
    this.goals = new WorkspaceGoalService(repository);
  }

  async generateWorkspaceGoalRoadmap(goalId: string, actorId = "web_console") {
    const inFlight = this.roadmapGenerations.get(goalId);
    if (inFlight) return inFlight;
    const generation = this.generateInitialRoadmap(goalId, actorId);
    this.roadmapGenerations.set(goalId, generation);
    try { return await generation; }
    finally { this.roadmapGenerations.delete(goalId); }
  }

  private async generateInitialRoadmap(goalId: string, actorId: string): Promise<WorkspaceGoal> {
    const goal = this.goals.get(goalId);
    if (!goal?.definition || goal.activeDefinitionRevisionId !== goal.definition.id || goal.status !== "active") {
      throw new Error("an active approved Workspace Goal definition is required before Roadmap generation");
    }
    if (goal.currentRunId) throw new Error("Workspace Goal Roadmap cannot be generated while a guided TaskRun is active");
    if (goal.roadmap) throw new Error("Workspace Goal already has a Roadmap; edit the existing draft instead of calling the LLM again");
    if (!this.generator) throw new Error("Workspace Goal Roadmap LLM is not configured");
    const definition = goal.definition.content as WorkspaceGoalDefinition;
    const generated = await this.generator.generate({
      goalId,
      definition,
    });
    const roadmap = validateWorkspaceGoalRoadmap(generated, definition);
    if (roadmap.items.length < 2 || roadmap.items.length > 8) throw new Error("Workspace Goal Roadmap LLM must return between 2 and 8 items");
    if (roadmap.items.some((item) => !item.criterionKeys.length)) throw new Error("every generated Roadmap item must advance at least one Goal criterion");
    const coveredKeys = new Set(roadmap.items.flatMap((item) => item.criterionKeys));
    const missingRequired = definition.criteria
      .filter((criterion) => criterion.required && !coveredKeys.has(criterion.key));
    if (missingRequired.length) throw new Error(`generated Roadmap does not cover required Goal criteria: ${missingRequired.map((item) => item.key).join(", ")}`);
    const current = this.goals.get(goalId);
    if (!current?.definition || current.status !== "active" || current.currentRunId || current.roadmap
      || current.activeDefinitionRevisionId !== goal.activeDefinitionRevisionId
      || current.definition.id !== goal.definition.id || current.definition.contentHash !== goal.definition.contentHash) {
      throw new Error("Workspace Goal changed during Roadmap generation; the late LLM draft was discarded");
    }
    this.goals.addRoadmap(goalId, roadmap, null, `${actorId}:llm:${this.generator.model}`);
    return this.goals.get(goalId)!;
  }

  startWorkspaceGoalRoadmapItem(goalId: string, roadmapItemId: string, requestId?: string) {
    const goal = this.goals.get(goalId);
    if (!goal?.definition || !goal.roadmap || goal.status !== "active"
      || goal.activeDefinitionRevisionId !== goal.definition.id || goal.activeRoadmapRevisionId !== goal.roadmap.id) {
      throw new Error("an active approved Workspace Goal Roadmap is required before starting a TaskRun");
    }
    const approval = [...goal.decisions].reverse().find((decision) => decision.kind === "approve_roadmap"
      && decision.targetRevisionId === goal.roadmap?.id && decision.targetHash === goal.roadmap.contentHash);
    if (!approval?.approvedItemIds.includes(roadmapItemId)) throw new Error("Goal Roadmap item is not approved");
    const roadmap = goal.roadmap.content as WorkspaceGoalRoadmap;
    const roadmapItem = roadmap.items.find((item) => item.id === roadmapItemId);
    if (!roadmapItem) throw new Error("Goal Roadmap item not found");
    return this.admission.enqueueGoalRoadmapItem({
      workspaceId: goal.workspaceId,
      goalId,
      goalRevision: goal.definition.revision,
      goalOutcome: (goal.definition.content as WorkspaceGoalDefinition).outcome,
      roadmapRevisionId: goal.roadmap.id,
      roadmapItem,
      requestId,
    });
  }
}
