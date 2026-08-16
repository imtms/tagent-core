import type { ServiceCredential } from "./auth.js";
import type {
  HttpApplicationPort,
  HttpArtifactContentPort,
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
  writerReadiness?: HttpWriterReadiness;
  generationStatus?: () => Readonly<Record<string, unknown>> | null;
  onClose?: () => Promise<void>;
}
