export interface ArtifactSinkWriteInput {
  runId: string;
  artifactId: string;
  title: string;
  kind: string;
  content: string | Buffer;
  totalBytes?: number;
  truncatedAtSource?: boolean;
  mediaType?: string;
}

export interface ArtifactSinkWriteResult {
  artifactId: string;
  title: string;
  kind: string;
  uri: string;
  mediaType: string;
  sha256: string;
  totalBytes: number;
  storedBytes: number;
  truncatedAtSource: boolean;
}

/** Durable content sink used before a bounded tool-result projection is returned to the model. */
export interface ArtifactSinkPort {
  readonly maxBytes: number;
  write(input: ArtifactSinkWriteInput, signal: AbortSignal): Promise<ArtifactSinkWriteResult>;
}
