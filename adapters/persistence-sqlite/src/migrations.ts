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
export {
  assertWorkspaceGoalsV35Schema,
  migrateWorkspaceGoalsV35,
} from "./migrations/v35-workspace-goals.js";
export {
  assertWorkspaceGoalReliabilityV36Schema,
  migrateWorkspaceGoalReliabilityV36,
} from "./migrations/v36-workspace-goal-reliability.js";
export {
  assertTrustedEvidenceV37Schema,
  migrateTrustedEvidenceV37,
} from "./migrations/v37-trusted-evidence.js";
export {
  assertWorkspaceGoalExecutionV38Schema,
  migrateWorkspaceGoalExecutionV38,
} from "./migrations/v38-workspace-goal-execution.js";
export {
  assertGatewayContractsV39Schema,
  migrateGatewayContractsV39,
} from "./migrations/v39-gateway-contracts.js";
export {
  assertGatewayOperatorV40Schema,
  migrateGatewayOperatorV40,
} from "./migrations/v40-gateway-operator.js";
export {
  assertOperatorReadV41Schema,
  migrateOperatorReadV41,
} from "./migrations/v41-operator-read.js";
export {
  assertExecutionPolicyV42Schema,
  migrateExecutionPolicyV42,
} from "./migrations/v42-execution-policy.js";
