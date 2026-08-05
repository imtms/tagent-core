import type { AttemptExecutor } from "./attempt-executor.js";
import type { AttemptSettlementService } from "./attempt-settlement-service.js";
import type { ContinuationScheduler } from "./continuation-scheduler.js";
import type { ControlInboxDispatcher } from "./control-inbox-dispatcher.js";
import type { ExecutionLifecycleService } from "./execution-lifecycle-service.js";
import type { RecoveryCoordinator } from "./recovery-coordinator.js";
import type { RunContextService } from "./run-context-service.js";
import type { RunEventHub } from "./run-event-hub.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

/** Execution-owned service graph. Cross-domain facades belong to the Core composition root. */
export interface ExecutionServices {
  readonly attemptExecutor: AttemptExecutor;
  readonly settlement: AttemptSettlementService;
  readonly continuation: ContinuationScheduler;
  readonly controlInbox: ControlInboxDispatcher;
  readonly lifecycle: ExecutionLifecycleService;
  readonly recovery: RecoveryCoordinator;
  readonly contextService: RunContextService;
  readonly eventHub: RunEventHub;
  readonly runtimeRegistry: RuntimeRegistry;
}
