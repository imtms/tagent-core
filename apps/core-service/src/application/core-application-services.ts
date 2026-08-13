import type { AdmissionCoordinator } from "@tagent/admission";
import type { ExecutionCoordinator } from "@tagent/execution";
import type { LearningApplication } from "@tagent/learning/application";
import type { CoreWorkflowGovernanceApplication } from "./workflow-governance-application.js";
import type { CoreWorkspaceGoalApplication } from "./workspace-goal-application.js";
import type { CoreSkillApplication } from "./skill-application.js";

export interface CoreApplicationServices {
  readonly admission: AdmissionCoordinator;
  readonly execution: ExecutionCoordinator;
  readonly governance: CoreWorkflowGovernanceApplication;
  readonly learning: LearningApplication;
  readonly workspaceGoals: CoreWorkspaceGoalApplication;
  readonly skills: CoreSkillApplication;
}
