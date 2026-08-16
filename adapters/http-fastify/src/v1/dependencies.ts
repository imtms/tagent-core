import type { ServiceCredential } from "../auth.js";
import type {
  HttpApplicationPort,
  HttpArtifactContentPort,
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
  writerReadiness?: HttpWriterReadiness;
  generationStatus?: () => Readonly<Record<string, unknown>> | null;
}
