import type { ServiceCredential } from "./auth.js";
import type {
  HttpApplicationPort,
  HttpArtifactContentPort,
  HttpLearningControlPort,
  HttpMemoryPort,
  HttpPersistencePort,
  HttpRuntimeConfig,
  HttpWriterReadiness,
} from "./ports/index.js";

export interface AppDependencies {
  persistence: HttpPersistencePort;
  service: HttpApplicationPort;
  workspaceRoot?: string;
  logger?: boolean;
  runtimeConfig?: HttpRuntimeConfig;
  serviceCredentials?: ServiceCredential[];
  memory?: HttpMemoryPort;
  artifacts?: HttpArtifactContentPort;
  closeResources?: () => Promise<void>;
  distillationWorker?: { snapshot: () => Record<string, unknown> };
  learningControl?: HttpLearningControlPort;
  writerReadiness?: HttpWriterReadiness;
  generationStatus?: () => Readonly<Record<string, unknown>> | null;
  onClose?: () => Promise<void>;
}
