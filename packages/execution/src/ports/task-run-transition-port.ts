import type { CanonicalJsonValue } from "@tagent/governance/domain";
import type { RunEvent, RunStatus } from "../domain/task-run.js";

export interface RuntimeTransitionFence {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly leaseToken: string;
  readonly executionFence: number;
}

export interface MessageRejectedPrecedingEvent {
  readonly kind: "message_rejected";
  readonly data: Readonly<Record<string, CanonicalJsonValue>>;
}

export type RuntimeTransitionCommand =
  | {
    readonly kind: "complete";
    readonly reason: string;
    readonly data: Readonly<Record<string, CanonicalJsonValue>>;
  }
  | {
    readonly kind: "block";
    readonly reason: string;
    readonly data: Readonly<Record<string, CanonicalJsonValue>>;
    readonly precedingEvents?: readonly MessageRejectedPrecedingEvent[];
  }
  | {
    readonly kind: "fail";
    readonly reason: string;
    readonly data: Readonly<Record<string, CanonicalJsonValue>>;
  };

interface AttemptBoundSystemCommand {
  readonly attemptId: string;
  readonly expectedVersion: number;
}

export type SystemTransitionCommand =
  | (AttemptBoundSystemCommand & {
    readonly kind: "admission_launch_failed";
    readonly inboxItemId: string;
    readonly error: string;
    readonly retryable: boolean;
  })
  | (AttemptBoundSystemCommand & {
    readonly kind: "require_external_approval";
    readonly approvalId: string;
    readonly reason: string;
  })
  | { readonly kind: "startup_interrupt_active" }
  | { readonly kind: "shutdown_interrupt_active" }
  | (AttemptBoundSystemCommand & {
    readonly kind: "resume_manual";
    readonly reason: string;
  })
  | (AttemptBoundSystemCommand & {
    readonly kind: "resume_approval";
    readonly approvalId: string;
  })
  | (AttemptBoundSystemCommand & {
    readonly kind: "resume_input";
    readonly inputRequestId: string;
  });

export type SystemTransitionAuthority =
  | {
    readonly kind: "admission_launch_failure";
    readonly component: "admission_coordinator";
    readonly inboxItemId: string;
  }
  | {
    readonly kind: "external_action_guard";
    readonly component: "admission_coordinator";
    readonly approvalId: string;
  }
  | {
    readonly kind: "lifecycle_interrupt";
    readonly component: "execution_lifecycle_service";
    readonly phase: "startup";
  }
  | {
    readonly kind: "lifecycle_interrupt";
    readonly component: "runtime_registry";
    readonly phase: "shutdown";
  }
  | {
    readonly kind: "manual_resume";
    readonly actorId: string;
  }
  | {
    readonly kind: "approval_resume";
    readonly approvalId: string;
  }
  | {
    readonly kind: "input_resume";
    readonly inputRequestId: string;
  };

export interface TaskRunTransitionOutcome {
  readonly runId: string;
  readonly sourceAttemptId: string;
  readonly sourceOrdinal: number;
  readonly targetAttemptId: string;
  readonly targetOrdinal: number;
  readonly fromStatus: RunStatus;
  readonly toStatus: RunStatus;
  readonly precedingEvents: readonly RunEvent[];
  /** Null only for lifecycle interrupt and resume transitions, which do not append a RunEvent. */
  readonly event: RunEvent | null;
}

export interface TaskRunTransitionResult {
  readonly transitions: readonly TaskRunTransitionOutcome[];
}

/** Closed production authority for TaskRun state transitions. */
export interface TaskRunTransitionPort {
  transitionRuntime(
    command: RuntimeTransitionCommand,
    fence: RuntimeTransitionFence,
  ): TaskRunTransitionResult;
  transitionSystem(
    command: SystemTransitionCommand,
    authority: SystemTransitionAuthority,
  ): TaskRunTransitionResult;
}
