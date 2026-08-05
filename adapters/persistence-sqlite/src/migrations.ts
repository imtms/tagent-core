export {
  ATTEMPT_SCHEMA_V30_SQL,
  migrateAttemptsV30,
} from "./migrations/v30-attempts.js";
export {
  assertGovernanceV31Foundation,
  assertGovernanceV31Schema,
  GOVERNANCE_SCHEMA_V31_SQL,
  migrateGovernanceV31,
} from "./migrations/v31-governance.js";
export {
  assertCapabilityAuthorizationV32Schema,
  CAPABILITY_AUTHORIZATION_SCHEMA_V32_SQL,
  migrateCapabilityAuthorizationV32,
} from "./migrations/v32-capability-authorization.js";
export {
  assertLearningIntegrationV33Schema,
  LEARNING_INTEGRATION_ISSUES_V33_SQL,
  LEARNING_INTEGRATION_SCHEMA_V33_SQL,
  migrateLearningIntegrationV33,
  prepareLearningIntegrationV33,
} from "./migrations/v33-learning-integration.js";
export {
  assertWorkspaceExecutionProfileV34Schema,
  migrateWorkspaceExecutionProfileV34,
} from "./migrations/v34-workspace-execution-profile.js";
