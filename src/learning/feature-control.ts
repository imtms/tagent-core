import type { Store } from "../store/store.js";

export interface LearningFeatureState {
  memoryAvailable: boolean;
  memoryEnabled: boolean;
  learningEnabled: boolean;
  autoExecutionEnabled: boolean;
  passiveLearningEnabled: boolean;
  activeExecutionRequiresApproval: true;
  updatedAt: number;
  reason: string;
}

export class LearningFeatureControl {
  private state: LearningFeatureState;
  private listeners = new Set<(state: LearningFeatureState) => void | Promise<void>>();

  constructor(private readonly store: Store, private readonly memoryAvailable: boolean, defaults: { learningEnabled?: boolean; autoExecutionEnabled?: boolean } = {}) {
    const row = store.db.prepare("SELECT memory_enabled as memoryEnabled,learning_enabled as learningEnabled,auto_execution_enabled as autoExecutionEnabled,updated_at as updatedAt,reason FROM learning_feature_settings WHERE id=1").get() as Omit<LearningFeatureState,"memoryAvailable"|"passiveLearningEnabled"|"activeExecutionRequiresApproval"> | undefined;
    const timestamp = Date.now();
    if (!row) {
      store.db.prepare("INSERT INTO learning_feature_settings (id,memory_enabled,learning_enabled,auto_execution_enabled,updated_at,reason) VALUES (1,?,?,?,?,?)")
        .run(Number(memoryAvailable), Number(memoryAvailable && defaults.learningEnabled), Number(Boolean(memoryAvailable && defaults.learningEnabled && defaults.autoExecutionEnabled)), timestamp, memoryAvailable ? "initialized_from_runtime_configuration" : "memory_unavailable");
    }
    const persisted = (row ?? { memoryEnabled: Number(memoryAvailable), learningEnabled: Number(memoryAvailable && defaults.learningEnabled), autoExecutionEnabled: Number(Boolean(memoryAvailable && defaults.learningEnabled && defaults.autoExecutionEnabled)), updatedAt: timestamp, reason: memoryAvailable ? "initialized_from_runtime_configuration" : "memory_unavailable" }) as {memoryEnabled:number;learningEnabled:number;autoExecutionEnabled:number;updatedAt:number;reason:string};
    const enablingAfterUnavailable = Boolean(row && memoryAvailable && !persisted.memoryEnabled && persisted.reason === "memory_unavailable");
    this.state = this.normalize(enablingAfterUnavailable || Boolean(persisted.memoryEnabled), enablingAfterUnavailable ? Boolean(defaults.learningEnabled) : Boolean(persisted.learningEnabled), enablingAfterUnavailable ? Boolean(defaults.learningEnabled && defaults.autoExecutionEnabled) : Boolean(persisted.autoExecutionEnabled), enablingAfterUnavailable ? timestamp : persisted.updatedAt, enablingAfterUnavailable ? "reconciled_memory_runtime_available" : persisted.reason);
    this.persist();
  }

  snapshot() { return { ...this.state }; }
  onChange(listener: (state: LearningFeatureState) => void | Promise<void>) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async update(input: { memoryEnabled?: boolean; learningEnabled?: boolean; autoExecutionEnabled?: boolean; reason?: string }) {
    if (input.memoryEnabled === true && !this.memoryAvailable) throw new Error("Memory is not configured and cannot be enabled at runtime");
    const memoryEnabled = input.memoryEnabled ?? this.state.memoryEnabled;
    const requestedLearning = input.learningEnabled ?? this.state.learningEnabled;
    const requestedAuto = input.autoExecutionEnabled ?? this.state.autoExecutionEnabled;
    if (!memoryEnabled && input.learningEnabled === true) throw new Error("Learning requires Memory to be enabled");
    if ((!memoryEnabled || !requestedLearning) && input.autoExecutionEnabled === true) throw new Error("Learning automatic execution requires Memory and Learning to be enabled");
    this.state = this.normalize(memoryEnabled, requestedLearning, requestedAuto, Date.now(), input.reason ?? "runtime_feature_update");
    this.persist();
    await Promise.all([...this.listeners].map((listener) => listener(this.snapshot())));
    return this.snapshot();
  }

  requireMemory() { if (!this.state.memoryEnabled) throw new Error("Memory is disabled"); }
  requireLearning() { if (!this.state.learningEnabled) throw new Error(this.state.memoryEnabled ? "Learning is disabled" : "Learning is disabled because Memory is disabled"); }
  requireAutoExecution() {
    this.requireLearning();
    if (!this.state.autoExecutionEnabled) throw new Error("Learning automatic execution is disabled; passive observation, learning, distillation and candidate evolution remain available");
  }

  private normalize(memoryEnabled: boolean, learningEnabled: boolean, autoExecutionEnabled: boolean, updatedAt: number, reason: string): LearningFeatureState {
    const effectiveMemory = this.memoryAvailable && memoryEnabled;
    const effectiveLearning = effectiveMemory && learningEnabled;
    return {
      memoryAvailable: this.memoryAvailable,
      memoryEnabled: effectiveMemory,
      learningEnabled: effectiveLearning,
      autoExecutionEnabled: effectiveLearning && autoExecutionEnabled,
      passiveLearningEnabled: effectiveLearning,
      activeExecutionRequiresApproval: true,
      updatedAt,
      reason,
    };
  }

  private persist() {
    this.store.db.prepare("UPDATE learning_feature_settings SET memory_enabled=?,learning_enabled=?,auto_execution_enabled=?,updated_at=?,reason=? WHERE id=1")
      .run(Number(this.state.memoryEnabled), Number(this.state.learningEnabled), Number(this.state.autoExecutionEnabled), this.state.updatedAt, this.state.reason);
  }
}
