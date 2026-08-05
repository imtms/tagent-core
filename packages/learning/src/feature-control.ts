import type { LearningSettings, SettingsRepository } from "./ports/settings-repository.js";

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

  constructor(private readonly settings: SettingsRepository, private readonly memoryAvailable: boolean, defaults: { learningEnabled?: boolean; autoExecutionEnabled?: boolean } = {}) {
    const row = settings.getLearningSettings();
    const timestamp = Date.now();
    const initial: LearningSettings = {
      memoryEnabled: memoryAvailable,
      learningEnabled: Boolean(memoryAvailable && defaults.learningEnabled),
      autoExecutionEnabled: Boolean(memoryAvailable && defaults.learningEnabled && defaults.autoExecutionEnabled),
      updatedAt: timestamp,
      reason: memoryAvailable ? "initialized_from_runtime_configuration" : "memory_unavailable",
    };
    const persisted = row ?? initial;
    const enablingAfterUnavailable = Boolean(row && memoryAvailable && !persisted.memoryEnabled && persisted.reason === "memory_unavailable");
    this.state = this.normalize(enablingAfterUnavailable || persisted.memoryEnabled, enablingAfterUnavailable ? Boolean(defaults.learningEnabled) : persisted.learningEnabled, enablingAfterUnavailable ? Boolean(defaults.learningEnabled && defaults.autoExecutionEnabled) : persisted.autoExecutionEnabled, enablingAfterUnavailable ? timestamp : persisted.updatedAt, enablingAfterUnavailable ? "reconciled_memory_runtime_available" : persisted.reason);
  }

  snapshot() { return { ...this.state }; }
  onChange(listener: (state: LearningFeatureState) => void | Promise<void>) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async refresh(): Promise<LearningFeatureState> {
    const committed = this.settings.getLearningSettings();
    if (!committed) return this.snapshot();
    return this.applyCommittedState(committed);
  }

  async applyCommittedState(settings: LearningSettings): Promise<LearningFeatureState> {
    this.state = this.normalize(
      settings.memoryEnabled,
      settings.learningEnabled,
      settings.autoExecutionEnabled,
      settings.updatedAt,
      settings.reason,
    );
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
}
