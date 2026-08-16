import type { ServiceCredential } from "../auth.js";
import type {
  HttpApplicationPort,
  HttpArtifactContentPort,
  HttpLearningControlPort,
  HttpMemoryPort,
  HttpPersistencePort,
  HttpRuntimeConfig,
  HttpWriterReadiness,
} from "../ports/index.js";

export interface ChannelV1Dependencies {
  persistence: HttpPersistencePort;
  service: HttpApplicationPort;
  workspaceRoot: string;
  serviceCredentials: ServiceCredential[];
  artifacts: HttpArtifactContentPort;
  memory?: HttpMemoryPort;
  runtimeConfig?: HttpRuntimeConfig;
  learningControl?: HttpLearningControlPort;
  writerReadiness?: HttpWriterReadiness;
  generationStatus?: () => Readonly<Record<string, unknown>> | null;
  distillationWorker?: { snapshot: () => Record<string, unknown> };
}
