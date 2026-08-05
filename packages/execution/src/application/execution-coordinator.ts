import type { ExecutionServices } from "./execution-services.js";
export type { ExecutionCoordinatorStartupOptions } from "./execution-state.js";

/** Public Execution application surface; contains no Admission or Learning facade. */
export class ExecutionCoordinator {
  constructor(private readonly services: ExecutionServices) {}

  initialize(...args: Parameters<ExecutionServices["lifecycle"]["initialize"]>) { return this.services.lifecycle.initialize(...args); }
  startBackgroundWork(...args: Parameters<ExecutionServices["lifecycle"]["startBackgroundWork"]>) { return this.services.lifecycle.startBackgroundWork(...args); }
  closeRuntimes(...args: Parameters<ExecutionServices["runtimeRegistry"]["closeRuntimes"]>) { return this.services.runtimeRegistry.closeRuntimes(...args); }
  recoverContinuations(...args: Parameters<ExecutionServices["recovery"]["recoverContinuations"]>) { return this.services.recovery.recoverContinuations(...args); }
  enqueueControl(...args: Parameters<ExecutionServices["controlInbox"]["enqueueControl"]>) { return this.services.controlInbox.enqueueControl(...args); }
  followUp(...args: Parameters<ExecutionServices["controlInbox"]["followUp"]>) { return this.services.controlInbox.followUp(...args); }
  steer(...args: Parameters<ExecutionServices["controlInbox"]["steer"]>) { return this.services.controlInbox.steer(...args); }
  compact(...args: Parameters<ExecutionServices["runtimeRegistry"]["compact"]>) { return this.services.runtimeRegistry.compact(...args); }
  cancel(...args: Parameters<ExecutionServices["continuation"]["cancel"]>) { return this.services.continuation.cancel(...args); }
  resume(...args: Parameters<ExecutionServices["contextService"]["resume"]>) { return this.services.contextService.resume(...args); }
  rejectRunApproval(...args: Parameters<ExecutionServices["contextService"]["rejectRunApproval"]>) { return this.services.contextService.rejectRunApproval(...args); }
  submitUserInput(...args: Parameters<ExecutionServices["contextService"]["submitUserInput"]>) { return this.services.contextService.submitUserInput(...args); }
  subscribe(...args: Parameters<ExecutionServices["eventHub"]["subscribe"]>) { return this.services.eventHub.subscribe(...args); }
  replay(...args: Parameters<ExecutionServices["eventHub"]["replay"]>) { return this.services.eventHub.replay(...args); }
  getRun(...args: Parameters<ExecutionServices["contextService"]["getRun"]>) { return this.services.contextService.getRun(...args); }
  getCurrentAttemptId(...args: Parameters<ExecutionServices["contextService"]["getCurrentAttemptId"]>) { return this.services.contextService.getCurrentAttemptId(...args); }
}
