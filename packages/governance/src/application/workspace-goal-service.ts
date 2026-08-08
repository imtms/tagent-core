import { createHash } from "node:crypto";
import type {
  CreateWorkspaceGoalInput,
  LinkWorkspaceGoalEvidenceInput,
  LinkWorkspaceGoalInboxInput,
  LinkWorkspaceGoalRunInput,
  WorkspaceGoal,
  WorkspaceGoalDecisionInput,
  WorkspaceGoalNextAction,
  WorkspaceGoalRoadmap,
  WorkspaceGoalRoadmapItemProgress,
  WorkspaceGoalStatus,
} from "../domain/workspace-goal.js";
import type { WorkspaceGoalRepository } from "../ports/workspace-goal-repository.js";

export class WorkspaceGoalService {
  constructor(private readonly goals: WorkspaceGoalRepository) {}

  create(input: CreateWorkspaceGoalInput): WorkspaceGoal {
    return this.goals.createGoal({
      ...input,
      workspaceId: required(input.workspaceId, "workspaceId", 300),
      createdBy: required(input.createdBy, "createdBy", 300),
      idempotencyKey: input.idempotencyKey?.trim() || undefined,
      definition: validateDefinition(input.definition),
    });
  }

  list(workspaceId: string) {
    return this.goals.listGoals(required(workspaceId, "workspaceId", 300));
  }

  get(goalId: string) {
    return this.goals.getGoal(required(goalId, "goalId", 300));
  }

  reviseDefinition(goalId: string, definition: CreateWorkspaceGoalInput["definition"], createdBy: string) {
    return this.goals.addDefinitionRevision(required(goalId, "goalId", 300), validateDefinition(definition), required(createdBy, "createdBy", 300));
  }

  addRoadmap(goalId: string, content: WorkspaceGoalRoadmap, sourceArtifactId: string | null, createdBy: string) {
    const normalizedGoalId = required(goalId, "goalId", 300);
    const goal = this.goals.getGoal(normalizedGoalId);
    if (!goal?.definition || goal.activeDefinitionRevisionId !== goal.definition.id) {
      throw new Error("an approved Goal definition is required before a Roadmap");
    }
    return this.goals.addRoadmapRevision(normalizedGoalId, validateRoadmap(content, goal.definition.content as CreateWorkspaceGoalInput["definition"]), sourceArtifactId?.trim() || null, required(createdBy, "createdBy", 300));
  }

  decide(input: WorkspaceGoalDecisionInput) {
    return this.goals.decideGoal({
      ...input,
      goalId: required(input.goalId, "goalId", 300),
      requestId: input.requestId?.trim() || undefined,
      targetRevisionId: required(input.targetRevisionId, "targetRevisionId", 300),
      targetHash: required(input.targetHash, "targetHash", 128),
      actorId: required(input.actorId, "actorId", 300),
      reason: input.reason?.trim() || "",
      approvedItemIds: uniqueStrings(input.approvedItemIds ?? [], "approvedItemIds", 200),
    });
  }

  linkRun(input: LinkWorkspaceGoalRunInput) {
    return this.goals.linkRun({
      ...input,
      goalId: required(input.goalId, "goalId", 300),
      runId: required(input.runId, "runId", 300),
      goalRevision: positiveInteger(input.goalRevision, "goalRevision"),
      roadmapRevisionId: input.roadmapRevisionId?.trim() || null,
      roadmapItemIds: uniqueStrings(input.roadmapItemIds ?? [], "roadmapItemIds", 200),
      criterionKeys: uniqueStrings(input.criterionKeys ?? [], "criterionKeys", 200),
      mode: input.mode ?? "workspace",
    });
  }

  linkInbox(input: LinkWorkspaceGoalInboxInput) {
    return this.goals.linkInbox({
      goalId: required(input.goalId, "goalId", 300),
      inboxItemId: required(input.inboxItemId, "inboxItemId", 300),
      goalRevision: positiveInteger(input.goalRevision, "goalRevision"),
      roadmapRevisionId: required(input.roadmapRevisionId, "roadmapRevisionId", 300),
      roadmapItemIds: uniqueStrings(input.roadmapItemIds, "roadmapItemIds", 200),
      criterionKeys: uniqueStrings(input.criterionKeys, "criterionKeys", 200),
    });
  }

  attachRun(runId: string, inboxItemId?: string) {
    return this.goals.attachRun(required(runId, "runId", 300), inboxItemId?.trim() || null);
  }

  recordRunOutcome(runId: string) {
    return this.goals.recordRunOutcome(required(runId, "runId", 300));
  }

  linkEvidence(input: LinkWorkspaceGoalEvidenceInput) {
    return this.goals.linkEvidence({
      ...input,
      goalId: required(input.goalId, "goalId", 300),
      requestId: input.requestId?.trim() || undefined,
      runId: required(input.runId, "runId", 300),
      criterionKey: required(input.criterionKey, "criterionKey", 200),
      goalRevision: positiveInteger(input.goalRevision, "goalRevision"),
      checkKey: input.checkKey?.trim() || null,
      artifactId: input.artifactId?.trim() || null,
      operationId: input.operationId?.trim() || null,
      status: input.status ?? "valid",
    });
  }
}

