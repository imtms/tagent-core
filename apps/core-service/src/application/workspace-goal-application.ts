import { WorkspaceGoalService, validateWorkspaceGoalRoadmap, type WorkspaceGoal, type WorkspaceGoalDecisionInput, type WorkspaceGoalDefinition, type WorkspaceGoalOperationReceipt, type WorkspaceGoalOperationRepository, type WorkspaceGoalRepository, type WorkspaceGoalRoadmap } from "@tagent/governance";
import type { AdmissionCoordinator } from "@tagent/admission";
import type { SessionRepository } from "@tagent/admission/ports";

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
    private readonly sessions?: Pick<SessionRepository, "getSession">,
    private readonly operations?: WorkspaceGoalOperationRepository,
  ) {
    this.goals = new WorkspaceGoalService(repository);
  }

  listWorkspaceGoals(workspaceId:string){this.requireWorkspace(workspaceId);return this.goals.list(workspaceId);}

  createWorkspaceGoal(workspaceId:string,input:{definition:WorkspaceGoalDefinition;actorId?:string;requestId?:string}){this.requireWorkspace(workspaceId);return this.goals.create({workspaceId,definition:input.definition,createdBy:input.actorId?.trim()||"web_console",idempotencyKey:input.requestId?.trim()||undefined});}

  getWorkspaceGoal(goalId:string){return this.goals.get(goalId);}

  reviseWorkspaceGoalDefinition(goalId:string,input:{definition:WorkspaceGoalDefinition;actorId?:string;requestId:string}){const actorId=input.actorId?.trim()||"web_console";return this.runOperation(goalId,input.requestId,"definition.revise",{definition:input.definition,actorId},()=>this.goals.reviseDefinition(goalId,input.definition,actorId));}

  reviseWorkspaceGoalRoadmap(goalId:string,input:{content:WorkspaceGoalRoadmap;sourceArtifactId?:string|null;actorId?:string;requestId:string}){const actorId=input.actorId?.trim()||"web_console",sourceArtifactId=input.sourceArtifactId?.trim()||null;return this.runOperation(goalId,input.requestId,"roadmap.revise",{content:input.content,sourceArtifactId,actorId},()=>{this.goals.addRoadmap(goalId,input.content,sourceArtifactId,actorId);return this.requireGoal(goalId);});}

  async requestWorkspaceGoalRoadmapGeneration(goalId:string,input:{requestId:string;actorId?:string}){const actorId=input.actorId?.trim()||"web_console",operations=this.requireOperations(),claim=operations.claimWorkspaceGoalOperation({goalId,requestId:input.requestId,operationType:"roadmap.generate",canonicalPayload:canonicalJson({actorId})});if(!claim.claimed){this.replayOperation(claim.receipt);return this.requireGoal(goalId);}try{await this.generateWorkspaceGoalRoadmap(goalId,actorId);operations.settleWorkspaceGoalOperation(goalId,input.requestId,"succeeded",{generated:true});return this.requireGoal(goalId);}catch(error){operations.settleWorkspaceGoalOperation(goalId,input.requestId,"failed",{},operationError(error));throw error;}}

  getWorkspaceGoalOperation(goalId:string,requestId:string){this.requireGoal(goalId);return this.requireOperations().getWorkspaceGoalOperation(goalId,requestId);}

  decideWorkspaceGoal(input:WorkspaceGoalDecisionInput){this.goals.decide({...input,actorId:input.actorId?.trim()||"web_console"});return this.requireGoal(input.goalId);}

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

  startWorkspaceGoalRoadmapTask(goalId:string,roadmapItemId:string,requestId?:string){const result=this.startWorkspaceGoalRoadmapItem(goalId,roadmapItemId,requestId);return{goal:this.requireGoal(goalId),inboxItemId:result.item.id,runId:result.run?.id??null};}

  private runOperation<T extends object>(goalId:string,requestId:string,operationType:string,payload:Record<string,unknown>,operation:()=>T):T{const operations=this.requireOperations(),claim=operations.claimWorkspaceGoalOperation({goalId,requestId,operationType,canonicalPayload:canonicalJson(payload)});if(!claim.claimed)return this.replayOperation(claim.receipt) as T;try{const result=operation();operations.settleWorkspaceGoalOperation(goalId,requestId,"succeeded",result as unknown as Record<string,unknown>);return result;}catch(error){operations.settleWorkspaceGoalOperation(goalId,requestId,"failed",{},operationError(error));throw error;}}

  private replayOperation(receipt:WorkspaceGoalOperationReceipt):Record<string,unknown>{if(receipt.state==="succeeded"&&receipt.result)return receipt.result;if(receipt.state==="failed")throw new Error(String(receipt.error?.message??"Workspace Goal operation failed"));if(receipt.state==="started")throw new Error("Workspace Goal operation is still in progress");throw new Error("Workspace Goal operation outcome is unknown; inspect the Goal before retrying with a new requestId");}

  private requireWorkspace(workspaceId:string){if(this.sessions&&!this.sessions.getSession(workspaceId))throw new Error("workspace not found");}

  private requireGoal(goalId:string){const goal=this.goals.get(goalId);if(!goal)throw new Error("Workspace Goal not found");return goal;}

  private requireOperations(){if(!this.operations)throw new Error("Workspace Goal operation persistence is unavailable");return this.operations;}
}

function operationError(error:unknown):Record<string,unknown>{return{message:error instanceof Error?error.message:String(error)};}

function canonicalJson(value:unknown):string{if(value===null||typeof value!=="object")return JSON.stringify(value) as string;if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;return`{${Object.entries(value as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;}
