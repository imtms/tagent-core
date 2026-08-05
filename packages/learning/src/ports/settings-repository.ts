export interface LearningSettings {
  memoryEnabled: boolean;
  learningEnabled: boolean;
  autoExecutionEnabled: boolean;
  updatedAt: number;
  reason: string;
}

export interface SettingsRepository {
  getLearningSettings(): LearningSettings | undefined;
}