export function workspaceGoalNextAction(input: {
  status: WorkspaceGoalStatus;
  hasDefinition: boolean;
  hasApprovedDefinition: boolean;
  hasRoadmap: boolean;
  hasApprovedRoadmap: boolean;
  currentRunId: string | null;
  requiredCriteria: number;
  verifiedCriteria: number;
  roadmapProgress: WorkspaceGoalRoadmapItemProgress[];
  approvedItemIds: string[];
  currentRunStatus: string | null;
}): WorkspaceGoalNextAction {
  if (["completed", "cancelled"].includes(input.status)) return action("none", "view_result", "Goal ended", "Review the result and evidence.", "View result");
  if (input.status === "paused") return action("user", "resume", "Goal is paused", "Resume when you are ready to continue.", "Resume Goal");
  if (!input.hasDefinition || !input.hasApprovedDefinition) return action("user", "review_goal", "Review this Goal", "Confirm the long-term outcome before starting Workspace changes.", "Approve Goal");
  if (!input.hasRoadmap) return action("system", "generate_roadmap", "Generate a Goal Roadmap", "Use one bounded LLM call to draft TaskRun-sized outcomes, then edit and approve them.", "Generate Roadmap");
  if (!input.hasApprovedRoadmap) return action("user", "review_roadmap", "Review the Goal Roadmap", "Edit the draft and approve only the items that may drive TaskRuns.", "Approve selected");
  if (input.currentRunId && ["blocked", "interrupted"].includes(input.currentRunStatus ?? "")) return action("user", "resolve_problem", "A Goal TaskRun needs attention", "Open the blocked TaskRun, resolve its blocker, and resume it.", "Open task");
  if (input.currentRunId) return action("system", "view_running_task", "A Goal TaskRun is active", "The current TaskRun is executing with an immutable Goal direction snapshot.", "View task");
  if (input.requiredCriteria > 0 && input.verifiedCriteria >= input.requiredCriteria) return action("user", "view_result", "Verified criteria are ready", "Review the evidence and confirm closure.", "Confirm closure");
  const progress = new Map(input.roadmapProgress.map((item) => [item.itemId, item]));
  const nextItemId = input.approvedItemIds.find((itemId) => !["completed", "skipped"].includes(progress.get(itemId)?.status ?? "pending")) ?? null;
  if (nextItemId) return action("user", "run_roadmap_item", "Run the next Roadmap item", "Start one bounded TaskRun with the Goal and Roadmap item embedded in its execution contract.", "Start TaskRun", nextItemId);
  return action("user", "review_roadmap", "Extend the Goal Roadmap", "Approved Roadmap work is exhausted while required Goal criteria remain open.", "Revise Roadmap");
}

export function workspaceGoalContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function action(actor: WorkspaceGoalNextAction["actor"], kind: WorkspaceGoalNextAction["kind"], title: string, explanation: string, primaryActionLabel: string, roadmapItemId: string | null = null): WorkspaceGoalNextAction {
  return { actor, kind, title, explanation, primaryActionLabel, roadmapItemId };
}

function validateDefinition(input: CreateWorkspaceGoalInput["definition"]): CreateWorkspaceGoalInput["definition"] {
  if (!input || typeof input !== "object") throw new Error("definition is required");
  const criteria = input.criteria?.map((criterion, index) => ({
    key: required(criterion.key, `criteria[${index}].key`, 200),
    title: required(criterion.title, `criteria[${index}].title`, 2_000),
    required: criterion.required !== false,
  })) ?? [];
  if (!criteria.length) throw new Error("at least one criterion is required");
  if (criteria.length > 100 || new Set(criteria.map((item) => item.key)).size !== criteria.length) throw new Error("criterion keys must be unique and cannot exceed 100 items");
  if (!criteria.some((item) => item.required)) throw new Error("at least one required criterion is required for evidence-based Goal completion");
  return {
    title: required(input.title, "title", 200),
    outcome: required(input.outcome, "outcome", 4_000),
    scope: uniqueStrings(input.scope ?? [], "scope", 100, 2_000),
    nonGoals: uniqueStrings(input.nonGoals ?? [], "nonGoals", 100, 2_000),
    criteria,
    completionPolicy: "user_confirm",
  };
}

export function validateWorkspaceGoalRoadmap(input: WorkspaceGoalRoadmap, definition: CreateWorkspaceGoalInput["definition"]): WorkspaceGoalRoadmap {
  return validateRoadmap(input, definition);
}

function validateRoadmap(input: WorkspaceGoalRoadmap, definition: CreateWorkspaceGoalInput["definition"]): WorkspaceGoalRoadmap {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Roadmap is required");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new Error("Roadmap items must contain between 1 and 50 items");
  const criterionKeys = new Set(definition.criteria.map((criterion) => criterion.key));
  const items = input.items.map((item, index) => ({
    id: required(item?.id, `items[${index}].id`, 200),
    title: required(item?.title, `items[${index}].title`, 500),
    outcome: required(item?.outcome, `items[${index}].outcome`, 2_000),
    verification: required(item?.verification, `items[${index}].verification`, 2_000),
    criterionKeys: uniqueStrings(item?.criterionKeys ?? [], `items[${index}].criterionKeys`, 100, 200),
  }));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Roadmap item ids must be unique");
  if (items.some((item) => !/^[a-z][a-z0-9_]{0,63}$/.test(item.id))) throw new Error("Roadmap item ids must be short snake_case identifiers");
  if (items.some((item) => !item.criterionKeys.length)) throw new Error("every Roadmap item must advance at least one Goal criterion");
  if (items.some((item) => item.criterionKeys.some((key) => !criterionKeys.has(key)))) throw new Error("Roadmap item references an unknown Goal criterion");
  return { summary: required(input.summary, "summary", 4_000), items };
}

function uniqueStrings(value: string[], name: string, maxItems: number, maxLength = 300): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array with at most ${maxItems} items`);
  const normalized = value.map((item, index) => required(item, `${name}[${index}]`, maxLength));
  return [...new Set(normalized)];
}

function required(value: string | undefined, name: string, maxLength: number): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} cannot exceed ${maxLength} characters`);
  return text;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
