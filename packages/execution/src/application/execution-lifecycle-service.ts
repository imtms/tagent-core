import type { ExecutionStateView } from "./execution-state.js";
import type { ExecutionBackgroundWorkPort } from "./collaboration-ports.js";

type ExecutionLifecycleState = ExecutionStateView<
  | "backgroundWorkStarted" | "closing" | "initialized" | "persistence",
  "taskRunTransitions"
>;

export class ExecutionLifecycleService {
  constructor(
    private readonly state: ExecutionLifecycleState,
    private readonly backgroundWork: ExecutionBackgroundWorkPort,
  ) {}

  initialize(): void {
    if (this.state.initialized) return;
    if (this.state.closing) throw new Error("Service is shutting down");
    this.state.persistence.taskRunTransitions.transitionSystem(
      { kind: "startup_interrupt_active" },
      {
        kind: "lifecycle_interrupt",
        component: "execution_lifecycle_service",
        phase: "startup",
      },
    );
    this.state.initialized = true;
  }

  startBackgroundWork(): void {
    if (this.state.backgroundWorkStarted) return;
    if (this.state.closing) throw new Error("Service is shutting down");
    this.initialize();
    this.backgroundWork.start();
    this.state.backgroundWorkStarted = true;
  }
}
